import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { UnrecoverableError } from 'bullmq';
import type { OutboundContent } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { OutboundProcessor } from '../../src/queues/outbound.processor';
import type { OutboundJob } from '../../src/queues/outbound.queue';
import { MetaSendError } from '../../src/whatsapp/sender';
import { resetDb, seedChannel, adminQuery } from '../helpers';

let app: DataSource;
let channels: ChannelResolver;
// MetaSender de mentira: nunca se llama a la red real en un test.
let sender: { send: ReturnType<typeof vi.fn> };
let processor: OutboundProcessor;
let tenantId: string, channelId: string;

const HOLA: OutboundContent = { kind: 'text', body: 'Hola' };
const MENU: OutboundContent = { kind: 'buttons', body: '¿En qué te ayudo?',
                                buttons: [{ id: 'agendar', title: 'Agendar' }] };

/**
 * Deja un turno como lo deja FlowRunner: el entrante y sus salientes en
 * `pending`, enlazados por `reply_to_id` y ordenados por `seq`.
 */
async function seedTurn(contents: OutboundContent[], lastInbound = `now()`) {
  return runInTenant(app, tenantId, async (m) => {
    const [contact] = await m.query(
      `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, '573001112233') RETURNING id`,
      [tenantId]);
    const [conv] = await m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
       VALUES ($1, $2, $3, ${lastInbound}) RETURNING id`,
      [tenantId, contact.id, channelId]);
    const [inbound] = await m.query(
      `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type, body)
       VALUES ($1, $2, 'wamid.IN1', 'in', 'customer', 'text', 'Hola') RETURNING id`,
      [tenantId, conv.id]);
    for (const [seq, c] of contents.entries()) {
      await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload,
                               status, reply_to_id, seq)
         VALUES ($1, $2, 'out', 'bot', 'text', $3, $4, 'pending', $5, $6)`,
        [tenantId, conv.id, c.body, JSON.stringify(c), inbound.id, seq]);
    }
    const job: OutboundJob = { tenantId, channelId, conversationId: conv.id,
                               turnId: inbound.id, to: '573001112233' };
    return job;
  });
}

const outRows = (): Promise<{ status: string; wamid: string | null; body: string }[]> =>
  adminQuery(`SELECT status, wamid, body FROM messages WHERE direction = 'out' ORDER BY seq`);

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
  let n = 0;
  sender = { send: vi.fn().mockImplementation(async () => ({ wamid: `wamid.OUT${++n}` })) };
  processor = new OutboundProcessor(app, channels, sender as never);
});

