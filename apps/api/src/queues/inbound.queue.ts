import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { InboundMessage } from '@citara/shared';

export const INBOUND_QUEUE = 'inbound';

export interface InboundJob {
  tenantId: string;
  channelId: string;
  message: InboundMessage;
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

  async onModuleDestroy() { await this.queue.close(); }
}
