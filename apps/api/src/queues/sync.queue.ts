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
