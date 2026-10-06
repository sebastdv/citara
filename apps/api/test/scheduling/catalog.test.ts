import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { resetDb, seedChannel, seedCatalog, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('catálogo de agenda', () => {
  it('enlaza un servicio con el recurso que lo presta', async () => {
    const { serviceId, resourceId } = await seedCatalog(tenantId);

    const rows = await runInTenant(app, tenantId, (m) => m.query(
      `SELECT s.name AS servicio, s.duration_min, r.name AS recurso
         FROM resource_services rs
         JOIN services s ON s.id = rs.service_id
         JOIN resources r ON r.id = rs.resource_id
        WHERE rs.service_id = $1 AND rs.resource_id = $2`, [serviceId, resourceId]));

    expect(rows).toEqual([{ servicio: 'Corte de cabello', duration_min: 30, recurso: 'María' }]);
  });

  it('rechaza una duración de cero o negativa', async () => {
    await expect(adminQuery(
      `INSERT INTO services (tenant_id, key, name, duration_min) VALUES ($1, 'x', 'X', 0)`, [tenantId]))
      .rejects.toThrow(/check/i);
  });

  it('los servicios quedan aislados por negocio', async () => {
    await seedCatalog(tenantId);
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    const rows = await runInTenant(app, otro.id, (m) => m.query(`SELECT * FROM services`));
    expect(rows).toEqual([]);
  });

  it('la clave de un servicio es única dentro del negocio, no entre negocios', async () => {
    await seedCatalog(tenantId);
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    await expect(seedCatalog(otro.id)).resolves.toBeDefined();
    await expect(adminQuery(
      `INSERT INTO services (tenant_id, key, name, duration_min) VALUES ($1, 'corte', 'Otro', 20)`,
      [tenantId])).rejects.toThrow(/duplicate key/);
  });

  it('un negocio trae reglas de reserva por defecto', async () => {
    const [t] = await adminQuery(
      `SELECT min_lead_minutes, horizon_days, slot_granularity_minutes FROM tenants WHERE id = $1`, [tenantId]);
    expect(t).toEqual({ min_lead_minutes: 60, horizon_days: 60, slot_granularity_minutes: 15 });
  });
});
