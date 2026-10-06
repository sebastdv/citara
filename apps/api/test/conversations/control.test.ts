import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import {
  botRepliesSuperseded, giveControlToHuman, humanControlExpired, humanInControl,
  readControl, returnControlToBot, type ControlState,
} from '../../src/conversations/control';
import { DEMO_FLOW } from '../../src/cli/provision';
import { resetDb, seedChannel, seedFlow, adminQuery, closeHelpers } from '../helpers';

const now = new Date('2026-10-06T15:00:00Z');
const state = (over: Partial<ControlState>): ControlState =>
  ({ control: 'bot', humanUntil: null, reason: null, ...over });
const hoursFromNow = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('regla de control (puras)', () => {
  it('manda el humano solo mientras su plazo no ha vencido', () => {
    expect(humanInControl(state({ control: 'human', humanUntil: hoursFromNow(1) }), now)).toBe(true);
    expect(humanInControl(state({ control: 'human', humanUntil: hoursFromNow(-1) }), now)).toBe(false);
    expect(humanInControl(state({ control: 'bot' }), now)).toBe(false);
  });

  it('un control humano sin plazo cuenta como vencido, no como eterno', () => {
    expect(humanInControl(state({ control: 'human', humanUntil: null }), now)).toBe(false);
    expect(humanControlExpired(state({ control: 'human', humanUntil: null }), now)).toBe(true);
  });

  it('lo pendiente del bot sobra solo si un humano intervino', () => {
    const phone = state({ control: 'human', humanUntil: hoursFromNow(1), reason: 'phone' });
    const flow = state({ control: 'human', humanUntil: hoursFromNow(1), reason: 'flow_handoff' });
    expect(botRepliesSuperseded(phone, now)).toBe(true);
    // El mensaje de traspaso se produjo en el mismo turno que pidió el traspaso.
    expect(botRepliesSuperseded(flow, now)).toBe(false);
  });
});

let ds: DataSource;
let tenantId: string, channelId: string, conversationId: string;

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  const [contact] = await adminQuery(
    `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, '573001112233') RETURNING id`, [tenantId]);
  const [conv] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, contact.id, channelId]);
  conversationId = conv.id;
});

const control = () => runInTenant(ds, tenantId, (m) => readControl(m, conversationId));
const audit = () => adminQuery(`SELECT actor, action, details FROM audit_log ORDER BY created_at`);

describe('regla de control (base de datos)', () => {
  it('dar el control al humano fija el plazo con las horas del negocio y lo audita', async () => {
    await adminQuery(`UPDATE tenants SET human_takeover_hours = 2 WHERE id = $1`, [tenantId]);
    const from = new Date();

    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from, reason: 'phone', actor: 'phone' }));

    const c = await control();
    expect(c.control).toBe('human');
    expect(c.reason).toBe('phone');
    expect(c.humanUntil!.getTime()).toBe(from.getTime() + 2 * 3_600_000);
    expect(await audit()).toEqual([
      { actor: 'phone', action: 'control.to_human', details: { reason: 'phone' } }]);
  });

  it('una segunda intervención alarga el plazo pero nunca lo acorta', async () => {
    const later = new Date();
    const earlier = new Date(later.getTime() - 3_600_000);
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: later, reason: 'phone', actor: 'phone' }));
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: earlier, reason: 'phone', actor: 'phone' }));

    expect((await control()).humanUntil!.getTime()).toBe(later.getTime() + 12 * 3_600_000);
  });

  it('alargar el plazo no repite la auditoría', async () => {
    for (let i = 0; i < 3; i++) {
      await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
        tenantId, conversationId, from: new Date(), reason: 'phone', actor: 'phone' }));
    }
    expect(await audit()).toHaveLength(1);
  });

  it('devolver el control al bot cierra las sesiones a medias y lo audita', async () => {
    const flowId = await seedFlow(tenantId, DEMO_FLOW);
    await adminQuery(
      `INSERT INTO conversation_sessions (tenant_id, conversation_id, flow_id, step_key, status)
       VALUES ($1, $2, $3, 'pide_nombre', 'active')`, [tenantId, conversationId, flowId]);
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: new Date(), reason: 'phone', actor: 'phone' }));

    await runInTenant(ds, tenantId, (m) => returnControlToBot(m, {
      tenantId, conversationId, cause: 'expired', actor: 'system' }));

    const c = await control();
    expect([c.control, c.humanUntil, c.reason]).toEqual(['bot', null, null]);
    const sessions = await adminQuery(`SELECT status FROM conversation_sessions`);
    expect(sessions).toEqual([{ status: 'ended' }]);
    expect((await audit()).at(-1)).toEqual(
      { actor: 'system', action: 'control.to_bot', details: { cause: 'expired' } });
  });

  it('lee el estado del canal junto con el control', async () => {
    expect((await control()).channelStatus).toBe('active');
  });

  it('la aplicación no puede corregir ni borrar la bitácora', async () => {
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: new Date(), reason: 'phone', actor: 'phone' }));
    await expect(runInTenant(ds, tenantId, (m) => m.query(`DELETE FROM audit_log`)))
      .rejects.toThrow(/permission denied/);
  });
});
