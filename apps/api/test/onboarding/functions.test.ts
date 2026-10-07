import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { DEMO_FLOW } from '../../src/cli/provision';
import { resetDb, seedCatalog, seedHours, seedFlow, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;

/** Un enlace vigente del negocio, como el que crea el operador (solo importa su id). */
const newLink = async (tenant = tenantId): Promise<string> => (await adminQuery(
  `INSERT INTO onboarding_links (tenant_id, purpose, token_hash, expires_at)
   VALUES ($1, 'whatsapp', md5(random()::text) || md5(random()::text), now() + interval '1 hour') RETURNING id`,
  [tenant]))[0].id;
const register = async (phone = '106999', tenant = tenantId, token = Buffer.from('cifrado'), link?: string) => {
  const linkId = link ?? await newLink(tenant);
  return runInTenant(app, tenant, (m) => m.query(
    `SELECT register_channel($1, '777', $2, '+57 300 000 0000', $3, 'coexistence') AS id`, [linkId, phone, token]));
};
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

describe('register_channel exige un enlace vigente', () => {
  it('sin un enlace vigente del negocio, la app no puede registrar ni reescribir un canal', async () => {
    const link = await newLink();
    await register('106999', tenantId, Buffer.from('original'), link);

    await expect(register('106999', tenantId, Buffer.from('basura'), '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/enlace/);
    await expect(register('106999', tenantId, Buffer.from('basura'), link)).rejects.toThrow(/enlace/);
    const [ch] = await adminQuery(`SELECT access_token_encrypted FROM whatsapp_channels`);
    expect(Buffer.from(ch.access_token_encrypted).toString()).toBe('original');
  });

  it('un enlace de otro negocio no sirve', async () => {
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    await expect(register('106999', tenantId, undefined, await newLink(otro.id))).rejects.toThrow(/enlace/);
  });

  it('de dos registros simultáneos con el mismo enlace, solo uno gana', async () => {
    const link = await newLink();
    const results = await Promise.allSettled([
      register('106999', tenantId, undefined, link), register('106999', tenantId, undefined, link)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const [{ used }] = await adminQuery(`SELECT used_at IS NOT NULL AS used FROM onboarding_links`);
    expect(used).toBe(true);
  });
});

describe('las funciones con privilegios de dueño no se pueden secuestrar', () => {
  it('el rol de la app no puede crear tablas temporales que tapen las reales', async () => {
    await expect(app.query(`CREATE TEMP TABLE whatsapp_channels (id int)`)).rejects.toThrow(/permission denied/);
  });

  it('las funciones buscan pg_temp al final', async () => {
    const rows = await adminQuery(
      `SELECT proconfig FROM pg_proc WHERE proname IN ('register_channel', 'refresh_tenant_status')`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
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
