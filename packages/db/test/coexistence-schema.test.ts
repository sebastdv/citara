import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/data-source';

let ds: DataSource;

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await ds.initialize();
  await ds.runMigrations();
});
afterAll(async () => { await ds.destroy(); });

const columns = async (table: string) => {
  const rows: { column_name: string; column_default: string | null; is_nullable: string }[] =
    await ds.query(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return Object.fromEntries(rows.map((r) => [r.column_name, r]));
};

describe('esquema de coexistencia', () => {
  it('una conversación nace abierta y en manos del bot, sin assigned_to', async () => {
    const c = await columns('conversations');
    expect(c.status.column_default).toContain("'open'");
    expect(c.control.column_default).toContain("'bot'");
    expect(c.human_until).toBeDefined();
    expect(c.control_reason).toBeDefined();
    expect(c.assigned_to).toBeUndefined();
  });

  it('todo mensaje declara quién lo escribió y cuándo ocurrió', async () => {
    const c = await columns('messages');
    // Sin default a propósito: un INSERT que olvide el origen debe fallar.
    expect(c.origin.is_nullable).toBe('NO');
    expect(c.origin.column_default).toBeNull();
    expect(c.occurred_at.is_nullable).toBe('NO');
    expect(c.occurred_at.column_default).toContain('clock_timestamp');
  });

  it('un canal nace como cloud_api sin historial que sincronizar', async () => {
    const c = await columns('whatsapp_channels');
    expect(c.mode.column_default).toContain("'cloud_api'");
    expect(c.history_sync.column_default).toContain("'not_applicable'");
  });

  it('un negocio trae 12 horas de plazo humano por defecto', async () => {
    const c = await columns('tenants');
    expect(c.human_takeover_hours.column_default).toBe('12');
  });

  it('los contactos pueden guardar el nombre del celular del negocio', async () => {
    const c = await columns('contacts');
    expect(c.saved_name.is_nullable).toBe('YES');
  });

  it('rechaza un origin desconocido', async () => {
    const [con] = await ds.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'messages_origin_check'`);
    for (const o of ['customer', 'bot', 'phone', 'operator', 'history']) expect(con.def).toContain(`'${o}'`);
  });
});
