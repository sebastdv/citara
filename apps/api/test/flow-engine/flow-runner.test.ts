import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import type { InboundMessage } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { FlowRunner, type OutboundEnqueuer } from '../../src/flow-engine/flow-runner.service';
import { InboundProcessor } from '../../src/queues/inbound.processor';
import type { OutboundJob } from '../../src/queues/outbound.queue';
import { DEMO_FLOW } from '../../src/cli/provision';
import { resetDb, seedChannel, seedFlow, adminQuery, closeHelpers, buildScheduling } from '../helpers';
import { systemClock } from '../../src/clock';

let ds: DataSource;
let tenantId: string, channelId: string;
let jobs: OutboundJob[];
let failEnqueue: boolean;
let runner: FlowRunner;

const queue: OutboundEnqueuer = {
  add(job) {
    if (failEnqueue) { failEnqueue = false; throw new Error('Redis caído'); }
    jobs.push(job);
  },
};

const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  wamid: 'wamid.FR1', phoneNumberId: '106540', wabaId: '102290',
  from: '573001112233', profileName: 'Ana', type: 'text', text: 'Hola',
  mediaId: null, timestamp: new Date(), raw: {}, ...over,
});

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  runner = new FlowRunner(ds, new InboundProcessor(ds), queue, buildScheduling().tools, systemClock);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  jobs = [];
  failEnqueue = false;
});

