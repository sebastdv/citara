import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { INestApplication } from '@nestjs/common';
import type { OutboundContent } from '@citara/shared';
import { AppModule } from '../../src/app.module';
import { MetaSender } from '../../src/whatsapp/sender';
import { startWorkers } from '../../src/queues/workers';
import { INBOUND_QUEUE } from '../../src/queues/inbound.queue';
import { OUTBOUND_QUEUE, OutboundQueue } from '../../src/queues/outbound.queue';
import { CLOCK } from '../../src/clock';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { RemindersService } from '../../src/scheduling/reminders.service';
import { SYNC_QUEUE } from '../../src/queues/sync.queue';
import { REMINDERS_QUEUE } from '../../src/queues/reminders.queue';
import { echoPayload, historyPayload } from '../whatsapp/fixtures/coexistence';
import { DEMO_FLOW } from '../../src/cli/provision';
import { resetDb, seedChannel, seedFlow, seedCatalog, seedHours, adminQuery, closeHelpers } from '../helpers';

/** Lunes 7 de septiembre, 22:00 en Bogotá: la primera franja libre es el martes 09:00. */
const AGENDA_NOW = new Date('2026-09-08T03:00:00Z');

/**
 * Punta a punta con TODO real menos Meta: webhook firmado → Redis → worker de
 * entrada → FlowRunner → Redis → worker de salida → MetaSender (falso).
 * El arnés de conversación usa una cola de mentira y por eso no vio que BullMQ
 * rechazaba el jobId de salida: el bot estaba mudo en producción con 108 tests
 * en verde. Este archivo existe para que esa costura no vuelva a quedar sin
 * probar.
 */

const SECRET = process.env.META_APP_SECRET!;
const SALUDO = '¡Hola! Soy el asistente de Citara 👋';
const MENU = '¿En qué te ayudo?';

let app: INestApplication;
let workers: { close: () => Promise<void> };
let queues: Queue[];
let sent: { to: string; body: string }[];
let failNext: (() => Error | null) | null;

/** MetaSender de mentira: registra en orden lo que "llegó" a WhatsApp. */
const fakeSender = {
  async send(_channel: unknown, to: string, content: OutboundContent) {
    const err = failNext?.() ?? null;
    if (err) throw err;
    sent.push({ to, body: 'body' in content ? content.body : `[plantilla ${content.name}]` });
    return { wamid: `wamid.out.${sent.length}.${Date.now()}` };
  },
};

const sign = (body: object) =>
  'sha256=' + createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

const webhook = (wamid: string, text: string, from = '573001112233') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: from }],
    messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)),
                 type: 'text', text: { body: text } }],
  } }] }],
});

const post = (body: object) =>
  request(app.getHttpServer()).post('/webhooks/whatsapp')
    .set('X-Hub-Signature-256', sign(body)).send(body).expect(200);

