import { Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { CalendarQueue } from '../queues/calendar.queue';
import { hashToken } from '../onboarding/links';
import { runInTenant } from '../tenancy/tenant-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ráfagas de avisos de la misma cuenta se juntan en una lectura cada 10 s. */
const PULL_BUCKET_MS = 10_000;
/** El secreto del canal: 24 bytes en base64url (calendar-watch.service). */
const SECRET = /^[A-Za-z0-9_-]{32}$/;

/**
 * Cuántas consultas a la base puede abrir este endpoint, que es público: sin
 * tope, cualquiera con un uuid bien formado abría una transacción por petición.
 * Los avisos legítimos ya llegan de a pocos (Google los agrupa y aquí van en
 * baldes de 10 s por cuenta), así que el tope no los toca en la operación normal.
 */
export class LookupBudget {
  private tokens: number;
  private last: number;

  constructor(private readonly perSecond = 20, private readonly burst = 40, now = Date.now()) {
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Avisos de Google (`events.watch`). No traen el cambio: solo dicen "algo
 * cambió"; la lectura con syncToken trae qué. Siempre 200: un aviso que no es
 * nuestro no se arregla con reintentos de Google.
 */
@Controller('webhooks/google')
export class GoogleWebhookController {
  private readonly budget = new LookupBudget();

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
    if (!tenantId || !secret || !UUID.test(tenantId) || !SECRET.test(secret)) return;
    // Sin presupuesto se descarta: si era un aviso real, el barrido lo cubre.
    if (!this.budget.take()) return;
    const [acc] = await runInTenant(this.ds, tenantId, (m) => m.query(
      `SELECT id FROM google_accounts
        WHERE watch_channel_id = $1 AND watch_token_hash = $2 AND status = 'active'`,
      [channelId, hashToken(secret)]));
    if (!acc) return;
    await this.queue.add({ name: 'pull', data: { tenantId, accountId: acc.id },
                           jobId: `pull-${acc.id}-w${Math.floor(Date.now() / PULL_BUCKET_MS)}` });
  }
}
