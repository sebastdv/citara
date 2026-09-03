import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDataSource } from '../src/data-source';
import type { DataSource } from 'typeorm';

let ds: DataSource;

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await ds.initialize();
  await ds.runMigrations();
});

afterAll(async () => { await ds.destroy(); });

describe('migraciones', () => {
  it('crea la tabla tenants', async () => {
    const rows = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'tenants' ORDER BY column_name`,
    );
    const cols = rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'slug', 'name', 'timezone', 'status', 'created_at']),
    );
  });

  it('crea el rol citara_app sin privilegio de saltar RLS', async () => {
    const [role] = await ds.query(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'citara_app'`,
    );
    expect(role).toBeDefined();
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolsuper).toBe(false);
  });
});
