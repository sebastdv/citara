import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import type { LlmMessage, LlmParams, LlmProvider } from '../../src/agent/llm';
import { AgentService, APOLOGY, HANDOFF, type AgentSegment } from '../../src/agent/agent.service';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, adminQuery, closeHelpers,
         buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, contactId: string, conversationId: string, serviceId: string, resourceId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const TURNO_1 = '11111111-1111-4111-8111-111111111111', TURNO_2 = '22222222-2222-4222-8222-222222222222';
const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const reply = (content: object[], stop = 'end_turn') =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, usage }) as unknown as LlmMessage;

/** Proveedor guionado: cada llamada recibe los params (para leer tokens de resultados previos). */
class ScriptedLlm implements LlmProvider {
  calls: LlmParams[] = [];
  constructor(private readonly steps: ((p: LlmParams) => LlmMessage | Error)[]) {}
  async create(p: LlmParams) {
    this.calls.push(structuredClone(p));
    const step = this.steps.shift();
    if (!step) throw new Error('el guion se acabó');
    const r = step(p);
    if (r instanceof Error) throw r;
    return r;
  }
}
const lastToolResult = (p: LlmParams) => {
  for (const msg of [...p.messages].reverse()) {
    if (Array.isArray(msg.content)) {
      const r = (msg.content as { type: string; content?: string }[]).find((b) => b.type === 'tool_result');
      if (r) return JSON.parse(r.content!);
    }
  }
  return null;
};

const segment = (): AgentSegment => ({ system: 'SYSTEM', model: 'claude-opus-5-5', effort: 'low', configVersion: 1, transcript: [] });
const respond = (llm: LlmProvider, texts: string[], seg = segment(), turnId = TURNO_1) =>
  new AgentService(app, llm, buildScheduling(app).tools).respond({
    tenantId, conversationId, contactId, turnId, now: AHORA, timezone: 'America/Bogota', segment: seg, texts });
