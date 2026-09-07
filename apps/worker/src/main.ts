// Debe ser el primer import: instala el polyfill de metadata de reflexión que
// `emitDecoratorMetadata` necesita para que Nest resuelva por tipo las
// dependencias de los providers de AppModule (mismo motivo que en
// apps/api/src/main.ts).
import 'reflect-metadata';
// La configuración se lee del entorno. En un servidor la inyecta el
// orquestador, pero en local vive en `.env`, y sin esto el proceso arranca con
// todas las variables en undefined y falla mucho más adentro, con un error que
// no menciona la causa.
import { config } from 'dotenv';
config();

import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
// Import profundo ('@citara/api/src/app.module') no resolvía: apps/api no
// declaraba `main`/`types` y el import iba sin extensión. La convención de
// este repo (packages/db, packages/shared) es un único punto de entrada en
// `src/index.ts`; apps/api ya lo tiene (ver apps/api/src/index.ts) y expone
// justo lo que este worker necesita.
import { AppModule, InboundProcessor, INBOUND_QUEUE, type InboundJob } from '@citara/api';

async function bootstrap() {
  // createApplicationContext: sin servidor HTTP. Este proceso SOLO procesa
  // colas — compartir proceso con el servidor HTTP haría que el worker
  // compita por el event loop y sature el pool de conexiones mientras la
  // base de datos queda ociosa.
  const ctx = await NestFactory.createApplicationContext(AppModule);
  const processor = ctx.get(InboundProcessor);

  const worker = new Worker<InboundJob>(
    INBOUND_QUEUE,
    (job) => processor.process(job.data),
    {
      connection: { url: process.env.REDIS_URL },
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[inbound] job ${job?.id} falló: ${err.message}`);
  });

  const shutdown = async () => { await worker.close(); await ctx.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
void bootstrap();
