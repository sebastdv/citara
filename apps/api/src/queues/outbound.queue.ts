import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { OutboundContent } from '@citara/shared';

export const OUTBOUND_QUEUE = 'outbound';

/**
 * Un job por TURNO, no por mensaje: el procesador envía en orden los salientes
 * que el turno dejó en `messages` (`reply_to_id = turnId`, ordenados por
 * `seq`). El contenido no viaja en Redis: las filas son la fuente de verdad, y
 * así un job jamás apunta a contenido distinto del que quedó persistido.
 */
export interface OutboundJob {
  tenantId: string;
  channelId: string;
  conversationId: string;
  /** id del mensaje ENTRANTE que produjo este turno. */
  turnId: string;
  to: string;
}

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

  add(job: OutboundJob) {
    // jobId = turnId (un uuid: BullMQ rechaza ids con `:`). Evita encolar dos
    // veces el mismo turno; NO evita re-ejecutarlo. Eso lo garantiza el
    // procesador reclamando cada fila antes de enviarla.
    return this.queue.add('send-turn', job, { jobId: job.turnId });
  }

  constructor() {
    // Sin listener, un corte de Redis es un 'error' sin manejar que tumba el
    // proceso de la API entera, no solo el encolado.
    this.queue.on('error', (err) => console.error(`[outbound] error de la cola: ${err.message}`));
  }

  async onModuleDestroy() { await this.queue.close(); }
}