const agendar = (extra: object = {}) => ({ servicio_id: serviceId, recurso_id: resourceId,
  inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana', ...extra });

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  let channelId: string;
  ({ tenantId, channelId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [tenantId, contactId, channelId]);
  conversationId = c.id;
});

describe('AgentService', () => {
  it('responde con el texto final, guarda el turno en la transcripción y registra el costo', async () => {
    const llm = new ScriptedLlm([() => reply([text('¡Hola! ¿En qué te ayudo?')])]);
    const r = await respond(llm, ['Hola']);

    expect(r).toMatchObject({ replies: ['¡Hola! ¿En qué te ayudo?'], action: 'continue', degraded: false });
    expect(r.transcript.map((m) => m.role)).toEqual(['user', 'assistant']);
    const [run] = await adminQuery(`SELECT kind, model, usd, inbound_message_id FROM agent_runs`);
    expect(run).toMatchObject({ kind: 'agent', model: 'claude-opus-5-5', inbound_message_id: TURNO_1 });
    expect(Number(run.usd)).toBeCloseTo(0.008, 9);
  });

  it('manda el system con caché, las herramientas, el effort del segmento y la fecha en el turno del usuario', async () => {
    const llm = new ScriptedLlm([() => reply([text('ok')])]);
    await respond(llm, ['Hola']);
    const p = llm.calls[0] as unknown as Record<string, any>;
    expect(p.system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.cache_control).toEqual({ type: 'ephemeral' });
    expect(p.tools.map((t: { name: string }) => t.name)).toContain('agendar_cita');
    expect(JSON.stringify(p.messages[0].content)).toMatch(/Ahora: martes 8 de septiembre/);
  });

  it('ejecuta las herramientas y le devuelve sus resultados en un solo mensaje', async () => {
    const llm = new ScriptedLlm([
      () => reply([toolUse('t1', 'consultar_servicios', {}), toolUse('t2', 'consultar_mis_citas', {})], 'tool_use'),
      (p) => {
        const results = (p.messages.at(-1)!.content as { type: string; tool_use_id: string }[]);
        expect(results.map((b) => [b.type, b.tool_use_id])).toEqual([['tool_result', 't1'], ['tool_result', 't2']]);
        return reply([text('Tenemos corte de cabello.')]);
      },
    ]);
    expect((await respond(llm, ['¿Qué servicios tienen?'])).replies).toEqual(['Tenemos corte de cabello.']);
    expect(await adminQuery(`SELECT tools FROM agent_runs ORDER BY created_at`))
      .toEqual([{ tools: ['consultar_servicios', 'consultar_mis_citas'] }, { tools: [] }]);
  });

  it('agenda solo cuando la persona confirma en un turno posterior', async () => {
    // Turno 1: el modelo pide reservar, recibe el token y pregunta.
    const llm1 = new ScriptedLlm([
      () => reply([toolUse('t1', 'agendar_cita', agendar())], 'tool_use'),
      () => reply([text('¿Confirmo corte el jueves a las 10:00 a nombre de Ana?')]),
    ]);
    const r1 = await respond(llm1, ['Quiero un corte el jueves a las 10, soy Ana']);
    expect(await adminQuery(`SELECT id FROM appointments`)).toEqual([]);

    // Turno 2: con el "sí" y el token, reserva.
    const llm2 = new ScriptedLlm([
      (p) => reply([toolUse('t2', 'agendar_cita', agendar({ confirmation_token: lastToolResult(p).confirmationToken }))], 'tool_use'),
      () => reply([text('¡Listo!')]),
    ]);
    const r2 = await respond(llm2, ['Sí'], { ...segment(), transcript: r1.transcript }, TURNO_2);
    expect(r2.replies).toEqual(['¡Listo!']);
    expect(await adminQuery(`SELECT customer_name FROM appointments`)).toEqual([{ customer_name: 'Ana' }]);
  });

  it('usar el token en la misma respuesta que lo pidió no agenda', async () => {
    const llm = new ScriptedLlm([
      () => reply([toolUse('t1', 'agendar_cita', agendar())], 'tool_use'),
      (p) => reply([toolUse('t2', 'agendar_cita', agendar({ confirmation_token: lastToolResult(p).confirmationToken }))], 'tool_use'),
      (p) => { expect(lastToolResult(p)).toMatchObject({ ok: false }); return reply([text('¿Confirmas?')]); },
    ]);
    await respond(llm, ['Quiero un corte el jueves a las 10, soy Ana']);
    expect(await adminQuery(`SELECT id FROM appointments`)).toEqual([]);
  });

  it('pasar_a_humano y volver_al_menu cambian la acción del turno', async () => {
    const humano = new ScriptedLlm([
      () => reply([toolUse('t1', 'pasar_a_humano', { motivo: 'lo pidió' })], 'tool_use'),
      () => reply([text('Te comunico con alguien del equipo.')]),
    ]);
    expect(await respond(humano, ['quiero hablar con una persona'])).toMatchObject({ action: 'human' });
    const menu = new ScriptedLlm([
      () => reply([toolUse('t1', 'volver_al_menu', {})], 'tool_use'),
      () => reply([]),
    ]);
    expect(await respond(menu, ['mejor muéstrame el menú'])).toMatchObject({ action: 'menu', replies: [] });
  });

  it('si el modelo falla después de agendar, el cliente se entera de que su cita quedó hecha', async () => {
    const r1 = await respond(new ScriptedLlm([
      () => reply([toolUse('t1', 'agendar_cita', agendar())], 'tool_use'),
      () => reply([text('¿Confirmo?')]),
    ]), ['Quiero un corte el jueves a las 10, soy Ana']);
    const r2 = await respond(new ScriptedLlm([
      (p) => reply([toolUse('t2', 'agendar_cita', agendar({ confirmation_token: lastToolResult(p).confirmationToken }))], 'tool_use'),
      () => new Error('Request timed out'),
    ]), ['Sí'], { ...segment(), transcript: r1.transcript }, TURNO_2);
    expect(await adminQuery(`SELECT status FROM appointments`)).toEqual([{ status: 'confirmed' }]);
    expect(r2).toMatchObject({ degraded: true, action: 'human' });
    expect(r2.replies).toEqual([expect.stringMatching(/quedó agendada para el jueves 10 de septiembre/), APOLOGY]);
  });

  it('si el modelo falla después de cancelar, también lo dice', async () => {
    const [cita] = await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, customer_name)
       VALUES ($1, $2, $3, $4, '2026-09-10T15:00:00Z', '2026-09-10T15:30:00Z', 'Ana') RETURNING id`,
      [tenantId, resourceId, serviceId, contactId]);
    const r1 = await respond(new ScriptedLlm([
      () => reply([toolUse('t1', 'cancelar_cita', { cita_id: cita.id })], 'tool_use'),
      () => reply([text('¿La cancelo?')]),
    ]), ['cancela mi cita']);
    const r2 = await respond(new ScriptedLlm([
      (p) => reply([toolUse('t2', 'cancelar_cita', { cita_id: cita.id, confirmation_token: lastToolResult(p).confirmationToken })], 'tool_use'),
      () => reply([], 'refusal'),
    ]), ['sí'], { ...segment(), transcript: r1.transcript }, TURNO_2);
    expect(r2.replies).toEqual([expect.stringMatching(/jueves 10 de septiembre.*quedó cancelada/), APOLOGY]);
  });

  it('si agenda y luego pasa al menú o a humano sin escribir nada, el cliente igual se entera', async () => {
    const turnoConToken = async (control: string, final: object[]) => {
      await adminQuery(`DELETE FROM appointments`);
      const r1 = await respond(new ScriptedLlm([
        () => reply([toolUse('t1', 'agendar_cita', agendar())], 'tool_use'),
        () => reply([text('¿Confirmo?')]),
      ]), ['Quiero un corte el jueves a las 10, soy Ana']);
      return respond(new ScriptedLlm([
        (p) => reply([toolUse('t2', 'agendar_cita', agendar({ confirmation_token: lastToolResult(p).confirmationToken })),
                      toolUse('t3', control, control === 'pasar_a_humano' ? { motivo: 'x' } : {})], 'tool_use'),
        () => reply(final),
      ]), ['Sí'], { ...segment(), transcript: r1.transcript }, TURNO_2);
    };
    const menu = await turnoConToken('volver_al_menu', []);
    expect(menu).toMatchObject({ action: 'menu', degraded: false });
    expect(menu.replies).toEqual([expect.stringMatching(/quedó agendada/)]);
    expect(menu.effects).toEqual(menu.replies);
    const humano = await turnoConToken('pasar_a_humano', []);
    expect(humano.replies).toEqual([expect.stringMatching(/quedó agendada/), HANDOFF]);
    // Con texto final, el modelo ya lo dijo: no se repite, pero queda en effects para el worker.
    const conTexto = await turnoConToken('volver_al_menu', [text('¡Listo, Ana! Quedaste el jueves.')]);
    expect(conTexto.replies).toEqual(['¡Listo, Ana! Quedaste el jueves.']);
    expect(conTexto.effects).toEqual([expect.stringMatching(/quedó agendada/)]);
  });

  it('si ya pidió pasar a humano y después falla, el cliente lee el traspaso, no "tuve un problema"', async () => {
    const r = await respond(new ScriptedLlm([
      () => reply([text('Te paso con alguien del equipo.'), toolUse('t1', 'pasar_a_humano', { motivo: 'lo pidió' })], 'tool_use'),
      () => new Error('Request timed out'),
    ]), ['quiero hablar con una persona']);
    expect(r).toMatchObject({ action: 'human', degraded: true, replies: ['Te paso con alguien del equipo.'] });
  });

  it('el texto de una respuesta que mezcla herramientas de agenda y de control no se toma como mensaje', async () => {
    const r = await respond(new ScriptedLlm([
      () => reply([text('Déjame revisar tus citas.'), toolUse('t1', 'consultar_mis_citas', {}), toolUse('t2', 'volver_al_menu', {})], 'tool_use'),
      () => reply([]),
    ]), ['mis citas y luego el menú']);
    expect(r).toMatchObject({ action: 'menu', replies: [] });
  });

  it('el mismo efecto dos veces en un turno se avisa una sola vez', async () => {
    const [cita] = await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, customer_name)
       VALUES ($1, $2, $3, $4, '2026-09-10T15:00:00Z', '2026-09-10T15:30:00Z', 'Ana') RETURNING id`,
      [tenantId, resourceId, serviceId, contactId]);
    const args = { cita_id: cita.id, nuevo_inicio: '2026-09-10T11:00:00-05:00' };
    const r1 = await respond(new ScriptedLlm([
      () => reply([toolUse('t1', 'reprogramar_cita', args)], 'tool_use'),
      () => reply([text('¿La muevo a las 11?')]),
    ]), ['muévela a las 11']);
    const r2 = await respond(new ScriptedLlm([
      (p) => { const token = lastToolResult(p).confirmationToken;
               return reply([toolUse('t2', 'reprogramar_cita', { ...args, confirmation_token: token }),
                             toolUse('t3', 'reprogramar_cita', { ...args, confirmation_token: token })], 'tool_use'); },
      () => new Error('boom'),
    ]), ['sí'], { ...segment(), transcript: r1.transcript }, TURNO_2);
    expect(r2.replies).toEqual([expect.stringMatching(/quedó movida/), APOLOGY]);
  });

  it('pedir confirmación no es un efecto: si falla después, solo hay disculpa', async () => {
    const r = await respond(new ScriptedLlm([
      () => reply([toolUse('t1', 'agendar_cita', agendar())], 'tool_use'),
      () => new Error('boom'),
    ]), ['Quiero un corte el jueves a las 10, soy Ana']);
    expect(r.replies).toEqual([APOLOGY]);
  });

  it('el texto que acompaña a pasar_a_humano llega al cliente aunque la respuesta final venga vacía', async () => {
    const r = await respond(new ScriptedLlm([
      () => reply([text('Claro, te paso con alguien del equipo.'), toolUse('t1', 'pasar_a_humano', { motivo: 'lo pidió' })], 'tool_use'),
      () => reply([]),
    ]), ['quiero hablar con una persona']);
    expect(r).toMatchObject({ action: 'human', replies: ['Claro, te paso con alguien del equipo.'], degraded: false });
  });

  it('un traspaso sin ningún texto avisa con la frase fija: el cliente no queda en silencio', async () => {
    const r = await respond(new ScriptedLlm([
      () => reply([toolUse('t1', 'pasar_a_humano', { motivo: 'lo pidió' })], 'tool_use'),
      () => reply([]),
    ]), ['quiero hablar con una persona']);
    expect(r).toMatchObject({ action: 'human', replies: [HANDOFF] });
  });

  it('si el proveedor falla, pide disculpas, pasa a un humano y no toca la transcripción', async () => {
    const llm = new ScriptedLlm([() => new Error('Request timed out')]);
    const r = await respond(llm, ['Hola']);
    expect(r).toEqual({ replies: [APOLOGY], action: 'human', transcript: [], degraded: true, effects: [] });
    expect(await adminQuery(`SELECT usd, error FROM agent_runs`)).toEqual([{ usd: '0.000000', error: 'Request timed out' }]);
  });

  it('un rechazo, o el tope de llamadas, también degradan', async () => {
    expect(await respond(new ScriptedLlm([() => reply([], 'refusal')]), ['x'])).toMatchObject({ degraded: true });
    const loop = new ScriptedLlm(Array.from({ length: 6 }, (_, i) =>
      () => reply([toolUse(`t${i}`, 'consultar_servicios', {})], 'tool_use')));
    expect(await respond(loop, ['x'])).toMatchObject({ degraded: true, action: 'human' });
  });

  it('una respuesta cortada con un tool_use pendiente degrada sin guardar un tool_use huérfano', async () => {
    const llm = new ScriptedLlm([() => reply([text('Déjame revisar...'), toolUse('t1', 'consultar_servicios', {})], 'max_tokens')]);
    const r = await respond(llm, ['Hola']);
    expect(r).toMatchObject({ degraded: true, action: 'human', transcript: [] });
  });
});
