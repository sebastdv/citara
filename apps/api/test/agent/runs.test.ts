import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource } from 'typeorm';
import { recordRun, MAX_ERROR_LENGTH } from '../../src/agent/runs';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let app: DataSource, tenantId: string;
beforeAll(async () => { app = await createDataSource(process.env.DATABASE_URL!).initialize(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });

describe('recordRun', () => {
  it('recorta el error del proveedor (un HTML de 502 o un volcado enorme no llena la tabla)', async () => {
    await recordRun(app, { tenantId, conversationId: null, inboundMessageId: null, kind: 'agent',
      model: 'claude-opus-5-5', configVersion: 1, usage: null, latencyMs: 5, tools: [], stopReason: null,
      error: `<html>${'x'.repeat(20_000)}</html>` });
    const [r] = await adminQuery(`SELECT length(error) AS n, error FROM agent_runs`);
    expect(r.n).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(r.error.startsWith('<html>')).toBe(true);
  });
});
