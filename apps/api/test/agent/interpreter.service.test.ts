import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import type { LlmMessage, LlmParams, LlmProvider } from '../../src/agent/llm';
import { InterpreterService } from '../../src/agent/interpreter.service';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;
const OPTIONS = [{ id: 'agendar', title: 'Agendar cita' }, { id: 'mis_citas', title: 'Mis citas' }];
const answer = (json: object | string, stop = 'end_turn') => ({
  id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: stop,
  content: [{ type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }],
  usage: { input_tokens: 300, output_tokens: 20 } }) as unknown as LlmMessage;
const llm = (res: LlmMessage | Error) => {
  const calls: LlmParams[] = [];
  const p: LlmProvider = { async create(params) { calls.push(params); if (res instanceof Error) throw res; return res; } };
  return { p, calls };
};
const interpret = (provider: LlmProvider, text = 'quiero ver mis citas porfa') =>
  new InterpreterService(app, provider).interpret({ tenantId, conversationId: null as never, turnId: null as never,
    model: 'claude-haiku-5-5', configVersion: 1, question: '¿Qué necesitas?', options: OPTIONS, text });

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('InterpreterService', () => {
  it('traduce lo que escribió a una opción del menú, con Haiku, sin pensamiento y con salida estructurada', async () => {
    const { p, calls } = llm(answer({ action: 'option', option_id: 'mis_citas' }));
    expect(await interpret(p)).toEqual({ action: 'option', optionId: 'mis_citas' });
    const params = calls[0] as unknown as Record<string, any>;
    expect(params).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 256, thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(JSON.stringify(params.messages)).toContain('mis_citas: Mis citas');
    const [run] = await adminQuery(`SELECT kind, usd FROM agent_runs`);
    expect(run.kind).toBe('interpret');
    expect(Number(run.usd)).toBeCloseTo((300 * 0.1 + 20 * 0.5) / 1e6, 12);
  });

  it('un pedido que el menú no cubre va al agente', async () => {
    const { p } = llm(answer({ action: 'agent', option_id: '' }));
    expect(await interpret(p, '¿tienen cita el jueves en la tarde?')).toEqual({ action: 'agent' });
  });

  it('una opción inventada, JSON roto, un rechazo o un error valen "nada"', async () => {
    expect(await interpret(llm(answer({ action: 'option', option_id: 'borrar_todo' })).p)).toEqual({ action: 'none' });
    expect(await interpret(llm(answer('esto no es json')).p)).toEqual({ action: 'none' });
    expect(await interpret(llm(answer({ action: 'agent', option_id: '' }, 'refusal')).p)).toEqual({ action: 'none' });
    expect(await interpret(llm(new Error('overloaded')).p)).toEqual({ action: 'none' });
    expect((await adminQuery(`SELECT error FROM agent_runs WHERE error IS NOT NULL`))).toEqual([{ error: 'overloaded' }]);
  });
});
