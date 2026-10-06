import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { OutboundContent } from '@citara/shared';

export const OUTBOUND_QUEUE = 'outbound';

/**
 * El job no lleva contenido: las filas de `messages` son la fuente de verdad
 * (outbox), así un job jamás apunta a contenido distinto del persistido.
 */
interface OutboundTarget {
  tenantId: string;
  channelId: string;
  conversationId: string;
  to: string;
}

/** Las respuestas de un turno: las filas con reply_to_id = turnId, en orden de seq. */
export interface TurnOutboundJob extends OutboundTarget { turnId: string }

/** Un envío suelto (un recordatorio): la fila con id = messageId. */
export interface MessageOutboundJob extends OutboundTarget { messageId: string }

export type OutboundJob = TurnOutboundJob | MessageOutboundJob;

export const outboundJobId = (job: OutboundJob) => ('turnId' in job ? job.turnId : job.messageId);

@Injectable()
export class OutboundQueue implements OnModuleDestroy {
  private readonly queue = new Queue<OutboundJob>(OUTBOUND_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      // ~8,5 min en total (2 s, 4 s, ... 256 s): una caída de Graph o un
      // límite de tasa sostenido duran más que los ~15 s de antes.
      attempts: 9,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: false, // los fallidos quedan para inspección
    },
  });

  add(job: OutboundJob, opts: { delay?: number } = {}) {
    // jobId = el uuid del turno o del mensaje (BullMQ rechaza ids con `:`).
    return this.queue.add('send-turn', job, { jobId: outboundJobId(job), delay: opts.delay });
  }

  constructor() {
    // Sin listener, un corte de Redis es un 'error' sin manejar que tumba el
    // proceso de la API entera, no solo el encolado.
    this.queue.on('error', (err) => console.error(`[outbound] error de la cola: ${err.message}`));
  }

  async onModuleDestroy() { await this.queue.close(); }
}
