import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource, type EntityManager } from 'typeorm';
import type { FlowDefinition, FlowStep, SessionState } from '@citara/shared';
import { AgentService, APOLOGY, type AgentSegment } from './agent.service';
import { InterpreterService, type Interpretation } from './interpreter.service';
import { AiGate, type AiAvailability } from './ai-gate';
import { buildSystem, isCustomerTurn, loadFacts, recentHistory } from './context';
import { FlowRunner, type OutboundEnqueuer, type TurnContext } from '../flow-engine/flow-runner.service';
import type { AiRequest } from '../flow-engine/executor';
import { insertBotReplies } from '../flow-engine/outbox';
import { OutboundQueue } from '../queues/outbound.queue';
import { AgentQueue, type AgentEnqueuer, type AgentJob } from '../queues/agent.queue';
import { ChannelResolver } from '../tenancy/channel-resolver.service';
import { MetaSender } from '../whatsapp/sender';
import { CLOCK, type Clock } from '../clock';
import { runInTenant } from '../tenancy/tenant-context';
import { giveControlToHuman, humanInControl, readControl } from '../conversations/control';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type AiStep = Extract<FlowStep, { type: 'ai_turn' }>;

const LEASE_SECONDS = 120;
/** El dueño renueva su lease a este ritmo mientras trabaja (un turno lento pasa de los 120 s). */
const RENEW_EVERY_MS = 30_000;
/** Un segmento largo se corta: cada turno reenvía la transcripción entera. */
export const MAX_SEGMENT_TURNS = 15;
export const MENU_NOTICE = 'Ahora mismo te atiendo con el menú.';
const LONG_SEGMENT = 'Para seguir, te dejo el menú.';
const NO_TEXT = '[El cliente envió un mensaje sin texto]';

interface Session {
  id: string; flow_id: string; step_key: string; vars: Record<string, string>; status: SessionState['status'];
  agent_system: string | null; agent_transcript: string | null; agent_model: string | null;
  agent_effort: string | null; agent_config_version: number | null;
}
interface Pending { id: string; body: string | null; wamid: string | null; created_at: Date }

/**
 * Cierra el estado del segmento. `agent_cursor` se conserva: marca hasta dónde
 * respondió el agente, y es lo que distingue un mensaje ya atendido de uno que
 * llegó mientras el segmento se cerraba. Un segmento nuevo lo vuelve a fijar.
 */
const CLEAR_AGENT = `agent_system = NULL, agent_transcript = NULL, agent_model = NULL, agent_effort = NULL,
                     agent_config_version = NULL`;

/**
 * El worker de la cola `agent` (spec §3.4). Ninguna llamada al modelo ocurre con
 * una transacción abierta: se lee, se piensa y se cierra en una transacción
 * corta que escribe el outbox. Un lease por conversación serializa los turnos
 * del agente; lo que el cliente escriba mientras tanto se junta en el siguiente.
 */
@Injectable()
export class AgentProcessor {
  private readonly log = new Logger(AgentProcessor.name);

