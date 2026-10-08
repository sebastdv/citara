import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { GoogleAuthError, GoogleClient } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { loadAccount, markNeedsReauth } from './accounts';
import { hashToken } from '../onboarding/links';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';
import type { AccountJob } from '../queues/calendar.queue';

/** Se renueva con dos días de margen: el job de renovación puede fallar un día entero. */
export const RENEW_BEFORE_MS = 2 * 86_400_000;
/** Lo que se pide; Google puede dar menos y se guarda la expiración que devuelve. */
const TTL_SECONDS = 30 * 86_400;

const publicBase = () => (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
/** Google solo avisa a direcciones HTTPS con certificado válido. En desarrollo, sondeo. */
export const watchEnabled = () => publicBase().startsWith('https://');

@Injectable()
export class CalendarWatchService {
  private readonly log = new Logger(CalendarWatchService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
  ) {}

  async renew(job: AccountJob, now = new Date()): Promise<'renewed' | 'skipped'> {
    if (!watchEnabled()) return 'skipped';
    const acc = await runInTenant(this.ds, job.tenantId, (m) => loadAccount(m, job.accountId));
    if (!acc || acc.status !== 'active' || !acc.calendarId) return 'skipped';
    if (acc.watchExpiresAt && acc.watchExpiresAt.getTime() - now.getTime() > RENEW_BEFORE_MS) return 'skipped';

    const channelId = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    let channel: { resourceId: string; expiration: Date };
    try {
      channel = await this.tokens.withToken(acc, (t) => this.google.watchEvents(t, acc.calendarId!, {
        // El negocio va en el token: el webhook lo resuelve sin saltarse RLS.
        id: channelId, token: `${acc.tenantId}.${secret}`,
        address: `${publicBase()}/webhooks/google`, ttlSeconds: TTL_SECONDS }));
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await runInTenant(this.ds, acc.tenantId, (m) => markNeedsReauth(m, acc, err.message));
        return 'skipped';
      }
      const message = (err as Error).message;
      await runInTenant(this.ds, acc.tenantId, async (m) => {
        // Se audita la primera falla; las siguientes solo actualizan el detalle.
        const [, first] = (await m.query(
          `UPDATE google_accounts SET watch_error = $2, updated_at = now() WHERE id = $1 AND watch_error IS NULL`,
          [acc.id, message])) as [unknown[], number];
        if (first) {
          await recordAudit(m, { tenantId: acc.tenantId, actor: 'google', action: 'calendar.watch_failed',
                                 details: { resourceId: acc.resourceId, error: message } });
        } else {
          await m.query(`UPDATE google_accounts SET watch_error = $2 WHERE id = $1`, [acc.id, message]);
        }
      });
      throw err;
    }

    await runInTenant(this.ds, acc.tenantId, (m) => m.query(
      `UPDATE google_accounts SET watch_channel_id = $2, watch_resource_id = $3, watch_token_hash = $4,
              watch_expires_at = $5, watch_error = NULL, updated_at = now()
        WHERE id = $1`, [acc.id, channelId, channel.resourceId, hashToken(secret), channel.expiration]));
    // El canal viejo se cierra después del nuevo: si esto falla, solo llegan avisos de más hasta que venza.
    if (acc.watchChannelId && acc.watchResourceId) {
      await this.tokens.withToken(acc, (t) => this.google.stopChannel(t, acc.watchChannelId!, acc.watchResourceId!))
        .catch((err: Error) => this.log.warn(`no se pudo cerrar el canal ${acc.watchChannelId}: ${err.message}`));
    }
    return 'renewed';
  }
}
