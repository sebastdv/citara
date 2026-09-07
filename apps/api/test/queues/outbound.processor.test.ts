import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { OutboundProcessor } from '../../src/queues/outbound.processor';
import type { OutboundJob } from '../../src/queues/outbound.queue';
import { resetDb, seedChannel } from '../helpers';

let app: DataSource;
let channels: ChannelResolver;
// MetaSender de mentira: nunca se llama a la red real en un test.
let sender: { send: ReturnType<typeof vi.fn> };
let processor: OutboundProcessor;
let tenantId: string, channelId: string;

const job = (over: Partial<OutboundJob> = {}): OutboundJob => ({
  tenantId, channelId, conversationId: 'conv-placeholder',
  to: '573001112233', idempotencyKey: 'idem-1',
  content: { kind: 'text', body: 'Hola' }, ...over,
});

beforeAll(async () => {
  app = createDataSource(process.env.DATABASE_URL!);
  await app.initialize();
  const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
  await enc.ready();
  channels = new ChannelResolver(app, enc);
});
afterAll(async () => { await app.destroy(); });

beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  sender = { send: vi.fn().mockResolvedValue({ wamid: 'wamid.OUT1' }) };
  processor = new OutboundProcessor(app, channels, sender as never);
});

describe('OutboundProcessor', () => {
  it('envía por MetaSender y persiste el mensaje saliente con su wamid', async () => {
    // La conversación debe existir de verdad: messages.conversation_id
    // referencia conversations(id).
    const [contact] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, '573001112233'],
    ));
    const [conversation] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, contact.id, channelId],
    ));

    const result = await processor.process(
      job({ conversationId: conversation.id, idempotencyKey: 'idem-out-1' }),
    );

    expect(result.wamid).toBe('wamid.OUT1');
    expect(sender.send).toHaveBeenCalledTimes(1);
    const [channelArg, to, content] = sender.send.mock.calls[0];
    expect(channelArg.phoneNumberId).toBe('106540');
    expect(to).toBe('573001112233');
    expect(content).toEqual({ kind: 'text', body: 'Hola' });

    const rows = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT * FROM messages WHERE conversation_id = $1`, [conversation.id]));
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('out');
    expect(rows[0].wamid).toBe('wamid.OUT1');
    expect(rows[0].body).toBe('Hola');
  });

  it('lanza si el canal no existe o está inactivo, sin llamar a MetaSender', async () => {
    await expect(
      processor.process(job({ channelId: '00000000-0000-0000-0000-000000000000' })),
    ).rejects.toThrow();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
