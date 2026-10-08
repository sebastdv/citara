import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import { createDataSource } from '@citara/db';
import { AppModule } from '../../src/app.module';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { GoogleApiError, GoogleClient } from '../../src/google/google.client';
import { createLink, peekLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedContact, adminQuery, closeHelpers } from '../helpers';

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created',
                'https://www.googleapis.com/auth/calendar.freebusy'];

let app: INestApplication, admin: DataSource, enc: EncryptionService;
let tenantId: string, resourceId: string, token: string;
const google = {
  authUrl: vi.fn((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  exchangeCode: vi.fn(), calendarExists: vi.fn(), createCalendar: vi.fn(), refreshAccessToken: vi.fn(),
};
const http = () => request(app.getHttpServer());
const callback = (q: Record<string, string> = {}) =>
  http().get('/connect/google/callback').query({ state: token, code: 'CODIGO', ...q });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleClient).useValue(google).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();
});
afterAll(async () => { await app.close(); await admin.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  await adminQuery(`UPDATE resources SET name = 'María <b>'`);
  token = await createLink(admin, tenantId, 'google', { resourceId });
  google.exchangeCode.mockResolvedValue({ accessToken: 'ya29.a', expiresIn: 3599, refreshToken: '1//refresh',
                                          scopes: SCOPES, email: 'maria@gmail.com' });
  google.calendarExists.mockResolvedValue(false);
  google.createCalendar.mockResolvedValue('citas-nuevo@group.calendar.google.com');
});

describe('GET /connect/google', () => {
  it('sirve la página con el botón hacia Google, escapada y sin caché ni Referer', async () => {
    const res = await http().get('/connect/google').query({ t: token }).expect(200);
    expect(res.text).toContain('https://accounts.google.com/o/oauth2/v2/auth?state=');
    expect(res.text).toContain('María &lt;b&gt;');
    expect(res.text).not.toContain('María <b>');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('un enlace inválido responde 410', async () => {
    await http().get('/connect/google').query({ t: 'inventado' }).expect(410);
  });
});

describe('GET /connect/google/callback', () => {
  it('guarda la cuenta con el token cifrado, crea el calendario "Citas" y sube lo ya agendado', async () => {
    const contactId = await seedContact(tenantId);
    const [{ id: futura }] = await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
       SELECT $1, $2, s.id, $3, now() + interval '2 days', now() + interval '2 days 30 minutes'
         FROM services s RETURNING id`, [tenantId, resourceId, contactId]);

    const res = await callback().expect(200);

    expect(res.text).toContain('quedó conectado');
    const [acc] = await adminQuery(`SELECT email, calendar_id, status, refresh_token_encrypted FROM google_accounts`);
    expect(acc).toMatchObject({ email: 'maria@gmail.com', calendar_id: 'citas-nuevo@group.calendar.google.com', status: 'active' });
    expect(enc.decrypt(acc.refresh_token_encrypted)).toBe('1//refresh');
    expect(google.createCalendar).toHaveBeenCalledWith('ya29.a', 'Citas · María <b>', 'America/Bogota');
    const [cita] = await adminQuery(`SELECT google_sync_status, google_sync_version FROM appointments WHERE id = $1`, [futura]);
    expect(cita).toEqual({ google_sync_status: 'pending', google_sync_version: 1 });
    const actions = (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['calendar.connected', 'calendar.created']);
  });

  it('el enlace se usa una sola vez', async () => {
    await callback().expect(200);
    await callback().expect(410);
    expect(await adminQuery(`SELECT id FROM google_accounts`)).toHaveLength(1);
  });

  it('si desmarcó un permiso de calendario: error claro, nada guardado y el enlace sigue sirviendo', async () => {
    google.exchangeCode.mockResolvedValue({ accessToken: 'ya29.a', expiresIn: 3599, refreshToken: '1//r',
                                            scopes: ['openid', 'email'], email: null });
    const res = await callback().expect(422);
    expect(res.text).toContain('marca todas las casillas');
    expect(await adminQuery(`SELECT id FROM google_accounts`)).toEqual([]);
    expect(await peekLink(admin, token, 'google')).not.toBeNull();
  });

  it('si canceló en Google, la página lo dice y el enlace sigue sirviendo', async () => {
    const res = await http().get('/connect/google/callback').query({ state: token, error: 'access_denied' }).expect(200);
    expect(res.text).toContain('No se conectó');
    expect(await peekLink(admin, token, 'google')).not.toBeNull();
  });

  it('si Google falla, 502 sin el detalle de Google', async () => {
    google.exchangeCode.mockRejectedValue(new GoogleApiError('canje del código: Google respondió 400 — invalid_request', 400));
    const res = await callback().expect(502);
    expect(res.text).not.toContain('invalid_request');
  });

  it('al reconectar con la misma cuenta, reutiliza su calendario', async () => {
    await callback().expect(200);
    await adminQuery(`UPDATE google_accounts SET status = 'needs_reauth'`);
    token = await createLink(admin, tenantId, 'google', { resourceId });
    google.calendarExists.mockResolvedValue(true);
    google.createCalendar.mockClear();

    await callback().expect(200);

    expect(google.createCalendar).not.toHaveBeenCalled();
    expect(await adminQuery(`SELECT status, calendar_id FROM google_accounts`))
      .toEqual([{ status: 'active', calendar_id: 'citas-nuevo@group.calendar.google.com' }]);
  });

  it('si crear el calendario falla, la conexión queda y el calendario se crea después', async () => {
    google.createCalendar.mockRejectedValue(new GoogleApiError('creación del calendario: Google respondió 503', 503));
    await callback().expect(200);
    expect(await adminQuery(`SELECT status, calendar_id FROM google_accounts`)).toEqual([{ status: 'active', calendar_id: null }]);
  });
});
