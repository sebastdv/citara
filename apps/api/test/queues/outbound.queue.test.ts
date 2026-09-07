import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { OutboundQueue, OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';
import type { OutboundJob } from '../../src/queues/outbound.queue';

let queue: OutboundQueue;
// Instancia aparte solo para limpiar antes/después: los jobs de esta cola no
// los procesa nadie en este test, así que quedarían "waiting" para siempre
// en Redis si no se purgan.
let probe: Queue;

const job = (over: Partial<OutboundJob> = {}): OutboundJob => ({
  tenantId: 't', channelId: 'c', conversationId: 'conv',
  to: '573001112233', idempotencyKey: 'idem-1',
  content: { kind: 'text', body: 'Hola' }, ...over,
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
  it('usa idempotencyKey como jobId: la segunda barrera contra el doble envío', async () => {
    const added = await queue.add(job({ idempotencyKey: 'idem-unico-1' }));
    expect(added.id).toBe('idem-unico-1');
  });

  it('no reemplaza el job si se reintenta con la misma idempotencyKey', async () => {
    await queue.add(job({ idempotencyKey: 'idem-repetido', to: '111' }));
    await queue.add(job({ idempotencyKey: 'idem-repetido', to: '222' }));

    // BullMQ no sobrescribe un jobId ya existente: el dato persistido sigue
    // siendo el del primer add(). Esa es la barrera contra el doble envío.
    const found = await probe.getJob('idem-repetido');
    expect(found?.data.to).toBe('111');
  });
});
