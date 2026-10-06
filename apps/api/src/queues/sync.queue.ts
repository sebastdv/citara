import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { ContactSync, HistoryChunk } from '@citara/shared';

export const SYNC_QUEUE = 'sync';

export interface HistoryJob {
  tenantId: string;
  channelId: string;
  chunk: HistoryChunk;
}

export interface ContactsSyncJob {
  tenantId: string;
  contacts: ContactSync[];
}

/** BullMQ guarda JSON: las fechas del historial llegan como string. */
export function rehydrateHistoryJob(d: HistoryJob): HistoryJob {
  return {
    ...d,
    chunk: {
      ...d.chunk,
      threads: d.chunk.threads.map((t) => ({
        ...t,
        messages: t.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })),
      })),
    },
  };
}

@Injectable()
export class SyncQueue implements OnModuleDestroy {
  private readonly queue = new Queue<HistoryJob | ContactsSyncJob>(SYNC_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  });

  constructor() {
    this.queue.on('error', (err) => console.error(`[sync] error de la cola: ${err.message}`));
  }

  addHistory(job: HistoryJob) { return this.queue.add('history_chunk', job); }

  addContacts(job: ContactsSyncJob) { return this.queue.add('contacts_sync', job); }

  async onModuleDestroy() { await this.queue.close(); }
}
