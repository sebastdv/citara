import { DateTime } from 'luxon';
import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { panelTenants, type PanelTenant } from './tenants';

/** La zona del operador: solo decide qué mes se muestra por defecto. */
export const PANEL_ZONE = 'America/Bogota';

export interface CostRow {
  tenant: PanelTenant; agentUsd: number; interpretUsd: number; calls: number; failed: number;
  budgetUsd: number | null; enabled: boolean | null; appointments: number; byAgent: number; byFlow: number;
  usdPerAppointment: number | null;
}

export function parseMonth(v: unknown, now = new Date()): { year: number; month: number } {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})$/.exec(v) : null;
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  const d = DateTime.fromJSDate(now).setZone(PANEL_ZONE);
  return { year: d.year, month: d.month };
}

// Límites del mes en la zona del negocio, como AiGate.monthSpend.
const BOUNDS = `
  WITH b AS (SELECT (make_timestamp($1::int, $2::int, 1, 0, 0, 0) AT TIME ZONE t.timezone) AS lo,
                    ((make_timestamp($1::int, $2::int, 1, 0, 0, 0) + interval '1 month') AT TIME ZONE t.timezone) AS hi
               FROM tenants t WHERE t.id = $3)`;

/** Costo de IA por cita (spec §3.7.2): USD del mes ÷ citas creadas en el mes, por negocio. */
export async function loadCosts(ds: DataSource, ym: { year: number; month: number }): Promise<CostRow[]> {
  const out: CostRow[] = [];
  for (const tenant of await panelTenants(ds)) {
    const row = await runInTenant(ds, tenant.id, async (m) => {
      const [runs] = await m.query(`${BOUNDS}
        SELECT coalesce(sum(r.usd) FILTER (WHERE r.kind = 'agent'), 0) AS agent_usd,
               coalesce(sum(r.usd) FILTER (WHERE r.kind = 'interpret'), 0) AS interpret_usd,
               count(r.id)::int AS calls, count(r.id) FILTER (WHERE r.error IS NOT NULL)::int AS failed
          FROM b LEFT JOIN agent_runs r ON r.created_at >= b.lo AND r.created_at < b.hi`,
        [ym.year, ym.month, tenant.id]);
      // Cuentan aunque luego se cancelaran: el gasto para agendarlas ya se hizo.
      const [apps] = await m.query(`${BOUNDS}
        SELECT count(a.id)::int AS total, count(a.id) FILTER (WHERE a.booked_by = 'agent')::int AS by_agent
          FROM b LEFT JOIN appointments a ON a.created_at >= b.lo AND a.created_at < b.hi`,
        [ym.year, ym.month, tenant.id]);
      const [cfg] = await m.query(`SELECT enabled, monthly_budget_usd FROM agent_configs WHERE is_active`);
      return { runs, apps, cfg };
    });
    const agentUsd = Number(row.runs.agent_usd), interpretUsd = Number(row.runs.interpret_usd);
    out.push({
      tenant, agentUsd, interpretUsd, calls: row.runs.calls, failed: row.runs.failed,
      budgetUsd: row.cfg ? Number(row.cfg.monthly_budget_usd) : null, enabled: row.cfg ? row.cfg.enabled : null,
      appointments: row.apps.total, byAgent: row.apps.by_agent, byFlow: row.apps.total - row.apps.by_agent,
      usdPerAppointment: row.apps.total ? (agentUsd + interpretUsd) / row.apps.total : null,
    });
  }
  return out;
}
