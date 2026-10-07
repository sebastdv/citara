import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { StatusProcessor } from '../../src/queues/status.processor';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: StatusProcessor;
let tenantId: string;

const statusOf = async (wamid: string) =>
  (await adminQuery(`SELECT status FROM messages WHERE wamid = $1`, [wamid]))[0]?.status;
const apply = (wamid: string, status: string) => processor.process({
  tenantId, status: { wamid, status, phoneNumberId: '106540', wabaId: '102290', timestamp: new Date() } });

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new StatusProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  let channelId: string;
  ({ tenantId, channelId } = await seedChannel());
  const [k] = await adminQuery(`INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, '573001112233') RETURNING id`, [tenantId]);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, k.id, channelId]);
  await adminQuery(
    `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type, body, status)
     VALUES ($1, $2, 'wamid.S1', 'out', 'bot', 'text', 'Hola', 'sent'),
            ($1, $2, 'wamid.P1', 'out', 'phone', 'text', 'Ya voy', NULL)`,
    [tenantId, c.id]);
});

describe('StatusProcessor', () => {
  it('avanza sent → delivered → read', async () => {
    await apply('wamid.S1', 'delivered');
    expect(await statusOf('wamid.S1')).toBe('delivered');
    await apply('wamid.S1', 'read');
    expect(await statusOf('wamid.S1')).toBe('read');
  });

  it('nunca retrocede: un delivered que llega tarde no pisa un read', async () => {
    await apply('wamid.S1', 'read');
    const r = await apply('wamid.S1', 'delivered');
    expect(r.updated).toBe(false);
    expect(await statusOf('wamid.S1')).toBe('read');
  });

  it('registra un fallo que Meta reporta después de haber aceptado', async () => {
    await apply('wamid.S1', 'failed');
    expect(await statusOf('wamid.S1')).toBe('failed');
  });

  it('no toca los mensajes que no salieron por nosotros', async () => {
    await apply('wamid.P1', 'read');
    expect(await statusOf('wamid.P1')).toBeNull();
  });

  it('ignora un wamid desconocido o un estado que no reconoce', async () => {
    expect((await apply('wamid.NOPE', 'read')).updated).toBe(false);
    expect((await apply('wamid.S1', 'deleted')).updated).toBe(false);
    expect(await statusOf('wamid.S1')).toBe('sent');
  });
});
