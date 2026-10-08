import { Injectable, Logger } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { GoogleApiError, GoogleAuthError, GoogleClient, isRetryable, type EventBody } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { markCalendarMissing, markNeedsReauth } from './accounts';
import { googleEventId } from './event-id';
import { runInTenant } from '../tenancy/tenant-context';
import type { PushJob } from '../queues/calendar.queue';

type Row = Record<string, any>;

/** Citara → Google (spec §7.3). La cita ya está confirmada; esto es su proyección. */
@Injectable()
export class CalendarPushProcessor {
  private readonly log = new Logger(CalendarPushProcessor.name);

  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
  ) {}

  async process(job: PushJob): Promise<{ result: 'created' | 'updated' | 'deleted' | 'skipped' | 'failed' }> {
    const row: Row | undefined = await runInTenant(this.ds, job.tenantId, async (m) => (await m.query(
      `SELECT a.id, a.status, a.starts_at, a.ends_at, a.customer_name, a.notes,
              s.name AS service_name, c.wa_id, t.timezone,
              g.id AS account_id, g.resource_id, g.calendar_id, g.refresh_token_encrypted, g.status AS account_status
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         JOIN contacts c ON c.id = a.contact_id
         JOIN tenants t ON t.id = a.tenant_id
         LEFT JOIN google_accounts g ON g.resource_id = a.resource_id
        WHERE a.id = $1 AND a.google_sync_status = 'pending' AND a.google_sync_version = $2`,
      [job.appointmentId, job.version]))[0]);
    // Ya subida, o hay una versión más nueva con su propio job.
    if (!row) return { result: 'skipped' };
    // Sin cuenta sana o sin calendario: queda pendiente hasta reconectar o recrearlo.
    if (!row.account_id || row.account_status !== 'active' || !row.calendar_id) return { result: 'skipped' };

    const eventId = googleEventId(row.id);
    let result: 'created' | 'updated' | 'deleted';
    try {
      result = await this.tokens.withToken(
        { id: row.account_id, refreshTokenEncrypted: row.refresh_token_encrypted },
        async (token) => {
          if (row.status === 'cancelled') {
            await this.google.deleteEvent(token, row.calendar_id, eventId);
            return 'deleted';
          }
          const body = eventBody(row);
          if ((await this.google.insertEvent(token, row.calendar_id, eventId, body)) === 'created') return 'created';
          // 409: ya existía (un reintento, o la cita cambió). Se pone al día.
          await this.google.patchEvent(token, row.calendar_id, eventId, body);
          return 'updated';
        });
    } catch (err) {
      return this.onError(job, row, err);
    }

    // Compare-and-set: si la cita cambió mientras se hablaba con Google, su versión
    // subió y esta marca no aplica; el job de la versión nueva la sube.
    await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE appointments SET google_sync_status = 'synced', google_event_id = $3, google_synced_at = now()
        WHERE id = $1 AND google_sync_version = $2 AND google_sync_status = 'pending'`,
      [row.id, job.version, eventId]));
    return { result };
  }

  /** Reintentos agotados o rechazo permanente. El chequeo diario lo vuelve a intentar. */
  async markFailed(job: PushJob): Promise<void> {
    await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE appointments SET google_sync_status = 'failed'
        WHERE id = $1 AND google_sync_version = $2 AND google_sync_status = 'pending'`,
      [job.appointmentId, job.version]));
  }

  private async onError(job: PushJob, row: Row, err: unknown) {
    const account = { id: row.account_id, tenantId: job.tenantId, resourceId: row.resource_id, calendarId: row.calendar_id };
    if (err instanceof GoogleAuthError) {
      await runInTenant(this.ds, job.tenantId, (m) => markNeedsReauth(m, account, err.message));
      return { result: 'skipped' as const };
    }
    // 404 al crear o actualizar: el calendario "Citas" ya no existe.
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) {
      await runInTenant(this.ds, job.tenantId, (m) => markCalendarMissing(m, account));
      return { result: 'skipped' as const };
    }
    if (isRetryable(err)) throw err;
    this.log.warn(`la cita ${row.id} no se pudo reflejar en Google: ${(err as Error).message}`);
    await this.markFailed(job);
    return { result: 'failed' as const };
  }
}

function eventBody(r: Row): EventBody {
  const customer = r.customer_name ?? 'Cliente';
  return {
    summary: `${r.service_name} — ${customer}`,
    description: [
      `Cliente: ${customer}`,
      `WhatsApp: +${r.wa_id}`,
      r.notes ? `Notas: ${r.notes}` : null,
      'Agendada por Citara. Si la mueves o la borras aquí, Citara se entera.',
    ].filter(Boolean).join('\n'),
    start: { dateTime: new Date(r.starts_at).toISOString(), timeZone: r.timezone },
    end: { dateTime: new Date(r.ends_at).toISOString(), timeZone: r.timezone },
    extendedProperties: { private: { citaraAppointmentId: r.id } },
  };
}
