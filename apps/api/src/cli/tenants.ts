import type { DataSource, EntityManager } from 'typeorm';
import { DateTime } from 'luxon';
import type { EncryptionService } from '../crypto/encryption.service';
import type { MetaOnboardingClient, SyncType } from '../onboarding/meta-onboarding.client';
import { OnboardingService } from '../onboarding/onboarding.service';
import { createLink, type LinkPurpose } from '../onboarding/links';
import { recordAudit } from '../audit/audit';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

const publicBase = () => (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export const connectUrl = (token: string) => `${publicBase()}/connect/whatsapp?t=${token}`;

export const googleConnectUrl = (token: string) => `${publicBase()}/connect/google?t=${token}`;

async function tenantBySlug(admin: DataSource, slug: string): Promise<string> {
  const [t] = await admin.query(`SELECT id FROM tenants WHERE slug = $1`, [slug]);
  if (!t) throw new Error(`No existe el negocio '${slug}'`);
  return t.id;
}

/** Nace en alta: guarda lo que llega pero no responde hasta tener canal, agenda y flujo. */
export async function createTenant(admin: DataSource, input: { slug: string; name: string; timezone?: string }) {
  if (!SLUG.test(input.slug)) throw new Error('El slug debe ser minúsculas, números y guiones (2-63)');
  const timezone = input.timezone ?? 'America/Bogota';
  if (!DateTime.local().setZone(timezone).isValid) throw new Error(`Zona horaria inválida: ${timezone}`);
  return admin.transaction(async (m) => {
    const [exists] = await m.query(`SELECT 1 FROM tenants WHERE slug = $1`, [input.slug]);
    if (exists) throw new Error(`El negocio '${input.slug}' ya existe`);
    const [t] = await m.query(
      `INSERT INTO tenants (slug, name, timezone, status) VALUES ($1, $2, $3, 'onboarding') RETURNING id`,
      [input.slug, input.name, timezone]);
    const token = await createLink(m, t.id, 'whatsapp');
    return { tenantId: t.id as string, token };
  });
}

/** Vence ya los enlaces sin usar: uno perdido pudo llegarle a otra persona. */
const revokeLinks = (m: EntityManager, tenantId: string, scope: { purpose?: LinkPurpose; resourceId?: string } = {}) =>
  m.query(
    `UPDATE onboarding_links SET expires_at = now()
      WHERE tenant_id = $1 AND used_at IS NULL AND expires_at > now()
        AND ($2::varchar IS NULL OR purpose = $2) AND ($3::uuid IS NULL OR resource_id = $3)`,
    [tenantId, scope.purpose ?? null, scope.resourceId ?? null]);

/** Un enlace nuevo reemplaza a los anteriores: solo el último sirve. */
export async function newLink(admin: DataSource, slug: string): Promise<string> {
  const tenantId = await tenantBySlug(admin, slug);
  return admin.transaction(async (m) => {
    await revokeLinks(m, tenantId, { purpose: 'whatsapp' });
    return createLink(m, tenantId, 'whatsapp');
  });
}

/** Enlace para que un recurso conecte su Google Calendar. Reemplaza al anterior de ese recurso. */
export async function newGoogleLink(admin: DataSource, slug: string, resourceKey: string): Promise<string> {
  const tenantId = await tenantBySlug(admin, slug);
  return admin.transaction(async (m) => {
    const [r] = await m.query(
      `SELECT id FROM resources WHERE tenant_id = $1 AND key = $2 AND active`, [tenantId, resourceKey]);
    if (!r) throw new Error(`'${slug}' no tiene el recurso activo '${resourceKey}'`);
    await revokeLinks(m, tenantId, { purpose: 'google', resourceId: r.id });
    return createLink(m, tenantId, 'google', { resourceId: r.id });
  });
}

/** Suspender saca al negocio de operación al instante; reanudar lo devuelve si está completo. */
export async function setSuspended(admin: DataSource, slug: string, suspended: boolean): Promise<string> {
  const tenantId = await tenantBySlug(admin, slug);
  return admin.transaction(async (m) => {
    if (suspended) {
      await m.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);
      // Reanudar no debe revivirlos: si hace falta conectar, se pide uno nuevo.
      await revokeLinks(m, tenantId);
    } else {
      await m.query(`UPDATE tenants SET status = 'onboarding' WHERE id = $1 AND status = 'suspended'`, [tenantId]);
    }
    const [{ status }] = await m.query(`SELECT refresh_tenant_status($1) AS status`, [tenantId]);
    await recordAudit(m, { tenantId, actor: 'operator', action: suspended ? 'tenant.suspended' : 'tenant.resumed',
                           details: { status } });
    return status as string;
  });
}

export interface TenantSummary {
  slug: string; name: string; status: string; phone: string | null; mode: string | null;
  channelStatus: string | null; historySync: string | null; lastPhoneEcho: Date | null; lastCustomer: Date | null;
  /** Último resultado de pedir cada sincronización (del audit_log); vacío si nunca se pidió. */
  syncs: Partial<Record<SyncType, 'requested' | 'failed'>>;
}

/** Lo que el operador necesita ver: quién opera, cómo está su canal, y si el dueño sigue abriendo la app. */
export async function listTenants(admin: DataSource): Promise<TenantSummary[]> {
  const rows = await admin.query(`
    SELECT t.slug, t.name, t.status,
           ch.display_phone_number AS phone, ch.mode, ch.status AS channel_status, ch.history_sync,
           (SELECT max(occurred_at) FROM messages m WHERE m.tenant_id = t.id AND m.origin = 'phone') AS last_phone_echo,
           (SELECT max(occurred_at) FROM messages m WHERE m.tenant_id = t.id AND m.origin = 'customer') AS last_customer,
           (SELECT jsonb_object_agg(s.sync_type, s.result) FROM (
              SELECT DISTINCT ON (a.details->>'syncType') a.details->>'syncType' AS sync_type,
                     CASE a.action WHEN 'channel.sync_requested' THEN 'requested' ELSE 'failed' END AS result
                FROM audit_log a
               WHERE a.tenant_id = t.id AND a.action IN ('channel.sync_requested', 'channel.sync_failed')
               ORDER BY a.details->>'syncType', a.created_at DESC) s) AS syncs
      FROM tenants t
      LEFT JOIN LATERAL (SELECT * FROM whatsapp_channels c WHERE c.tenant_id = t.id ORDER BY c.created_at DESC LIMIT 1) ch ON true
     ORDER BY t.slug`);
  return rows.map((r: Record<string, any>) => ({
    slug: r.slug, name: r.name, status: r.status, phone: r.phone, mode: r.mode,
    channelStatus: r.channel_status, historySync: r.history_sync,
    lastPhoneEcho: r.last_phone_echo, lastCustomer: r.last_customer, syncs: r.syncs ?? {},
  }));
}

/** Reintenta la sincronización de un número en coexistencia (Meta la acepta dentro de 24 h del alta). */
export async function syncTenant(admin: DataSource, enc: EncryptionService, meta: MetaOnboardingClient, slug: string) {
  const tenantId = await tenantBySlug(admin, slug);
  const [ch] = await admin.query(
    `SELECT phone_number_id, access_token_encrypted FROM whatsapp_channels
      WHERE tenant_id = $1 AND mode = 'coexistence' AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [tenantId]);
  if (!ch) throw new Error(`'${slug}' no tiene un canal activo en coexistencia`);
  const service = new OnboardingService(admin, enc, meta);
  return service.requestSyncs(tenantId, ch.phone_number_id, enc.decrypt(ch.access_token_encrypted));
}
