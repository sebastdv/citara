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
export { OutboundProcessor } from './queues/outbound.processor';
export { OUTBOUND_QUEUE } from './queues/outbound.queue';
export type { OutboundJob } from './queues/outbound.queue';
// FlowRunner es quien de verdad cierra el circuito de entrada: persiste el
// mensaje entrante, avanza el flujo y encola la salida. apps/worker lo usa
// para procesar INBOUND_QUEUE en vez de llamar a InboundProcessor a secas
// (que solo persiste, sin ejecutar el motor de flujos).
export { FlowRunner } from './flow-engine/flow-runner.service';
