import { Injectable } from '@nestjs/common';
// Import de VALOR: parámetro del constructor de un servicio Nest.
import { DataSource, type EntityManager } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { CalendarJob } from '../queues/calendar.queue';

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
    return out;
  }
}
