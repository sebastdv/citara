import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import type { OutboundContent } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { AppModule } from '../../src/app.module';
import { MetaSender } from '../../src/whatsapp/sender';
import { GoogleClient } from '../../src/google/google.client';
import { googleEventId } from '../../src/google/event-id';
import { CalendarSweep } from '../../src/google/calendar-sweep.service';
import { CALENDAR_QUEUE, CalendarQueue } from '../../src/queues/calendar.queue';
import { startWorkers } from '../../src/queues/workers';
import { INBOUND_QUEUE } from '../../src/queues/inbound.queue';
import { OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';
import { SYNC_QUEUE } from '../../src/queues/sync.queue';
import { REMINDERS_QUEUE } from '../../src/queues/reminders.queue';
import { CLOCK } from '../../src/clock';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { createLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow, adminQuery, closeHelpers } from '../helpers';

/**
 * Google Calendar de punta a punta, con todo real menos Meta y Google: el
 * recurso conecta su calendario, un cliente agenda por WhatsApp sin que se le
 * ofrezca lo ocupado en Google, la cita sube al calendario "Citas", y cuando
 * el dueño la borra allí, Citara la cancela.
 */
/** Lunes 7 de septiembre, 22:00 en Bogotá: la primera franja del martes es 09:00. */
const AGENDA_NOW = new Date('2026-09-08T03:00:00Z');
const CAL = 'citas-e2e@group.calendar.google.com';

let app: INestApplication, admin: DataSource, workers: { close: () => Promise<void> }, queues: Queue[];
const sent: string[] = [];
let changes: object[] = [];
const fakeSender = { async send(_c: unknown, _to: string, content: OutboundContent) {
  sent.push('body' in content ? content.body : `[plantilla ${content.name}]`); return { wamid: `wamid.g.${sent.length}` }; } };
const google = {
  authUrl: vi.fn((s: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${s}`),
  exchangeCode: vi.fn().mockResolvedValue({ accessToken: 'ya29.e2e', expiresIn: 3599, refreshToken: '1//e2e',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created',
             'https://www.googleapis.com/auth/calendar.freebusy'], email: 'maria@gmail.com' }),
  refreshAccessToken: vi.fn().mockResolvedValue({ accessToken: 'ya29.e2e', expiresIn: 3599 }),
  calendarExists: vi.fn().mockResolvedValue(true),
  createCalendar: vi.fn().mockResolvedValue(CAL),
  // María tiene algo personal el martes de 09:00 a 10:00 (Bogotá) en su calendario principal.
  freeBusy: vi.fn().mockResolvedValue([{ start: new Date('2026-09-08T14:00:00Z'), end: new Date('2026-09-08T15:00:00Z') }]),
  insertEvent: vi.fn().mockResolvedValue('created'),
  patchEvent: vi.fn(), deleteEvent: vi.fn(),
  listEvents: vi.fn(async () => ({ items: changes, nextPageToken: null, nextSyncToken: 'S1' })),
  watchEvents: vi.fn().mockResolvedValue({ resourceId: 'RID', expiration: new Date('2026-10-08T00:00:00Z') }),
  stopChannel: vi.fn(),
};

const sign = (b: object) => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(JSON.stringify(b)).digest('hex');
const say = (wamid: string, text: string) => {
  const b = { object: 'whatsapp_business_account', entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
  } }] }] };
  return request(app.getHttpServer()).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(b)).send(b).expect(200);
};
async function quiesce() {
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 150; i++) {
    const counts = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
    if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('las colas no se vaciaron');
}
const sweep = async () => {
  for (const j of await app.get(CalendarSweep).run(AGENDA_NOW)) await app.get(CalendarQueue).add(j);
  await quiesce();
};

beforeAll(async () => {
  process.env.PUBLIC_BASE_URL = 'https://citara.test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaSender).useValue(fakeSender)
    .overrideProvider(GoogleClient).useValue(google)
    .overrideProvider(CLOCK).useValue({ now: () => AGENDA_NOW })
    .compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  queues = [INBOUND_QUEUE, OUTBOUND_QUEUE, SYNC_QUEUE, REMINDERS_QUEUE, CALENDAR_QUEUE]
    .map((n) => new Queue(n, { connection: { url: process.env.REDIS_URL } }));
  for (const q of queues) await q.obliterate({ force: true });
  await resetDb();
  workers = startWorkers(app, { concurrency: 5, scheduleReminders: false, scheduleCalendar: false });
});
afterAll(async () => {
  await workers.close();
  for (const q of queues) { await q.obliterate({ force: true }); await q.close(); }
  await app.close(); await admin.destroy(); await closeHelpers();
  process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
});

describe('Google Calendar de punta a punta', () => {
  it('conectar → no ofrecer lo ocupado → subir la cita → borrarla en Google la cancela', async () => {
    const { tenantId } = await seedChannel();
    const { resourceId } = await seedCatalog(tenantId);
    await seedHours(tenantId);
    await seedFlow(tenantId, AGENDA_FLOW);

    // El recurso conecta su calendario desde el enlace.
    const token = await createLink(admin, tenantId, 'google', { resourceId });
    await request(app.getHttpServer()).get('/connect/google/callback').query({ state: token, code: 'CODIGO' }).expect(200);

    // Un cliente agenda por WhatsApp: el martes a las 09:00 está ocupado en Google.
    let n = 0;
    for (const text of ['Hola', 'agendar', '1', '1', '1', 'Ana']) { await say(`wamid.G${n++}`, text); await quiesce(); }
    const [cita] = await adminQuery(`SELECT id, starts_at FROM appointments`);
    expect(new Date(cita.starts_at).toISOString()).toBe('2026-09-08T15:00:00.000Z');   // 10:00

    // El barrido sube la cita y abre el canal de avisos.
    await sweep();
    expect(google.insertEvent).toHaveBeenCalledWith('ya29.e2e', CAL, googleEventId(cita.id), expect.any(Object));
    expect(await adminQuery(`SELECT google_sync_status FROM appointments`)).toEqual([{ google_sync_status: 'synced' }]);
    const [{ id: channelId, token: channelToken }] = google.watchEvents.mock.calls.at(-1)!.slice(2) as
      [{ id: string; token: string }];

    // El dueño la borra en Google y Google avisa.
    changes = [{ id: googleEventId(cita.id), status: 'cancelled' }];
    await request(app.getHttpServer()).post('/webhooks/google')
      .set({ 'X-Goog-Channel-ID': channelId, 'X-Goog-Channel-Token': channelToken, 'X-Goog-Resource-State': 'exists' })
      .send().expect(200);
    await quiesce();

    expect(await adminQuery(`SELECT status FROM appointments`)).toEqual([{ status: 'cancelled' }]);
    expect(await adminQuery(`SELECT DISTINCT status FROM reminders`)).toEqual([{ status: 'cancelled' }]);
  });
});
