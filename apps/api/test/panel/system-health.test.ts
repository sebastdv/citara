import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { backupStatus, systemAlerts, QueueStats } from '../../src/panel/system-health';
import { OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';

const NOW = new Date('2026-10-20T12:00:00Z');
const dirs: string[] = [];
const dirWith = (files: Record<string, Date>) => {
  const d = mkdtempSync(join(tmpdir(), 'citara-backups-')); dirs.push(d);
  for (const [name, at] of Object.entries(files)) { writeFileSync(join(d, name), 'x'); utimesSync(join(d, name), at, at); }
  return d;
};
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('respaldos', () => {
  it('sin carpeta configurada no se sabe (desarrollo)', () => {
    expect(backupStatus(undefined, NOW)).toEqual({ configured: false });
  });
  it('toma el diario más reciente e ignora los parciales, los semanales y los de antes de desplegar', () => {
    const d = dirWith({
      'daily-20261019-083000.dump': hoursAgo(27.5), 'daily-20261020-083000.dump': hoursAgo(3.5),
      '.daily-20261020-120000.dump.partial': hoursAgo(0), 'pre-deploy-20261020-110000-abc.dump': hoursAgo(1),
    });
    expect(backupStatus(d, NOW)).toEqual({ configured: true, last: 'daily-20261020-083000.dump', ageHours: 3 });
  });
  it('una carpeta vacía o inexistente es "sin respaldos"', () => {
    expect(backupStatus(dirWith({}), NOW)).toEqual({ configured: true, last: null, ageHours: null });
    expect(backupStatus('/no/existe/citara', NOW)).toEqual({ configured: true, last: null, ageHours: null });
  });
});

describe('avisos generales', () => {
  const ok = { backup: { configured: true as const, last: 'daily-x.dump', ageHours: 5 }, queues: [{ queue: 'outbound', failed: 0 }] };
  it('todo bien: sin avisos', () => {
    expect(systemAlerts(ok)).toEqual([]);
  });
  it('respaldo de 26 h o más, o ninguno, es crítico; sin carpeta es info', () => {
    expect(systemAlerts({ ...ok, backup: { configured: true, last: 'd', ageHours: 26 } }).map((a) => a.severity)).toEqual(['critical']);
    expect(systemAlerts({ ...ok, backup: { configured: true, last: null, ageHours: null } }).map((a) => a.severity)).toEqual(['critical']);
    expect(systemAlerts({ ...ok, backup: { configured: false } }).map((a) => a.severity)).toEqual(['info']);
  });
  it('jobs fallidos son aviso; sin Redis es crítico', () => {
    expect(systemAlerts({ ...ok, queues: [{ queue: 'outbound', failed: 3 }] })[0])
      .toMatchObject({ severity: 'warning', message: expect.stringContaining('3 jobs fallidos') });
    expect(systemAlerts({ ...ok, queues: null })[0]).toMatchObject({ severity: 'critical' });
  });
});

describe('QueueStats', () => {
  it('cuenta los jobs fallidos de cada cola y sin Redis devuelve null', async () => {
    const probe = new Queue(OUTBOUND_QUEUE, { connection: { url: process.env.REDIS_URL } });
    await probe.obliterate({ force: true });
    await probe.add('x', {}, { jobId: 'falla-1' });
    const events = new QueueEvents(OUTBOUND_QUEUE, { connection: { url: process.env.REDIS_URL } });
    await events.waitUntilReady();
    const failed = new Promise<void>((ok) => events.once('failed', () => ok()));
    const worker = new Worker(OUTBOUND_QUEUE, async () => { throw new UnrecoverableError('x'); },
      { connection: { url: process.env.REDIS_URL } });
    await failed;
    await worker.close(); await events.close();

    const stats = new QueueStats(process.env.REDIS_URL!);
    const counts = await stats.failed();
    expect(counts).toContainEqual({ queue: 'outbound', failed: 1 });
    expect(counts!.map((c) => c.queue).sort()).toEqual(['agent', 'calendar', 'inbound', 'outbound', 'reminders', 'sync']);
    await stats.close();
    await probe.obliterate({ force: true }); await probe.close();

    const dead = new QueueStats('redis://127.0.0.1:1');
    const t0 = Date.now();
    expect(await dead.failed()).toBeNull();
    await dead.close();
    expect(Date.now() - t0).toBeLessThan(4000);   // ni el conteo ni el cierre se cuelgan
  }, 10_000);
});
