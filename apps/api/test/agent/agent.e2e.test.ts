import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { INestApplication } from '@nestjs/common';
import type { OutboundContent } from '@citara/shared';
import { AppModule } from '../../src/app.module';
import { MetaSender } from '../../src/whatsapp/sender';
import { LLM, type LlmMessage, type LlmParams } from '../../src/agent/llm';
import { APOLOGY } from '../../src/agent/agent.service';
import { startWorkers } from '../../src/queues/workers';
import { INBOUND_QUEUE } from '../../src/queues/inbound.queue';
import { OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';
import { AGENT_QUEUE } from '../../src/queues/agent.queue';
import { CLOCK } from '../../src/clock';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { echoPayload } from '../whatsapp/fixtures/coexistence';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow, seedAgentConfig, adminQuery, closeHelpers } from '../helpers';

/**
 * El agente de punta a punta, con todo real menos Meta y el modelo: webhook →
 * FlowRunner deriva → cola `agent` → AgentProcessor → herramientas reales →
 * outbox → envío. El modelo es un guion que responde según lo que recibe.
 */
const AGENDA_NOW = new Date('2026-09-08T03:00:00Z');   // lunes 22:00 en Bogotá

let app: INestApplication, workers: { close: () => Promise<void> }, queues: Queue[];
let sent: string[];
let opus: ((p: LlmParams) => LlmMessage | Promise<LlmMessage>)[];
let haiku: LlmMessage | null;
let opusCalls: LlmParams[];
let serviceId: string, resourceId: string;

const usage = { input_tokens: 500, output_tokens: 100 };
const msg = (content: object[], stop = 'end_turn', model = 'claude-opus-5-5') =>
  ({ id: 'm', type: 'message', role: 'assistant', model, content, stop_reason: stop, usage }) as unknown as LlmMessage;
