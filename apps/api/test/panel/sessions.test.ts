import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource } from 'typeorm';
import { createSession, findSession, destroySession, csrfFor } from '../../src/panel/sessions';
import { resetDb, seedOperator, adminQuery, closeHelpers } from '../helpers';

let app: DataSource, operatorId: string;
const meta = { ip: null, userAgent: null };
beforeEach(async () => {
  await resetDb();
  app ??= await createDataSource(process.env.DATABASE_URL!).initialize();
  operatorId = await seedOperator();
});
afterAll(async () => { await app?.destroy(); await closeHelpers(); });

describe('sesiones', () => {
  it('crea una sesión que se encuentra por su token y solo guarda el hash', async () => {
    const token = await createSession(app, operatorId, { ip: '1.2.3.4', userAgent: 'vitest' });
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(await findSession(app, token)).toMatchObject({ operatorId, email: 'op@citara.co', csrf: csrfFor(token) });
    const [row] = await adminQuery(`SELECT token_hash, ip, user_agent FROM operator_sessions`);
    expect(row.token_hash.toString('base64url')).not.toBe(token);
    expect(row.token_hash).toHaveLength(32);
    expect([row.ip, row.user_agent]).toEqual(['1.2.3.4', 'vitest']);
  });
  it('vence a las 12 h sin uso', async () => {
    const token = await createSession(app, operatorId, meta);
    await adminQuery(`UPDATE operator_sessions SET last_seen_at = now() - interval '12 hours 1 minute'`);
    expect(await findSession(app, token)).toBeNull();
  });
  it('vence a los 7 días aunque se use', async () => {
    const token = await createSession(app, operatorId, meta);
    const [r] = await adminQuery(`SELECT expires_at - created_at AS span FROM operator_sessions`);
    expect(r.span).toMatchObject({ days: 7 });
    await adminQuery(`UPDATE operator_sessions SET expires_at = now() - interval '1 second'`);
    expect(await findSession(app, token)).toBeNull();
  });
  it('usarla renueva last_seen_at', async () => {
    const token = await createSession(app, operatorId, meta);
    await adminQuery(`UPDATE operator_sessions SET last_seen_at = now() - interval '2 hours'`);
    await findSession(app, token);
    const [r] = await adminQuery(`SELECT now() - last_seen_at < interval '1 minute' AS fresh FROM operator_sessions`);
    expect(r.fresh).toBe(true);
  });
  it('un operador deshabilitado no tiene sesión', async () => {
    const token = await createSession(app, operatorId, meta);
    await adminQuery(`UPDATE operators SET disabled_at = now()`);
    expect(await findSession(app, token)).toBeNull();
  });
  it('cerrar sesión borra la fila; un token inventado no encuentra nada', async () => {
    const token = await createSession(app, operatorId, meta);
    await destroySession(app, token);
    expect(await adminQuery(`SELECT * FROM operator_sessions`)).toEqual([]);
    expect(await findSession(app, 'x'.repeat(43))).toBeNull();
  });
  it('al crear una sesión se borran las vencidas del operador', async () => {
    await createSession(app, operatorId, meta);
    await adminQuery(`UPDATE operator_sessions SET expires_at = now() - interval '1 day'`);
    await createSession(app, operatorId, meta);
    expect(await adminQuery(`SELECT * FROM operator_sessions`)).toHaveLength(1);
  });
  it('el csrf depende del token', () => {
    expect(csrfFor('a')).not.toBe(csrfFor('b'));
  });
});
