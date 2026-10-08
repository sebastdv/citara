import { createHash, randomBytes } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';

export type LinkPurpose = 'whatsapp' | 'google';
type Db = DataSource | EntityManager;
const DEFAULT_TTL_HOURS = 72;

/** Solo se guarda el hash: con la tabla filtrada, nadie puede rearmar los enlaces. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Crea un enlace de un solo uso (conexión admin). Devuelve el token en claro: es lo que va en la URL. */
export async function createLink(
  admin: Db, tenantId: string, purpose: LinkPurpose,
  opts: { ttlHours?: number; resourceId?: string } = {},
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await admin.query(
    `INSERT INTO onboarding_links (tenant_id, purpose, token_hash, expires_at, resource_id)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5)`,
    [tenantId, purpose, hashToken(token), opts.ttlHours ?? DEFAULT_TTL_HOURS, opts.resourceId ?? null]);
  return token;
}

export interface ValidLink {
  linkId: string; tenantId: string; tenantName: string;
  /** Solo en los enlaces de Google: el recurso cuyo calendario se conecta. */
  resourceId: string | null; resourceName: string | null;
}

/**
 * Válido: del propósito pedido, sin usar, sin vencer y de un negocio no suspendido.
 * Solo consulta: lo consume register_channel o consume_google_link, en la
 * misma transacción que lo que registra.
 */
export async function peekLink(db: Db, token: string, purpose: LinkPurpose): Promise<ValidLink | null> {
  const [row] = await db.query(
    `SELECT l.id, l.tenant_id, t.name, l.resource_id
       FROM onboarding_links l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.token_hash = $1 AND l.purpose = $2 AND l.used_at IS NULL
        AND l.expires_at > now() AND t.status <> 'suspended'`,
    [hashToken(token), purpose]);
  if (!row) return null;
  let resourceName: string | null = null;
  if (row.resource_id) {
    // resources tiene RLS: sin el negocio fijado no se ve. Se lee dentro de él.
    const read = (m: EntityManager) => m.query(`SELECT name FROM resources WHERE id = $1`, [row.resource_id]);
    const [r] = db instanceof DataSource ? await runInTenant(db, row.tenant_id, read) : await read(db);
    resourceName = r?.name ?? null;
  }
  return { linkId: row.id, tenantId: row.tenant_id, tenantName: row.name,
           resourceId: row.resource_id, resourceName };
}
