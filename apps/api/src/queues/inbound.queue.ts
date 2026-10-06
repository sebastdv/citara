import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { InboundMessage } from '@citara/shared';

export const INBOUND_QUEUE = 'inbound';

export interface InboundJob {
  tenantId: string;
  channelId: string;
  message: InboundMessage;
}

/**
 * BullMQ guarda los jobs como JSON: el `Date` del mensaje llega al worker como
 * string. Se rehidrata en la frontera para que el tipo diga la verdad.
 */
export function rehydrateInboundJob(data: InboundJob): InboundJob {
  return { ...data, message: { ...data.message, timestamp: new Date(data.message.timestamp) } };
}

@Injectable()
export class InboundQueue implements OnModuleDestroy {
  private readonly queue = new Queue<InboundJob>(INBOUND_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false, // los fallidos quedan para inspección
    },
  });

  add(job: InboundJob) {
    // jobId = wamid: segunda barrera de idempotencia, ahora en la cola.
    return this.queue.add('process', job, { jobId: job.message.wamid });
  }

  constructor() {
    // Sin listener, un corte de Redis es un 'error' sin manejar que tumba el
    // proceso de la API entera, no solo el encolado.
    this.queue.on('error', (err) => console.error(`[inbound] error de la cola: ${err.message}`));
  }

  async onModuleDestroy() { await this.queue.close(); }
}
