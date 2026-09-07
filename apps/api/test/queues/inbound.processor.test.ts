import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { InboundProcessor } from '../../src/queues/inbound.processor';
import { resetDb, seedChannel } from '../helpers';
import type { InboundMessage } from '@citara/shared';

let app: DataSource, processor: InboundProcessor;
let tenantId: string, channelId: string;

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  wamid: 'wamid.P1', phoneNumberId: '106540', wabaId: '102290',
  from: '573001112233', profileName: 'Ana', type: 'text', text: 'Hola',
  mediaId: null, timestamp: new Date('2026-09-03T15:00:00Z'), raw: {}, ...over,
});

beforeAll(async () => {
  app = createDataSource(process.env.DATABASE_URL!);
  await app.initialize();
  processor = new InboundProcessor(app);
});
beforeEach(async () => { await resetDb(); ({ tenantId, channelId } = await seedChannel()); });
afterAll(async () => { await app.destroy(); });

describe('InboundProcessor', () => {
  it('crea contacto, conversación y mensaje en la primera interacción', async () => {
    await processor.process({ tenantId, channelId, message: msg() });

    const rows = await runInTenant(app, tenantId, async (m) => ({
      contacts: await m.query(`SELECT * FROM contacts`),
      conversations: await m.query(`SELECT * FROM conversations`),
      messages: await m.query(`SELECT * FROM messages`),
    }));

    expect(rows.contacts).toHaveLength(1);
    expect(rows.contacts[0].wa_id).toBe('573001112233');
    expect(rows.conversations).toHaveLength(1);
    expect(rows.messages).toHaveLength(1);
    expect(rows.messages[0].direction).toBe('in');
    expect(rows.messages[0].body).toBe('Hola');
  });

  it('reutiliza contacto y conversación en la segunda interacción', async () => {
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.A' }) });
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.B', text: 'Otra' }) });

    const rows = await runInTenant(app, tenantId, async (m) => ({
      contacts: await m.query(`SELECT * FROM contacts`),
      conversations: await m.query(`SELECT * FROM conversations`),
      messages: await m.query(`SELECT * FROM messages ORDER BY created_at`),
    }));

    expect(rows.contacts).toHaveLength(1);
    expect(rows.conversations).toHaveLength(1);
    expect(rows.messages).toHaveLength(2);
  });

  it('actualiza last_inbound_at para la ventana de 24 horas', async () => {
    const at = new Date('2026-09-03T15:00:00Z');
    await processor.process({ tenantId, channelId, message: msg({ timestamp: at }) });

    const [conv] = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT last_inbound_at FROM conversations`));
    expect(new Date(conv.last_inbound_at).toISOString()).toBe(at.toISOString());
  });
});
