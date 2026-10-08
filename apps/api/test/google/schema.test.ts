import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { appointmentIdFromEventId, googleEventId } from '../../src/google/event-id';
import { createLink, peekLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource;
let tenantId: string, resourceId: string;

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
});

describe('id de evento', () => {
  it('es el uuid en hex sin guiones, válido para Google (base32hex, 5-1024)', () => {
    expect(googleEventId(UUID)).toBe('3f2504e04f8941d39a0c0305e82c3301');
    expect(googleEventId(UUID.toUpperCase())).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it('se puede volver del id de evento a la cita, y lo ajeno no es nuestro', () => {
    expect(appointmentIdFromEventId(googleEventId(UUID))).toBe(UUID);
    expect(appointmentIdFromEventId('7kvq2h0s1d2o9c3jtn4u0tqk1c')).toBeNull();
    expect(appointmentIdFromEventId('3f2504e04f8941d39a0c0305e82c3301_20261010T150000Z')).toBeNull();
  });

  it('rechaza algo que no sea un uuid', () => {
    expect(() => googleEventId('no-es-uuid')).toThrow(/uuid/i);
  });
});

describe('google_accounts', () => {
  it('un recurso tiene a lo sumo una cuenta de Google', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    await expect(seedGoogleAccount(tenantId, resourceId)).rejects.toThrow(/duplicate|unique/i);
  });

  it('la app puede leer y actualizar su cuenta, pero no borrarla', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const rows = await runInTenant(app, tenantId, (m) => m.query(`SELECT status FROM google_accounts`));
    expect(rows).toEqual([{ status: 'active' }]);
    await expect(runInTenant(app, tenantId, (m) => m.query(`DELETE FROM google_accounts`)))
      .rejects.toThrow(/permission denied/);
  });

  it('el estado de una cuenta solo puede ser active o needs_reauth', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    await expect(adminQuery(`UPDATE google_accounts SET status = 'rota'`)).rejects.toThrow(/check/i);
  });
});

describe('enlaces de Google', () => {
  it('un enlace de Google exige el recurso y trae su nombre', async () => {
    await expect(createLink(admin, tenantId, 'google')).rejects.toThrow(/check/i);
    const token = await createLink(admin, tenantId, 'google', { resourceId });
    expect(await peekLink(app, token, 'google')).toMatchObject({ tenantId, resourceId, resourceName: 'María' });
  });

  it('consume_google_link devuelve el recurso una sola vez', async () => {
    await createLink(admin, tenantId, 'google', { resourceId });
    const [link] = await adminQuery(`SELECT id FROM onboarding_links`);
    const consume = () => runInTenant(app, tenantId, (m) => m.query(`SELECT consume_google_link($1) AS r`, [link.id]));
    expect((await consume())[0].r).toBe(resourceId);
    await expect(consume()).rejects.toMatchObject({ driverError: { code: 'CT410' } });
  });

  it('consume_google_link no sirve desde el contexto de otro negocio', async () => {
    await createLink(admin, tenantId, 'google', { resourceId });
    const [link] = await adminQuery(`SELECT id FROM onboarding_links`);
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    await expect(runInTenant(app, otro.id, (m) => m.query(`SELECT consume_google_link($1)`, [link.id])))
      .rejects.toMatchObject({ driverError: { code: 'CT410' } });
  });

  it('consume_google_link busca pg_temp al final', async () => {
    const [row] = await adminQuery(`SELECT proconfig FROM pg_proc WHERE proname = 'consume_google_link'`);
    expect(row.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
  });
});

describe('sincronización de citas', () => {
  it('google_sync_status solo admite pending, synced o failed', async () => {
    const [{ def }] = await adminQuery(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'appointments_google_sync_status_check'`);
    expect(def).toMatch(/pending.*synced.*failed/);
  });
});
