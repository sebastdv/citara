import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { advance, interpolate, type AiRequest } from './executor';
import { isBareGreeting } from './greeting';
import { insertBotReplies } from './outbox';
import { ToolRegistry } from '../scheduling/tools/registry';
import { CLOCK, type Clock } from '../clock';
import { runInTenant } from '../tenancy/tenant-context';
import {
  giveControlToHuman, humanControlExpired, humanInControl, readControl, returnControlToBot,
} from '../conversations/control';
import { InboundProcessor } from '../queues/inbound.processor';
import type { InboundJob } from '../queues/inbound.queue';
import { OutboundQueue } from '../queues/outbound.queue';
import type { OutboundJob } from '../queues/outbound.queue';
import { AgentQueue, type AgentEnqueuer } from '../queues/agent.queue';
import { AiGate } from '../agent/ai-gate';

const MAX_TOOL_HOPS = 5;
/** Una sesión quieta más que esto se da por abandonada. */
const SESSION_TTL_HOURS = 2;

/**
 * Lo mínimo que FlowRunner necesita de la cola de salida: encolar un job.
 * Se separa de la clase concreta para que el arnés de pruebas conversacionales
 * pueda inyectar un doble en memoria (sin Redis, sin red) en vez de construir
 * un OutboundQueue real, que abre una conexión al arrancar.
 */
export interface OutboundEnqueuer {
  add(job: OutboundJob): unknown;
}

/** Dónde avanza el flujo: la conversación, quién escribe y el entrante que se atiende. */
export interface TurnContext { tenantId: string; conversationId: string; contactId: string; inboundId: string }

interface SessionRow {
  id: string; flow_id?: string; step_key: string; vars: Record<string, string>;
  status: SessionState['status']; stale?: boolean;
}

