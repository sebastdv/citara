import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { GoogleAuthError } from '../../src/google/google.client';
import { CalendarHealthProcessor } from '../../src/google/calendar-health.processor';
import { resetDb, seedChannel, seedCatalog, seedContact, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string, accountId: string;
let google: Record<'calendarExists' | 'createCalendar', ReturnType<typeof vi.fn>>;
let tokens: { withToken: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> };
let health: CalendarHealthProcessor;

const AHORA = new Date('2026-09-08T12:00:00Z');
const run = () => health.process({ tenantId, accountId }, AHORA);
const appointment = async (status: string, startsAt: string) => (await adminQuery(
  `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, google_sync_status)
   VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '30 minutes', $6) RETURNING id`,
  [tenantId, resourceId, serviceId, contactId, startsAt, status]))[0].id as string;
const status = async (id: string) =>
  (await adminQuery(`SELECT google_sync_status AS s FROM appointments WHERE id = $1`, [id]))[0].s;

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  contactId = await seedContact(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  google = { calendarExists: vi.fn().mockResolvedValue(true), createCalendar: vi.fn().mockResolvedValue('citas-nuevo@group') };
  tokens = { withToken: vi.fn((_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba')), invalidate: vi.fn() };
  health = new CalendarHealthProcessor(app, tokens as never, google as never);
});

describe('CalendarHealthProcessor', () => {
  it('una cuenta sana: renueva el token, deja constancia y reintenta lo fallido futuro', async () => {
    const futura = await appointment('failed', '2026-09-20T15:00:00Z');
    const vieja = await appointment('failed', '2026-09-01T15:00:00Z');

    expect(await run()).toBe('ok');

    expect(tokens.invalidate).toHaveBeenCalledWith(accountId);
    expect([await status(futura), await status(vieja)]).toEqual(['pending', 'failed']);
    const [acc] = await adminQuery(`SELECT last_checked_at FROM google_accounts`);
    expect(new Date(acc.last_checked_at).toISOString()).toBe(AHORA.toISOString());
  });

  it('un acceso revocado deja la cuenta para reconectar', async () => {
    tokens.withToken.mockRejectedValue(new GoogleAuthError('renovación del token: Google respondió invalid_grant'));
    expect(await run()).toBe('needs_reauth');
    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
  });

  it('si el dueño borró el calendario "Citas", se recrea y lo futuro vuelve a subir', async () => {
    google.calendarExists.mockResolvedValue(false);
    const futura = await appointment('synced', '2026-09-20T15:00:00Z');

    expect(await run()).toBe('recreated');

    expect(google.createCalendar).toHaveBeenCalledWith('ya29.prueba', 'Citas · María', 'America/Bogota');
    expect(await adminQuery(`SELECT calendar_id FROM google_accounts`)).toEqual([{ calendar_id: 'citas-nuevo@group' }]);
    expect(await status(futura)).toBe('pending');
    expect((await adminQuery(`SELECT action FROM audit_log`)).map((a: { action: string }) => a.action))
      .toContain('calendar.created');
  });

  it('una cuenta sin calendario (lo detectó una subida) también lo recrea', async () => {
    await adminQuery(`UPDATE google_accounts SET calendar_id = NULL`);
    expect(await run()).toBe('recreated');
    expect(google.calendarExists).not.toHaveBeenCalled();
  });
});
