import type { DataSource, EntityManager } from 'typeorm';
import { recordAudit } from '../audit/audit';
import { runInTenant } from '../tenancy/tenant-context';
import type { GoogleClient } from './google.client';
import type { GoogleAccountRef } from './google-tokens.service';

export interface GoogleAccount extends GoogleAccountRef {
  tenantId: string; resourceId: string; resourceName: string; timezone: string;
  email: string | null; calendarId: string | null; status: string; syncToken: string | null;
  watchChannelId: string | null; watchResourceId: string | null; watchExpiresAt: Date | null;
}

export async function loadAccount(m: EntityManager, accountId: string): Promise<GoogleAccount | null> {
  const [r] = await m.query(
    `SELECT g.*, r.name AS resource_name, t.timezone
       FROM google_accounts g
       JOIN resources r ON r.id = g.resource_id
       JOIN tenants t ON t.id = g.tenant_id
      WHERE g.id = $1`, [accountId]);
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenant_id, resourceId: r.resource_id, resourceName: r.resource_name,
    timezone: r.timezone, email: r.email, calendarId: r.calendar_id, status: r.status,
    refreshTokenEncrypted: r.refresh_token_encrypted, syncToken: r.sync_token,
    watchChannelId: r.watch_channel_id, watchResourceId: r.watch_resource_id,
    watchExpiresAt: r.watch_expires_at ? new Date(r.watch_expires_at) : null,
  };
}

/**
 * La cuenta deja de usarse hasta reconectar. Se audita la transición, no cada
 * intento: lo que queda pendiente se sube al reconectar.
 */
export async function markNeedsReauth(
  m: EntityManager, a: { id: string; tenantId: string; resourceId: string }, cause: string,
): Promise<boolean> {
  // Con UPDATE, TypeORM devuelve [filas, conteo].
  const [, affected] = (await m.query(
    `UPDATE google_accounts SET status = 'needs_reauth', updated_at = now()
      WHERE id = $1 AND status = 'active'`, [a.id])) as [unknown[], number];
  if (affected > 0) {
    await recordAudit(m, { tenantId: a.tenantId, actor: 'google', action: 'calendar.needs_reauth',
                           details: { resourceId: a.resourceId, cause } });
  }
  return affected > 0;
}

/** El dueño borró el calendario "Citas": el chequeo de salud lo recrea y vuelve a subir lo futuro. */
export async function markCalendarMissing(
  m: EntityManager, a: { id: string; tenantId: string; resourceId: string; calendarId: string | null },
): Promise<void> {
  const [, affected] = (await m.query(
    `UPDATE google_accounts SET calendar_id = NULL, sync_token = NULL, updated_at = now()
      WHERE id = $1 AND calendar_id IS NOT DISTINCT FROM $2`, [a.id, a.calendarId])) as [unknown[], number];
  if (affected > 0) {
    await recordAudit(m, { tenantId: a.tenantId, actor: 'google', action: 'calendar.missing',
                           details: { resourceId: a.resourceId } });
  }
}

/**
 * Crea el calendario "Citas · <recurso>" y deja todo lo futuro pendiente de
 * subir a él. Sirve al conectar y cuando el dueño borró el calendario.
 */
export async function attachNewCalendar(
  ds: DataSource, google: GoogleClient, accessToken: string,
  a: { id: string; tenantId: string; resourceId: string; resourceName: string; timezone: string },
  now = new Date(),
): Promise<string> {
  const calendarId = await google.createCalendar(accessToken, `Citas · ${a.resourceName}`, a.timezone);
  await runInTenant(ds, a.tenantId, async (m) => {
    // Calendario nuevo: lo leído y los canales del anterior ya no aplican.
    await m.query(
      `UPDATE google_accounts SET calendar_id = $2, sync_token = NULL, watch_channel_id = NULL,
              watch_resource_id = NULL, watch_token_hash = NULL, watch_expires_at = NULL,
              watch_error = NULL, updated_at = now()
        WHERE id = $1`, [a.id, calendarId]);
    await m.query(
      `UPDATE appointments SET google_sync_status = 'pending', google_sync_version = google_sync_version + 1
        WHERE resource_id = $1 AND status = 'confirmed' AND ends_at > $2`, [a.resourceId, now]);
    await recordAudit(m, { tenantId: a.tenantId, actor: 'google', action: 'calendar.created',
                           details: { resourceId: a.resourceId } });
  });
  return calendarId;
}
