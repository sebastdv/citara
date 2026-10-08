import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import { AGENT_PROMPT_VERSION } from './prompt';
import { recordAudit } from '../audit/audit';

export const AGENT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

export const agentYamlSchema = z.object({
  enabled: z.boolean().default(true),
  // Decisión del usuario: Opus 5.5 por defecto. Bajarlo es una decisión sobre datos del banco.
  model: z.enum(AGENT_MODELS).default('claude-opus-5-5'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  interpreter_model: z.enum(AGENT_MODELS).default('claude-haiku-5-5'),
  instructions: z.string().max(4000).default(''),
  monthly_budget_usd: z.number().min(0).max(10_000).default(20),
}).strict();
export type AgentYaml = z.infer<typeof agentYamlSchema>;

/** Lo que cambia cómo se comporta el agente. El tope y el interruptor no cuentan. */
export function configHash(c: AgentYaml): string {
  return createHash('sha256')
    .update(JSON.stringify([AGENT_PROMPT_VERSION, c.model, c.effort, c.interpreter_model, c.instructions]))
    .digest('hex');
}

/** Dentro de la transacción admin de tenant:apply. Crea versión solo si algo cambió. */
export async function applyAgentConfig(m: EntityManager, tenantId: string, c: AgentYaml) {
  const hash = configHash(c);
  const [active] = await m.query(
    `SELECT version, enabled, monthly_budget_usd, config_hash FROM agent_configs
      WHERE tenant_id = $1 AND is_active`, [tenantId]);
  if (active && active.config_hash === hash && active.enabled === c.enabled
      && Number(active.monthly_budget_usd) === c.monthly_budget_usd) {
    return { version: active.version as number, changed: false, behaviorChanged: false, hash };
  }
  const [{ next }] = await m.query(
    `SELECT COALESCE(max(version), 0) + 1 AS next FROM agent_configs WHERE tenant_id = $1`, [tenantId]);
  await m.query(`UPDATE agent_configs SET is_active = false WHERE tenant_id = $1 AND is_active`, [tenantId]);
  await m.query(
    `INSERT INTO agent_configs (tenant_id, version, enabled, model, effort, interpreter_model, instructions,
                                monthly_budget_usd, config_hash, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
    [tenantId, next, c.enabled, c.model, c.effort, c.interpreter_model, c.instructions, c.monthly_budget_usd, hash]);
  const behaviorChanged = active?.config_hash !== hash;
  await recordAudit(m, { tenantId, actor: 'operator', action: 'agent.config_published',
                         details: { version: next, hash, behaviorChanged } });
  return { version: next as number, changed: true, behaviorChanged, hash };
}

async function tenantBySlug(admin: DataSource, slug: string): Promise<string> {
  const [t] = await admin.query(`SELECT id FROM tenants WHERE slug = $1`, [slug]);
  if (!t) throw new Error(`No existe el negocio '${slug}'`);
  return t.id;
}

export async function listAgentVersions(admin: DataSource, slug: string) {
  const tenantId = await tenantBySlug(admin, slug);
  const rows = await admin.query(
    `SELECT version, is_active, enabled, model, effort, monthly_budget_usd, config_hash, created_at
       FROM agent_configs WHERE tenant_id = $1 ORDER BY version`, [tenantId]);
  return rows.map((r: Record<string, any>) => ({
    version: r.version as number, active: r.is_active as boolean, enabled: r.enabled as boolean,
    model: r.model as string, effort: r.effort as string, budgetUsd: Number(r.monthly_budget_usd),
    hash: r.config_hash as string, createdAt: r.created_at as Date,
  }));
}

/** Vuelve a una versión anterior: las conversaciones en curso terminan su segmento con lo congelado. */
export async function rollbackAgentConfig(admin: DataSource, slug: string, version: number): Promise<void> {
  const tenantId = await tenantBySlug(admin, slug);
  await admin.transaction(async (m) => {
    const [target] = await m.query(
      `SELECT id FROM agent_configs WHERE tenant_id = $1 AND version = $2`, [tenantId, version]);
    if (!target) throw new Error(`'${slug}' no tiene la versión ${version} del agente`);
    await m.query(`UPDATE agent_configs SET is_active = false WHERE tenant_id = $1 AND is_active`, [tenantId]);
    await m.query(`UPDATE agent_configs SET is_active = true WHERE id = $1`, [target.id]);
    await recordAudit(m, { tenantId, actor: 'operator', action: 'agent.rolled_back', details: { version } });
  });
}
