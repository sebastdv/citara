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
import { advance } from './executor';
import { runInTenant } from '../tenancy/tenant-context';
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

      const outbound = await this.advanceFlow(m, job, inbound.conversationId, inbound.messageId);
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
    m: EntityManager, job: InboundJob, conversationId: string, inboundId: string,
  ): Promise<OutboundContent[]> {
    const [flowRow] = await m.query(
      `SELECT id, definition FROM flows
        WHERE is_active AND is_default LIMIT 1`,
    );
    if (!flowRow) return [];
    const flow = flowRow.definition as FlowDefinition;

    // `status <> 'ended'`, no `status = 'active'`: una sesión en traspaso a
    // humano ('handoff') sigue siendo LA sesión vigente de la conversación
    // — hay que encontrarla para que `advance()` la corte en seco (sin
    // salida), no para que se pierda y dispare un flujo nuevo desde el
    // saludo. Solo 'ended' significa "esta conversación ya cerró".
    //
    // ORDER BY updated_at (no `id`, que es un UUID sin orden temporal).
    const [sessionRow] = await m.query(
      `SELECT id, step_key, vars, status FROM conversation_sessions
        WHERE conversation_id = $1 AND status <> 'ended'
        ORDER BY updated_at DESC LIMIT 1`,
      [conversationId],
    );

    const state: SessionState | null = sessionRow
      ? { stepKey: sessionRow.step_key, vars: sessionRow.vars, status: sessionRow.status }
      : null;

    // Sesión nueva → sin input, para que el flujo emita su paso de entrada.
    const input = state ? job.message.text : null;
    const result = advance(flow, state, input);

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
      const type = content.kind === 'text' ? 'text' : 'interactive';
      await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload,
                               status, reply_to_id, seq)
         VALUES ($1, $2, 'out', 'bot', $3, $4, $5, 'pending', $6, $7)`,
        [job.tenantId, conversationId, type, content.body, JSON.stringify(content),
         inboundId, seq],
      );
    }

    return result.outbound;
  }
}
