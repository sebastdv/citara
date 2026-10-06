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
  messageId: 'msg-placeholder',
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
      `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [tenantId, contact.id, channelId],
    ));

    // La fila la crea el flujo antes de encolar; el envío solo la completa.
    const [pendiente] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, status)
       VALUES ($1, $2, 'out', 'text', 'Hola', 'pending') RETURNING id`,
      [tenantId, conversation.id],
    ));

    const result = await processor.process(
      job({ conversationId: conversation.id, messageId: pendiente.id,
            idempotencyKey: 'idem-out-1' }),
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

  it('guarda el mismo vocabulario de `type` que el entrante', async () => {
    // `messages.type` lo leen por igual las filas entrantes y las salientes: el
    // panel de la fase 5 muestra la conversación completa en una sola lista.
    // Si el saliente guardara su `kind` interno ('buttons', 'list') y el
    // entrante el tipo de Meta ('interactive'), el significado de la columna
    // dependería de `direction`, y todo el que la consulte tendría que saberlo.
    // Botones y lista son las dos formas de un mismo mensaje interactivo, que
    // es exactamente lo que el entrante ya registra. El `kind` fino no se
    // pierde: queda en `payload`.
    const [contact] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, '573001112233'],
    ));
    const [conversation] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [tenantId, contact.id, channelId],
    ));

    const [pendiente] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, status)
       VALUES ($1, $2, 'out', 'text', 'pendiente', 'pending') RETURNING id`,
      [tenantId, conversation.id],
    ));

    await processor.process(job({
      conversationId: conversation.id,
      messageId: pendiente.id,
      idempotencyKey: 'idem-out-botones',
      content: { kind: 'buttons', body: '¿En qué te ayudo?',
                 buttons: [{ id: 'agendar', title: 'Agendar' }] },
    }));

    const [row] = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT type, payload FROM messages WHERE conversation_id = $1`,
              [conversation.id]));
    expect(row.type).toBe('interactive');
    // El detalle sigue disponible para quien lo necesite.
    expect(row.payload.kind).toBe('buttons');
  });

  it('actualiza la fila que ya creó el flujo en vez de insertar una segunda', async () => {
    // `FlowRunner` inserta la fila del saliente en el momento en que el flujo
    // lo produce —para que el panel vea el mensaje aunque el envío tarde o
    // falle— y encola el job. Si este procesador insertara otra fila al
    // enviar, cada mensaje del bot dejaría DOS filas en la conversación.
    // La fila se crea una vez y se completa con el wamid cuando Meta confirma.
    const [contact] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, '573001112233'],
    ));
    const [conversation] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [tenantId, contact.id, channelId],
    ));
    // La fila tal como la deja el flujo: sin wamid, porque aún no se ha enviado.
    const [pendiente] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body)
       VALUES ($1, $2, 'out', 'text', 'Hola') RETURNING id`,
      [tenantId, conversation.id],
    ));

    await processor.process(job({
      conversationId: conversation.id,
      messageId: pendiente.id,
      idempotencyKey: 'idem-out-update',
    }));

    const filas = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT id, wamid FROM messages WHERE conversation_id = $1`,
              [conversation.id]));
    expect(filas).toHaveLength(1);
    expect(filas[0].id).toBe(pendiente.id);
    expect(filas[0].wamid).toBe('wamid.OUT1');
  });

  it('no envía texto libre fuera de la ventana de 24 h y deja la fila marcada', async () => {
    // Meta rechaza el texto libre pasadas 24 h del último ENTRANTE; fuera de la
    // ventana solo vale una plantilla aprobada. La guarda va en el envío, no en
    // quien encola, porque un job puede esperar en la cola (reintentos, worker
    // caído) y cruzar el límite entre que se produce y que se envía.
    const [contact] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, '573001112233'],
    ));
    const [conversation] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
       VALUES ($1, $2, $3, now() - interval '25 hours') RETURNING id`,
      [tenantId, contact.id, channelId],
    ));
    const [pendiente] = await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, status)
       VALUES ($1, $2, 'out', 'text', 'Hola', 'pending') RETURNING id`,
      [tenantId, conversation.id],
    ));

    // No lanza: reintentar no reabre la ventana, así que quemar los cinco
    // intentos de BullMQ solo retrasaría el mismo desenlace.
    const result = await processor.process(job({
      conversationId: conversation.id, messageId: pendiente.id,
      idempotencyKey: 'idem-out-ventana',
    }));

    expect(sender.send).not.toHaveBeenCalled();
    expect(result.wamid).toBeNull();
    const [row] = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT status, wamid FROM messages WHERE id = $1`, [pendiente.id]));
    expect(row.status).toBe('window_closed');
    expect(row.wamid).toBeNull();
  });

  it('lanza si el canal no existe o está inactivo, sin llamar a MetaSender', async () => {
    await expect(
      processor.process(job({ channelId: '00000000-0000-0000-0000-000000000000' })),
    ).rejects.toThrow();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
