import { Injectable, Logger } from '@nestjs/common';
// Import de VALOR, no `import type`: con emitDecoratorMetadata activo, Nest
// necesita la referencia en tiempo de ejecución para resolver este parámetro
// del constructor. Un `import type` se borra en la emisión y TypeScript
// sustituye el design:paramtype por `Object`, así que Nest ya no sabe qué
// inyectar aquí y falla con "Nest can't resolve dependencies... (?, ...)".
import { DataSource } from 'typeorm';
import { normalizeWebhook } from './normalizer';
import { ChannelResolver } from '../tenancy/channel-resolver.service';
import { InboundQueue } from '../queues/inbound.queue';
import { SyncQueue } from '../queues/sync.queue';
import type { ContactSync } from '@citara/shared';

@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly channels: ChannelResolver,
    private readonly queue: InboundQueue,
    private readonly sync: SyncQueue,
  ) {}

  /**
   * Cada evento a su cola. Nada de lógica de negocio aquí: el webhook debe
   * responder 200 en menos de 100 ms (regla de oro, spec §3.5).
   */
  async ingest(payload: unknown): Promise<{ enqueued: number; duplicates: number }> {
    const n = normalizeWebhook(payload);
    let enqueued = 0;
    let duplicates = 0;

    for (const msg of n.messages) {
      // wamid vacío = Meta mandó un mensaje sin `id`. Con cadena vacía, el
      // primero entraría y todos los siguientes chocarían como "duplicados".
      if (!msg.wamid) { this.log.warn('mensaje sin wamid descartado antes de persistir'); continue; }
      const channel = await this.resolve(msg.phoneNumberId);
      if (!channel) continue;
      const fresh = await this.gate(msg.wamid, channel.tenantId, msg.raw);
      // También ante duplicado se encola: si la vez anterior falló Redis justo
      // después del INSERT, la reentrega de Meta es la única oportunidad.
      await this.queue.add({ tenantId: channel.tenantId, channelId: channel.channelId, message: msg });
      if (fresh) enqueued++; else duplicates++;
    }

    for (const echo of n.echoes) {
      if (!echo.wamid) { this.log.warn('eco sin wamid descartado'); continue; }
      const channel = await this.resolve(echo.phoneNumberId);
      if (!channel) continue;
      const fresh = await this.gate(echo.wamid, channel.tenantId, echo.raw);
      await this.queue.addEcho({ tenantId: channel.tenantId, channelId: channel.channelId, echo });
      if (fresh) enqueued++; else duplicates++;
    }

    for (const status of n.statuses) {
      if (!status.wamid) continue;
      const channel = await this.resolve(status.phoneNumberId);
      if (!channel) continue;
      await this.queue.addStatus({ tenantId: channel.tenantId, status });
      enqueued++;
    }

    for (const chunk of n.history) {
      const channel = await this.resolve(chunk.phoneNumberId);
      if (!channel) continue;
      await this.sync.addHistory({ tenantId: channel.tenantId, channelId: channel.channelId, chunk });
      enqueued++;
    }

    const contactsByPhone = new Map<string, ContactSync[]>();
    for (const c of n.contacts) {
      contactsByPhone.set(c.phoneNumberId, [...(contactsByPhone.get(c.phoneNumberId) ?? []), c]);
    }
    for (const [phoneNumberId, contacts] of contactsByPhone) {
      const channel = await this.resolve(phoneNumberId);
      if (!channel) continue;
      await this.sync.addContacts({ tenantId: channel.tenantId, contacts });
      enqueued++;
    }

    // Llega por WABA, sin phone_number_id: el procesador resuelve los canales.
    for (const update of n.accountUpdates) {
      await this.queue.addAccountUpdate({ update });
      enqueued++;
    }

    return { enqueued, duplicates };
  }

  private async resolve(phoneNumberId: string) {
    const channel = await this.channels.resolveByPhoneNumberId(phoneNumberId);
    // 200 igual: un error haría que Meta reintente para siempre.
    if (!channel) this.log.warn(`phone_number_id sin canal: ${phoneNumberId}`);
    return channel;
  }

  /** La idempotencia es la restricción única, no un SELECT previo. Devuelve si es nuevo. */
  private async gate(wamid: string, tenantId: string, raw: unknown): Promise<boolean> {
    const inserted = await this.ds.query(
      `INSERT INTO webhook_events (wamid, tenant_id, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (wamid) DO NOTHING
       RETURNING id`,
      [wamid, tenantId, JSON.stringify(raw)],
    );
    return inserted.length > 0;
  }
}
