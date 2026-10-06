import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import type { HistoryChunk } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { HistoryProcessor } from '../../src/coexistence/history.processor';
import { EchoProcessor } from '../../src/coexistence/echo.processor';
import { normalizeWebhook } from '../../src/whatsapp/normalizer';
import { historyPayload, historyDeclinedPayload, type HistoryLine } from '../whatsapp/fixtures/coexistence';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: HistoryProcessor;
let tenantId: string, channelId: string;

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const chunkOf = (customer: string, lines: HistoryLine[], phase = 2, progress = 100): HistoryChunk =>
  normalizeWebhook(historyPayload({ customer, lines, phase, progress })).history[0];
const run = (chunk: HistoryChunk) => processor.process({ tenantId, channelId, chunk });
const controlOf = async (waId: string) => (await adminQuery(
  `SELECT c.control, c.control_reason, c.human_until, c.last_inbound_at
     FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.wa_id = $1`, [waId]))[0];

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new HistoryProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  await adminQuery(`UPDATE whatsapp_channels SET mode = 'coexistence', history_sync = 'pending'`);
});

describe('HistoryProcessor', () => {
  it('importa cada mensaje con su dirección, origen history y hora real', async () => {
    await run(chunkOf('573001112233', [
      { wamid: 'wamid.H1', fromCustomer: true, text: 'Hola, ¿tienen cita el martes?', at: ago(50) },
      { wamid: 'wamid.H2', fromCustomer: false, text: 'Sí, a las 3', at: ago(49) },
    ], 1, 50));

    const rows = await adminQuery(
      `SELECT wamid, direction, origin, body FROM messages ORDER BY occurred_at`);
    expect(rows).toEqual([
      { wamid: 'wamid.H1', direction: 'in', origin: 'history', body: 'Hola, ¿tienen cita el martes?' },
      { wamid: 'wamid.H2', direction: 'out', origin: 'history', body: 'Sí, a las 3' },
    ]);
  });

  it('los mensajes del cliente cuentan para la ventana de 24 h', async () => {
    const at = ago(3);
    await run(chunkOf('573001112233', [{ wamid: 'wamid.W1', fromCustomer: true, text: 'Hola', at }], 0, 10));
    const c = await controlOf('573001112233');
    expect(new Date(c.last_inbound_at).getTime()).toBe(Math.floor(at.getTime() / 1000) * 1000);
  });

  it('reimportar el mismo chunk no duplica nada', async () => {
    const chunk = chunkOf('573001112233', [{ wamid: 'wamid.D1', fromCustomer: true, text: 'Hola', at: ago(5) }], 1, 50);
    await run(chunk);
    const second = await run(chunk);
    expect(second.imported).toBe(0);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    expect(n).toBe(1);
  });

  it('un mensaje que ya llegó por eco no se duplica al importar el historial', async () => {
    await new EchoProcessor(ds).process({ tenantId, channelId, echo: {
      wamid: 'wamid.SAME', phoneNumberId: '106540', wabaId: '102290', to: '573001112233',
      type: 'text', text: 'Ya voy', mediaId: null, timestamp: ago(1), raw: {} } });
    await run(chunkOf('573001112233', [{ wamid: 'wamid.SAME', fromCustomer: false, text: 'Ya voy', at: ago(1) }]));

    const rows = await adminQuery(`SELECT origin FROM messages WHERE wamid = 'wamid.SAME'`);
    expect(rows).toEqual([{ origin: 'phone' }]);
  });

  it('si el negocio no compartió el historial, el canal lo registra', async () => {
    await run(normalizeWebhook(historyDeclinedPayload()).history[0]);
    const [ch] = await adminQuery(`SELECT history_sync FROM whatsapp_channels`);
    expect(ch.history_sync).toBe('declined');
  });

  it('al completar, deja en manos del dueño solo donde estuvo activo hace menos de N horas', async () => {
    // Una sola medición: Meta trae segundos, y recalcular `ago(2)` en la
    // aserción podría caer en el segundo siguiente.
    const ownerAt = ago(2);
    await run(chunkOf('573000000001', [
      { wamid: 'wamid.R1', fromCustomer: true, text: '¿A qué hora me dijiste?', at: ago(3) },
      { wamid: 'wamid.R2', fromCustomer: false, text: 'A las 5', at: ownerAt },
    ], 1, 60));
    await run(chunkOf('573000000002', [
      { wamid: 'wamid.O1', fromCustomer: false, text: 'Gracias por venir', at: ago(72) },
    ], 2, 100));

    const reciente = await controlOf('573000000001');
    expect([reciente.control, reciente.control_reason]).toEqual(['human', 'history']);
    expect(new Date(reciente.human_until).getTime())
      .toBe(Math.floor(ownerAt.getTime() / 1000) * 1000 + 12 * 3_600_000);
    expect((await controlOf('573000000002')).control).toBe('bot');
    const [ch] = await adminQuery(`SELECT history_sync FROM whatsapp_channels`);
    expect(ch.history_sync).toBe('done');
  });

  it('un chunk que llega después del final también aplica la regla', async () => {
    // Reentregas: el chunk con progress 100 puede procesarse antes que otro.
    await run(chunkOf('573000000003', [{ wamid: 'wamid.F1', fromCustomer: false, text: 'x', at: ago(80) }], 2, 100));
    await run(chunkOf('573000000004', [{ wamid: 'wamid.L1', fromCustomer: false, text: 'Ya te confirmo', at: ago(1) }], 1, 70));

    expect((await controlOf('573000000004')).control).toBe('human');
  });

  it('si el historial trae primero el mensaje del dueño, el eco posterior igual le da el control', async () => {
    // Orden inverso al de 'ya llegó por eco': la fase 0 (último día) importa el
    // mensaje del dueño y el eco del mismo wamid llega después como duplicado.
    const at = ago(0.1);
    await run(chunkOf('573001112233', [{ wamid: 'wamid.INV', fromCustomer: false, text: 'Ya voy', at }], 0, 10));
    await new EchoProcessor(ds).process({ tenantId, channelId, echo: {
      wamid: 'wamid.INV', phoneNumberId: '106540', wabaId: '102290', to: '573001112233',
      type: 'text', text: 'Ya voy', mediaId: null, timestamp: at, raw: {} } });

    expect((await controlOf('573001112233')).control).toBe('human');
  });

  it('protege al dueño desde el primer chunk, sin esperar a que termine la importación', async () => {
    // Un historial de 180 días puede tardar en completarse; mientras tanto el
    // bot no debe hablarle encima a quien escribió hace un rato.
    await run(chunkOf('573000000005', [{ wamid: 'wamid.P0', fromCustomer: false, text: 'Te espero', at: ago(1) }], 0, 5));
    expect((await controlOf('573000000005')).control).toBe('human');
  });
});
