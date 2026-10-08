import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import type { LlmMessage, LlmProvider } from '../../src/agent/llm';
import { agentYamlSchema, configHash } from '../../src/agent/agent-config';
import { assertBenchDatabase, assertBenchPassed, runBench, writeBenchResult } from '../../src/agent/bench/runner';
import { BENCH_SCRIPTS } from '../../src/agent/bench/scripts';
import { closeHelpers, resetDb } from '../helpers';

let admin: DataSource, app: DataSource, enc: EncryptionService;
const agent = agentYamlSchema.parse({});
const msg = (content: object[], stop = 'end_turn') => ({ id: 'm', type: 'message', role: 'assistant',
  model: 'claude-opus-5-5', content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 10 } }) as unknown as LlmMessage;
/** Un modelo que siempre pasa la conversación a un humano. */
const derivador: LlmProvider = {
  async create(p) {
    const last = p.messages.at(-1)!;
    const answered = Array.isArray(last.content) && (last.content as { type: string }[]).some((b) => b.type === 'tool_result');
    return answered ? msg([{ type: 'text', text: 'Te comunico con alguien.' }])
                    : msg([{ type: 'tool_use', id: 't1', name: 'pasar_a_humano', input: { motivo: 'lo pidió' } }], 'tool_use');
  },
};

beforeAll(async () => {
  await resetDb();   // migra la base de tests
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });

describe('banco de regresión', () => {
  it('trae los 12 guiones, cada uno con lo que espera', () => {
    expect(BENCH_SCRIPTS).toHaveLength(12);
    expect(new Set(BENCH_SCRIPTS.map((s) => s.name)).size).toBe(12);
    for (const s of BENCH_SCRIPTS) expect(Object.keys(s.expect).length).toBeGreaterThan(0);
  });

  it('corre un guion contra el modelo y afirma sobre el resultado en la base', async () => {
    const scripts = BENCH_SCRIPTS.filter((s) => s.name === 'humano' || s.name === 'agendar_directo');
    const results = await runBench({ admin, app, llm: derivador, agent, enc, scripts });
    expect(results.find((r) => r.name === 'humano')).toMatchObject({ passed: true, reason: null });
    expect(results.find((r) => r.name === 'agendar_directo')).toMatchObject({ passed: false });
    expect(results.find((r) => r.name === 'agendar_directo')!.reason).toMatch(/cita/);
    expect(results[0].usd).toBeGreaterThan(0);
  });

  it('el resultado se guarda por hash y la compuerta solo deja pasar uno aprobado', () => {
    const dir = mkdtempSync(join(tmpdir(), 'banco-'));
    expect(() => assertBenchPassed(dir, configHash(agent))).toThrow(/pnpm agent:bench/);
    const path = writeBenchResult(dir, agent, [{ name: 'x', passed: false, reason: 'no', usd: 0.1, replies: [] }]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ hash: configHash(agent), passed: false });
    expect(() => assertBenchPassed(dir, configHash(agent))).toThrow(/no pasó/);
    writeBenchResult(dir, agent, [{ name: 'x', passed: true, reason: null, usd: 0.1, replies: [] }]);
    expect(() => assertBenchPassed(dir, configHash(agent))).not.toThrow();
  });

  it('se niega a vaciar una base que no sea de banco o de pruebas', () => {
    // El banco hace TRUNCATE de todas las tablas: apuntarlo a la base real borraría a los clientes.
    expect(() => assertBenchDatabase('citara')).toThrow(/citara_bench/);
    expect(() => assertBenchDatabase('produccion')).toThrow();
    expect(() => assertBenchDatabase('citara_bench')).not.toThrow();
    expect(() => assertBenchDatabase('citara_test')).not.toThrow();
  });
});