  constructor(
    private readonly ds: DataSource,
    private readonly agent: AgentService,
    private readonly interpreter: InterpreterService,
    private readonly gate: AiGate,
    private readonly flows: FlowRunner,
    @Inject(OutboundQueue) private readonly outbound: OutboundEnqueuer,
    @Inject(AgentQueue) private readonly agents: AgentEnqueuer,
    private readonly channels: ChannelResolver,
    private readonly sender: MetaSender,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async process(job: AgentJob): Promise<'answered' | 'nothing' | 'busy' | 'skipped'> {
    const owner = randomUUID();
    if (!(await acquireLease(this.ds, job.tenantId, job.conversationId, owner))) return 'busy';
    const heartbeat = setInterval(() => {
      renewLease(this.ds, job.tenantId, job.conversationId, owner)
        .catch((err: Error) => this.log.warn(`no se pudo renovar el lease: ${err.message}`));
    }, RENEW_EVERY_MS);
    try {
      return await this.run({ ...job, owner });
    } finally {
      clearInterval(heartbeat);
      await releaseLease(this.ds, job.tenantId, job.conversationId, owner);
    }
  }

  /** Reintentos agotados (la base o Redis cayeron): disculpa y traspaso, nunca silencio. */
  async failSafe(job: AgentJob): Promise<void> {
    await runInTenant(this.ds, job.tenantId, async (m) => {
      await insertBotReplies(m, job.tenantId, job.conversationId, job.inboundId, [{ kind: 'text', body: APOLOGY }]);
      await this.toHuman(m, job);
    });
    await this.enqueueTurn(job, job.inboundId);
  }

  private async run(job: LeasedJob): Promise<'answered' | 'nothing' | 'skipped'> {
    const now = this.clock.now();
    const read = await runInTenant(this.ds, job.tenantId, async (m) => {
      const control = await readControl(m, job.conversationId);
      const [session] = await m.query(
        `SELECT id, flow_id, step_key, vars, status, agent_system, agent_transcript, agent_model, agent_effort,
                agent_config_version
           FROM conversation_sessions WHERE conversation_id = $1 AND status = 'active'`, [job.conversationId]);
      const [flowRow] = session ? await m.query(`SELECT definition FROM flows WHERE id = $1`, [session.flow_id]) : [];
      const [t] = await m.query(`SELECT timezone FROM tenants WHERE id = $1`, [job.tenantId]);
      return { control, session: session as Session | undefined, flow: flowRow?.definition as FlowDefinition | undefined,
               gate: await this.gate.availability(m, job.tenantId, now), timezone: t.timezone as string };
    });
    const { control, flow, gate, timezone } = read;
    // El entrante quedó guardado; si ya no manda el bot, no se responde (spec §6.2).
    // El control se mide con la hora real (como en FlowRunner): CLOCK es solo para agendar.
    if (control.tenantStatus !== 'active' || control.channelStatus === 'disconnected'
        || humanInControl(control, new Date())) {
      return 'skipped';
    }
    // La conversación siguió por otro lado (otro turno la movió, la sesión venció).
    let session = read.session;
    if (!session || !flow) return 'nothing';
    if (session.step_key !== job.stepKey) {
      // El segmento se cerró (volvió al menú) mientras este mensaje esperaba su turno.
      return job.kind === 'agent' ? this.orphan(job, session, gate) : 'nothing';
    }

    if (job.kind === 'interpret') {
      const done = await this.interpret(job, flow, session, gate);
      if (done !== 'to_agent') return done;
      session = { ...session, step_key: flow.ai_step!, agent_system: null, agent_transcript: null,
                  agent_model: null, agent_effort: null, agent_config_version: null };
    }
    return this.converse(job, flow, session, gate, now, timezone);
  }

  /**
   * Un mensaje derivado al agente que nadie respondió (llegó después del cursor y
   * no tiene salientes) se atiende como un turno del paso actual, como si llegara ahora.
   */
  private async orphan(job: LeasedJob, session: Session, gate: AiAvailability): Promise<'answered' | 'nothing'> {
    const [row] = await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `SELECT i.body FROM messages i, conversation_sessions s
        WHERE i.id = $1 AND s.id = $2
          AND i.created_at > COALESCE(s.agent_cursor, '-infinity'::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to_id = i.id)`, [job.inboundId, session.id]));
    if (!row) return 'nothing';
    await this.finish(job, job.inboundId, async (m) => {
      const out = await this.flows.resume(m, this.ctx(job, job.inboundId), { input: row.body ?? '', ai: gate.ok });
      if (out?.enteredHandoff) await this.toHuman(m, job, 'flow');
      return out?.ai ?? null;
    });
    return 'answered';
  }

  private async interpret(job: LeasedJob, flow: FlowDefinition, session: Session, gate: AiAvailability) {
    // Si la persona ya escribió otra cosa, ese mensaje manda: su propio turno ya corrió.
    const [newer] = await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'in' AND origin = 'customer'
          AND created_at > (SELECT created_at FROM messages WHERE id = $2) LIMIT 1`,
      [job.conversationId, job.inboundId]));
    if (newer) return 'nothing' as const;

    const step = flow.steps[job.stepKey];
    let r: Interpretation = { action: 'none' };
    if (gate.ok) {
      r = await this.interpreter.interpret({
        tenantId: job.tenantId, conversationId: job.conversationId, turnId: job.inboundId,
        model: gate.config.interpreterModel, configVersion: gate.config.version,
        question: questionOf(step, session.vars), options: optionsOf(step, session.vars), text: job.input ?? '' });
    }
    if (r.action === 'agent' && flow.ai_step && gate.ok) {
      await runInTenant(this.ds, job.tenantId, (m) => m.query(
        `UPDATE conversation_sessions
            SET step_key = $2, ${CLEAR_AGENT},
                agent_cursor = (SELECT created_at FROM messages WHERE id = $3) - interval '1 microsecond',
                updated_at = now()
          WHERE id = $1`, [session.id, flow.ai_step, job.inboundId]));
      return 'to_agent' as const;
    }
    await this.finish(job, job.inboundId, async (m) => {
      const ctx = this.ctx(job, job.inboundId);
      const out = r.action === 'option'
        ? await this.flows.resume(m, ctx, { input: r.optionId, ai: true })
        : await this.flows.resume(m, ctx, { input: null, fromStep: job.stepKey, ai: false });
      if (out?.enteredHandoff) await this.toHuman(m, job, 'flow');
      return out?.ai ?? null;
    });
    return 'answered' as const;
  }

  private async converse(job: LeasedJob, flow: FlowDefinition, session: Session, gate: AiAvailability,
                         now: Date, timezone: string): Promise<'answered' | 'nothing'> {
    // Todo lo que el cliente escribió desde la última respuesta. La comparación
    // va en SQL: created_at tiene microsegundos y un Date de JS no.
    const pending: Pending[] = await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `SELECT i.id, i.body, i.wamid, i.created_at
         FROM messages i, conversation_sessions s
        WHERE s.id = $2 AND i.conversation_id = $1 AND i.direction = 'in' AND i.origin = 'customer'
          AND i.created_at > COALESCE(s.agent_cursor,
                (SELECT created_at FROM messages WHERE id = $3) - interval '1 microsecond')
        ORDER BY i.created_at`, [job.conversationId, session.id, job.inboundId]));
    if (!pending.length) return 'nothing';
    const first = pending[0], last = pending[pending.length - 1];
    const aiStep = flow.steps[session.step_key] as AiStep;

    // Sin IA desde que se derivó (tope, apagada): aviso y menú, sin llamar al modelo.
    if (!gate.ok) return this.leaveToMenu(job, session, aiStep, first.id, last.id, [MENU_NOTICE]);

    let segment: AgentSegment;
    let recent: string | null = null;
    if (session.agent_transcript) {
      // Congelado al empezar el segmento: una configuración nueva entra en el próximo.
      segment = { system: session.agent_system!, model: session.agent_model!, effort: session.agent_effort!,
                  configVersion: session.agent_config_version!,
                  transcript: JSON.parse(session.agent_transcript) as MessageParam[] };
    } else {
      const facts = await runInTenant(this.ds, job.tenantId, async (m) => ({
        facts: await loadFacts(m, job.tenantId),
        recent: await recentHistory(m, job.conversationId, first.created_at) }));
      segment = { system: buildSystem(facts.facts, gate.config), model: gate.config.model,
                  effort: gate.config.effort, configVersion: gate.config.version, transcript: [] };
      recent = facts.recent;
    }
    if (segment.transcript.filter(isCustomerTurn).length >= MAX_SEGMENT_TURNS) {
      return this.leaveToMenu(job, session, aiStep, first.id, last.id, [LONG_SEGMENT]);
    }

    void this.typing(job.channelId, last.wamid);
    const r = await this.agent.respond({
      tenantId: job.tenantId, conversationId: job.conversationId, contactId: job.contactId, turnId: last.id,
      now, timezone, segment, texts: pending.map((p) => p.body?.trim() || NO_TEXT), recent });

    await this.finish(job, first.id, async (m) => {
      // Las respuestas van al primer entrante pendiente: es el turno cuyo envío aún no se encoló.
      await insertBotReplies(m, job.tenantId, job.conversationId, first.id,
                             r.replies.map((body) => ({ kind: 'text' as const, body })));
      await m.query(
        `UPDATE conversation_sessions
            SET agent_system = $2, agent_transcript = $3, agent_model = $4, agent_effort = $5,
                agent_config_version = $6, agent_cursor = (SELECT created_at FROM messages WHERE id = $7),
                updated_at = now()
          WHERE id = $1`,
        [session.id, segment.system, JSON.stringify(r.transcript), segment.model, segment.effort,
         segment.configVersion, last.id]);
      if (r.action === 'menu') await this.toMenu(m, job, session, aiStep, first.id);
      if (r.action === 'human') await this.toHuman(m, job);
      return null;
    });
    return 'answered';
  }

  private async leaveToMenu(job: LeasedJob, session: Session, aiStep: AiStep, firstId: string, lastId: string,
                            notices: string[]): Promise<'answered'> {
    await this.finish(job, firstId, async (m) => {
      await insertBotReplies(m, job.tenantId, job.conversationId, firstId,
                             notices.map((body) => ({ kind: 'text' as const, body })));
      await m.query(`UPDATE conversation_sessions SET agent_cursor = (SELECT created_at FROM messages WHERE id = $2) WHERE id = $1`,
                    [session.id, lastId]);
      await this.toMenu(m, job, session, aiStep, firstId);
      return null;
    });
    return 'answered';
  }

  /** Termina el segmento y sigue el flujo desde el paso siguiente al agente (el menú). */
  private async toMenu(m: EntityManager, job: AgentJob, session: Session, aiStep: AiStep, turnId: string) {
    await m.query(`UPDATE conversation_sessions SET ${CLEAR_AGENT} WHERE id = $1`, [session.id]);
    await this.flows.resume(m, this.ctx(job, turnId), { input: null, fromStep: aiStep.next, ai: false });
  }

  /** El agente (o un fallo) pasa la conversación al dueño: la regla de flow_handoff deja salir su mensaje. */
  private async toHuman(m: EntityManager, job: AgentJob, actor: 'agent' | 'flow' = 'agent') {
    await m.query(
      `UPDATE conversation_sessions SET status = 'handoff', ${CLEAR_AGENT}, updated_at = now()
        WHERE conversation_id = $1 AND status = 'active'`, [job.conversationId]);
    // Si el dueño ya intervino mientras el modelo pensaba, su control se respeta:
    // pasarlo a 'flow_handoff' dejaría salir la respuesta del bot encima de la suya.
    const control = await readControl(m, job.conversationId);
    if (humanInControl(control, new Date()) && control.reason !== 'flow_handoff') return;
    await giveControlToHuman(m, { tenantId: job.tenantId, conversationId: job.conversationId,
                                  from: new Date(), reason: 'flow_handoff', actor });
  }

  private async finish(job: LeasedJob, turnId: string, fn: (m: EntityManager) => Promise<AiRequest | null>) {
    const next = await runInTenant(this.ds, job.tenantId, async (m) => {
      // Si este job perdió el lease (la renovación falló), otro ya está atendiendo
      // la conversación: no se escribe nada y BullMQ lo reintenta.
      const [mine] = await m.query(
        `SELECT 1 FROM conversations WHERE id = $1 AND agent_lease_owner = $2 FOR NO KEY UPDATE`,
        [job.conversationId, job.owner]);
      if (!mine) throw new Error(`el job del agente perdió el lease de la conversación ${job.conversationId}`);
      return fn(m);
    });
    // Una opción del menú que lleva a otro paso con IA se atiende en su propio job,
    // y es ESE job el que encola el envío del turno: el jobId del envío es el id
    // del turno, y un segundo encolado con el mismo id BullMQ lo descarta.
    if (next) {
      const { owner: _owner, ...plain } = job;
      await this.agents.add({ ...plain, kind: next.kind, stepKey: next.stepKey,
                              input: next.kind === 'interpret' ? next.input : undefined });
      return;
    }
    await this.enqueueTurn(job, turnId);
  }

  private enqueueTurn(job: AgentJob, turnId: string) {
    return this.outbound.add({ tenantId: job.tenantId, channelId: job.channelId,
                               conversationId: job.conversationId, turnId, to: job.to });
  }

  private ctx(job: AgentJob, inboundId: string): TurnContext {
    return { tenantId: job.tenantId, conversationId: job.conversationId, contactId: job.contactId, inboundId };
  }

  private async typing(channelId: string, wamid: string | null): Promise<void> {
    if (!wamid) return;
    try {
      const channel = await this.channels.resolveById(channelId);
      if (channel) await this.sender.markTyping(channel, wamid);
    } catch (err) {
      this.log.debug(`sin indicador de escritura: ${(err as Error).message}`);
    }
  }
}

type LeasedJob = AgentJob & { owner: string };

/** Toma el lease si está libre o vencido. Compare-and-set: solo un job por conversación. */
export async function acquireLease(
  ds: DataSource, tenantId: string, conversationId: string, owner: string, seconds = LEASE_SECONDS,
): Promise<boolean> {
  const [, affected] = (await runInTenant(ds, tenantId, (m) => m.query(
    `UPDATE conversations SET agent_lease_until = now() + make_interval(secs => $2), agent_lease_owner = $3
      WHERE id = $1 AND (agent_lease_until IS NULL OR agent_lease_until < now())`,
    [conversationId, seconds, owner]))) as [unknown[], number];
  return affected > 0;
}

/** Solo el dueño lo renueva. */
export async function renewLease(
  ds: DataSource, tenantId: string, conversationId: string, owner: string, seconds = LEASE_SECONDS,
): Promise<boolean> {
  const [, affected] = (await runInTenant(ds, tenantId, (m) => m.query(
    `UPDATE conversations SET agent_lease_until = now() + make_interval(secs => $2)
      WHERE id = $1 AND agent_lease_owner = $3`, [conversationId, seconds, owner]))) as [unknown[], number];
  return affected > 0;
}

/** Solo el dueño lo libera: un job que lo perdió no suelta el de otro. */
export async function releaseLease(ds: DataSource, tenantId: string, conversationId: string, owner: string) {
  await runInTenant(ds, tenantId, (m) => m.query(
    `UPDATE conversations SET agent_lease_until = NULL, agent_lease_owner = NULL
      WHERE id = $1 AND agent_lease_owner = $2`, [conversationId, owner]));
}

/** Las opciones que el intérprete puede elegir: los botones, o las filas de una lista numerada. */
function optionsOf(step: FlowStep, vars: Record<string, string>): { id: string; title: string }[] {
  if (step.type === 'choice') return step.buttons.map((b) => ({ id: b.id, title: b.title }));
  if (step.type === 'pick') {
    return (vars[step.from] ?? '').split('\n').filter(Boolean)
      .map((line, i) => ({ id: String(i + 1), title: line.replace(/^\d+\.\s*/, '') }));
  }
  return [];
}

function questionOf(step: FlowStep, vars: Record<string, string>): string {
  const text = 'text' in step && typeof step.text === 'string' ? step.text : '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (k === (step as { from?: string }).from ? '' : vars[k] ?? ''));
}
