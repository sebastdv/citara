import { Injectable } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource, type EntityManager } from 'typeorm';
import { GoogleApiError, GoogleAuthError, GoogleClient, type GoogleEvent } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { loadAccount, markCalendarMissing, markNeedsReauth, type GoogleAccount } from './accounts';
import { appointmentIdFromEventId } from './event-id';
import { RemindersService } from '../scheduling/reminders.service';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';
import type { AccountJob } from '../queues/calendar.queue';

const PG_EXCLUSION_VIOLATION = '23P01';
type Stats = { cancelled: number; moved: number; rejected: number };

/** Google → Citara (spec §7.3): lo que el dueño mueve o borra en el calendario "Citas". */
@Injectable()
export class CalendarPullProcessor {
  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
    private readonly reminders: RemindersService,
  ) {}

  async process(job: AccountJob, now = new Date()): Promise<Stats> {
    const stats: Stats = { cancelled: 0, moved: 0, rejected: 0 };
    const acc = await runInTenant(this.ds, job.tenantId, (m) => loadAccount(m, job.accountId));
    if (!acc || acc.status !== 'active' || !acc.calendarId) return stats;
    try {
      await this.readAll(acc, acc.calendarId, now, stats);
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await runInTenant(this.ds, acc.tenantId, (m) => markNeedsReauth(m, acc, err.message));
        return stats;
      }
      if (err instanceof GoogleApiError && err.status === 404) {
        await runInTenant(this.ds, acc.tenantId, (m) => markCalendarMissing(m, acc));
        return stats;
      }
      throw err;
    }
    return stats;
  }

  private async readAll(acc: GoogleAccount, calendarId: string, now: Date, stats: Stats): Promise<void> {
    let syncToken = acc.syncToken;
    let pageToken: string | null = null;
    let restarted = false;
    for (;;) {
      let page;
      try {
        page = await this.tokens.withToken(acc, (t) => this.google.listEvents(t, calendarId, { syncToken, pageToken }));
      } catch (err) {
        // 410: el syncToken venció. Se lee todo desde cero, una vez (aplicar es idempotente).
        if (err instanceof GoogleApiError && err.status === 410 && !restarted) {
          restarted = true; syncToken = null; pageToken = null;
          continue;
        }
        throw err;
      }
      await runInTenant(this.ds, acc.tenantId, async (m) => {
        for (const ev of page.items) await this.apply(m, acc, ev, now, stats);
      });
      if (page.nextPageToken) { pageToken = page.nextPageToken; continue; }
      await runInTenant(this.ds, acc.tenantId, (m) => m.query(
        `UPDATE google_accounts SET sync_token = $2, last_pulled_at = $3, updated_at = now() WHERE id = $1`,
        [acc.id, page.nextSyncToken, now]));
      return;
    }
  }

  private async apply(m: EntityManager, acc: GoogleAccount, ev: GoogleEvent, now: Date, stats: Stats): Promise<void> {
    const appointmentId = appointmentIdFromEventId(ev.id);
    if (!appointmentId) return;   // algo creado a mano en "Citas": no es una cita
    const [a] = await m.query(
      `SELECT id, status, starts_at, ends_at, google_sync_status FROM appointments
        WHERE id = $1 AND resource_id = $2 FOR UPDATE`, [appointmentId, acc.resourceId]);
    // Con un cambio local pendiente gana lo local: la subida pisa lo que haya en Google.
    if (!a || a.google_sync_status !== 'synced' || a.status !== 'confirmed') return;
    const audit = (action: string, details: Record<string, unknown>) =>
      recordAudit(m, { tenantId: acc.tenantId, actor: 'google', action, details: { appointmentId, ...details } });

    if (ev.status === 'cancelled') {
      await m.query(`UPDATE appointments SET status = 'cancelled', updated_at = now() WHERE id = $1`, [a.id]);
      await this.reminders.cancelFor(m, a.id);
      await audit('appointment.cancelled_in_google', {});
      stats.cancelled++;
      return;
    }

    // Pasada a "todo el día" no es una hora: se ignora.
    if (!ev.start?.dateTime || !ev.end?.dateTime) return;
    const start = new Date(ev.start.dateTime), end = new Date(ev.end.dateTime);
    if (!(end > start)) return;
    if (start.getTime() === new Date(a.starts_at).getTime() && end.getTime() === new Date(a.ends_at).getTime()) return;

    await m.query(`SAVEPOINT mover_desde_google`);
    try {
      await m.query(`UPDATE appointments SET starts_at = $2, ends_at = $3, updated_at = now() WHERE id = $1`,
                    [a.id, start, end]);
      await m.query(`RELEASE SAVEPOINT mover_desde_google`);
    } catch (err) {
      await m.query(`ROLLBACK TO SAVEPOINT mover_desde_google`);
      if ((err as { code?: string }).code !== PG_EXCLUSION_VIOLATION) throw err;
      // Choca con otra cita: no se aplica, y la hora de Citara vuelve a Google.
      await m.query(
        `UPDATE appointments SET google_sync_status = 'pending', google_sync_version = google_sync_version + 1
          WHERE id = $1`, [a.id]);
      await audit('appointment.move_rejected', { start: start.toISOString(), end: end.toISOString() });
      stats.rejected++;
      return;
    }
    await this.reminders.rescheduleFor(m, acc.tenantId, a.id, start, now);
    await audit('appointment.moved_in_google', { from: new Date(a.starts_at).toISOString(), to: start.toISOString() });
    stats.moved++;
  }
}
