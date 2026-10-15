import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { INestApplication } from '@nestjs/common';
import type { OutboundContent } from '@citara/shared';
import { AppModule } from '../../src/app.module';
import { MetaSender } from '../../src/whatsapp/sender';
import { LLM, type LlmMessage, type LlmParams } from '../../src/agent/llm';
import { startWorkers } from '../../src/queues/workers';
import { INBOUND_QUEUE } from '../../src/queues/inbound.queue';
import { OUTBOUND_QUEUE, OutboundQueue } from '../../src/queues/outbound.queue';
import { AGENT_QUEUE } from '../../src/queues/agent.queue';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow, seedAgentConfig, seedContact, adminQuery, closeHelpers } from '../helpers';
import { panelSession, csrfIn, envioIn } from './session';

/**
 * Las acciones del panel de punta a punta: formulario → outbox → cola
 * `outbound` → MetaSender falso, con los workers reales y el agente guionado.
 */
let app: INestApplication, workers: { close: () => Promise<void> }, queues: Queue[];
let s: Awaited<ReturnType<typeof panelSession>>;
let sent: string[], opus: ((p: LlmParams) => LlmMessage | Promise<LlmMessage>)[], opusCalls: number;
let tenantId: string, channelId: string;

const msg = (content: object[], stop = 'end_turn') => ({ id: 'm', type: 'message', role: 'assistant',
  model: 'claude-opus-5-5', content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as LlmMessage;
const fakeLlm = {
  async create(p: LlmParams) {
    opusCalls++;
    const step = opus.shift();
    if (!step) throw new Error('el guion se acabó');
    return step(p);
  },
};
const fakeSender = {
  async send(_c: unknown, _to: string, c: OutboundContent) { sent.push('body' in c ? c.body : c.name); return { wamid: `w.${randomUUID()}` }; },
  async markTyping() {},
};
const sign = (b: object) => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(JSON.stringify(b)).digest('hex');
let n = 0;
const say = (t: string) => {
  const b = { object: 'whatsapp_business_account', entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: `wamid.P${n++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: t } }],
  } }] }] };
  return request(app.getHttpServer()).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(b)).send(b).expect(200);
};
async function quiesce() {
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 200; i++) {
    const c = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
    if (c.every((x) => Object.values(x).every((k) => k === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('las colas no se vaciaron');
}
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!cond()) throw new Error('la condición no se cumplió');
}
/** Una conversación con un mensaje reciente del cliente (ventana abierta). */
async function seedConversation(): Promise<string> {
  const contactId = await seedContact(tenantId);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [tenantId, contactId, channelId]);
  return c.id;
}
const chat = (id: string) => `/panel/negocios/salon/conversaciones/${id}`;
const reply = async (id: string, texto: string) => {
  const page = await s.get(chat(id)).expect(200);
  return s.http().post(`${chat(id)}/responder`).set('Cookie', s.cookie).type('form')
    .send({ _csrf: csrfIn(page.text), texto, envio: envioIn(page.text) });
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaSender).useValue(fakeSender)
    .overrideProvider(LLM).useValue(fakeLlm)
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
  ({ tenantId, channelId } = await seedChannel());
  await seedCatalog(tenantId);
  await seedHours(tenantId);
  await seedFlow(tenantId, AGENDA_FLOW);
  sent = []; opus = []; opusCalls = 0;
  s = await panelSession(app);
  workers = startWorkers(app, { concurrency: 5, scheduleReminders: false, scheduleCalendar: false });
});

describe('acciones del panel de punta a punta', () => {
  it('el operador responde y sale por el outbox; lo que el bot tenía pendiente se descarta', async () => {
    const c = await seedConversation();
    const [inb] = await adminQuery(
      `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body) VALUES ($1, $2, 'in', 'customer', 'text', 'hola') RETURNING id`,
      [tenantId, c]);
    await adminQuery(
      `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload, status, reply_to_id, seq)
       VALUES ($1, $2, 'out', 'bot', 'text', 'te agendo', '{"kind":"text","body":"te agendo"}', 'pending', $3, 0)`,
      [tenantId, c, inb.id]);
    await reply(c, 'Hola, soy del equipo').then((r) => expect(r.status).toBe(303));
    await quiesce();
    expect(sent).toEqual(['Hola, soy del equipo']);
    // El turno del bot, si se reprocesa ahora, ve el control del operador y descarta su respuesta.
    await app.get(OutboundQueue).add({ tenantId, channelId, conversationId: c, to: '573001112233', turnId: inb.id });
    await quiesce();
    expect(sent).toEqual(['Hola, soy del equipo']);
    expect(await adminQuery(`SELECT origin, status FROM messages WHERE direction = 'out' ORDER BY origin`))
      .toEqual([{ origin: 'bot', status: 'superseded' }, { origin: 'operator', status: 'sent' }]);
  });

  it('si el agente está pensando cuando el operador toma el control, su respuesta no sale', async () => {
    await seedAgentConfig(tenantId);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    opus.push(async () => { await gate; return msg([{ type: 'text', text: 'Claro, te agendo el martes' }]); });
    await say('quiero una cita el martes en la tarde');
    await waitFor(() => opusCalls === 1);
    const [{ id }] = await adminQuery(`SELECT id FROM conversations`);
    const page = await s.get(chat(id)).expect(200);
    await s.http().post(`${chat(id)}/tomar`).set('Cookie', s.cookie).type('form').send({ _csrf: csrfIn(page.text) }).expect(303);
    release();
    await quiesce();
    expect(sent).toEqual([]);
    expect(await adminQuery(`SELECT status FROM messages WHERE origin = 'bot'`)).toEqual([{ status: 'superseded' }]);
  });

  it('un error al responder devuelve el chat con el aviso y el texto intacto', async () => {
    const c = await seedConversation();
    await adminQuery(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours'`);
    const res = await reply(c, 'mi borrador <b>');
    expect(res.status).toBe(422);
    expect(res.text).toContain('mi borrador &lt;b&gt;</textarea>');
    expect(res.text).toContain('últimas 24 h');
    expect(await adminQuery(`SELECT * FROM messages`)).toEqual([]);
  });

  it('el mismo envío dos veces A LA VEZ (doble clic) sale una sola vez', async () => {
    const c = await seedConversation();
    const page = await s.get(chat(c)).expect(200);
    const body = { _csrf: csrfIn(page.text), texto: 'doble clic', envio: envioIn(page.text) };
    const post = () => s.http().post(`${chat(c)}/responder`).set('Cookie', s.cookie).type('form').send(body);
    const [r1, r2] = await Promise.all([post(), post()]);
    expect([r1.status, r2.status]).toEqual([303, 303]);
    await quiesce();
    expect(sent).toEqual(['doble clic']);
    expect(await adminQuery(`SELECT count(*)::int AS n FROM messages WHERE origin = 'operator'`)).toEqual([{ n: 1 }]);
  });

  it('el mismo envío dos veces sale una sola vez', async () => {
    const c = await seedConversation();
    const page = await s.get(chat(c)).expect(200);
    const body = { _csrf: csrfIn(page.text), texto: 'una vez', envio: envioIn(page.text) };
    for (let i = 0; i < 2; i++) {
      await s.http().post(`${chat(c)}/responder`).set('Cookie', s.cookie).type('form').send(body).expect(303);
    }
    await quiesce();
    expect(sent).toEqual(['una vez']);
  });

  it('si encolar falla, la fila queda pending y reintentar la envía una sola vez', async () => {
    const c = await seedConversation();
    const spy = vi.spyOn(app.get(OutboundQueue), 'add').mockRejectedValueOnce(new Error('redis caído'));
    await reply(c, 'hola').then((r) => expect(r.status).toBe(303));
    await quiesce();
    expect(sent).toEqual([]);
    expect((await s.get(chat(c)).expect(200)).text).not.toContain('Hay mensajes tuyos sin enviar');
    await adminQuery(`UPDATE messages SET created_at = now() - interval '1 minute'`);
    const page = await s.get(chat(c)).expect(200);
    expect(page.text).toContain('Hay mensajes tuyos sin enviar');
    for (let i = 0; i < 2; i++) {
      await s.http().post(`${chat(c)}/reintentar`).set('Cookie', s.cookie).type('form')
        .send({ _csrf: csrfIn(page.text) }).expect(303);
    }
    await quiesce();
    expect(sent).toEqual(['hola']);
    spy.mockRestore();
  });

  it('tomar y devolver por el panel cambian quién habla', async () => {
    const c = await seedConversation();
    let page = await s.get(chat(c)).expect(200);
    await s.http().post(`${chat(c)}/tomar`).set('Cookie', s.cookie).type('form').send({ _csrf: csrfIn(page.text) }).expect(303);
    expect((await adminQuery(`SELECT control FROM conversations`))[0].control).toBe('human');
    page = await s.get(chat(c)).expect(200);
    expect(page.text).toContain('Devolver al bot');
    await s.http().post(`${chat(c)}/devolver`).set('Cookie', s.cookie).type('form').send({ _csrf: csrfIn(page.text) }).expect(303);
    expect((await adminQuery(`SELECT control FROM conversations`))[0].control).toBe('bot');
  });

  it('las acciones sobre una conversación de otro negocio dan 404 sin efectos', async () => {
    const c = await seedConversation();
    const [t] = await adminQuery(`INSERT INTO tenants (slug, name, status) VALUES ('otro', 'Otro', 'active') RETURNING id`);
    void t;
    const page = await s.get(chat(c)).expect(200);
    for (const action of ['tomar', 'devolver', 'responder', 'reintentar']) {
      await s.http().post(`/panel/negocios/otro/conversaciones/${c}/${action}`).set('Cookie', s.cookie).type('form')
        .send({ _csrf: csrfIn(page.text), texto: 'x', envio: randomUUID() }).expect(404);
    }
    expect(await adminQuery(`SELECT * FROM messages`)).toEqual([]);
    expect(await adminQuery(`SELECT * FROM audit_log`)).toEqual([]);
  });
});
