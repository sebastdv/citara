import { describe, it, expect } from 'vitest';
import { rehydrateInboundJob, type InboundJob } from '../../src/queues/inbound.queue';

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
