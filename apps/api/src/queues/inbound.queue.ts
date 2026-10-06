import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { AccountUpdate, InboundMessage, InboundStatus, PhoneEcho } from '@citara/shared';

export const INBOUND_QUEUE = 'inbound';

export interface InboundJob {
  tenantId: string;
  channelId: string;
  message: InboundMessage;
}

/** Lo que el negocio envió desde su celular (coexistencia). */
export interface EchoJob {
  tenantId: string;
  channelId: string;
  echo: PhoneEcho;
}

/** Acuse de entrega o lectura de algo que enviamos. */
export interface StatusJob {
  tenantId: string;
  status: InboundStatus;
}

/** Aviso de Meta sobre la cuenta. Llega por WABA, sin phone_number_id. */
export interface AccountUpdateJob {
  update: AccountUpdate;
}

/**
 * BullMQ guarda los jobs como JSON: el `Date` del mensaje llega al worker como
 * string. Se rehidrata en la frontera para que el tipo diga la verdad.
 */
export function rehydrateInboundJob(data: InboundJob): InboundJob {
  return { ...data, message: { ...data.message, timestamp: new Date(data.message.timestamp) } };
}

export function rehydrateEchoJob(d: EchoJob): EchoJob {
  return { ...d, echo: { ...d.echo, timestamp: new Date(d.echo.timestamp) } };
}

export function rehydrateStatusJob(d: StatusJob): StatusJob {
  return { ...d, status: { ...d.status, timestamp: new Date(d.status.timestamp) } };
}

@Injectable()
export class InboundQueue implements OnModuleDestroy {
  private readonly queue = new Queue<InboundJob | EchoJob | StatusJob | AccountUpdateJob>(INBOUND_QUEUE, {
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

  // Los ecos van por esta cola y no por `sync`: tienen que pasar por el mismo
  // bloqueo de la conversación que los mensajes del cliente (spec §3.4).
  addEcho(job: EchoJob) {
    return this.queue.add('phone_echo', job, { jobId: job.echo.wamid });
  }

  addStatus(job: StatusJob) {
    // BullMQ rechaza ids con `:`; el mismo acuse reentregado no se encola dos veces.
    const jobId = `st-${job.status.wamid}-${job.status.status}`.replaceAll(':', '_');
    return this.queue.add('status', job, { jobId });
  }

  addAccountUpdate(job: AccountUpdateJob) {
    return this.queue.add('account_update', job);
  }

  constructor() {
    // Sin listener, un corte de Redis es un 'error' sin manejar que tumba el
    // proceso de la API entera, no solo el encolado.
    this.queue.on('error', (err) => console.error(`[inbound] error de la cola: ${err.message}`));
  }

  async onModuleDestroy() { await this.queue.close(); }
}
