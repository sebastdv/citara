import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configHash, type AgentYaml } from '../agent-config';
import type { BenchResult } from './runner';

/** Guarda el resultado por hash de configuración. Devuelve la ruta escrita. */
export function writeBenchResult(dir: string, agent: AgentYaml, results: BenchResult[]): string {
  mkdirSync(dir, { recursive: true });
  const hash = configHash(agent);
  const path = join(dir, `${hash}.json`);
  writeFileSync(path, JSON.stringify({
    hash, passed: results.every((r) => r.passed), model: agent.model, effort: agent.effort,
    usd: results.reduce((s, r) => s + r.usd, 0), ranAt: new Date().toISOString(),
    results: results.map(({ name, passed, reason, usd }) => ({ name, passed, reason, usd })),
  }, null, 2));
  return path;
}

/** Spec §11: banco de regresión obligatorio antes de publicar un cambio del agente. */
export function assertBenchPassed(dir: string, hash: string): void {
  const path = join(dir, `${hash}.json`);
  if (!existsSync(path)) {
    throw new Error(`Este cambio del agente no pasó por el banco. Corre: pnpm agent:bench <archivo del negocio> ` +
                    `(o publícalo igual con --sin-banco).`);
  }
  if (!JSON.parse(readFileSync(path, 'utf8')).passed) {
    throw new Error(`El banco de esta configuración no pasó (${path}). Revisa los guiones que fallaron.`);
  }
}
