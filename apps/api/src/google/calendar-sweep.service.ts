import { Injectable } from '@nestjs/common';
// Import de VALOR: parámetro del constructor de un servicio Nest.
import { DataSource, type EntityManager } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { CalendarJob } from '../queues/calendar.queue';
import { RENEW_BEFORE_MS, watchEnabled } from './calendar-watch.service';

const PULL_EVERY_MS = 15 * 60_000;

/**
 * Qué hay que hacer con Google, negocio por negocio (las tablas tienen RLS:
 * un SELECT global sin `app.tenant_id` no ve nada). Solo lee y devuelve jobs;
 * el worker los encola. Los jobIds evitan duplicados entre barridos.
 */
@Injectable()
export class CalendarSweep {
  constructor(private readonly ds: DataSource) {}

  async run(now: Date): Promise<CalendarJob[]> {
    const tenants: { id: string }[] = await this.ds.query(`SELECT id FROM tenants WHERE status <> 'suspended'`);
    const out: CalendarJob[] = [];
    for (const t of tenants) out.push(...await runInTenant(this.ds, t.id, (m) => this.forTenant(m, t.id, now)));
    return out;
  }

  private async forTenant(m: EntityManager, tenantId: string, now: Date): Promise<CalendarJob[]> {
    const out: CalendarJob[] = [];
    // Citara → Google: lo pendiente de recursos con cuenta sana y calendario. Sin historia.
    const pending: { id: string; version: number }[] = await m.query(
      `SELECT a.id, a.google_sync_version AS version
         FROM appointments a
         JOIN google_accounts g ON g.resource_id = a.resource_id
        WHERE a.google_sync_status = 'pending' AND g.status = 'active' AND g.calendar_id IS NOT NULL
          AND a.ends_at > $1::timestamptz - interval '1 day'`, [now]);
    for (const p of pending) {
      out.push({ name: 'push', data: { tenantId, appointmentId: p.id, version: p.version },
                 jobId: `push-${p.id}-${p.version}` });
    }
    // Google → Citara: además de los avisos, una lectura cada 15 minutos. Si el
    // canal de watch muere en silencio, los cambios igual llegan (spec §11).
    const accounts: { id: string; last_pulled_at: Date | null; watch_expires_at: Date | null }[] = await m.query(
      `SELECT id, last_pulled_at, watch_expires_at FROM google_accounts
        WHERE status = 'active' AND calendar_id IS NOT NULL`);
    const pullBucket = Math.floor(now.getTime() / PULL_EVERY_MS);
    const hourBucket = Math.floor(now.getTime() / 3_600_000);
    for (const a of accounts) {
      if (!a.last_pulled_at || now.getTime() - new Date(a.last_pulled_at).getTime() >= PULL_EVERY_MS) {
        out.push({ name: 'pull', data: { tenantId, accountId: a.id }, jobId: `pull-${a.id}-p${pullBucket}` });
      }
      if (watchEnabled() && (!a.watch_expires_at
          || new Date(a.watch_expires_at).getTime() - now.getTime() < RENEW_BEFORE_MS)) {
        out.push({ name: 'watch', data: { tenantId, accountId: a.id }, jobId: `watch-${a.id}-${hourBucket}` });
      }
    }
    // Salud: una vez al día; cada hora si a la cuenta le falta el calendario.
    const checks: { id: string; last_checked_at: Date | null; calendar_id: string | null }[] = await m.query(
      `SELECT id, last_checked_at, calendar_id FROM google_accounts WHERE status = 'active'`);
    const dayBucket = now.toISOString().slice(0, 10).replace(/-/g, '');
    for (const c of checks) {
      if (!c.calendar_id) {
        out.push({ name: 'health', data: { tenantId, accountId: c.id }, jobId: `health-${c.id}-h${hourBucket}` });
      } else if (!c.last_checked_at || now.getTime() - new Date(c.last_checked_at).getTime() >= 86_400_000) {
        out.push({ name: 'health', data: { tenantId, accountId: c.id }, jobId: `health-${c.id}-${dayBucket}` });
      }
    }
    return out;
  }
}
