import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { INBOUND_QUEUE } from '../queues/inbound.queue';
import { OUTBOUND_QUEUE } from '../queues/outbound.queue';
import { AGENT_QUEUE } from '../queues/agent.queue';
import { CALENDAR_QUEUE } from '../queues/calendar.queue';
import { SYNC_QUEUE } from '../queues/sync.queue';
import { REMINDERS_QUEUE } from '../queues/reminders.queue';
import type { Alert } from './alerts';

/** El nocturno corre cada 24 h: pasadas 26 sin uno nuevo, algo falló. */
export const BACKUP_MAX_AGE_HOURS = 26;
const TIMEOUT_MS = 2000;

export type BackupStatus =
  | { configured: false }
  | { configured: true; last: string | null; ageHours: number | null };

/**
 * El respaldo nocturno más reciente (daily-*.dump) de la carpeta de respaldos,
 * que en producción la API ve montada en solo lectura. Sin carpeta (desarrollo)
 * no se sabe.
 */
export function backupStatus(dir: string | undefined, now: Date): BackupStatus {
  if (!dir) return { configured: false };
  let newest: { name: string; at: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^daily-.*\.dump$/.test(name)) continue;
      const at = statSync(join(dir, name)).mtimeMs;
      if (!newest || at > newest.at) newest = { name, at };
    }
  } catch {
    // Carpeta inexistente o ilegible: lo mismo que no tener respaldos.
  }
  if (!newest) return { configured: true, last: null, ageHours: null };
  return { configured: true, last: newest.name, ageHours: Math.floor((now.getTime() - newest.at) / 3_600_000) };
}

export interface QueueFailures { queue: string; failed: number }

const QUEUES = [INBOUND_QUEUE, OUTBOUND_QUEUE, AGENT_QUEUE, CALENDAR_QUEUE, SYNC_QUEUE, REMINDERS_QUEUE];

/** Jobs fallidos (agotaron reintentos o son irrecuperables) por cola; null si Redis no responde. */
export class QueueStats {
  private readonly queues: Queue[];

  constructor(url: string) {
    this.queues = QUEUES.map((name) => {
      const q = new Queue(name, { connection: { url } });
      q.on('error', () => {}); // se reporta como null en failed()
      return q;
    });
  }

  async failed(): Promise<QueueFailures[] | null> {
    const counts = Promise.all(this.queues.map(async (q) => ({ queue: q.name, failed: await q.getFailedCount() })));
    const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), TIMEOUT_MS).unref());
    return Promise.race([counts.catch(() => null), timeout]);
  }

  onModuleDestroy() { return this.close(); }

  /** Con Redis caído, disconnect espera a una conexión que no llega: se abandona tras un segundo. */
  async close(): Promise<void> {
    const all = Promise.all(this.queues.map((q) => q.disconnect().catch(() => {})));
    await Promise.race([all, new Promise((ok) => setTimeout(ok, 1000).unref())]);
  }
}

/** Lo que vale para todo el servidor, no para un negocio. */
export function systemAlerts(s: { backup: BackupStatus; queues: QueueFailures[] | null }): Alert[] {
  const out: Alert[] = [];
  if (!s.backup.configured) {
    out.push({ severity: 'info', area: 'negocio', message: 'No hay carpeta de respaldos configurada (normal en desarrollo).' });
  } else if (s.backup.last === null) {
    out.push({ severity: 'critical', area: 'negocio', message: 'No hay ningún respaldo nocturno: ¿está activo citara-backup.timer?' });
  } else if (s.backup.ageHours !== null && s.backup.ageHours >= BACKUP_MAX_AGE_HOURS) {
    out.push({ severity: 'critical', area: 'negocio', message: `El último respaldo nocturno tiene ${s.backup.ageHours} h: revisa journalctl -u citara-backup.` });
  }
  if (s.queues === null) {
    out.push({ severity: 'critical', area: 'negocio', message: 'Redis no responde: las colas están detenidas.' });
  } else {
    for (const q of s.queues) {
      if (q.failed > 0) out.push({ severity: 'warning', area: 'negocio', message: `Cola ${q.queue}: ${q.failed} jobs fallidos (agotaron sus reintentos).` });
    }
  }
  return out;
}
