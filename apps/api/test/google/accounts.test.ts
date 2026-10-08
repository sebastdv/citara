import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { loadAccount, markCalendarMissing, markNeedsReauth } from '../../src/google/accounts';
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
    const ref = { id: accountId, tenantId, resourceId };
    expect(await runInTenant(app, tenantId, (m) => markNeedsReauth(m, ref, 'invalid_grant'))).toBe(true);
    expect(await runInTenant(app, tenantId, (m) => markNeedsReauth(m, ref, 'invalid_grant'))).toBe(false);
    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
    const audits = await adminQuery(`SELECT actor, action FROM audit_log`);
    expect(audits).toEqual([{ actor: 'google', action: 'calendar.needs_reauth' }]);
  });

  it('un calendario borrado deja la cuenta sin calendario y lo audita', async () => {
    await runInTenant(app, tenantId, (m) => markCalendarMissing(m,
      { id: accountId, tenantId, resourceId, calendarId: 'citas123@group.calendar.google.com' }));
    expect(await adminQuery(`SELECT calendar_id, sync_token FROM google_accounts`)).toEqual([{ calendar_id: null, sync_token: null }]);
    expect((await adminQuery(`SELECT action FROM audit_log`))[0].action).toBe('calendar.missing');
  });
});