type FlowOutcome = { outbound: OutboundContent[]; enteredHandoff: boolean; ai?: AiRequest };

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
    // Opcionales: sin ellos (el arnés, un negocio sin IA) el bot es el de menús.
    @Optional() @Inject(AgentQueue) private readonly agents?: AgentEnqueuer,
    @Optional() private readonly gate?: AiGate,
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
        // salió. Lo mismo si el agente nunca lo atendió.
        const [{ n }] = await m.query(
          `SELECT count(*)::int AS n FROM messages
            WHERE reply_to_id = $1 AND status = 'pending'`, [inbound.messageId]);
        const ai = await this.unansweredAgentTurn(m, inbound.conversationId, inbound.messageId);
        return { ...inbound, outbound: [] as OutboundContent[], pending: n > 0, ai };
      }

      // Regla de control (spec §6.2), ya con la conversación bloqueada por el
      // upsert de `persist`: antes de avanzar, ¿quién habla?
      const control = await readControl(m, inbound.conversationId);
      const now = new Date();
      // En alta (sin agenda completa) o suspendido: se guarda lo que llega y
      // no se responde. Igual con el canal desconectado o un humano al mando.
      if (control.tenantStatus !== 'active' || control.channelStatus === 'disconnected'
          || humanInControl(control, now)) {
        // El entrante ya quedó guardado; el bot no responde.
        return { ...inbound, outbound: [] as OutboundContent[], pending: false, ai: undefined };
      }
      if (humanControlExpired(control, now)) {
        await returnControlToBot(m, {
          tenantId: job.tenantId, conversationId: inbound.conversationId,
          cause: 'expired', actor: 'system',
        });
      }

      const ctx: TurnContext = { tenantId: job.tenantId, conversationId: inbound.conversationId,
                                 contactId: inbound.contactId, inboundId: inbound.messageId };
      const { outbound, enteredHandoff, ai } = await this.advanceFlow(m, ctx, job.message.text);
      if (enteredHandoff) {
        await giveControlToHuman(m, {
          tenantId: job.tenantId, conversationId: inbound.conversationId,
          from: now, reason: 'flow_handoff', actor: 'flow',
        });
      }
      return { ...inbound, outbound, pending: outbound.length > 0, ai };
    });

    // Se encola DESPUÉS del commit (outbox): las filas `pending` ya existen y
    // son la fuente de verdad. Si el turno derivó a la IA, el envío lo encola
    // el worker del agente cuando escribe su respuesta en este mismo turno.
    if (turn.ai) {
      await this.agents!.add({
        tenantId: job.tenantId, channelId: job.channelId, conversationId: turn.conversationId,
        contactId: turn.contactId, inboundId: turn.messageId, to: job.message.from, ...turn.ai,
      });
    } else if (turn.pending) {
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

  /**
   * Retoma el flujo desde la sesión activa, fuera del turno original (lo usa el
   * worker del agente): con `input` como si el cliente lo hubiera escrito, o
   * saltando a `fromStep`. Persiste sesión y salida en `m`.
   */
  async resume(
    m: EntityManager, ctx: TurnContext, opts: { input: string | null; fromStep?: string; ai: boolean },
  ): Promise<FlowOutcome | null> {
    const [sessionRow] = await m.query(
      `SELECT id, flow_id, step_key, vars, status FROM conversation_sessions
        WHERE conversation_id = $1 AND status = 'active'`, [ctx.conversationId]);
    if (!sessionRow) return null;
    const [flowRow] = await m.query(`SELECT id, definition FROM flows WHERE id = $1`, [sessionRow.flow_id]);
    const state: SessionState = {
      stepKey: opts.fromStep ?? sessionRow.step_key, vars: sessionRow.vars, status: sessionRow.status };
    return this.run(m, ctx, flowRow.definition as FlowDefinition, flowRow.id, sessionRow, state, opts.input, opts.ai);
  }

  private async advanceFlow(m: EntityManager, ctx: TurnContext, text: string | null): Promise<FlowOutcome> {
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
    let [sessionRow]: (SessionRow | undefined)[] = await m.query(
      `SELECT id, step_key, vars, status,
              updated_at < now() - make_interval(hours => $2) AS stale
         FROM conversation_sessions
        WHERE conversation_id = $1 AND status <> 'ended'
        ORDER BY updated_at DESC LIMIT 1`,
      [ctx.conversationId, SESSION_TTL_HOURS],
    );

    // Aquí ya se sabe que manda el bot. Una sesión es un residuo, y se cierra
    // para empezar de nuevo, si:
    // - quedó en 'handoff' (el control ya volvió), y silenciaría al bot;
    // - lleva más de SESSION_TTL_HOURS sin moverse: quien vuelve horas después
    //   no debe caer en la pregunta donde quedó ni ver horarios ya pasados;
    // - su paso ya no existe en el flujo (tenant:apply lo cambió): si no, cada
    //   mensaje de ese contacto fallaría para siempre.
    const residue = sessionRow &&
      (sessionRow.status === 'handoff' || sessionRow.stale || !(sessionRow.step_key in flow.steps));
    if (residue) {
      await m.query(
        `UPDATE conversation_sessions SET status = 'ended', updated_at = now() WHERE id = $1`,
        [sessionRow!.id]);
      sessionRow = undefined;
    }

    const ai = await this.aiOn(m, ctx.tenantId);
    let state: SessionState | null = sessionRow
      ? { stepKey: sessionRow.step_key, vars: sessionRow.vars, status: sessionRow.status }
      : null;

    // Sesión nueva → sin input, para que el flujo emita su paso de entrada...
    let input = state ? text : null;
    // ...salvo que el primer mensaje traiga un pedido: con IA va directo al agente.
    if (!state && ai && flow.ai_step && text && !isBareGreeting(text)) {
      state = { stepKey: flow.ai_step, vars: {}, status: 'active' };
      input = text;
    }
    return this.run(m, ctx, flow, flowRow.id, sessionRow ?? null, state, input, ai);
  }

  /** ¿Hay IA para este negocio ahora? Sin cola o sin compuerta (el arnés), no. */
  private async aiOn(m: EntityManager, tenantId: string): Promise<boolean> {
    if (!this.gate || !this.agents) return false;
    return (await this.gate.availability(m, tenantId, this.clock.now())).ok;
  }

  /** Avanza desde `state`, ejecuta herramientas y persiste sesión y salida. */
  private async run(
    m: EntityManager, ctx: TurnContext, flow: FlowDefinition, flowId: string,
    sessionRow: SessionRow | null, state: SessionState | null, input: string | null, ai: boolean,
  ): Promise<FlowOutcome> {
    let result = advance(flow, state, input, { ai });
    // Las herramientas corren aquí, en la transacción del turno: si algo falla
    // después de agendar, el rollback se lleva también la cita.
    for (let hop = 0; result.pending; hop++) {
      if (hop >= MAX_TOOL_HOPS) throw new Error(`Cadena de herramientas demasiado larga en el flujo '${flow.key}'`);
      const { tool, args, stepKey } = result.pending;
      const step = flow.steps[stepKey] as Extract<FlowStep, { type: 'tool' }>;
      const out = await this.tools.run(tool, args, {
        m, tenantId: ctx.tenantId, contactId: ctx.contactId, conversationId: ctx.conversationId,
        now: this.clock.now(), turnId: ctx.inboundId, actor: 'flow' });

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
      const after = advance(flow, { ...result.state, vars, stepKey: next }, null, { ai });
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
        [ctx.tenantId, ctx.conversationId, flowId, result.state.stepKey,
         JSON.stringify(result.state.vars), result.state.status],
      );
    }

    // Un segmento nuevo del agente empieza limpio, y responde desde este entrante.
    if (result.ai?.kind === 'agent' && sessionRow?.step_key !== result.ai.stepKey) {
      await m.query(
        `UPDATE conversation_sessions
            SET agent_system = NULL, agent_transcript = NULL, agent_model = NULL, agent_effort = NULL,
                agent_config_version = NULL,
                agent_cursor = (SELECT created_at FROM messages WHERE id = $2) - interval '1 microsecond'
          WHERE conversation_id = $1 AND status = 'active'`, [ctx.conversationId, ctx.inboundId]);
    }

    await insertBotReplies(m, ctx.tenantId, ctx.conversationId, ctx.inboundId, result.outbound);

    return {
      outbound: result.outbound,
      enteredHandoff: result.state.status === 'handoff' && state?.status !== 'handoff',
      ai: result.ai,
    };
  }

  /** Un entrante del agente sin responder: su sesión sigue en el segmento y el cursor no lo pasó. */
  private async unansweredAgentTurn(
    m: EntityManager, conversationId: string, inboundId: string,
  ): Promise<AiRequest | undefined> {
    const [s] = await m.query(
      `SELECT s.step_key, f.definition FROM conversation_sessions s
         JOIN flows f ON f.id = s.flow_id, messages i
        WHERE s.conversation_id = $1 AND s.status = 'active' AND i.id = $2
          AND s.agent_cursor IS NOT NULL AND s.agent_cursor < i.created_at`, [conversationId, inboundId]);
    // El cursor sobrevive al segmento: solo cuenta si la sesión sigue en un paso del agente.
    if (!s || (s.definition as FlowDefinition).steps[s.step_key]?.type !== 'ai_turn') return undefined;
    return { kind: 'agent', stepKey: s.step_key };
  }
}
