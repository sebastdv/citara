import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import type { InboundMessage } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { FlowRunner, type OutboundEnqueuer } from '../../src/flow-engine/flow-runner.service';
import { InboundProcessor } from '../../src/queues/inbound.processor';
import type { AgentEnqueuer, AgentJob } from '../../src/queues/agent.queue';
import { AiGate } from '../../src/agent/ai-gate';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { systemClock } from '../../src/clock';
import { resetDb, seedChannel, seedFlow, seedAgentConfig, adminQuery, closeHelpers, buildScheduling } from '../helpers';

let ds: DataSource;
let tenantId: string, channelId: string;
let sent: unknown[], derived: AgentJob[];
let runner: FlowRunner;

const outbound: OutboundEnqueuer = { add(job) { sent.push(job); } };
const agents: AgentEnqueuer = { add(job) { derived.push(job); } };
let n = 0;
const say = (text: string) => runner.handle({ tenantId, channelId, message: {
  wamid: `wamid.AI${n++}`, phoneNumberId: '106540', wabaId: '102290', from: '573001112233', profileName: 'Ana',
  type: 'text', text, mediaId: null, timestamp: new Date(), raw: {} } as InboundMessage });

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize();
  runner = new FlowRunner(ds, new InboundProcessor(ds), outbound, buildScheduling().tools, systemClock, agents, new AiGate());
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  await seedFlow(tenantId, AGENDA_FLOW);
  sent = []; derived = [];
});

describe('FlowRunner con IA', () => {
  it('un primer mensaje con contenido va al agente, sin respuesta del menú ni envío encolado', async () => {
    await seedAgentConfig(tenantId);
    expect(await say('Hola, quiero un corte mañana a las 3')).toEqual([]);
    expect(derived).toEqual([expect.objectContaining({ kind: 'agent', stepKey: 'asistente', tenantId })]);
    expect(sent).toEqual([]);
    const [s] = await adminQuery(`SELECT step_key, agent_cursor IS NOT NULL AS cursor FROM conversation_sessions`);
    expect(s).toEqual({ step_key: 'asistente', cursor: true });
  });

  it('un saludo pelado abre el menú como siempre', async () => {
    await seedAgentConfig(tenantId);
    expect((await say('Hola')).length).toBe(2);
    expect(derived).toEqual([]);
  });

  it('en el menú, lo que no encaja se interpreta en vez de repetir el menú', async () => {
    await seedAgentConfig(tenantId);
    await say('Hola');
    expect(await say('quiero ver mis citas porfa')).toEqual([]);
    expect(derived).toEqual([expect.objectContaining({ kind: 'interpret', stepKey: 'menu', input: 'quiero ver mis citas porfa' })]);
  });

  it('lo que llega mientras la sesión está con el agente va al agente', async () => {
    await seedAgentConfig(tenantId);
    await say('Hola, ¿cuánto vale el corte?');
    await say('y el tinte?');
    expect(derived.map((j) => j.kind)).toEqual(['agent', 'agent']);
  });

  it('sin presupuesto, todo es como en la Fase 4', async () => {
    await seedAgentConfig(tenantId, { monthlyBudgetUsd: 0 });
    expect((await say('Hola, quiero un corte mañana')).length).toBe(2);
    expect((await say('xyz'))[0]).toMatchObject({ kind: 'buttons' });
    expect(derived).toEqual([]);
  });

  it('si se acaba el presupuesto con la sesión en el agente, vuelve al menú con un aviso', async () => {
    await seedAgentConfig(tenantId);
    await say('Hola, quiero un corte mañana');
    await adminQuery(`UPDATE agent_configs SET monthly_budget_usd = 0`);
    const out = await say('a las 3');
    expect(out.map((o) => ('body' in o ? o.body : ''))).toEqual(['Ahora mismo te atiendo con el menú.', '¿Qué necesitas?']);
  });

  it('si encolar al agente falló, la reentrega del mismo mensaje lo vuelve a derivar', async () => {
    await seedAgentConfig(tenantId);
    const msg = { wamid: 'wamid.DUP', phoneNumberId: '106540', wabaId: '102290', from: '573001112233',
      profileName: 'Ana', type: 'text', text: 'quiero un corte', mediaId: null, timestamp: new Date(), raw: {} } as InboundMessage;
    await runner.handle({ tenantId, channelId, message: msg });
    await runner.handle({ tenantId, channelId, message: msg });
    expect(derived.map((j) => j.inboundId)).toEqual([derived[0].inboundId, derived[0].inboundId]);
  });

  it('si encolar la interpretación falló, la reentrega del mismo mensaje la vuelve a derivar', async () => {
    await seedAgentConfig(tenantId);
    await say('Hola');
    const msg = { wamid: 'wamid.DUPI', phoneNumberId: '106540', wabaId: '102290', from: '573001112233',
      profileName: 'Ana', type: 'text', text: 'quiero ver mis citas', mediaId: null, timestamp: new Date(), raw: {} } as InboundMessage;
    await runner.handle({ tenantId, channelId, message: msg });
    await runner.handle({ tenantId, channelId, message: msg });
    expect(derived.map((j) => [j.kind, j.input])).toEqual([
      ['interpret', 'quiero ver mis citas'], ['interpret', 'quiero ver mis citas']]);
  });

  it('una reentrega de un mensaje del menú ya respondido no deriva nada', async () => {
    await seedAgentConfig(tenantId);
    const msg = { wamid: 'wamid.DUPH', phoneNumberId: '106540', wabaId: '102290', from: '573001112233',
      profileName: 'Ana', type: 'text', text: 'Hola', mediaId: null, timestamp: new Date(), raw: {} } as InboundMessage;
    await runner.handle({ tenantId, channelId, message: msg });
    await runner.handle({ tenantId, channelId, message: msg });
    expect(derived).toEqual([]);
  });
});