/** Espera a que ambas colas queden sin trabajo pendiente (ni reintentos). */
async function quiesce(timeoutMs = 15000) {
  const start = Date.now();
  // Un margen inicial: un job recién añadido puede no figurar aún como waiting.
  await new Promise((r) => setTimeout(r, 150));
  while (Date.now() - start < timeoutMs) {
    const counts = await Promise.all(queues.map((q) =>
      q.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children')));
    if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('las colas no se vaciaron a tiempo');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaSender).useValue(fakeSender)
    .overrideProvider(CLOCK).useValue({ now: () => AGENDA_NOW })
    .compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  queues = [INBOUND_QUEUE, OUTBOUND_QUEUE, SYNC_QUEUE, REMINDERS_QUEUE].map(
    (name) => new Queue(name, { connection: { url: process.env.REDIS_URL } }));
});

beforeEach(async () => {
  // Las colas son las reales y compartidas: se vacían para no heredar jobs de
  // otros archivos de test que encolan sin consumir.
  await workers?.close();
  for (const q of queues) await q.obliterate({ force: true });
  await resetDb();
  const { tenantId } = await seedChannel();
  await seedFlow(tenantId, DEMO_FLOW);
  sent = [];
  failNext = null;
  workers = startWorkers(app, { concurrency: 10, scheduleReminders: false });
});

afterAll(async () => {
  await workers?.close();
  for (const q of queues) { await q.obliterate({ force: true }); await q.close(); }
  await app.close();
  await closeHelpers();
});

describe('pipeline real webhook → worker → Meta', () => {
  it('el usuario recibe saludo y menú, en ese orden', async () => {
    await post(webhook('wamid.E2E1', 'Hola'));
    await quiesce();

    expect(sent.map((s) => s.body)).toEqual([SALUDO, MENU]);
    expect(sent.every((s) => s.to === '573001112233')).toBe(true);
    const out = await adminQuery(
      `SELECT status FROM messages WHERE direction = 'out' ORDER BY seq`);
    expect(out.map((r: { status: string }) => r.status)).toEqual(['sent', 'sent']);
  });

  it('la reentrega del mismo webhook no produce una segunda respuesta', async () => {
    // Aquí la reentrega la frena BullMQ (mismo jobId = wamid del job ya
    // completado). El camino en que el job SÍ se re-ejecuta y FlowRunner ve el
    // entrante como duplicado lo cubre flow-runner.test.ts.
    await post(webhook('wamid.E2E2', 'Hola'));
    await quiesce();
    await post(webhook('wamid.E2E2', 'Hola'));
    await quiesce();

    expect(sent.map((s) => s.body)).toEqual([SALUDO, MENU]);
  });

  it('un fallo transitorio de Meta se reintenta sin duplicar ni desordenar', async () => {
    let calls = 0;
    // El primer envío (el saludo) falla una vez, como un 5xx de Graph.
    failNext = () => (calls++ === 0 ? new Error('Graph 503') : null);

    await post(webhook('wamid.E2E3', 'Hola'));
    await quiesce();

    expect(sent.map((s) => s.body)).toEqual([SALUDO, MENU]);
  });

  it('dos mensajes simultáneos de un contacto nuevo no repiten el saludo', async () => {
    // Llegan casi a la vez y el worker procesa en paralelo.
    // AVISO: este test NO detecta la carrera de forma fiable. Se verificó
    // quitando la transacción única y el lock por conversación, y siguió en
    // verde: los dos jobs casi nunca llegan a solaparse. Lo que serializa es el
    // lock de la fila de `conversations` (garantía de Postgres), y lo que evita
    // el silencio tras un fallo lo prueba de forma determinista
    // flow-runner.test.ts. Se conserva como humo del camino concurrente.
    await Promise.all([
      post(webhook('wamid.E2E4a', 'Hola')),
      post(webhook('wamid.E2E4b', 'Buenas')),
    ]);
    await quiesce();

    // Un saludo, y ninguno de los dos mensajes sin respuesta: el primero abre
    // el flujo (saludo + menú) y el segundo, que no es una opción, repite el
    // menú. El orden ENTRE turnos no está garantizado (cada turno es su job),
    // por eso se compara sin orden.
    expect(sent.map((s) => s.body).sort()).toEqual([SALUDO, MENU, MENU].sort());
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM conversation_sessions`);
    expect(n).toBe(1);
    const [{ turnos }] = await adminQuery(
      `SELECT count(DISTINCT reply_to_id)::int AS turnos FROM messages WHERE direction = 'out'`);
    expect(turnos).toBe(2);
  });
});

describe('pipeline real con coexistencia', () => {
  it('después de que el dueño contesta desde el celular, el bot no le habla encima', async () => {
    // Un minuto antes: Meta trae segundos, y empatar con el mensaje del cliente
    // dejaría el orden por occurred_at al azar.
    await post(echoPayload({ wamid: 'wamid.PE1', to: '573001112233', text: 'Hola Ana, ya te atiendo',
                             at: new Date(Date.now() - 60_000) }));
    await quiesce();
    await post(webhook('wamid.PE2', '¿A qué hora puedo ir?'));
    await quiesce();

    expect(sent).toEqual([]);
    const rows = await adminQuery(`SELECT origin FROM messages ORDER BY occurred_at`);
    expect(rows.map((r: { origin: string }) => r.origin)).toEqual(['phone', 'customer']);
  });

  it('cuando vence el plazo del dueño, el bot vuelve a atender', async () => {
    await post(echoPayload({ wamid: 'wamid.PV1', to: '573001112233' }));
    await quiesce();
    await adminQuery(`UPDATE conversations SET human_until = now() - interval '1 minute'`);
    await post(webhook('wamid.PV2', 'Hola'));
    await quiesce();

    expect(sent.map((s) => s.body)).toEqual([SALUDO, MENU]);
  });

  it('al conectar, una conversación donde el dueño estuvo activo queda en sus manos', async () => {
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
    await post(historyPayload({ customer: '573001112233', lines: [
      { wamid: 'wamid.PH1', fromCustomer: true, text: '¿Me guardas el jueves?', at: ago(2) },
      { wamid: 'wamid.PH2', fromCustomer: false, text: 'Claro, a las 4', at: ago(1) },
    ] }));
    await quiesce();
    await post(webhook('wamid.PH3', 'Perfecto, gracias'));
    await quiesce();

    expect(sent).toEqual([]);
  });
});

describe('pipeline real de agenda', () => {
  it('un cliente agenda por WhatsApp y recibe el recordatorio por plantilla', async () => {
    const [t] = await adminQuery(`SELECT id FROM tenants`);
    await seedCatalog(t.id);
    await seedHours(t.id);
    await adminQuery(`UPDATE flows SET is_default = false`);
    await seedFlow(t.id, AGENDA_FLOW);

    let n = 0;
    for (const text of ['Hola', 'agendar', '1', '1', 'Ana']) {
      await post(webhook(`wamid.AG${n++}`, text));
      await quiesce();
    }
    expect(sent.at(-1)!.body).toMatch(/^¡Listo, Ana! Tu cita quedó para el martes/);
    const [cita] = await adminQuery(`SELECT starts_at FROM appointments`);
    expect(new Date(cita.starts_at).toISOString()).toBe('2026-09-08T14:00:00.000Z');

    // El recordatorio de 2 h (12:00Z). El de 24 h ya había pasado al agendar.
    const queue = app.get(OutboundQueue);
    for (const { job, delay } of await app.get(RemindersService).sweep(new Date('2026-09-08T12:01:00Z'))) {
      await queue.add(job, { delay });
    }
    await quiesce();
    expect(sent.at(-1)!.body).toBe('[plantilla recordatorio_cita_2h]');
  });
});
