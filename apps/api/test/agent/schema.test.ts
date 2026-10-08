import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { resetDb, seedChannel, seedAgentConfig, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('esquema de la IA', () => {
  it('la configuración del agente es del operador: la app la lee pero no la escribe', async () => {
    await seedAgentConfig(tenantId);
    const rows = await runInTenant(app, tenantId, (m) => m.query(`SELECT model, effort, is_active FROM agent_configs`));
    expect(rows).toEqual([{ model: 'claude-opus-5-5', effort: 'low', is_active: true }]);
    await expect(runInTenant(app, tenantId, (m) => m.query(`UPDATE agent_configs SET monthly_budget_usd = 9999`)))
      .rejects.toThrow(/permission denied/);
  });

  it('un negocio tiene a lo sumo una configuración activa', async () => {
    await seedAgentConfig(tenantId, { version: 1 });
    await expect(seedAgentConfig(tenantId, { version: 2 })).rejects.toThrow(/duplicate|unique/i);
  });

  it('el effort solo admite los niveles de la API', async () => {
    await expect(seedAgentConfig(tenantId, { effort: 'altisimo' })).rejects.toThrow(/check/i);
  });

  it('la app registra corridas pero no puede corregirlas ni borrarlas', async () => {
    await runInTenant(app, tenantId, (m) => m.query(
      `INSERT INTO agent_runs (tenant_id, kind, model, usd, latency_ms) VALUES ($1, 'agent', 'claude-opus-5-5', 0.0123, 900)`,
      [tenantId]));
    await expect(runInTenant(app, tenantId, (m) => m.query(`UPDATE agent_runs SET usd = 0`)))
      .rejects.toThrow(/permission denied/);
    await expect(runInTenant(app, tenantId, (m) => m.query(`DELETE FROM agent_runs`)))
      .rejects.toThrow(/permission denied/);
  });

  it('la sesión guarda el estado del agente y la conversación su lease', async () => {
    const cols = await adminQuery(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'conversation_sessions' AND column_name LIKE 'agent_%')
           OR (table_name = 'conversations' AND column_name = 'agent_lease_until')
        ORDER BY table_name, column_name`);
    expect(cols.map((c: { column_name: string }) => c.column_name)).toEqual([
      'agent_config_version', 'agent_cursor', 'agent_effort', 'agent_model', 'agent_system', 'agent_transcript',
      'agent_lease_until']);
  });
});
