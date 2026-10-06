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

  it('no hace retroceder last_inbound_at si un mensaje viejo llega tarde', async () => {
    // Meta no garantiza orden de entrega y el worker procesa en paralelo. Si
    // el más viejo se procesa último, la ventana de 24 h no puede encogerse.
    const nuevo = new Date('2026-09-03T15:00:00Z');
    const viejo = new Date('2026-09-03T14:00:00Z');
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.N', timestamp: nuevo }) });
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.V', timestamp: viejo }) });

    const [conv] = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT last_inbound_at FROM conversations`));
    expect(new Date(conv.last_inbound_at).toISOString()).toBe(nuevo.toISOString());
  });

  it('una reentrega no crea una conversación nueva si la original ya se cerró', async () => {
    // El duplicado se reconoce ANTES de tocar conversaciones: si no, el upsert
    // abre una conversación vacía para un mensaje que pertenece a la cerrada.
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.CERR' }) });
    await runInTenant(app, tenantId, (m) => m.query(`UPDATE conversations SET status = 'closed'`));

    const again = await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.CERR' }) });

    expect(again.messageId).toBe('');
    const convs = await runInTenant(app, tenantId, (m) => m.query(`SELECT status FROM conversations`));
    expect(convs).toEqual([{ status: 'closed' }]);
  });
});
