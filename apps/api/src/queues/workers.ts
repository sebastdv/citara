import type { INestApplicationContext } from '@nestjs/common';
import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import { FlowRunner } from '../flow-engine/flow-runner.service';
import {
  INBOUND_QUEUE, rehydrateEchoJob, rehydrateInboundJob, rehydrateStatusJob,
  type AccountUpdateJob, type EchoJob, type InboundJob, type StatusJob,
} from './inbound.queue';
import { SYNC_QUEUE, rehydrateHistoryJob, type ContactsSyncJob, type HistoryJob } from './sync.queue';
import { StatusProcessor } from './status.processor';
import { EchoProcessor } from '../coexistence/echo.processor';
import { HistoryProcessor } from '../coexistence/history.processor';
import { ContactsSyncProcessor } from '../coexistence/contacts-sync.processor';
import { AccountUpdateProcessor } from '../coexistence/account-update.processor';
import { RemindersService } from '../scheduling/reminders.service';
import { RemindersQueue, REMINDERS_QUEUE } from './reminders.queue';
import { OutboundQueue } from './outbound.queue';
import { OutboundProcessor } from './outbound.processor';
import { OUTBOUND_QUEUE, type OutboundJob } from './outbound.queue';
import { CALENDAR_QUEUE, CalendarQueue, type AccountJob, type PushJob } from './calendar.queue';
import { CalendarSweep } from '../google/calendar-sweep.service';
import { CalendarPushProcessor } from '../google/calendar-push.processor';
import { CalendarPullProcessor } from '../google/calendar-pull.processor';
import { CalendarWatchService } from '../google/calendar-watch.service';
import { CalendarHealthProcessor } from '../google/calendar-health.processor';
import { AGENT_QUEUE, type AgentJob } from './agent.queue';
import { AgentProcessor } from '../agent/agent.processor';

/**
 * Arranca los consumidores de las colas sobre un contexto de Nest ya creado.
 * Vive aquí, y no en apps/worker, para que los tests de punta a punta levanten
 * EXACTAMENTE el mismo cableado que producción: el arnés con cola de mentira
 * no ejercita Redis, y por esa costura se coló un jobId que BullMQ rechaza.
 */
