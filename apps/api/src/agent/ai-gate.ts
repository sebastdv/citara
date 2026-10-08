import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export interface AgentConfig {
  version: number; enabled: boolean; model: string; effort: string;
  interpreterModel: string; instructions: string; monthlyBudgetUsd: number;
}
export type AiAvailability = { ok: true; config: AgentConfig } | { ok: false; reason: 'none' | 'disabled' | 'budget' };

/**
 * ¿Puede este negocio usar IA ahora? Configuración activa, encendida y con
 * presupuesto del mes (en la zona del negocio). Sin estado: corre con el
 * EntityManager de quien llama (dentro del turno, con RLS fijado).
 */
@Injectable()
export class AiGate {
  async availability(m: EntityManager, tenantId: string, now = new Date()): Promise<AiAvailability> {
    const [c] = await m.query(
      `SELECT version, enabled, model, effort, interpreter_model, instructions, monthly_budget_usd
         FROM agent_configs WHERE is_active`);
    if (!c) return { ok: false, reason: 'none' };
    if (!c.enabled) return { ok: false, reason: 'disabled' };
    const config: AgentConfig = {
      version: c.version, enabled: c.enabled, model: c.model, effort: c.effort,
      interpreterModel: c.interpreter_model, instructions: c.instructions, monthlyBudgetUsd: Number(c.monthly_budget_usd),
    };
    const spent = await this.monthSpend(m, tenantId, now);
    if (spent >= config.monthlyBudgetUsd) {
      // Decisión del usuario: al tope, menús hasta el mes siguiente. Se audita una vez por mes.
      await m.query(
        `INSERT INTO audit_log (tenant_id, actor, action, details)
         SELECT $1, 'system', 'agent.budget_exhausted', jsonb_build_object('spentUsd', $2::numeric, 'budgetUsd', $3::numeric)
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_log a, tenants t
             WHERE a.action = 'agent.budget_exhausted' AND t.id = $1
               AND a.created_at >= (date_trunc('month', $4::timestamptz AT TIME ZONE t.timezone) AT TIME ZONE t.timezone))`,
        [tenantId, spent, config.monthlyBudgetUsd, now]);
      return { ok: false, reason: 'budget' };
    }
    return { ok: true, config };
  }

  /** Lo gastado en IA este mes calendario, en la zona horaria del negocio. */
  async monthSpend(m: EntityManager, tenantId: string, now = new Date()): Promise<number> {
    const [{ usd }] = await m.query(
      `SELECT COALESCE(sum(r.usd), 0) AS usd
         FROM agent_runs r JOIN tenants t ON t.id = r.tenant_id
        WHERE r.tenant_id = $1
          AND r.created_at >= (date_trunc('month', $2::timestamptz AT TIME ZONE t.timezone) AT TIME ZONE t.timezone)
          AND r.created_at < ((date_trunc('month', $2::timestamptz AT TIME ZONE t.timezone) + interval '1 month')
                              AT TIME ZONE t.timezone)`,
      [tenantId, now]);
    return Number(usd);
  }
}
