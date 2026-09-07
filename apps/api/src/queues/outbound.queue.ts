import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { OutboundContent } from '@citara/shared';

export const OUTBOUND_QUEUE = 'outbound';

export interface OutboundJob {
  tenantId: string;
  channelId: string;
  conversationId: string;
  /**
   * Fila de `messages` que el flujo ya creó para este saliente. El envío la
   * COMPLETA con el wamid; no crea otra. Así el mensaje existe en la
   * conversación desde que el bot lo produce, aunque el envío tarde o falle.
   */
  messageId: string;
  to: string;
  idempotencyKey: string;
  content: OutboundContent;
}

@Injectable()
export class OutboundQueue implements OnModuleDestroy {
  private readonly queue = new Queue<OutboundJob>(OUTBOUND_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false, // los fallidos quedan para inspección
    },
  });

  add(job: OutboundJob) {
    // idempotencyKey como jobId: barrera que impide enviar dos veces el
    // mismo mensaje si el job de salida se reintenta (BullMQ no reemplaza
    // los datos de un jobId ya existente).
    return this.queue.add('send', job, { jobId: job.idempotencyKey });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
