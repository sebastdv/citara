import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource } from 'typeorm';
import { setRolePassword } from '../../src/cli/app-role';

// Un rol desechable: citara_app es del clúster entero y los demás tests entran con su clave de desarrollo.
const ROLE = 'citara_role_test';
let admin: DataSource;
const urlFor = (password: string) => {
  const u = new URL(process.env.DATABASE_URL!);
  u.username = ROLE; u.password = password;
  return u.toString();
};
const canLogin = async (password: string) => {
  const ds = createDataSource(urlFor(password));
  try { await ds.initialize(); await ds.query('SELECT 1'); return true; } catch { return false; } finally { if (ds.isInitialized) await ds.destroy(); }
};

beforeAll(async () => {
  admin = await createDataSource(process.env.DATABASE_ADMIN_URL!).initialize();
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'vieja'`);
});
afterAll(async () => { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); await admin.destroy(); });

describe('setRolePassword', () => {
  it('cambia la clave del rol: la nueva entra y la vieja ya no', async () => {
    const pw = `n'ueva"-${'x'.repeat(20)}`;   // comillas: se escapa como literal, no se interpola
    await setRolePassword(admin, ROLE, pw);
    expect(await canLogin(pw)).toBe(true);
    expect(await canLogin('vieja')).toBe(false);
  });
  it('rechaza una clave corta o la de desarrollo', async () => {
    await expect(setRolePassword(admin, ROLE, 'corta')).rejects.toThrow(/24 caracteres/);
    await expect(setRolePassword(admin, ROLE, ROLE)).rejects.toThrow(/24 caracteres|desarrollo/);
  });
  it('un rol inexistente es un error, no un no-op', async () => {
    await expect(setRolePassword(admin, 'no_existe_rol', 'y'.repeat(30))).rejects.toThrow(/no existe/);
  });
});
