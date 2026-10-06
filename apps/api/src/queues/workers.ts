import type { INestApplicationContext } from '@nestjs/common';
import { Worker } from 'bullmq';
import { FlowRunner } from '../flow-engine/flow-runner.service';
import { INBOUND_QUEUE, rehydrateInboundJob, type InboundJob } from './inbound.queue';
import { OutboundProcessor } from './outbound.processor';
import { OUTBOUND_QUEUE, type OutboundJob } from './outbound.queue';

/**
 * Arranca los consumidores de las colas sobre un contexto de Nest ya creado.
 * Vive aquí, y no en apps/worker, para que los tests de punta a punta levanten
 * EXACTAMENTE el mismo cableado que producción: el arnés con cola de mentira
 * no ejercita Redis, y por esa costura se coló un jobId que BullMQ rechaza.
 */
export function startWorkers(
  ctx: INestApplicationContext,
  opts: { concurrency?: number } = {},
): { close: () => Promise<void> } {
  const connection = { url: process.env.REDIS_URL };
  const concurrency = opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 10);

  // FlowRunner, no InboundProcessor a secas: InboundProcessor solo persiste
  // el entrante; FlowRunner además avanza el flujo y encola la salida.
  const flowRunner = ctx.get(FlowRunner);
  const outboundProcessor = ctx.get(OutboundProcessor);

  const inbound = new Worker<InboundJob>(
    INBOUND_QUEUE,
    (job) => flowRunner.handle(rehydrateInboundJob(job.data)),
    { connection, concurrency },
  );
  inbound.on('failed', (job, err) => {
    console.error(`[inbound] job ${job?.id} falló: ${err.message}`);
  });
  // Sin listener de 'error', un corte de Redis emite un evento sin manejar y
  // tumba el proceso. BullMQ reconecta solo; basta con dejar constancia.
  inbound.on('error', (err) => console.error(`[inbound] error del worker: ${err.message}`));

  // Mismo proceso, otro Worker: BullMQ procesa cada cola de forma
  // independiente, y separarlas en procesos no compra nada mientras ninguna
  // sature al worker.
  const outbound = new Worker<OutboundJob>(
    OUTBOUND_QUEUE,
    (job) => outboundProcessor.process(job.data),
    { connection, concurrency },
  );
  outbound.on('failed', (job, err) => {
    console.error(`[outbound] job ${job?.id} falló: ${err.message}`);
  });
  outbound.on('error', (err) => console.error(`[outbound] error del worker: ${err.message}`));

  return {
    close: async () => { await inbound.close(); await outbound.close(); },
  };
}
