import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import type { PhoneEcho } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { EchoProcessor } from '../../src/coexistence/echo.processor';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: EchoProcessor;
let tenantId: string, channelId: string;

const echo = (over: Partial<PhoneEcho> = {}): PhoneEcho => ({
  wamid: 'wamid.ECHO1', phoneNumberId: '106540', wabaId: '102290', to: '573001112233',
  type: 'text', text: 'Ya te atiendo', mediaId: null, timestamp: new Date(), raw: {}, ...over,
});
const conversation = async () => (await adminQuery(
  `SELECT control, human_until, control_reason, last_inbound_at FROM conversations`))[0];

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new EchoProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId, channelId } = await seedChannel()); });

describe('EchoProcessor', () => {
  it('guarda el eco como saliente del teléfono y le da el control al dueño', async () => {
    const at = new Date();
    await processor.process({ tenantId, channelId, echo: echo({ timestamp: at }) });

    const [m] = await adminQuery(`SELECT direction, origin, body, occurred_at, status FROM messages`);
    expect(m).toMatchObject({ direction: 'out', origin: 'phone', body: 'Ya te atiendo', status: null });
    expect(new Date(m.occurred_at).toISOString()).toBe(at.toISOString());
    const c = await conversation();
    expect(c.control).toBe('human');
    expect(c.control_reason).toBe('phone');
    expect(new Date(c.human_until).getTime()).toBe(at.getTime() + 12 * 3_600_000);
  });

  it('lo que escribe el negocio no abre la ventana de 24 h', async () => {
    await processor.process({ tenantId, channelId, echo: echo() });
    expect((await conversation()).last_inbound_at).toBeNull();
  });

  it('un eco a un cliente nuevo crea el contacto y la conversación', async () => {
    await processor.process({ tenantId, channelId, echo: echo({ to: '573009990000' }) });
    const [k] = await adminQuery(`SELECT wa_id FROM contacts`);
    expect(k.wa_id).toBe('573009990000');
  });

  it('el mismo eco dos veces no se duplica ni se audita dos veces', async () => {
    await processor.process({ tenantId, channelId, echo: echo() });
    const again = await processor.process({ tenantId, channelId, echo: echo() });

    expect(again.duplicate).toBe(true);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    const [{ a }] = await adminQuery(`SELECT count(*)::int AS a FROM audit_log`);
    expect([n, a]).toEqual([1, 1]);
  });

  it('cada eco nuevo alarga el plazo del dueño', async () => {
    const first = new Date(Date.now() - 3_600_000);
    const second = new Date();
    await processor.process({ tenantId, channelId, echo: echo({ wamid: 'wamid.EA', timestamp: first }) });
    await processor.process({ tenantId, channelId, echo: echo({ wamid: 'wamid.EB', timestamp: second }) });

    expect(new Date((await conversation()).human_until).getTime())
      .toBe(second.getTime() + 12 * 3_600_000);
  });

  it('un eco de un tipo que no entendemos sigue siendo el dueño atendiendo', async () => {
    // Un sticker o una reacción desde el celular: no hay texto, pero el dueño
    // está en la conversación y el bot no debe meterse.
    await processor.process({ tenantId, channelId, echo: echo({ type: 'unsupported', text: null }) });
    expect((await conversation()).control).toBe('human');
  });
});
