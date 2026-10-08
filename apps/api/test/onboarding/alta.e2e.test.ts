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
import { MetaOnboardingClient } from '../../src/onboarding/meta-onboarding.client';
import { startWorkers } from '../../src/queues/workers';
import { INBOUND_QUEUE } from '../../src/queues/inbound.queue';
import { OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';
import { SYNC_QUEUE } from '../../src/queues/sync.queue';
import { REMINDERS_QUEUE } from '../../src/queues/reminders.queue';
import { CALENDAR_QUEUE } from '../../src/queues/calendar.queue';
import { createTenant } from '../../src/cli/tenants';
import { applyTenantConfig } from '../../src/cli/tenant-config';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

/**
 * El alta completa, con todo real menos Meta: el operador crea el negocio, el
 * cliente conecta su número por la página, el negocio guarda pero no responde
 * hasta cargar la agenda, y después atiende.
 */
let app: INestApplication, admin: DataSource, workers: { close: () => Promise<void> }, queues: Queue[];
const sent: string[] = [];
const fakeSender = { async send(_c: unknown, _to: string, content: OutboundContent) {
  sent.push('body' in content ? content.body : `[plantilla ${content.name}]`); return { wamid: `wamid.o.${sent.length}` }; } };
const meta = {
  exchangeCode: vi.fn().mockResolvedValue('EAAG-negocio'),
  phoneNumbers: vi.fn().mockResolvedValue([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]),
  subscribeApp: vi.fn().mockResolvedValue(undefined),
  requestSync: vi.fn().mockResolvedValue(undefined),
};

const sign = (b: object) => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(JSON.stringify(b)).digest('hex');
const hola = (wamid: string) => ({ object: 'whatsapp_business_account', entry: [{ id: '777', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '573000000000', phone_number_id: '106999' },
  contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
  messages: [{ from: '573001112233', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hola' } }],
} }] }] });
const post = (b: object) => request(app.getHttpServer()).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(b)).send(b).expect(200);
async function quiesce() {
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 150; i++) {
    const counts = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
    if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('las colas no se vaciaron');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaSender).useValue(fakeSender)
    .overrideProvider(MetaOnboardingClient).useValue(meta).compile();
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
});

describe('alta asistida de punta a punta', () => {
  it('crear → conectar → guardar sin responder → cargar agenda → atender', async () => {
    const { token } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });

    await request(app.getHttpServer()).get('/connect/whatsapp').query({ t: token }).expect(200);
    await request(app.getHttpServer()).post('/connect/whatsapp/complete')
      .send({ t: token, code: 'CODIGO', waba_id: '777', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' }).expect(200);

    // En alta: el mensaje se guarda y nadie le responde todavía.
    await post(hola('wamid.ALTA1'));
    await quiesce();
    expect(sent).toEqual([]);
    expect(await adminQuery(`SELECT origin FROM messages`)).toEqual([{ origin: 'customer' }]);

    const r = await applyTenantConfig(admin, {
      tenant: 'nuevo',
      services: [{ key: 'corte', name: 'Corte', duration_min: 30 }],
      resources: [{ key: 'maria', name: 'María', services: ['corte'] }],
      hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '06:00', end: '22:00' }],
      flow: 'agenda',
    });
    expect(r.status).toBe('active');

    await post(hola('wamid.ALTA2'));
    await quiesce();
    expect(sent[0]).toBe('¡Hola! Soy el asistente de citas 👋');
  });
});
