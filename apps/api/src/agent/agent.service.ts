import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { LLM, type LlmMessage, type LlmParams, type LlmProvider } from './llm';
import { AGENT_TOOLS, CONTROL_TOOLS } from './agent-tools';
import { userTurn } from './context';
import { recordRun } from './runs';
import { ToolRegistry } from '../scheduling/tools/registry';
import { runInTenant } from '../tenancy/tenant-context';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;

const MAX_LLM_CALLS = 6;
const MAX_TOKENS = 4096;

/** Spec §7.2: al usuario nunca se le deja en silencio. */
export const APOLOGY = 'Disculpa, tuve un problema para responderte. Te comunico con alguien del equipo.';
/** Un traspaso que el modelo pidió sin escribir nada: el cliente no puede quedar en silencio. */
export const HANDOFF = 'Te comunico con alguien del equipo; te responden por aquí.';

export interface AgentSegment { system: string; model: string; effort: string; configVersion: number; transcript: MessageParam[] }
export interface AgentTurnInput {
  tenantId: string; conversationId: string; contactId: string; turnId: string;
  now: Date; timezone: string; segment: AgentSegment; texts: string[]; recent?: string | null;
}
export interface AgentTurnResult {
  replies: string[]; action: 'continue' | 'menu' | 'human'; transcript: MessageParam[]; degraded: boolean;
  /** Lo que el turno hizo de verdad, dicho para el cliente (puede repetir algo de replies). */
  effects: string[];
}

/**
 * Un turno del agente: llama al modelo, ejecuta las herramientas y vuelve a
 * llamar hasta que responde. No toca la conversación ni el outbox: eso es del
 * worker, en su transacción de cierre. Cada herramienta corre en su propia
 * transacción corta: nunca hay un lock tomado mientras el modelo piensa.
 */
@Injectable()
export class AgentService {
  private readonly log = new Logger(AgentService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(LLM) private readonly llm: LlmProvider,
    private readonly tools: ToolRegistry,
  ) {}

  async respond(i: AgentTurnInput): Promise<AgentTurnResult> {
    // Append-only: lo previo va tal cual (caché y bloques de pensamiento), y se agrega el turno nuevo.
    const messages: MessageParam[] = [...i.segment.transcript, userTurn(i.now, i.timezone, i.texts, i.recent)];
    let action: AgentTurnResult['action'] = 'continue';
    // Lo que ya pasó de verdad en este turno (una cita agendada, movida o cancelada):
    // si el turno se degrada después, el cliente igual tiene que enterarse.
    const effects: string[] = [];
    // Lo que el modelo escribió junto a pasar_a_humano o volver_al_menu.
    const beside: string[] = [];

    for (let call = 0; call < MAX_LLM_CALLS; call++) {
      const started = Date.now();
      let res: LlmMessage;
      try {
        res = await this.llm.create({
          model: i.segment.model, max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: i.segment.system, cache_control: { type: 'ephemeral' } }],
          tools: AGENT_TOOLS, messages,
          output_config: { effort: i.segment.effort },
          // Caché automática para la cola de la conversación.
          cache_control: { type: 'ephemeral' },
        } as unknown as LlmParams);
      } catch (err) {
        await this.record(i, null, Date.now() - started, [], null, (err as Error).message);
        this.log.warn(`el modelo falló en la conversación ${i.conversationId}: ${(err as Error).message}`);
        return this.degrade(i, effects);
      }
      const uses = res.content.filter((b): b is ToolUse => b.type === 'tool_use');
      await this.record(i, res, Date.now() - started, uses.map((u) => u.name), res.stop_reason ?? null, null);
      if (res.stop_reason === 'refusal') return this.degrade(i, effects);
      // Un tool_use sin ejecutar (respuesta cortada por max_tokens u otro motivo) no
      // se puede guardar: el siguiente turno llevaría un tool_use sin su resultado (400).
      if (uses.length > 0 && res.stop_reason !== 'tool_use') return this.degrade(i, effects);
      messages.push({ role: 'assistant', content: res.content as MessageParam['content'] });

