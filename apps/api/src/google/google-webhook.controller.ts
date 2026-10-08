import { Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { CalendarQueue } from '../queues/calendar.queue';
import { hashToken } from '../onboarding/links';
import { runInTenant } from '../tenancy/tenant-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ráfagas de avisos de la misma cuenta se juntan en una lectura cada 10 s. */
const PULL_BUCKET_MS = 10_000;

/**
 * Avisos de Google (`events.watch`). No traen el cambio: solo dicen "algo
 * cambió"; la lectura con syncToken trae qué. Siempre 200: un aviso que no es
 * nuestro no se arregla con reintentos de Google.
 */
@Controller('webhooks/google')
export class GoogleWebhookController {
  constructor(private readonly ds: DataSource, private readonly queue: CalendarQueue) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async notify(
    @Headers('x-goog-channel-id') channelId: string | undefined,
    @Headers('x-goog-channel-token') token: string | undefined,
    @Headers('x-goog-resource-state') state: string | undefined,
  ): Promise<void> {
    // 'sync' solo anuncia que el canal empezó a funcionar.
    if (state === 'sync' || !channelId || !token || !UUID.test(channelId)) return;
    const [tenantId, secret] = token.split('.');
    if (!tenantId || !secret || !UUID.test(tenantId)) return;
    const [acc] = await runInTenant(this.ds, tenantId, (m) => m.query(
      `SELECT id FROM google_accounts
        WHERE watch_channel_id = $1 AND watch_token_hash = $2 AND status = 'active'`,
      [channelId, hashToken(secret)]));
    if (!acc) return;
    await this.queue.add({ name: 'pull', data: { tenantId, accountId: acc.id },
                           jobId: `pull-${acc.id}-w${Math.floor(Date.now() / PULL_BUCKET_MS)}` });
  }
}
