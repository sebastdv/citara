import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DataSource } from 'typeorm';

export const SESSION_COOKIE = 'citara_op';
export const IDLE_HOURS = 12;
export const ABSOLUTE_DAYS = 7;

export interface OperatorSession { sessionId: string; operatorId: string; email: string; csrf: string }

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Token CSRF de la sesión: no se guarda y no se puede calcular sin la cookie. */
export const csrfFor = (token: string) => createHmac('sha256', token).update('csrf').digest('base64url');

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Devuelve el token en claro: va en la cookie y en la BD solo queda su SHA-256. */
export async function createSession(
  ds: DataSource, operatorId: string, meta: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await ds.query(`DELETE FROM operator_sessions WHERE operator_id = $1 AND expires_at <= now()`, [operatorId]);
  await ds.query(
    `INSERT INTO operator_sessions (operator_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [operatorId, sha256(token), ABSOLUTE_DAYS, meta.ip?.slice(0, 64) ?? null, meta.userAgent?.slice(0, 512) ?? null]);
  return token;
}

/**
 * `touch: false` para el refresco automático de la página: sondear no es usar
 * el panel, y si renovara, una pestaña abierta nunca vencería por inactividad.
 */
export async function findSession(
  ds: DataSource, token: string, opts: { touch?: boolean } = {},
): Promise<OperatorSession | null> {
  const [s] = await ds.query(
    `SELECT s.id, s.operator_id, o.email, s.last_seen_at < now() - interval '1 minute' AS stale
       FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(hours => $2) AND o.disabled_at IS NULL`,
    [sha256(token), IDLE_HOURS]);
  if (!s) return null;
  // Se renueva como mucho una vez por minuto: el refresco del chat pide cada 5 s.
  if (s.stale && opts.touch !== false) await ds.query(`UPDATE operator_sessions SET last_seen_at = now() WHERE id = $1`, [s.id]);
  return { sessionId: s.id, operatorId: s.operator_id, email: s.email, csrf: csrfFor(token) };
}

export async function destroySession(ds: DataSource, token: string): Promise<void> {
  await ds.query(`DELETE FROM operator_sessions WHERE token_hash = $1`, [sha256(token)]);
}
