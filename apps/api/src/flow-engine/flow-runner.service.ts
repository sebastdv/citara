import { Inject, Injectable } from '@nestjs/common';
// Import de VALOR, no `import type`: FlowRunner es @Injectable() y recibe
// DataSource e InboundProcessor por constructor. Con emitDecoratorMetadata
// activo, un `import type` se borra en la emisión y el design:paramtype
// queda en `Object`, y Nest ya no puede resolver la dependencia. Cuarta vez
// que este defecto aparece en el plan (Tasks 8, 9, 10 y esta): ver la misma
// nota en inbound.processor.ts y outbound.processor.ts.
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { OutboundContent, FlowDefinition, SessionState } from '@citara/shared';
import type { FlowStep } from '@citara/shared';
import { advance, interpolate } from './executor';
import { ToolRegistry } from '../scheduling/tools/registry';
import { CLOCK, type Clock } from '../clock';
import { messageTypeOf } from '../conversations/message-type';

const MAX_TOOL_HOPS = 5;
import { runInTenant } from '../tenancy/tenant-context';
import {
  giveControlToHuman, humanControlExpired, humanInControl, readControl, returnControlToBot,
} from '../conversations/control';
import { InboundProcessor } from '../queues/inbound.processor';
import type { InboundJob } from '../queues/inbound.queue';
import { OutboundQueue } from '../queues/outbound.queue';
import type { OutboundJob } from '../queues/outbound.queue';

/**
 * Lo mínimo que FlowRunner necesita de la cola de salida: encolar un job.
 * Se separa de la clase concreta para que el arnés de pruebas conversacionales
 * pueda inyectar un doble en memoria (sin Redis, sin red) en vez de construir
 * un OutboundQueue real, que abre una conexión al arrancar.
 */
export interface OutboundEnqueuer {
  add(job: OutboundJob): unknown;
}

