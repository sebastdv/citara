import { describe, it, expect } from 'vitest';
import {
  rehydrateEchoJob, rehydrateInboundJob, rehydrateStatusJob, type InboundJob,
} from '../../src/queues/inbound.queue';
import { rehydrateHistoryJob } from '../../src/queues/sync.queue';

describe('rehydrateInboundJob', () => {
  it('devuelve el timestamp como Date tras pasar por Redis', () => {
    // BullMQ serializa los jobs a JSON: el Date sale como string, y el tipo
    // InboundMessage miente del otro lado. El primer `.getTime()` reventaría.
    const job: InboundJob = {
      tenantId: 't', channelId: 'c',
      message: { wamid: 'w', phoneNumberId: 'p', wabaId: 'b', from: '57', profileName: null,
                 type: 'text', text: 'Hola', mediaId: null,
                 timestamp: new Date('2026-09-03T15:00:00Z'), raw: {} },
    };
    const fromRedis = JSON.parse(JSON.stringify(job));

    const back = rehydrateInboundJob(fromRedis);

    expect(back.message.timestamp).toBeInstanceOf(Date);
    expect(back.message.timestamp.toISOString()).toBe('2026-09-03T15:00:00.000Z');
  });
});

describe('rehidratación de los jobs de coexistencia', () => {
  const at = new Date('2026-10-06T15:00:00Z');
  const viaRedis = <T>(x: T): T => JSON.parse(JSON.stringify(x));

  it('devuelve como Date las fechas del eco, del estado y del historial', () => {
    const echo = rehydrateEchoJob(viaRedis({ tenantId: 't', channelId: 'c', echo: {
      wamid: 'w', phoneNumberId: 'p', wabaId: 'b', to: '57', type: 'text' as const,
      text: 'x', mediaId: null, timestamp: at, raw: {} } }));
    const status = rehydrateStatusJob(viaRedis({ tenantId: 't', status: {
      wamid: 'w', phoneNumberId: 'p', wabaId: 'b', status: 'read', timestamp: at } }));
    const history = rehydrateHistoryJob(viaRedis({ tenantId: 't', channelId: 'c', chunk: {
      phoneNumberId: 'p', wabaId: 'b', phase: 2, progress: 100, declined: false,
      threads: [{ waId: '57', messages: [{ wamid: 'w', from: '57', type: 'text' as const,
        text: 'x', mediaId: null, timestamp: at, raw: {} }] }] } }));

    expect(echo.echo.timestamp).toBeInstanceOf(Date);
    expect(status.status.timestamp).toBeInstanceOf(Date);
    expect(history.chunk.threads[0].messages[0].timestamp.toISOString()).toBe(at.toISOString());
  });
});
