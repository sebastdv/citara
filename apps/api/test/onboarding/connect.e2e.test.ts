import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import { createDataSource } from '@citara/db';
import { AppModule } from '../../src/app.module';
import { MetaOnboardingClient, MetaOnboardingError } from '../../src/onboarding/meta-onboarding.client';
import { createLink } from '../../src/onboarding/links';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

let app: INestApplication;
let admin: DataSource;
let token: string;
const meta = {
  exchangeCode: vi.fn(), phoneNumbers: vi.fn(), subscribeApp: vi.fn(), requestSync: vi.fn(),
};
const http = () => request(app.getHttpServer());
const body = (over: Record<string, unknown> = {}) =>
  ({ t: token, code: 'CODIGO', waba_id: '777', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', ...over });

beforeAll(async () => {
  process.env.META_APP_ID = '1234567890';
  process.env.META_ES_CONFIG_ID = 'CONFIG-987';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaOnboardingClient).useValue(meta).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
});
afterAll(async () => { await app.close(); await admin.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  const [t] = await adminQuery(
    `INSERT INTO tenants (slug, name, status) VALUES ('nuevo', 'Peluquería <script>alert(1)</script>', 'onboarding') RETURNING id`);
  token = await createLink(admin, t.id, 'whatsapp');
  meta.exchangeCode.mockResolvedValue('EAAG');
  meta.phoneNumbers.mockResolvedValue([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]);
  meta.subscribeApp.mockResolvedValue(undefined);
  meta.requestSync.mockResolvedValue(undefined);
});

describe('GET /connect/whatsapp', () => {
  it('sirve la página con el Embedded Signup de coexistencia', async () => {
    const res = await http().get('/connect/whatsapp').query({ t: token }).expect(200);
    expect(res.text).toContain('CONFIG-987');
    expect(res.text).toContain('whatsapp_business_app_onboarding');
    expect(res.text).toContain('connect.facebook.net');
  });

  it('no se cachea ni envía el token a terceros', async () => {
    const res = await http().get('/connect/whatsapp').query({ t: token });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('escapa el nombre del negocio', async () => {
    const res = await http().get('/connect/whatsapp').query({ t: token });
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('un enlace inválido o ya usado responde 410', async () => {
    await http().get('/connect/whatsapp').query({ t: 'inventado' }).expect(410);
    await http().post('/connect/whatsapp/complete').send(body()).expect(200);
    await http().get('/connect/whatsapp').query({ t: token }).expect(410);
  });
});

describe('POST /connect/whatsapp/complete', () => {
  it('completa el alta y devuelve el número conectado', async () => {
    const res = await http().post('/connect/whatsapp/complete').send(body()).expect(200);
    expect(res.body).toEqual({ ok: true, numero: '+57 300 000 0000' });
    expect(await adminQuery(`SELECT mode FROM whatsapp_channels`)).toEqual([{ mode: 'coexistence' }]);
  });

  it('el doble clic registra un solo canal', async () => {
    const [a, b] = await Promise.all([
      http().post('/connect/whatsapp/complete').send(body()),
      http().post('/connect/whatsapp/complete').send(body()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect(await adminQuery(`SELECT id FROM whatsapp_channels`)).toHaveLength(1);
  });

  it('datos incompletos → 400; alta cancelada en Meta → 422', async () => {
    await http().post('/connect/whatsapp/complete').send({ t: token }).expect(400);
    await http().post('/connect/whatsapp/complete').send(body({ event: 'CANCEL' })).expect(422);
  });

  it('si Meta rechaza un paso → 502 con un mensaje para el cliente, sin el detalle de Meta', async () => {
    meta.exchangeCode.mockRejectedValueOnce(new MetaOnboardingError('canje del código: Meta respondió 400 — detalle', 400));
    const res = await http().post('/connect/whatsapp/complete').send(body()).expect(502);
    expect(res.body.message).toMatch(/Intenta de nuevo/);
    expect(JSON.stringify(res.body)).not.toContain('detalle');
  });

  it('un fallo inesperado → 500 sin filtrar su mensaje', async () => {
    meta.exchangeCode.mockRejectedValueOnce(new Error('detalle interno con EAAG'));
    const res = await http().post('/connect/whatsapp/complete').send(body()).expect(500);
    expect(JSON.stringify(res.body)).not.toContain('EAAG');
  });
});
