import { createHash, randomBytes } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

export type LinkPurpose = 'whatsapp' | 'google';
type Db = DataSource | EntityManager;
const DEFAULT_TTL_HOURS = 72;

/** Solo se guarda el hash: con la tabla filtrada, nadie puede rearmar los enlaces. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Crea un enlace de un solo uso (conexión admin). Devuelve el token en claro: es lo que va en la URL. */
export async function createLink(
  admin: Db, tenantId: string, purpose: LinkPurpose, ttlHours = DEFAULT_TTL_HOURS,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await admin.query(
    `INSERT INTO onboarding_links (tenant_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [tenantId, purpose, hashToken(token), ttlHours]);
  return token;
}

export interface ValidLink { linkId: string; tenantId: string; tenantName: string }

/** Válido: del propósito pedido, sin usar, sin vencer y de un negocio no suspendido. */
export async function peekLink(db: Db, token: string, purpose: LinkPurpose): Promise<ValidLink | null> {
  const [row] = await db.query(
    `SELECT l.id, l.tenant_id, t.name
       FROM onboarding_links l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.token_hash = $1 AND l.purpose = $2 AND l.used_at IS NULL
        AND l.expires_at > now() AND t.status <> 'suspended'`,
    [hashToken(token), purpose]);
  return row ? { linkId: row.id, tenantId: row.tenant_id, tenantName: row.name } : null;
}

/** Lo marca usado de forma atómica: de dos usos simultáneos, solo uno gana. */
export async function consumeLink(db: Db, linkId: string): Promise<boolean> {
  // Con UPDATE, TypeORM devuelve [filas, conteo].
  const [, affected] = (await db.query(
    `UPDATE onboarding_links SET used_at = now()
      WHERE id = $1 AND used_at IS NULL AND expires_at > now()`, [linkId])) as [unknown[], number];
  return affected > 0;
}
