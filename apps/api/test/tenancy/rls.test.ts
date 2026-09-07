import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource, Contact } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';

let admin: DataSource;
let app: DataSource;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await admin.initialize();
  await admin.runMigrations();

  const [a] = await admin.query(
    `INSERT INTO tenants (slug, name) VALUES ('a', 'A') RETURNING id`);
  const [b] = await admin.query(
    `INSERT INTO tenants (slug, name) VALUES ('b', 'B') RETURNING id`);
  tenantA = a.id; tenantB = b.id;

  await admin.query(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1,'573001','Ana')`, [tenantA]);
  await admin.query(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1,'573002','Beto')`, [tenantB]);

  app = createDataSource(process.env.DATABASE_URL!);
  await app.initialize();
});

afterAll(async () => {
  await admin.query(`DELETE FROM contacts`);
  await admin.query(`DELETE FROM tenants`);
  await admin.destroy();
  await app.destroy();
});

describe('aislamiento por RLS', () => {
  it('dentro del contexto de A solo se ven los contactos de A', async () => {
    const rows = await runInTenant(app, tenantA, (m) => m.find(Contact));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Ana');
  });

  it('dentro del contexto de B solo se ven los contactos de B', async () => {
    const rows = await runInTenant(app, tenantB, (m) => m.find(Contact));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Beto');
  });

  it('SIN contexto de tenant devuelve cero filas — falla cerrado', async () => {
    const rows = await app.getRepository(Contact).find();
    expect(rows).toHaveLength(0);
  });

  it('el contexto no se filtra entre transacciones consecutivas', async () => {
    await runInTenant(app, tenantA, (m) => m.find(Contact));
    const rows = await app.getRepository(Contact).find();
    expect(rows).toHaveLength(0);
  });

  it('la tabla raíz tenants no tiene RLS', async () => {
    const [row] = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tenants'`);
    expect(row.relrowsecurity).toBe(false);
    expect(row.relforcerowsecurity).toBe(false);
  });
});
