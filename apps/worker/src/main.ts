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
import { AppModule, startWorkers } from '@citara/api';

async function bootstrap() {
  // createApplicationContext: sin servidor HTTP. Este proceso SOLO procesa
  // colas — compartir proceso con el servidor HTTP haría que el worker
  // compita por el event loop y sature el pool de conexiones mientras la
  // base de datos queda ociosa.
  const ctx = await NestFactory.createApplicationContext(AppModule);
  const workers = startWorkers(ctx);

  const shutdown = async () => {
    await workers.close();
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
void bootstrap();
