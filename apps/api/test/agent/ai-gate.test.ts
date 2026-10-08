import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { AiGate } from '../../src/agent/ai-gate';
import { recordRun } from '../../src/agent/runs';
import { resetDb, seedChannel, seedAgentConfig, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;
const gate = new AiGate();
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const spend = (usd: number, at?: string) => adminQuery(
  `INSERT INTO agent_runs (tenant_id, kind, model, usd, created_at) VALUES ($1, 'agent', 'claude-opus-5-5', $2, COALESCE($3::timestamptz, now()))`,
  [tenantId, usd, at ?? null]);

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('AiGate', () => {
  it('sin configuración, o apagada, no hay IA', async () => {
    expect(await inTenant((m) => gate.availability(m, tenantId))).toEqual({ ok: false, reason: 'none' });
    await seedAgentConfig(tenantId, { enabled: false });
    expect(await inTenant((m) => gate.availability(m, tenantId))).toEqual({ ok: false, reason: 'disabled' });
  });

  it('con presupuesto disponible devuelve la configuración activa', async () => {
    await seedAgentConfig(tenantId, { monthlyBudgetUsd: 20 });
    await spend(5);
    expect(await inTenant((m) => gate.availability(m, tenantId))).toMatchObject({
      ok: true, config: { version: 1, model: 'claude-opus-5-5', effort: 'low', interpreterModel: 'claude-haiku-5-5',
                          monthlyBudgetUsd: 20 } });
  });

  it('al llegar al tope del mes no hay IA, y se audita una sola vez', async () => {
    await seedAgentConfig(tenantId, { monthlyBudgetUsd: 1 });
    await spend(1.2);
    expect(await inTenant((m) => gate.availability(m, tenantId))).toEqual({ ok: false, reason: 'budget' });
    await inTenant((m) => gate.availability(m, tenantId));
    expect(await adminQuery(`SELECT action FROM audit_log`)).toEqual([{ action: 'agent.budget_exhausted' }]);
  });

  it('el mes se cuenta en la zona del negocio: lo del mes pasado no suma', async () => {
    await seedAgentConfig(tenantId, { monthlyBudgetUsd: 1 });
    // 30 de septiembre 23:30 en Bogotá = 1 de octubre 04:30 UTC: es de septiembre.
    await spend(5, '2026-10-01T04:30:00Z');
    expect(await inTenant((m) => gate.monthSpend(m, tenantId, new Date('2026-10-02T12:00:00Z')))).toBe(0);
    expect(await inTenant((m) => gate.monthSpend(m, tenantId, new Date('2026-09-30T12:00:00Z')))).toBe(5);
  });

  it('recordRun guarda el costo calculado de la corrida', async () => {
    const usd = await recordRun(app, { tenantId, conversationId: null, inboundMessageId: null, kind: 'agent',
      model: 'claude-opus-5-5', configVersion: 1, usage: { input_tokens: 1000, output_tokens: 500 },
      latencyMs: 1200, tools: ['consultar_servicios'], stopReason: 'end_turn', error: null });
    expect(usd).toBeCloseTo(0.014, 9);
    const [r] = await adminQuery(`SELECT usd, tools, latency_ms FROM agent_runs`);
    expect([Number(r.usd), r.tools, r.latency_ms]).toEqual([0.014, ['consultar_servicios'], 1200]);
  });
});
