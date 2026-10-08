// pnpm agent:bench <negocio.yaml>: corre el banco contra el modelo real con la configuración del agente del archivo.
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../crypto/encryption.service';
import { AnthropicProvider } from '../agent/llm';
import { agentYamlSchema } from '../agent/agent-config';
import { runBench, writeBenchResult } from '../agent/bench/runner';

const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Uso: pnpm agent:bench <negocio.yaml>');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY: el banco corre contra el modelo real.');
  const doc = parse(await readFile(file, 'utf8'));
  const agent = agentYamlSchema.parse(doc?.agent ?? {});

  // Base propia: el banco vacía sus tablas en cada guion.
  const adminUrl = process.env.BENCH_DATABASE_ADMIN_URL ?? withDb(process.env.DATABASE_ADMIN_URL!, 'citara_bench');
  const appUrl = process.env.BENCH_DATABASE_URL ?? withDb(process.env.DATABASE_URL!, 'citara_bench');
  const server = createDataSource(withDb(adminUrl, 'postgres'));
  await server.initialize();
  const [exists] = await server.query(`SELECT 1 FROM pg_database WHERE datname = 'citara_bench'`);
  if (!exists && !process.env.BENCH_DATABASE_ADMIN_URL) await server.query(`CREATE DATABASE citara_bench`);
  await server.destroy();
  const admin = createDataSource(adminUrl); await admin.initialize(); await admin.runMigrations();
  const app = createDataSource(appUrl); await app.initialize();
  const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();

  try {
    console.log(`Banco: ${agent.model}, effort ${agent.effort}...`);
    const results = await runBench({ admin, app, llm: new AnthropicProvider(process.env.ANTHROPIC_API_KEY), agent, enc });
    for (const r of results) {
      console.log(`${r.passed ? 'ok    ' : 'FALLÓ '} ${r.name.padEnd(22)} US$ ${r.usd.toFixed(4)}${r.reason ? `  — ${r.reason}` : ''}`);
    }
    const total = results.reduce((s, r) => s + r.usd, 0);
    const path = writeBenchResult(process.env.BENCH_RESULTS_DIR ?? 'bench-results', agent, results);
    const failed = results.filter((r) => !r.passed).length;
    console.log(`\n${results.length - failed}/${results.length} aprobados · US$ ${total.toFixed(4)} · ${path}`);
    if (failed) process.exitCode = 1;
  } finally {
    await admin.destroy(); await app.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
