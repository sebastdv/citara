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

@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly channels: ChannelResolver,
    private readonly queue: InboundQueue,
  ) {}

  async ingest(payload: unknown): Promise<{ enqueued: number; duplicates: number }> {
    const { messages } = normalizeWebhook(payload);
    let enqueued = 0;
    let duplicates = 0;

    for (const msg of messages) {
      // El normalizador produce wamid: '' (cadena vacía, no null) cuando Meta
      // manda un mensaje sin `id`. La columna es varchar(128) NOT NULL UNIQUE:
      // el primer mensaje sin wamid entraría con cadena vacía y CADA mensaje
      // sin wamid que llegue después chocaría contra esa misma fila y se
      // contaría como duplicado — pérdida silenciosa de datos, no un detalle.
      // Se descarta ANTES del INSERT.
      if (!msg.wamid) {
        this.log.warn('mensaje sin wamid descartado antes de persistir');
        continue;
      }

      const channel = await this.channels.resolveByPhoneNumberId(msg.phoneNumberId);
      if (!channel) {
        // 200 igual: un error haría que Meta reintente para siempre.
        this.log.warn(`phone_number_id sin canal: ${msg.phoneNumberId}`);
        continue;
      }

      // La idempotencia es la restricción única, no un SELECT previo.
      const inserted = await this.ds.query(
        `INSERT INTO webhook_events (wamid, tenant_id, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (wamid) DO NOTHING
         RETURNING id`,
        [msg.wamid, channel.tenantId, JSON.stringify(msg.raw)],
      );

      // También ante duplicado se encola: si la vez anterior falló Redis justo
      // después de este INSERT, la reentrega de Meta es la única oportunidad
      // de que el mensaje se procese. Es seguro: el jobId es el wamid (BullMQ
      // no encola dos veces el mismo id) y, si el job ya se completó, el
      // worker ve el entrante como ya procesado y no rehace el turno.
      await this.queue.add({ tenantId: channel.tenantId, channelId: channel.channelId, message: msg });
      if (inserted.length === 0) duplicates++;
      else enqueued++;
    }

    return { enqueued, duplicates };
  }
}