@Injectable()
export class FlowRunner {
  constructor(
    private readonly ds: DataSource,
    private readonly inbound: InboundProcessor,
    // @Inject explícito: el tipo estático del parámetro es la interfaz
    // mínima de arriba (para que el arnés pueda pasar un doble), así que
    // Nest no puede resolver la dependencia por tipo inferido — hay que
    // darle el token (la clase concreta registrada en AppModule).
    @Inject(OutboundQueue) private readonly outboundQueue: OutboundEnqueuer,
    private readonly tools: ToolRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async handle(job: InboundJob): Promise<OutboundContent[]> {
    // UNA transacción para guardar el entrante y avanzar el flujo: si algo
    // falla, se revierte todo y el reintento de BullMQ procesa el turno desde
    // cero, en vez de ver el entrante como "ya procesado" y callar.
    const turn = await runInTenant(this.ds, job.tenantId, async (m) => {
      const inbound = await this.inbound.persist(m, job);

      // Serialización por conversación: el upsert de `conversations` dentro
      // de `persist` toma el lock de la fila (FOR NO KEY UPDATE) hasta el
      // commit, así que dos mensajes del mismo contacto se procesan uno detrás
      // del otro. NO se añade un FOR UPDATE explícito: choca con el FOR KEY
      // SHARE que toma cualquier INSERT con FK a la conversación desde otra
      // conexión (p. ej. una herramienta que agenda una cita), y como ese
      // ciclo pasa por Node, Postgres no lo ve como deadlock: el job se cuelga.

      if (inbound.duplicate) {
        // El turno ya se procesó (es atómico con el entrante). Si su salida no
        // terminó de enviarse —la API murió tras el commit, Redis falló al
        // encolar— se vuelve a encolar; el procesador no reenvía lo que ya
        // salió.
        const [{ n }] = await m.query(
          `SELECT count(*)::int AS n FROM messages
            WHERE reply_to_id = $1 AND status = 'pending'`, [inbound.messageId]);
        return { ...inbound, outbound: [] as OutboundContent[], pending: n > 0 };
      }

      // Regla de control (spec §6.2), ya con la conversación bloqueada por el
      // upsert de `persist`: antes de avanzar, ¿quién habla?
      const control = await readControl(m, inbound.conversationId);
      const now = new Date();
      if (control.channelStatus === 'disconnected' || humanInControl(control, now)) {
        // El entrante ya quedó guardado; el bot no responde.
        return { ...inbound, outbound: [] as OutboundContent[], pending: false };
      }
      if (humanControlExpired(control, now)) {
        await returnControlToBot(m, {
          tenantId: job.tenantId, conversationId: inbound.conversationId,
          cause: 'expired', actor: 'system',
        });
      }

      const { outbound, enteredHandoff } =
        await this.advanceFlow(m, job, inbound);
      if (enteredHandoff) {
        await giveControlToHuman(m, {
          tenantId: job.tenantId, conversationId: inbound.conversationId,
          from: now, reason: 'flow_handoff', actor: 'flow',
        });
      }
      return { ...inbound, outbound, pending: outbound.length > 0 };
    });

    // Se encola DESPUÉS del commit (outbox): las filas `pending` ya existen y
    // son la fuente de verdad. Encolar dentro de la transacción dejaba jobs
    // apuntando a filas que podían revertirse, o que el worker tomaba antes de
    // que fueran visibles.
    if (turn.pending) {
      await this.outboundQueue.add({
        tenantId: job.tenantId,
        channelId: job.channelId,
        conversationId: turn.conversationId,
        turnId: turn.messageId,
        to: job.message.from,
      });
    }
    return turn.outbound;
  }

  private async advanceFlow(
    m: EntityManager, job: InboundJob,
    inbound: { conversationId: string; messageId: string; contactId: string },
  ): Promise<{ outbound: OutboundContent[]; enteredHandoff: boolean }> {
    const { conversationId, messageId: inboundId } = inbound;
    const [flowRow] = await m.query(
      `SELECT id, definition FROM flows
        WHERE is_active AND is_default LIMIT 1`,
    );
    if (!flowRow) return { outbound: [], enteredHandoff: false };
    const flow = flowRow.definition as FlowDefinition;

    // `status <> 'ended'`, no `status = 'active'`: una sesión en traspaso a
    // humano ('handoff') sigue siendo LA sesión vigente de la conversación
    // — hay que encontrarla para que `advance()` la corte en seco (sin
    // salida), no para que se pierda y dispare un flujo nuevo desde el
    // saludo. Solo 'ended' significa "esta conversación ya cerró".
    //
    // ORDER BY updated_at (no `id`, que es un UUID sin orden temporal).
    let [sessionRow] = await m.query(
      `SELECT id, step_key, vars, status FROM conversation_sessions
        WHERE conversation_id = $1 AND status <> 'ended'
        ORDER BY updated_at DESC LIMIT 1`,
      [conversationId],
    );

    // Aquí ya se sabe que manda el bot. Una sesión que quedó en 'handoff' es un
    // residuo (el control ya volvió): se cierra para no silenciar al bot.
    if (sessionRow?.status === 'handoff') {
      await m.query(
        `UPDATE conversation_sessions SET status = 'ended', updated_at = now() WHERE id = $1`,
        [sessionRow.id]);
      sessionRow = undefined;
    }

    const state: SessionState | null = sessionRow
      ? { stepKey: sessionRow.step_key, vars: sessionRow.vars, status: sessionRow.status }
      : null;

    // Sesión nueva → sin input, para que el flujo emita su paso de entrada.
    const input = state ? job.message.text : null;
    let result = advance(flow, state, input);
    // Las herramientas corren aquí, en la transacción del turno: si algo falla
    // después de agendar, el rollback se lleva también la cita.
    for (let hop = 0; result.pending; hop++) {
      if (hop >= MAX_TOOL_HOPS) throw new Error(`Cadena de herramientas demasiado larga en el flujo '${flow.key}'`);
      const { tool, args, stepKey } = result.pending;
      const step = flow.steps[stepKey] as Extract<FlowStep, { type: 'tool' }>;
      const out = await this.tools.run(tool, args, {
        m, tenantId: job.tenantId, contactId: inbound.contactId, conversationId, now: this.clock.now() });

      const vars = { ...result.state.vars };
      let next = out.ok ? step.on_success : step.on_error;
      if (!out.ok) vars.__tool_error = out.error ?? '';
      if (out.ok && step.save_list && Array.isArray(out.data)) {
        const items = out.data as Record<string, unknown>[];
        vars[`__${step.save_list}`] = JSON.stringify(items);
        vars[step.save_list] = items
          .map((it, i) => `${i + 1}. ${interpolate(step.render ?? '{{id}}',
            Object.fromEntries(Object.entries(it).map(([k, v]) => [k, String(v)])))}`)
          .join('\n');
        if (items.length === 0) next = step.on_empty ?? step.on_success;
      }
      const after = advance(flow, { ...result.state, vars, stepKey: next }, null);
      result = { ...after, outbound: [...result.outbound, ...after.outbound] };
    }

    if (sessionRow) {
      await m.query(
        `UPDATE conversation_sessions
            SET step_key = $1, vars = $2, status = $3, updated_at = now()
          WHERE id = $4`,
        [result.state.stepKey, JSON.stringify(result.state.vars), result.state.status, sessionRow.id],
      );
    } else {
      await m.query(
        `INSERT INTO conversation_sessions
           (tenant_id, conversation_id, flow_id, step_key, vars, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [job.tenantId, conversationId, flowRow.id, result.state.stepKey,
         JSON.stringify(result.state.vars), result.state.status],
      );
    }

    for (const [seq, content] of result.outbound.entries()) {
      // `type` con el MISMO vocabulario que el entrante (el de Meta): botones
      // y lista son las dos formas de un mensaje interactivo. El `kind` fino
      // viaja en `payload`, que además es lo que el envío manda tal cual.
      const type = messageTypeOf(content);
      await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload,
                               status, reply_to_id, seq)
         VALUES ($1, $2, 'out', 'bot', $3, $4, $5, 'pending', $6, $7)`,
        [job.tenantId, conversationId, type, 'body' in content ? content.body : null, JSON.stringify(content),
         inboundId, seq],
      );
    }

    return {
      outbound: result.outbound,
      enteredHandoff: result.state.status === 'handoff' && state?.status !== 'handoff',
    };
  }
}
