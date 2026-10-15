import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { attachNewCalendar, loadAccount, markCalendarMissing, markNeedsReauth } from '../../src/google/accounts';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, resourceId: string, accountId: string;

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  accountId = await seedGoogleAccount(tenantId, resourceId);
});

describe('cuentas de Google', () => {
  it('carga la cuenta con el nombre del recurso y la zona del negocio', async () => {
    const a = await runInTenant(app, tenantId, (m) => loadAccount(m, accountId));
    expect(a).toMatchObject({ id: accountId, tenantId, resourceId, resourceName: 'María', timezone: 'America/Bogota',
                              calendarId: 'citas123@group.calendar.google.com', status: 'active' });
    expect(Buffer.isBuffer(a!.refreshTokenEncrypted)).toBe(true);
  });

  it('marcar que hay que reconectar se audita una sola vez', async () => {
    const [{ refresh_token_encrypted: refreshTokenEncrypted }] =
      await adminQuery(`SELECT refresh_token_encrypted FROM google_accounts`);
    const ref = { id: accountId, tenantId, resourceId, refreshTokenEncrypted };
    expect(await runInTenant(app, tenantId, (m) => markNeedsReauth(m, ref, 'invalid_grant'))).toBe(true);
    expect(await runInTenant(app, tenantId, (m) => markNeedsReauth(m, ref, 'invalid_grant'))).toBe(false);
    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
    const audits = await adminQuery(`SELECT actor, action FROM audit_log`);
    expect(audits).toEqual([{ actor: 'google', action: 'calendar.needs_reauth' }]);
  });

  it('si guardar el calendario recién creado falla, lo borra en Google: no deja calendarios huérfanos', async () => {
    const google = { createCalendar: vi.fn().mockResolvedValue('huerfano@group.calendar.google.com'),
                     deleteCalendar: vi.fn().mockResolvedValue(undefined) };
    await adminQuery(`CREATE FUNCTION audit_boom() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await adminQuery(`CREATE TRIGGER audit_boom BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_boom()`);
    try {
      await expect(attachNewCalendar(app, google as never, 'ya29', {
        id: accountId, tenantId, resourceId, resourceName: 'María', timezone: 'America/Bogota' })).rejects.toThrow(/boom/);
    } finally {
      await adminQuery(`DROP TRIGGER audit_boom ON audit_log`);
      await adminQuery(`DROP FUNCTION audit_boom()`);
    }
    expect(google.deleteCalendar).toHaveBeenCalledWith('ya29', 'huerfano@group.calendar.google.com');
    expect(await adminQuery(`SELECT calendar_id FROM google_accounts`))
      .toEqual([{ calendar_id: 'citas123@group.calendar.google.com' }]);
  });

  it('un calendario borrado deja la cuenta sin calendario y lo audita', async () => {
    await runInTenant(app, tenantId, (m) => markCalendarMissing(m,
      { id: accountId, tenantId, resourceId, calendarId: 'citas123@group.calendar.google.com' }));
    expect(await adminQuery(`SELECT calendar_id, sync_token FROM google_accounts`)).toEqual([{ calendar_id: null, sync_token: null }]);
    expect((await adminQuery(`SELECT action FROM audit_log`))[0].action).toBe('calendar.missing');
  });
});