const text = (t: string) => ({ type: 'text', text: t });
const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const fakeLlm = {
  async create(p: LlmParams) {
    if (p.model === 'claude-haiku-5-5') {
      if (!haiku) throw new Error('sin respuesta de haiku');
      return haiku;
    }
    opusCalls.push(structuredClone(p));
    const step = opus.shift();
    if (!step) throw new Error('el guion de opus se acabó');
    return step(p);
  },
};
const lastToolResult = (p: LlmParams) => {
  for (const m of [...p.messages].reverse()) {
    const r = Array.isArray(m.content) && (m.content as { type: string; content?: string }[]).find((b) => b.type === 'tool_result');
    if (r) return JSON.parse(r.content!);
  }
  return null;
};
const fakeSender = {
  async send(_c: unknown, _to: string, c: OutboundContent) { sent.push('body' in c ? c.body : c.name); return { wamid: `w.${sent.length}` }; },
  async markTyping() {},
};
const sign = (b: object) => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(JSON.stringify(b)).digest('hex');
let n = 0;
const say = (t: string) => {
  const b = { object: 'whatsapp_business_account', entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: `wamid.E${n++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: t } }],
  } }] }] };
  return request(app.getHttpServer()).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(b)).send(b).expect(200);
};
const post = (b: object) => request(app.getHttpServer()).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(b)).send(b).expect(200);
async function quiesce() {
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 200; i++) {
    const c = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
    if (c.every((x) => Object.values(x).every((k) => k === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('las colas no se vaciaron');
}
const booking = (extra: object = {}) => ({ servicio_id: serviceId, recurso_id: resourceId,
  inicio: '2026-09-08T10:00:00-05:00', nombre: 'Ana', ...extra });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaSender).useValue(fakeSender)
    .overrideProvider(LLM).useValue(fakeLlm)
    .overrideProvider(CLOCK).useValue({ now: () => AGENDA_NOW })
    .compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  queues = [INBOUND_QUEUE, OUTBOUND_QUEUE, AGENT_QUEUE].map((q) => new Queue(q, { connection: { url: process.env.REDIS_URL } }));
});
afterAll(async () => {
  await workers?.close();
  for (const q of queues) { await q.obliterate({ force: true }); await q.close(); }
  await app.close(); await closeHelpers();
});
beforeEach(async () => {
  await workers?.close();
  for (const q of queues) await q.obliterate({ force: true });
  await resetDb();
  const { tenantId } = await seedChannel();
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  await seedFlow(tenantId, AGENDA_FLOW);
  await seedAgentConfig(tenantId);
  sent = []; opus = []; opusCalls = []; haiku = null;
  workers = startWorkers(app, { concurrency: 5, scheduleReminders: false, scheduleCalendar: false });
});

describe('el agente de punta a punta', () => {
  it('agenda conversando, con la confirmación en el siguiente mensaje', async () => {
    opus.push(
      () => msg([use('t1', 'agendar_cita', booking())], 'tool_use'),
      () => msg([text('¿Confirmo un corte mañana martes a las 10:00 a nombre de Ana?')]),
    );
    await say('Quiero un corte mañana a las 10, soy Ana');
    await quiesce();
    expect(sent).toEqual(['¿Confirmo un corte mañana martes a las 10:00 a nombre de Ana?']);
    expect(await adminQuery(`SELECT id FROM appointments`)).toEqual([]);

    opus.push(
      (p) => msg([use('t2', 'agendar_cita', booking({ confirmation_token: lastToolResult(p).confirmationToken }))], 'tool_use'),
      () => msg([text('¡Listo, Ana! Te esperamos.')]),
    );
    await say('Sí');
    await quiesce();
    expect(sent.at(-1)).toBe('¡Listo, Ana! Te esperamos.');
    expect(await adminQuery(`SELECT customer_name FROM appointments`)).toEqual([{ customer_name: 'Ana' }]);
    // El segundo turno reenvía la transcripción del primero tal cual (append-only).
    expect(JSON.stringify(opusCalls[2].messages.slice(0, 3))).toBe(JSON.stringify(opusCalls[1].messages.slice(0, 3)));
  });

  it('tres mensajes seguidos mientras el agente piensa reciben una sola respuesta que los tiene en cuenta', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    opus.push(async () => { await gate; return msg([text('Uno')]); }, () => msg([text('Dos')]));
    await say('Hola, quiero un corte');
    await new Promise((r) => setTimeout(r, 300));   // el primer job ya tomó el lease
    await say('mañana');
    await say('a las 10');
    release();
    await quiesce();
    // El primer job vio solo el primer mensaje; el segundo job juntó los otros dos; el tercero no tuvo nada.
    // Son dos turnos y el orden ENTRE turnos no está garantizado (ver pipeline.e2e).
    expect([...sent].sort()).toEqual(['Dos', 'Uno']);
    expect(opusCalls).toHaveLength(2);
    expect(JSON.stringify(opusCalls[1].messages.at(-1))).toMatch(/mañana\\na las 10/);
  });

  it('si el dueño contesta desde el celular mientras el agente piensa, la respuesta del bot no sale', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    opus.push(async () => { await gate; return msg([text('respuesta tardía')]); });
    await say('Hola, ¿cuánto cuesta el corte?');
    await new Promise((r) => setTimeout(r, 300));
    await post(echoPayload({ wamid: 'wamid.DUENO', to: '573001112233', text: 'Hola Ana, son 35 mil' }));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await quiesce();
    expect(sent).toEqual([]);
    expect(await adminQuery(`SELECT status FROM messages WHERE origin = 'bot'`)).toEqual([{ status: 'superseded' }]);
  });

  it('si el dueño contestó mientras el agente pensaba, el traspaso del agente no pisa su control', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    opus.push(
      async () => { await gate; return msg([use('t1', 'pasar_a_humano', { motivo: 'lo pidió' })], 'tool_use'); },
      () => msg([text('Te comunico con alguien del equipo.')]),
    );
    await say('Quiero hablar con una persona');
    await new Promise((r) => setTimeout(r, 300));
    await post(echoPayload({ wamid: 'wamid.DUENO2', to: '573001112233', text: 'Hola, aquí estoy' }));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await quiesce();
    expect(sent).toEqual([]);
    expect(await adminQuery(`SELECT control, control_reason FROM conversations`))
      .toEqual([{ control: 'human', control_reason: 'phone' }]);
  });

  it('si el modelo falla, el cliente recibe la disculpa y la conversación pasa a un humano', async () => {
    opus.push(() => { throw new Error('overloaded'); });
    await say('Hola, quiero un corte');
    await quiesce();
    expect(sent).toEqual([APOLOGY]);
    expect(await adminQuery(`SELECT control, control_reason FROM conversations`))
      .toEqual([{ control: 'human', control_reason: 'flow_handoff' }]);
  });

  it('en el menú, lo que no encaja lo interpreta Haiku y el flujo sigue por la opción', async () => {
    await say('Hola');
    await quiesce();
    haiku = msg([text(JSON.stringify({ action: 'option', option_id: 'mis_citas' }))], 'end_turn', 'claude-haiku-5-5');
    await say('quiero ver mis citas porfa');
    await quiesce();
    expect(sent.at(-1)).toBe('No tienes citas próximas.');
  });

  it('cambiar la configuración a mitad de una conversación no la afecta: el segmento sigue con lo congelado', async () => {
    opus.push(() => msg([text('¿Qué servicio buscas?')]));
    await say('Hola, quiero agendar algo');
    await quiesce();
    await adminQuery(`UPDATE agent_configs SET is_active = false`);
    await adminQuery(
      `INSERT INTO agent_configs (tenant_id, version, model, effort, interpreter_model, monthly_budget_usd, config_hash, is_active)
       SELECT tenant_id, 2, 'claude-sonnet-5-5', 'high', 'claude-haiku-5-5', 20, repeat('1', 64), true FROM agent_configs`);
    opus.push(() => msg([text('Perfecto.')]));
    await say('un corte');
    await quiesce();
    expect(opusCalls.map((c) => [c.model, (c as unknown as { output_config: { effort: string } }).output_config.effort]))
      .toEqual([['claude-opus-5-5', 'low'], ['claude-opus-5-5', 'low']]);
    expect(JSON.stringify(opusCalls[1].system)).toBe(JSON.stringify(opusCalls[0].system));
  });

  it('volver_al_menu termina el segmento y muestra el menú', async () => {
    opus.push(
      () => msg([use('t1', 'volver_al_menu', {})], 'tool_use'),
      () => msg([text('Claro, te dejo el menú.')]),
    );
    await say('Hola, prefiero el menú');
    await quiesce();
    expect(sent).toEqual(['Claro, te dejo el menú.', '¿Qué necesitas?']);
    expect(await adminQuery(`SELECT step_key, agent_transcript FROM conversation_sessions`))
      .toEqual([{ step_key: 'menu', agent_transcript: null }]);
  });
});
