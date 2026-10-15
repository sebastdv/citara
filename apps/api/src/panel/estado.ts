import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { summarizeTenant, type TenantSummary } from '../cli/tenants';
import { alertsFor, type Alert, type Severity } from './alerts';
import { backupStatus, systemAlerts, type BackupStatus, type QueueFailures, type QueueStats } from './system-health';
import { panelTenants } from './tenants';

export interface TenantHealth { summary: TenantSummary; alerts: Alert[]; worst: Severity | null }
export interface Estado {
  system: { alerts: Alert[]; backup: BackupStatus; queues: QueueFailures[] | null };
  tenants: TenantHealth[];
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const rank = (s: Severity | null) => (s === null ? 3 : RANK[s]);

/** Todo lo que la pantalla de estado muestra; cada negocio se lee en su propio contexto de RLS. */
export async function loadEstado(ds: DataSource, queues: QueueStats, backupDir: string | undefined, now = new Date()): Promise<Estado> {
  const tenants: TenantHealth[] = [];
  for (const t of await panelTenants(ds)) {
    const summary = await runInTenant(ds, t.id, (m) => summarizeTenant(m, t.id));
    if (!summary) continue;
    const alerts = alertsFor(summary, now);
    tenants.push({ summary, alerts, worst: alerts[0]?.severity ?? null });
  }
  // Lo más grave primero; a igual gravedad, por slug.
  tenants.sort((a, b) => rank(a.worst) - rank(b.worst) || a.summary.slug.localeCompare(b.summary.slug));
  const backup = backupStatus(backupDir, now);
  const failures = await queues.failed();
  return { system: { alerts: systemAlerts({ backup, queues: failures }), backup, queues: failures }, tenants };
}
