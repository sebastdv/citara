import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export const REMINDERS_QUEUE = 'reminders';

/** Un barrido por minuto. El scheduler vive en Redis y `upsert` es idempotente. */
@Injectable()
export class RemindersQueue implements OnModuleDestroy {
  private readonly queue = new Queue(REMINDERS_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 },
  });

  constructor() {
    this.queue.on('error', (err) => console.error(`[reminders] error de la cola: ${err.message}`));
  }

  schedule() {
    return this.queue.upsertJobScheduler('reminders-sweep', { every: 60_000 }, { name: 'sweep' });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
