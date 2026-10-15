import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { summarizeTenant, type TenantSummary } from '../cli/tenants';
import { alertsFor, type Alert, type Severity } from './alerts';
import { backupStatus, systemAlerts, type BackupStatus, type QueueFailures, type QueueStats } from './system-health';
import { panelTenants, type PanelTenant } from './tenants';

export interface TenantHealth { summary: TenantSummary; alerts: Alert[]; worst: Severity | null }
export interface Estado {
  system: { alerts: Alert[]; backup: BackupStatus; queues: QueueFailures[] | null };
  tenants: TenantHealth[];
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const rank = (s: Severity | null) => (s === null ? 3 : RANK[s]);

const unreadable = (t: PanelTenant): TenantSummary => ({
  slug: t.slug, name: t.name, status: t.status, phone: null, mode: null, channelStatus: null, historySync: null,
  channelCreatedAt: null, lastPhoneEcho: null, lastCustomer: null, syncs: {}, google: [], ai: null, failedOutbound24h: 0,
});

/** Todo lo que la pantalla de estado muestra; cada negocio se lee en su propio contexto de RLS. */
export async function loadEstado(ds: DataSource, queues: QueueStats, backupDir: string | undefined, now = new Date()): Promise<Estado> {
  const tenants: TenantHealth[] = [];
  for (const t of await panelTenants(ds)) {
    try {
      const summary = await runInTenant(ds, t.id, (m) => summarizeTenant(m, t.id));
      if (!summary) continue;
      const alerts = alertsFor(summary, now);
      tenants.push({ summary, alerts, worst: alerts[0]?.severity ?? null });
    } catch (err) {
      // Un negocio que no se puede leer no tumba la página de los demás: es un aviso más.
      tenants.push({ summary: unreadable(t), worst: 'critical', alerts: [{ severity: 'critical', area: 'negocio',
        message: `No se pudo leer el estado de este negocio: ${(err as Error).message.slice(0, 200)}` }] });
    }
  }
  // Lo más grave primero; a igual gravedad, por slug.
  tenants.sort((a, b) => rank(a.worst) - rank(b.worst) || a.summary.slug.localeCompare(b.summary.slug));
  const backup = backupStatus(backupDir, now);
  const failures = await queues.failed();
  const agentsWithoutKey = process.env.ANTHROPIC_API_KEY ? 0 : tenants.filter((t) => t.summary.ai?.enabled).length;
  return { system: { alerts: systemAlerts({ backup, queues: failures, agentsWithoutKey }), backup, queues: failures }, tenants };
}
