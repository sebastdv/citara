import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export const CALENDAR_QUEUE = 'calendar';

export interface PushJob { tenantId: string; appointmentId: string; version: number }
export interface AccountJob { tenantId: string; accountId: string }
export type CalendarJob =
  | { name: 'push'; data: PushJob; jobId: string }
  | { name: 'pull' | 'watch' | 'health'; data: AccountJob; jobId: string };

/**
 * Cola propia (no `sync`): `sync` corre con concurrencia 1 para el historial de
 * coexistencia, y una importación grande no debe retrasar las citas en Google.
 * Los jobIds deduplican: el mismo trabajo no se encola dos veces.
 */
@Injectable()
export class CalendarQueue implements OnModuleDestroy {
  private readonly queue = new Queue(CALENDAR_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  });

  constructor() {
    this.queue.on('error', (err) => console.error(`[calendar] error de la cola: ${err.message}`));
  }

  add(job: CalendarJob) { return this.queue.add(job.name, job.data, { jobId: job.jobId }); }

  /** Un barrido por minuto. El scheduler vive en Redis y `upsert` es idempotente. */
  schedule() {
    return this.queue.upsertJobScheduler('calendar-sweep', { every: 60_000 }, { name: 'sweep' });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
