import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource } from 'typeorm';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
beforeEach(async () => {
  await resetDb();
  app ??= await createDataSource(process.env.DATABASE_URL!).initialize();
});
afterAll(async () => { await app?.destroy(); await closeHelpers(); });

describe('operators y operator_sessions', () => {
  it('el correo es único sin importar mayúsculas', async () => {
    await adminQuery(`INSERT INTO operators (email, password_hash) VALUES ('Op@Citara.co', 'x')`);
    await expect(adminQuery(`INSERT INTO operators (email, password_hash) VALUES ('op@citara.co', 'y')`))
      .rejects.toThrow(/operators_email_lower/);
  });

  it('la app lee operadores pero no los crea ni los cambia', async () => {
    await adminQuery(`INSERT INTO operators (email, password_hash) VALUES ('op@citara.co', 'x')`);
    expect(await app.query(`SELECT email FROM operators`)).toEqual([{ email: 'op@citara.co' }]);
    await expect(app.query(`INSERT INTO operators (email, password_hash) VALUES ('b@c.co', 'x')`)).rejects.toThrow(/permission/);
    await expect(app.query(`UPDATE operators SET password_hash = 'y'`)).rejects.toThrow(/permission/);
  });

  it('la app crea, renueva y borra sesiones; borrar el operador las arrastra', async () => {
    const [o] = await adminQuery(`INSERT INTO operators (email, password_hash) VALUES ('op@citara.co', 'x') RETURNING id`);
    await app.query(
      `INSERT INTO operator_sessions (operator_id, token_hash, expires_at) VALUES ($1, '\\x01', now() + interval '1 day')`, [o.id]);
    await app.query(`UPDATE operator_sessions SET last_seen_at = now()`);
    await app.query(`DELETE FROM operator_sessions WHERE false`);
    await adminQuery(`DELETE FROM operators`);
    expect(await adminQuery(`SELECT * FROM operator_sessions`)).toEqual([]);
  });
});