describe('OutboundProcessor', () => {
  it('envía en orden los salientes del turno y los completa con su wamid', async () => {
    const job = await seedTurn([HOLA, MENU]);

    await processor.process(job);

    expect(sender.send.mock.calls.map(([, , c]) => c.body)).toEqual(['Hola', '¿En qué te ayudo?']);
    const [channelArg, to] = sender.send.mock.calls[0];
    expect(channelArg.phoneNumberId).toBe('106540');
    expect(to).toBe('573001112233');
    expect(await outRows()).toEqual([
      { status: 'sent', wamid: 'wamid.OUT1', body: 'Hola' },
      { status: 'sent', wamid: 'wamid.OUT2', body: '¿En qué te ayudo?' },
    ]);
  });

  it('re-ejecutar el mismo job no reenvía lo que ya salió', async () => {
    const job = await seedTurn([HOLA, MENU]);

    await processor.process(job);
    await processor.process(job);

    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('no reenvía a ciegas una fila que un intento muerto dejó reclamada', async () => {
    // Un intento previo marcó la fila como `sending` y murió: pudo haber
    // llegado a Meta o no. Reenviarla arriesga un duplicado; se marca para
    // revisión y el turno sigue con lo demás.
    const job = await seedTurn([HOLA, MENU]);
    await adminQuery(`UPDATE messages SET status = 'sending',
                        claimed_at = now() - interval '10 minutes' WHERE body = 'Hola'`);

    await processor.process(job);

    expect(sender.send.mock.calls.map(([, , c]) => c.body)).toEqual(['¿En qué te ayudo?']);
    expect((await outRows()).map((r) => r.status)).toEqual(['unconfirmed', 'sent']);
  });

  it('no envía una fila que otro intento ganó entre la lectura y el envío', async () => {
    // Dos ejecuciones del mismo turno en paralelo leen las mismas filas
    // pendientes. Mientras esta envía la primera, la otra ya completó la
    // segunda: el reclamo atómico tiene que perder, no "ganar" siempre.
    const job = await seedTurn([HOLA, MENU]);
    sender.send.mockImplementationOnce(async () => {
      await adminQuery(`UPDATE messages SET status = 'sent' WHERE body = '¿En qué te ayudo?'`);
      return { wamid: 'wamid.OUT1' };
    });

    await processor.process(job);

    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('un fallo transitorio devuelve la fila a pending y corta el turno para preservar el orden', async () => {
    const job = await seedTurn([HOLA, MENU]);
    sender.send.mockRejectedValueOnce(new MetaSendError('Graph 503', 'retry', 503));

    await expect(processor.process(job)).rejects.toThrow('Graph 503');

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect((await outRows()).map((r) => r.status)).toEqual(['pending', 'pending']);

    // El reintento de BullMQ completa el turno en orden.
    await processor.process(job);
    expect(sender.send.mock.calls.map(([, , c]) => c.body))
      .toEqual(['Hola', 'Hola', '¿En qué te ayudo?']);
  });

  it('un rechazo permanente marca el turno como fallido y no gasta reintentos', async () => {
    const job = await seedTurn([HOLA, MENU]);
    sender.send.mockRejectedValueOnce(new MetaSendError('token inválido', 'permanent', 401));

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await outRows()).map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  it('no envía texto libre fuera de la ventana de 24 h y deja las filas marcadas', async () => {
    // Meta rechaza el texto libre pasadas 24 h del último ENTRANTE. La guarda
    // va en el envío porque un job puede esperar en la cola y cruzar el límite.
    // No lanza: reintentar no reabre la ventana.
    const job = await seedTurn([HOLA], `now() - interval '25 hours'`);

    await processor.process(job);

    expect(sender.send).not.toHaveBeenCalled();
    expect(await outRows()).toEqual([{ status: 'window_closed', wamid: null, body: 'Hola' }]);
  });

  it('una fila reclamada hace poco es de un envío en curso: no se toca ni se adelanta', async () => {
    // Un job "atascado" que BullMQ re-ejecuta mientras el original sigue en el
    // fetch: si este intento la marcara `unconfirmed` y siguiera, enviaría el
    // menú antes que el saludo y pisaría el `sent` que el original va a poner.
    const job = await seedTurn([HOLA, MENU]);
    await adminQuery(`UPDATE messages SET status = 'sending', claimed_at = now() WHERE body = 'Hola'`);

    await expect(processor.process(job)).rejects.toThrow(/en curso/);

    expect(sender.send).not.toHaveBeenCalled();
    expect((await outRows()).map((r) => r.status)).toEqual(['sending', 'pending']);
  });

  it('una respuesta ambigua de Meta no se reenvía: queda unconfirmed y el turno sigue', async () => {
    const job = await seedTurn([HOLA, MENU]);
    sender.send.mockRejectedValueOnce(new MetaSendError('timeout', 'ambiguous'));

    await processor.process(job);

    expect(sender.send).toHaveBeenCalledTimes(2);
    expect((await outRows()).map((r) => r.status)).toEqual(['unconfirmed', 'sent']);
  });

  it('marcar unconfirmed no pisa el sent que otro intento ya confirmó', async () => {
    // Mientras este intento espera una respuesta que termina ambigua, el
    // original (re-ejecutado por BullMQ) confirma la misma fila. La transición
    // tiene que perder: el mensaje SÍ salió.
    const job = await seedTurn([HOLA]);
    sender.send.mockImplementationOnce(async () => {
      await adminQuery(`UPDATE messages SET status = 'sent', wamid = 'wamid.ORIG'
                         WHERE direction = 'out' AND body = 'Hola'`);
      throw new MetaSendError('timeout', 'ambiguous');
    });

    await processor.process(job);

    expect(await outRows()).toEqual([{ status: 'sent', wamid: 'wamid.ORIG', body: 'Hola' }]);
  });

  it('si Meta dice que la ventana cerró, el turno queda window_closed sin reintentos', async () => {
    // Nuestro reloj y el de Meta pueden diferir: manda el veredicto de Meta.
    const job = await seedTurn([HOLA, MENU]);
    sender.send.mockRejectedValueOnce(new MetaSendError('131047', 'window', 400, 131047));

    await processor.process(job);

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect((await outRows()).map((r) => r.status)).toEqual(['window_closed', 'window_closed']);
  });

  it('un rechazo permanente no pisa una fila que otro intento ya envió', async () => {
    const job = await seedTurn([HOLA, MENU]);
    sender.send.mockImplementationOnce(async () => {
      await adminQuery(`UPDATE messages SET status = 'sent' WHERE body = '¿En qué te ayudo?'`);
      throw new MetaSendError('token inválido', 'permanent', 401);
    });

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await outRows()).map((r) => r.status)).toEqual(['failed', 'sent']);
  });

  it('agotar los reintentos deja lo pendiente del turno como failed', async () => {
    // Sin esto, un Graph caído más que el backoff deja el turno en `pending`
    // para siempre: ni se envía ni el panel sabe que falló.
    const job = await seedTurn([HOLA, MENU]);
    await adminQuery(`UPDATE messages SET status = 'sent' WHERE body = 'Hola'`);

    await processor.failTurn(job);

    expect((await outRows()).map((r) => r.status)).toEqual(['sent', 'failed']);
  });

  const humanTookOver = (reason: string, until = `now() + interval '1 hour'`) =>
    adminQuery(`UPDATE conversations SET control = 'human', human_until = ${until},
                control_reason = '${reason}'`);

  it('si el dueño contestó desde el celular antes del envío, lo del bot no sale', async () => {
    // El bot produjo el saludo y, en el mismo segundo, llegó el eco del dueño.
    const job = await seedTurn([HOLA, MENU]);
    await humanTookOver('phone');

    await processor.process(job);

    expect(sender.send).not.toHaveBeenCalled();
    expect((await outRows()).map((r) => r.status)).toEqual(['superseded', 'superseded']);
  });

  it('si el dueño contesta mientras sale el primer mensaje, lo que sigue del bot no sale', async () => {
    // El control se mide por fila, en el reclamo: cada envío puede tardar
    // hasta 15 s, y leerlo una sola vez al inicio del job dejaba salir el resto.
    const job = await seedTurn([HOLA, MENU]);
    sender.send.mockImplementationOnce(async () => {
      await humanTookOver('phone');
      return { wamid: 'wamid.MID' };
    });

    await processor.process(job);

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect((await outRows()).map((r) => r.status)).toEqual(['sent', 'superseded']);
  });

  it('el mensaje de traspaso del propio flujo sí sale', async () => {
    const job = await seedTurn([HOLA]);
    await humanTookOver('flow_handoff');

    await processor.process(job);

    expect((await outRows()).map((r) => r.status)).toEqual(['sent']);
  });

  it('lo que escribe el operador sale aunque mande un humano', async () => {
    const job = await seedTurn([HOLA]);
    await adminQuery(`UPDATE messages SET origin = 'operator' WHERE direction = 'out'`);
    await humanTookOver('operator');

    await processor.process(job);

    expect((await outRows()).map((r) => r.status)).toEqual(['sent']);
  });

  it('un control humano ya vencido no reemplaza nada', async () => {
    const job = await seedTurn([HOLA]);
    await humanTookOver('phone', `now() - interval '1 minute'`);

    await processor.process(job);

    expect((await outRows()).map((r) => r.status)).toEqual(['sent']);
  });


  it('un canal inexistente o inactivo es un error permanente, sin llamar a Meta', async () => {
    const job = await seedTurn([HOLA]);

    await expect(processor.process({ ...job, channelId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toBeInstanceOf(UnrecoverableError);
    expect(sender.send).not.toHaveBeenCalled();
    // Estado final visible: no se queda en `pending` para siempre.
    expect((await outRows()).map((r) => r.status)).toEqual(['failed']);
  });

  it('se niega a enviar si el canal pertenece a otro tenant', async () => {
    // Defensa en profundidad: un job mal armado no puede usar las
    // credenciales de un negocio para escribir en nombre de otro.
    const job = await seedTurn([HOLA]);
    const [otro] = await adminQuery(
      `INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);

    await expect(processor.process({ ...job, tenantId: otro.id }))
      .rejects.toBeInstanceOf(UnrecoverableError);
    expect(sender.send).not.toHaveBeenCalled();
  });
});
