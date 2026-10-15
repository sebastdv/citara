import { readFileSync } from 'node:fs';
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
  | { configured: true; last: string | null; ageHours: number | null; error?: string };

/** Lo escribe deploy/server.sh tras cada respaldo nocturno: "<archivo> <epoch en segundos>". */
export const STATUS_FILE = 'last-nightly';

/**
 * El último respaldo nocturno, según el archivo de estado que deja server.sh. La
 * API no ve los respaldos en sí: solo esta carpeta, montada en solo lectura. Sin
 * carpeta (desarrollo) no se sabe.
 */
export function backupStatus(dir: string | undefined, now: Date): BackupStatus {
  if (!dir) return { configured: false };
  let content: string;
  try {
    content = readFileSync(join(dir, STATUS_FILE), 'utf8');
  } catch (err) {
    // Que no exista es "nunca corrió"; cualquier otra cosa (permisos) es un error a la vista.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { configured: true, last: null, ageHours: null };
    return { configured: true, last: null, ageHours: null, error: `${code ?? 'error'} al leer ${STATUS_FILE}` };
  }
  const m = /^(\S+)\s+(\d+)\s*$/.exec(content);
  if (!m) return { configured: true, last: null, ageHours: null, error: `${STATUS_FILE} mal formado` };
  const ageHours = Math.max(0, Math.floor((now.getTime() - Number(m[2]) * 1000) / 3_600_000));
  return { configured: true, last: m[1], ageHours };
}

export interface QueueFailures { queue: string; failed: number }

const QUEUES = [INBOUND_QUEUE, OUTBOUND_QUEUE, AGENT_QUEUE, CALENDAR_QUEUE, SYNC_QUEUE, REMINDERS_QUEUE];

const RECENT_MS = 24 * 3600_000;

/**
 * Jobs fallidos (agotaron reintentos o son irrecuperables) en las últimas 24 h,
 * por cola; null si Redis no responde. Solo los recientes: varias colas guardan
 * sus fallidos para inspección, y el total acumulado no se apagaría nunca.
 */
export class QueueStats {
  // Perezosas: el worker también construye este provider (comparte AppModule) y
  // nunca lo usa; no tiene por qué abrir seis conexiones a Redis.
  private queues: Queue[] | null = null;

  constructor(private readonly url: string) {}

  private open(): Queue[] {
    return this.queues ??= QUEUES.map((name) => {
      const q = new Queue(name, { connection: { url: this.url } });
      q.on('error', () => {}); // se reporta como null en failed()
      return q;
    });
  }

  async failed(): Promise<QueueFailures[] | null> {
    // El conjunto `failed` de BullMQ va ordenado por la hora en que falló cada job.
    const since = Date.now() - RECENT_MS;
    const counts = Promise.all(this.open().map(async (q) => {
      // El cliente es ioredis; BullMQ lo tipa con una interfaz mínima sin zcount.
      const client = (await q.client) as unknown as { zcount(key: string, min: number, max: string): Promise<number> };
      return { queue: q.name, failed: await client.zcount(q.toKey('failed'), since, '+inf') };
    }));
    const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), TIMEOUT_MS).unref());
    return Promise.race([counts.catch(() => null), timeout]);
  }

  onModuleDestroy() { return this.close(); }

  /** Con Redis caído, disconnect espera a una conexión que no llega: se abandona tras un segundo. */
  async close(): Promise<void> {
    if (!this.queues) return;
    const all = Promise.all(this.queues.map((q) => q.disconnect().catch(() => {})));
    await Promise.race([all, new Promise((ok) => setTimeout(ok, 1000).unref())]);
  }
}

/** Lo que vale para todo el servidor, no para un negocio. */
export function systemAlerts(s: { backup: BackupStatus; queues: QueueFailures[] | null }): Alert[] {
  const out: Alert[] = [];
  if (!s.backup.configured) {
    out.push({ severity: 'info', area: 'negocio', message: 'No hay carpeta de respaldos configurada (normal en desarrollo).' });
  } else if (s.backup.error) {
    out.push({ severity: 'critical', area: 'negocio', message: `No se puede leer el estado de los respaldos (${s.backup.error}): revisa el montaje en deploy/compose.yml.` });
  } else if (s.backup.last === null) {
    out.push({ severity: 'critical', area: 'negocio', message: 'No hay ningún respaldo nocturno: ¿está activo citara-backup.timer?' });
  } else if (s.backup.ageHours !== null && s.backup.ageHours >= BACKUP_MAX_AGE_HOURS) {
    out.push({ severity: 'critical', area: 'negocio', message: `El último respaldo nocturno tiene ${s.backup.ageHours} h: revisa journalctl -u citara-backup.` });
  }
  if (s.queues === null) {
    out.push({ severity: 'critical', area: 'negocio', message: 'Redis no responde: las colas están detenidas.' });
  } else {
    for (const q of s.queues) {
      if (q.failed > 0) out.push({ severity: 'warning', area: 'negocio', message: `Cola ${q.queue}: ${q.failed} jobs fallidos en las últimas 24 h (agotaron sus reintentos).` });
    }
  }
  return out;
}