export function startWorkers(
  ctx: INestApplicationContext,
  opts: { concurrency?: number; scheduleReminders?: boolean; scheduleCalendar?: boolean } = {},
): { close: () => Promise<void> } {
  const connection = { url: process.env.REDIS_URL };
  const concurrency = opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 10);

  // FlowRunner, no InboundProcessor a secas: InboundProcessor solo persiste
  // el entrante; FlowRunner además avanza el flujo y encola la salida.
  const flowRunner = ctx.get(FlowRunner);
  const outboundProcessor = ctx.get(OutboundProcessor);

  const echoes = ctx.get(EchoProcessor);
  const statuses = ctx.get(StatusProcessor);
  const accounts = ctx.get(AccountUpdateProcessor);
  const history = ctx.get(HistoryProcessor);
  const contacts = ctx.get(ContactsSyncProcessor);

  const inbound = new Worker<InboundJob | EchoJob | StatusJob | AccountUpdateJob>(
    INBOUND_QUEUE,
    (job) => {
      switch (job.name) {
        case 'process': return flowRunner.handle(rehydrateInboundJob(job.data as InboundJob));
        case 'phone_echo': return echoes.process(rehydrateEchoJob(job.data as EchoJob));
        case 'status': return statuses.process(rehydrateStatusJob(job.data as StatusJob));
        case 'account_update': return accounts.process(job.data as AccountUpdateJob);
        default: throw new UnrecoverableError(`job de entrada desconocido: ${job.name}`);
      }
    },
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
    // Último intento gastado: lo que no salió queda `failed` en vez de
    // `pending` para siempre. Un UnrecoverableError ya cerró sus filas.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      outboundProcessor.failTurn(job.data).catch((e: Error) =>
        console.error(`[outbound] no se pudo cerrar el turno ${job.id}: ${e.message}`));
    }
  });
  outbound.on('error', (err) => console.error(`[outbound] error del worker: ${err.message}`));

  // Concurrencia 1: el historial llega en tandas grandes y nada aquí es
  // urgente; un solo chunk a la vez acota cuántas conversaciones bloquea la
  // importación al mismo tiempo. (La regla del dueño activo corre en cada
  // chunk, así que no depende de este orden.)
  const sync = new Worker<HistoryJob | ContactsSyncJob>(
    SYNC_QUEUE,
    (job) => {
      switch (job.name) {
        case 'history_chunk': return history.process(rehydrateHistoryJob(job.data as HistoryJob));
        case 'contacts_sync': return contacts.process(job.data as ContactsSyncJob);
        default: throw new UnrecoverableError(`job de sync desconocido: ${job.name}`);
      }
    },
    { connection, concurrency: 1 },
  );
  sync.on('failed', (job, err) => console.error(`[sync] job ${job?.id} falló: ${err.message}`));
  sync.on('error', (err) => console.error(`[sync] error del worker: ${err.message}`));

  const reminders = ctx.get(RemindersService);
  const outboundQueue = ctx.get(OutboundQueue);
  // Concurrencia 1: un barrido a la vez. Si el encolado falla, el siguiente
  // barrido re-encola los huérfanos (outbox).
  const remindersWorker = new Worker(REMINDERS_QUEUE, async () => {
    for (const { job, delay } of await reminders.sweep(new Date())) await outboundQueue.add(job, { delay });
  }, { connection, concurrency: 1 });
  remindersWorker.on('failed', (job, err) => console.error(`[reminders] job ${job?.id} falló: ${err.message}`));
  remindersWorker.on('error', (err) => console.error(`[reminders] error del worker: ${err.message}`));
  if (opts.scheduleReminders !== false) {
    void ctx.get(RemindersQueue).schedule()
      .catch((err: Error) => console.error(`[reminders] no se pudo programar el barrido: ${err.message}`));
  }

  const calendarQueue = ctx.get(CalendarQueue);
  const sweep = ctx.get(CalendarSweep);
  const push = ctx.get(CalendarPushProcessor);
  const pull = ctx.get(CalendarPullProcessor);
  const watch = ctx.get(CalendarWatchService);
  const health = ctx.get(CalendarHealthProcessor);
  // Concurrencia 5: cada job es una o dos llamadas a Google; el barrido solo lee.
  const calendar = new Worker(CALENDAR_QUEUE, async (job) => {
    switch (job.name) {
      case 'sweep': for (const j of await sweep.run(new Date())) await calendarQueue.add(j); return;
      case 'push': return push.process(job.data as PushJob);
      case 'pull': return pull.process(job.data as AccountJob);
      case 'watch': return watch.renew(job.data as AccountJob);
      case 'health': return health.process(job.data as AccountJob);
      default: throw new UnrecoverableError(`job de calendario desconocido: ${job.name}`);
    }
  }, { connection, concurrency: 5 });
  calendar.on('failed', (job, err) => {
    console.error(`[calendar] job ${job?.id} falló: ${err.message}`);
    // Reintentos agotados: la cita queda `failed` y el chequeo diario la retoma.
    if (job?.name === 'push' && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      push.markFailed(job.data as PushJob).catch((e: Error) =>
        console.error(`[calendar] no se pudo marcar la cita ${(job.data as PushJob).appointmentId}: ${e.message}`));
    }
  });
  calendar.on('error', (err) => console.error(`[calendar] error del worker: ${err.message}`));
  if (opts.scheduleCalendar !== false) {
    void calendarQueue.schedule()
      .catch((err: Error) => console.error(`[calendar] no se pudo programar el barrido: ${err.message}`));
  }

  const agentProcessor = ctx.get(AgentProcessor);
  // Concurrencia 5: cada job es sobre todo espera de red al modelo. El lease
  // serializa por conversación; si otro job lo tiene, este vuelve en 1,5 s.
  const agent = new Worker<AgentJob>(AGENT_QUEUE, async (job, token) => {
    const r = await agentProcessor.process(job.data);
    if (r === 'busy') {
      await job.moveToDelayed(Date.now() + 1500, token);
      throw new DelayedError();
    }
    return r;
  }, { connection, concurrency: 5 });
  agent.on('failed', (job, err) => {
    console.error(`[agent] job ${job?.id} falló: ${err.message}`);
    // Al usuario nunca se le deja en silencio (spec §7.2).
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      agentProcessor.failSafe(job.data).catch((e: Error) =>
        console.error(`[agent] no se pudo degradar el job ${job.id}: ${e.message}`));
    }
  });
  agent.on('error', (err) => console.error(`[agent] error del worker: ${err.message}`));

  return {
    close: async () => { await inbound.close(); await outbound.close(); await sync.close();
      await remindersWorker.close(); await calendar.close(); await agent.close(); },
  };
}
