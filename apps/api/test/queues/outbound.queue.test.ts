import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { OutboundQueue, OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';
import type { OutboundJob } from '../../src/queues/outbound.queue';

let queue: OutboundQueue;
// Instancia aparte solo para limpiar antes/después: los jobs de esta cola no
// los procesa nadie en este test, así que quedarían "waiting" para siempre
// en Redis si no se purgan.
let probe: Queue;

const job = (over: Partial<OutboundJob> = {}): OutboundJob => ({
  tenantId: 't', channelId: 'c', conversationId: 'conv',
  turnId: '8d0e2c1a-1111-2222-3333-444455556666', to: '573001112233', ...over,
});

beforeAll(async () => {
  probe = new Queue(OUTBOUND_QUEUE, { connection: { url: process.env.REDIS_URL } });
  await probe.obliterate({ force: true });
  queue = new OutboundQueue();
});

afterAll(async () => {
  await queue.onModuleDestroy();
  await probe.obliterate({ force: true });
  await probe.close();
});

describe('OutboundQueue', () => {
  it('usa el id del turno como jobId, y BullMQ lo acepta', async () => {
    // Un uuid real, no un id inventado: el jobId anterior llevaba `:` y BullMQ
    // lo rechazaba, cosa que un id de juguete sin `:` jamás habría delatado.
    const turnId = '1f2e3d4c-aaaa-bbbb-cccc-000011112222';
    const added = await queue.add(job({ turnId }));
    expect(added.id).toBe(turnId);
  });

  it('no encola dos veces el mismo turno', async () => {
    const turnId = '1f2e3d4c-aaaa-bbbb-cccc-333344445555';
    await queue.add(job({ turnId, to: '111' }));
    await queue.add(job({ turnId, to: '222' }));

    // BullMQ no sobrescribe un jobId ya existente. Esto evita ENCOLAR dos
    // veces; no evita re-ejecutar el job (eso lo cubre el reclamo de filas).
    const found = await probe.getJob(turnId);
    expect(found?.data.to).toBe('111');
  });

  it('requeue vuelve a encolar un job ya terminado (fallido o completado) y no toca uno que espera', async () => {
    const failId = '1f2e3d4c-aaaa-bbbb-cccc-666677778888';
    const doneId = '1f2e3d4c-aaaa-bbbb-cccc-999900001111';
    const msgJob = (messageId: string): OutboundJob => ({ tenantId: 't', channelId: 'c', conversationId: 'conv', to: '57', messageId });
    await probe.obliterate({ force: true });
    await queue.add(msgJob(failId));
    await queue.add(msgJob(doneId));
    const events = new QueueEvents(OUTBOUND_QUEUE, { connection: { url: process.env.REDIS_URL } });
    await events.waitUntilReady();
    const settled = new Promise<void>((ok) => {
      let n = 0;
      const tick = () => { if (++n === 2) ok(); };
      events.on('failed', tick);
      events.on('completed', tick);
    });
    const worker = new Worker(OUTBOUND_QUEUE, async (j) => {
      if (j.id === failId) throw new UnrecoverableError('reintentos agotados');
    }, { connection: { url: process.env.REDIS_URL } });
    await settled;
    await worker.close();
    await events.close();
    expect([await (await probe.getJob(failId))!.getState(), await (await probe.getJob(doneId))!.getState()])
      .toEqual(['failed', 'completed']);

    await queue.requeue(msgJob(failId));
    await queue.requeue(msgJob(doneId));
    expect([await (await probe.getJob(failId))!.getState(), await (await probe.getJob(doneId))!.getState()])
      .toEqual(['waiting', 'waiting']);
    await queue.requeue(msgJob(failId));   // ya espera: no duplica ni falla
    expect(await probe.getWaitingCount()).toBe(2);
  });
});
