import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { applyTenantConfig } from '../../src/cli/tenant-config';
import { listAgentVersions, rollbackAgentConfig } from '../../src/agent/agent-config';
import { listTenants } from '../../src/cli/tenants';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource;
let tenantId: string;

const base = {
  tenant: 'salon',
  services: [{ key: 'corte', name: 'Corte', duration_min: 30 }],
  resources: [{ key: 'maria', name: 'María', services: ['corte'] }],
  hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }],
};
const apply = (agent: Record<string, unknown> | undefined) => applyTenantConfig(admin, { ...base, ...(agent ? { agent } : {}) });
const versions = () => listAgentVersions(admin, 'salon');

beforeAll(async () => { admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize(); });
afterAll(async () => { await admin.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('configuración del agente desde el YAML', () => {
  it('sin sección agent, el negocio no tiene IA', async () => {
    expect((await apply(undefined)).agent).toBeNull();
    expect(await versions()).toEqual([]);
  });

  it('con agent: {} toma los valores por defecto: Opus 5.5, effort low, Haiku 5.5 y US$20 al mes', async () => {
    const r = await apply({});
    expect(r.agent).toMatchObject({ version: 1, changed: true, behaviorChanged: true });
    expect(await versions()).toEqual([expect.objectContaining({
      version: 1, active: true, enabled: true, model: 'claude-opus-5-5', effort: 'low', budgetUsd: 20 })]);
    expect((await versions())[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reaplicar lo mismo no crea versión; cambiar el tope sí, pero no cambia el comportamiento', async () => {
    await apply({});
    expect((await apply({})).agent).toMatchObject({ version: 1, changed: false });
    expect((await apply({ monthly_budget_usd: 50 })).agent).toMatchObject({ version: 2, changed: true, behaviorChanged: false });
    expect((await apply({ monthly_budget_usd: 50, instructions: 'Tutea a los clientes.' })).agent)
      .toMatchObject({ version: 3, behaviorChanged: true });
    expect((await versions()).filter((v) => v.active).map((v) => v.version)).toEqual([3]);
  });

  it('el rollback reactiva una versión anterior y se audita', async () => {
    await apply({});
    await apply({ effort: 'medium' });
    await rollbackAgentConfig(admin, 'salon', 1);
    expect((await versions()).find((v) => v.active)).toMatchObject({ version: 1, effort: 'low' });
    expect((await adminQuery(`SELECT action, details FROM audit_log WHERE action = 'agent.rolled_back'`))[0].details)
      .toMatchObject({ version: 1 });
    await expect(rollbackAgentConfig(admin, 'salon', 9)).rejects.toThrow(/versión 9/);
  });

  it('un modelo que no está en la lista se rechaza', async () => {
    await expect(apply({ model: 'gpt-5' })).rejects.toThrow(/agent\.model/);
  });

  it('la lista de negocios muestra el gasto del mes contra el tope', async () => {
    await apply({ monthly_budget_usd: 10 });
    await adminQuery(`INSERT INTO agent_runs (tenant_id, kind, model, usd) VALUES ($1, 'agent', 'claude-opus-5-5', 2.5)`, [tenantId]);
    const [t] = await listTenants(admin);
    expect(t.ai).toEqual({ enabled: true, model: 'claude-opus-5-5', spentUsd: 2.5, budgetUsd: 10 });
  });
});
