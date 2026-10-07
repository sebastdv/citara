import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { DEMO_FLOW } from '../../src/cli/provision';
import { resetDb, seedCatalog, seedHours, seedFlow, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;

const register = (phone = '106999', tenant = tenantId, token = Buffer.from('cifrado')) =>
  runInTenant(app, tenant, (m) => m.query(
    `SELECT register_channel($1, '777', $2, '+57 300 000 0000', $3, 'coexistence') AS id`, [tenant, phone, token]));
const refresh = () => runInTenant(app, tenantId, (m) => m.query(`SELECT refresh_tenant_status($1) AS status`, [tenantId]));

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  const [t] = await adminQuery(
    `INSERT INTO tenants (slug, name, status) VALUES ('nuevo', 'Peluquería Nueva', 'onboarding') RETURNING id`);
  tenantId = t.id;
});

describe('register_channel', () => {
  it('la app registra un canal en coexistencia con el historial pendiente', async () => {
    const [{ id }] = await register();
    const [ch] = await adminQuery(`SELECT id, mode, history_sync, status, tenant_id FROM whatsapp_channels`);
    expect(ch).toMatchObject({ id, mode: 'coexistence', history_sync: 'pending', status: 'active', tenant_id: tenantId });
  });

  it('repetirlo para el mismo negocio rota el token sin duplicar', async () => {
    await register();
    await register('106999', tenantId, Buffer.from('otro'));
    const rows = await adminQuery(`SELECT access_token_encrypted FROM whatsapp_channels`);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].access_token_encrypted).toString()).toBe('otro');
  });

  it('se niega a pasarle a un negocio el número de otro', async () => {
    await register();
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    await expect(register('106999', otro.id)).rejects.toThrow(/otro negocio/);
  });
});

describe('refresh_tenant_status', () => {
  it('un negocio en alta sin agenda completa sigue en alta', async () => {
    await register();
    expect((await refresh())[0].status).toBe('onboarding');
  });

  it('con canal, servicio, horario y flujo pasa a activo', async () => {
    await register();
    await seedCatalog(tenantId);
    await seedHours(tenantId);
    await seedFlow(tenantId, DEMO_FLOW);
    expect((await refresh())[0].status).toBe('active');
  });

  it('nunca reactiva un negocio suspendido', async () => {
    await register(); await seedCatalog(tenantId); await seedHours(tenantId); await seedFlow(tenantId, DEMO_FLOW);
    await adminQuery(`UPDATE tenants SET status = 'suspended'`);
    expect((await refresh())[0].status).toBe('suspended');
  });
});
