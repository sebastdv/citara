import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource } from 'typeorm';
import { createOperator, setOperatorPassword, disableOperator } from '../../src/cli/operators';
import { verifyPassword } from '../../src/panel/password';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource;
beforeEach(async () => {
  await resetDb();
  admin ??= await createDataSource(process.env.DATABASE_ADMIN_URL!).initialize();
});
afterAll(async () => { await admin?.destroy(); await closeHelpers(); });

const sessionFor = (id: string) => adminQuery(
  `INSERT INTO operator_sessions (operator_id, token_hash, expires_at)
   VALUES ($1, decode(md5(random()::text), 'hex'), now() + interval '1 day')`, [id]);

describe('operadores por CLI', () => {
  it('crea el operador con la clave hasheada y normaliza el correo', async () => {
    const id = await createOperator(admin, '  Op@Citara.CO ', 'clave-de-prueba-123');
    const [o] = await adminQuery(`SELECT id, email, password_hash FROM operators`);
    expect(o).toMatchObject({ id, email: 'op@citara.co' });
    expect(await verifyPassword('clave-de-prueba-123', o.password_hash)).toBe(true);
  });
  it('rechaza claves cortas, correos inválidos y duplicados', async () => {
    await expect(createOperator(admin, 'op@citara.co', 'corta')).rejects.toThrow(/12 caracteres/);
    await expect(createOperator(admin, 'no-es-correo', 'clave-de-prueba-123')).rejects.toThrow(/correo/);
    await createOperator(admin, 'op@citara.co', 'clave-de-prueba-123');
    await expect(createOperator(admin, 'OP@citara.co', 'clave-de-prueba-123')).rejects.toThrow(/ya existe/);
  });
  it('cambiar la clave cierra todas sus sesiones', async () => {
    const id = await createOperator(admin, 'op@citara.co', 'clave-de-prueba-123');
    await sessionFor(id);
    await setOperatorPassword(admin, 'OP@citara.co', 'otra-clave-segura-456');
    expect(await adminQuery(`SELECT * FROM operator_sessions`)).toEqual([]);
    const [o] = await adminQuery(`SELECT password_hash FROM operators`);
    expect(await verifyPassword('otra-clave-segura-456', o.password_hash)).toBe(true);
    await expect(setOperatorPassword(admin, 'op@citara.co', 'corta')).rejects.toThrow(/12 caracteres/);
  });
  it('deshabilitar marca la fecha y cierra sesiones; un correo inexistente falla', async () => {
    const id = await createOperator(admin, 'op@citara.co', 'clave-de-prueba-123');
    await sessionFor(id);
    await disableOperator(admin, 'op@citara.co');
    expect((await adminQuery(`SELECT disabled_at FROM operators`))[0].disabled_at).not.toBeNull();
    expect(await adminQuery(`SELECT * FROM operator_sessions`)).toEqual([]);
    await expect(setOperatorPassword(admin, 'nadie@citara.co', 'clave-de-prueba-123')).rejects.toThrow(/No existe/);
    await expect(disableOperator(admin, 'nadie@citara.co')).rejects.toThrow(/No existe/);
  });
});
