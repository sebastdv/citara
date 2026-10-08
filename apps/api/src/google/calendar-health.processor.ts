import { Injectable } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { GoogleAuthError, GoogleClient } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { attachNewCalendar, loadAccount, markNeedsReauth } from './accounts';
import { runInTenant } from '../tenancy/tenant-context';
import type { AccountJob } from '../queues/calendar.queue';

/** Chequeo diario de cada conexión (spec §7.3, "token muerto"). */
@Injectable()
export class CalendarHealthProcessor {
  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
  ) {}

  async process(job: AccountJob, now = new Date()): Promise<'ok' | 'recreated' | 'needs_reauth' | 'skipped'> {
    const acc = await runInTenant(this.ds, job.tenantId, (m) => loadAccount(m, job.accountId));
    if (!acc || acc.status !== 'active') return 'skipped';
    // Sin el access token en caché, la llamada fuerza una renovación: si el
    // dueño revocó el acceso, aparece aquí y no al agendar.
    this.tokens.invalidate(acc.id);
    let result: 'ok' | 'recreated' = 'ok';
    try {
      const exists = acc.calendarId
        ? await this.tokens.withToken(acc, (t) => this.google.calendarExists(t, acc.calendarId!))
        : false;
      if (!exists) {
        await this.tokens.withToken(acc, (t) => attachNewCalendar(this.ds, this.google, t, acc, now));
        result = 'recreated';
      }
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await runInTenant(this.ds, acc.tenantId, (m) => markNeedsReauth(m, acc, err.message));
        return 'needs_reauth';
      }
      throw err;
    }
    await runInTenant(this.ds, acc.tenantId, async (m) => {
      // Lo que Google rechazó de forma permanente se reintenta una vez al día.
      await m.query(
        `UPDATE appointments SET google_sync_status = 'pending', google_sync_version = google_sync_version + 1
          WHERE resource_id = $1 AND google_sync_status = 'failed' AND ends_at > $2`, [acc.resourceId, now]);
      await m.query(`UPDATE google_accounts SET last_checked_at = $2 WHERE id = $1`, [acc.id, now]);
    });
    return result;
  }
}
