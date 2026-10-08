import { Inject, Injectable } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { LLM, type LlmParams, type LlmProvider } from './llm';
import { recordRun } from './runs';

export type Interpretation = { action: 'option'; optionId: string } | { action: 'agent' } | { action: 'none' };
export interface InterpretInput {
  tenantId: string; conversationId: string; turnId: string; model: string; configVersion: number;
  question: string; options: { id: string; title: string }[]; text: string;
}

const SYSTEM = `Clasificas la respuesta de un cliente a un menú de WhatsApp de un negocio que agenda citas.
- Si la respuesta elige una de las opciones, aunque la escriba con otras palabras ("el segundo", "la de las 3", "quiero agendar"), responde action "option" con su id exacto.
- Si pide o pregunta algo sobre citas o el negocio que el menú no cubre (una fecha concreta, un precio, una duda), responde action "agent".
- Si no se entiende o no tiene que ver con el negocio, responde action "none".
option_id va vacío cuando action no es "option".`;

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['option', 'agent', 'none'] },
    option_id: { type: 'string' },
  },
  required: ['action', 'option_id'],
  additionalProperties: false,
};

/** Spec §1: lo que no encaja en un menú lo interpreta un modelo barato antes de repetir el menú. */
@Injectable()
export class InterpreterService {
  constructor(private readonly ds: DataSource, @Inject(LLM) private readonly llm: LlmProvider) {}

  async interpret(i: InterpretInput): Promise<Interpretation> {
    const started = Date.now();
    const record = (res: { model?: string; usage?: never; stop_reason?: string } | null, error: string | null) =>
      recordRun(this.ds, { tenantId: i.tenantId, conversationId: i.conversationId, inboundMessageId: i.turnId,
        kind: 'interpret', model: res?.model ?? i.model, priceModel: i.model, configVersion: i.configVersion,
        usage: res?.usage ?? null,
        latencyMs: Date.now() - started, tools: [], stopReason: res?.stop_reason ?? null, error });
    let res;
    try {
      res = await this.llm.create({
        model: i.model, max_tokens: 256,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content:
          `Pregunta del menú: ${i.question}\nOpciones:\n${i.options.map((o) => `- ${o.id}: ${o.title}`).join('\n')}\n\nRespuesta del cliente: ${i.text}` }],
      } as unknown as LlmParams);
    } catch (err) {
      await record(null, (err as Error).message);
      return { action: 'none' };
    }
    await record(res as never, null);
    if (res.stop_reason === 'refusal') return { action: 'none' };
    try {
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const out = JSON.parse(text) as { action: string; option_id: string };
      if (out.action === 'option' && i.options.some((o) => o.id === out.option_id)) {
        return { action: 'option', optionId: out.option_id };
      }
      return out.action === 'agent' ? { action: 'agent' } : { action: 'none' };
    } catch {
      return { action: 'none' };
    }
  }
}