      if (res.stop_reason !== 'tool_use' || uses.length === 0) {
        const text = res.content
          .flatMap((b) => (b.type === 'text' && b.text.trim() ? [b.text.trim()] : [])).join('\n\n');
        if (!text && action === 'continue') return this.degrade(i, effects);
        // Sin nada escrito, lo hecho se dice igual. Junto al texto del modelo no: ya lo contó.
        const replies = text ? [text] : beside.length ? [beside.join('\n\n')]
          : [...effects, ...(action === 'human' ? [HANDOFF] : [])];
        return { replies, action, transcript: messages, degraded: false, effects };
      }

      if (uses.some((u) => u.name === CONTROL_TOOLS.human || u.name === CONTROL_TOOLS.menu)) {
        for (const b of res.content) if (b.type === 'text' && b.text.trim()) beside.push(b.text.trim());
      }
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        if (use.name === CONTROL_TOOLS.human || use.name === CONTROL_TOOLS.menu) {
          action = combine(action, use.name === CONTROL_TOOLS.human ? 'human' : 'menu');
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ ok: true }) });
          continue;
        }
        const out = await runInTenant(this.ds, i.tenantId, (m) => this.tools.run(use.name, use.input, {
          m, tenantId: i.tenantId, contactId: i.contactId, conversationId: i.conversationId,
          now: i.now, turnId: i.turnId, actor: 'agent' }));
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out),
                       ...(out.ok ? {} : { is_error: true }) });
        const effect = effectOf(use.name, out);
        if (effect) effects.push(effect);
      }
      messages.push({ role: 'user', content: results });
    }
    return this.degrade(i, effects);
  }

  /**
   * Disculpa y traspaso, precedidos de lo que el turno alcanzó a hacer. La
   * transcripción queda como estaba: el segmento termina con el traspaso.
   */
  private degrade(i: AgentTurnInput, effects: string[]): AgentTurnResult {
    return { replies: [...effects, APOLOGY], action: 'human', transcript: i.segment.transcript, degraded: true, effects };
  }

  private record(i: AgentTurnInput, res: LlmMessage | null, latencyMs: number, tools: string[],
                 stopReason: string | null, error: string | null) {
    return recordRun(this.ds, {
      tenantId: i.tenantId, conversationId: i.conversationId, inboundMessageId: i.turnId, kind: 'agent',
      // El modelo que respondió (con un fallback puede ser otro), o el pedido si falló.
      model: res?.model ?? i.segment.model, priceModel: i.segment.model, configVersion: i.segment.configVersion,
      usage: res?.usage ?? null, latencyMs, tools, stopReason, error,
    });
  }
}

/** Lo que una herramienta cambió de verdad, dicho para el cliente; null si no cambió nada (o pidió confirmación). */
function effectOf(tool: string, out: { ok: boolean; data?: unknown }): string | null {
  const data = out.data as { requiere_confirmacion?: boolean; etiqueta?: string } | undefined;
  if (!out.ok || !data || data.requiere_confirmacion) return null;
  switch (tool) {
    case 'agendar_cita': return `Tu cita quedó agendada para el ${data.etiqueta}.`;
    case 'reprogramar_cita': return `Tu cita quedó movida al ${data.etiqueta}.`;
    case 'cancelar_cita': return data.etiqueta ? `Tu cita del ${data.etiqueta} quedó cancelada.` : 'Tu cita quedó cancelada.';
    default: return null;
  }
}

/** Pasar a un humano gana sobre volver al menú si el modelo pidió las dos. */
function combine(current: AgentTurnResult['action'], next: 'menu' | 'human'): AgentTurnResult['action'] {
  return current === 'human' || next === 'human' ? 'human' : 'menu';
}
