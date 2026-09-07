// Punto de entrada público del paquete @citara/api.
//
// apps/worker necesita AppModule, InboundProcessor y el contrato de la cola
// de entrada para arrancar sin servidor HTTP (ver apps/worker/src/main.ts).
// apps/api/package.json no tenía `main` ni `types`, así que un import
// profundo como '@citara/api/src/app.module' no resolvía (sin extensión y
// sin `exports`). La convención de este repo (packages/db, packages/shared)
// es exponer un único `src/index.ts` y apuntar `main`/`types` ahí.
export { AppModule } from './app.module';
export { InboundProcessor } from './queues/inbound.processor';
export { INBOUND_QUEUE } from './queues/inbound.queue';
export type { InboundJob } from './queues/inbound.queue';