describe('FlowRunner', () => {
  it('si avanzar el flujo falla, el reintento responde en vez de callar', async () => {
    // Guardar el entrante y avanzar el flujo son UNA transacción. Con dos, el
    // fallo dejaba el entrante guardado y el reintento lo veía como duplicado:
    // el usuario no recibía respuesta nunca.
    const flowId = await seedFlow(tenantId, { ...DEMO_FLOW, entry: 'paso_que_no_existe' });
    const job = { tenantId, channelId, message: message() };

    await expect(runner.handle(job)).rejects.toThrow(/Paso inexistente/);

    await adminQuery(`UPDATE flows SET definition = $1 WHERE id = $2`,
                     [JSON.stringify(DEMO_FLOW), flowId]);
    const out = await runner.handle(job);

    expect(out.map((o) => o.kind)).toEqual(['text', 'buttons']);
    expect(jobs).toHaveLength(1);
  });

  it('encola un job por turno con el id del entrante, sin `:`', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await runner.handle({ tenantId, channelId, message: message() });

    const [inbound] = await adminQuery(`SELECT id FROM messages WHERE direction = 'in'`);
    expect(jobs).toEqual([expect.objectContaining({ turnId: inbound.id, to: '573001112233' })]);
    const out = await adminQuery(
      `SELECT type, status, seq FROM messages WHERE reply_to_id = $1 ORDER BY seq`, [inbound.id]);
    expect(out).toEqual([
      { type: 'text', status: 'pending', seq: 0 },
      { type: 'interactive', status: 'pending', seq: 1 },
    ]);
  });

  it('el entrante queda antes que sus respuestas al ordenar por created_at', async () => {
    // Entrante y salientes se guardan en la MISMA transacción, y `now()` es la
    // hora de inicio de la transacción: sin un reloj real, todos empatan y el
    // panel mostraría la respuesta antes que la pregunta.
    await seedFlow(tenantId, DEMO_FLOW);
    await runner.handle({ tenantId, channelId, message: message() });

    const rows = await adminQuery(`SELECT direction FROM messages ORDER BY created_at, id`);
    expect(rows.map((r: { direction: string }) => r.direction)).toEqual(['in', 'out', 'out']);
    const [{ distintos }] = await adminQuery(
      `SELECT count(DISTINCT created_at)::int AS distintos FROM messages`);
    expect(distintos).toBe(3);
  });

  it('si encolar falla tras el commit, la reentrega re-encola lo pendiente sin rehacer el turno', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    const job = { tenantId, channelId, message: message() };
    failEnqueue = true;

    await expect(runner.handle(job)).rejects.toThrow('Redis caído');
    const repetido = await runner.handle(job);

    expect(repetido).toEqual([]);           // el flujo no avanza dos veces
    expect(jobs).toHaveLength(1);           // pero la salida pendiente sí se encola
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages WHERE direction = 'out'`);
    expect(n).toBe(2);
  });

  it('una reentrega de un turno ya enviado no encola nada', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    const job = { tenantId, channelId, message: message() };
    await runner.handle(job);
    await adminQuery(`UPDATE messages SET status = 'sent' WHERE direction = 'out'`);

    await runner.handle(job);

    expect(jobs).toHaveLength(1);
  });

  const conversation = async () => (await adminQuery(
    `SELECT id, control, human_until, control_reason FROM conversations`))[0];
  const say = (wamid: string, text: string) =>
    runner.handle({ tenantId, channelId, message: message({ wamid, text }) });

  it('mientras manda el humano, guarda el entrante y el bot no responde', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.C1', 'Hola');
    await adminQuery(`UPDATE conversations SET control = 'human',
      human_until = now() + interval '1 hour', control_reason = 'phone'`);

    const out = await say('wamid.C2', '¿Siguen abiertos?');

    expect(out).toEqual([]);
    expect(jobs).toHaveLength(1);              // solo el del primer turno
    const [m] = await adminQuery(`SELECT origin FROM messages WHERE wamid = 'wamid.C2'`);
    expect(m.origin).toBe('customer');
  });

  it('al vencer el control humano, el bot retoma desde el inicio y no desde la captura', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.V1', 'Hola');
    await say('wamid.V2', 'agendar');          // la sesión queda en pide_nombre
    await adminQuery(`UPDATE conversations SET control = 'human',
      human_until = now() - interval '1 minute', control_reason = 'phone'`);

    const out = await say('wamid.V3', 'Hola');

    // Sin cerrar la sesión vieja respondería "Perfecto, Hola".
    expect(out.map((o) => o.kind)).toEqual(['text', 'buttons']);
    expect((await conversation()).control).toBe('bot');
    const [a] = await adminQuery(`SELECT action, details FROM audit_log`);
    expect(a).toEqual({ action: 'control.to_bot', details: { cause: 'expired' } });
  });

  it('el paso handoff del flujo dice su mensaje y le da el control al humano', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.H1', 'Hola');

    const out = await say('wamid.H2', 'asesor');

    expect(out).toEqual([{ kind: 'text', body: 'Te comunico con alguien del equipo.' }]);
    const c = await conversation();
    expect(c.control).toBe('human');
    expect(c.control_reason).toBe('flow_handoff');
    const hours = (new Date(c.human_until).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(await say('wamid.H3', '¿Hola?')).toEqual([]);
  });

  it('un canal desconectado guarda lo que llega pero no responde', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await adminQuery(`UPDATE whatsapp_channels SET status = 'disconnected'`);

    expect(await say('wamid.D1', 'Hola')).toEqual([]);
    expect(jobs).toEqual([]);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    expect(n).toBe(1);
  });

  it('si manda el bot, una sesión que quedó en traspaso es un residuo y no lo silencia', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.R1', 'Hola');
    const c = await conversation();
    await adminQuery(`UPDATE conversation_sessions SET status = 'handoff' WHERE conversation_id = $1`, [c.id]);

    const out = await say('wamid.R2', 'Hola');

    expect(out.map((o) => o.kind)).toEqual(['text', 'buttons']);
  });

  it('una sesión abandonada hace más de 2 horas vuelve a empezar', async () => {
    // Quien vuelve horas después no debe caer en la pregunta donde quedó, ni
    // ver una lista de horarios que ya pasaron.
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.T1', 'Hola');
    await say('wamid.T2', 'agendar');        // queda en pide_nombre
    await adminQuery(`UPDATE conversation_sessions SET updated_at = now() - interval '3 hours'`);

    const out = await say('wamid.T3', 'Hola');

    expect(out.map((o) => o.kind)).toEqual(['text', 'buttons']);
  });

  it('una sesión parada en un paso que ya no existe vuelve a empezar en vez de fallar para siempre', async () => {
    // Pasa cuando tenant:apply cambia o renombra pasos del flujo.
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.S1', 'Hola');
    await adminQuery(`UPDATE conversation_sessions SET step_key = 'paso_de_la_version_vieja'`);

    const out = await say('wamid.S2', 'Hola');

    expect(out.map((o) => o.kind)).toEqual(['text', 'buttons']);
  });

  it('un negocio en alta o suspendido guarda lo que llega pero no responde', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    for (const [i, status] of ['onboarding', 'suspended'].entries()) {
      await adminQuery(`UPDATE tenants SET status = $1`, [status]);
      expect(await say(`wamid.ST${i}`, 'Hola')).toEqual([]);
    }
    expect(jobs).toEqual([]);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    expect(n).toBe(2);
  });
});
