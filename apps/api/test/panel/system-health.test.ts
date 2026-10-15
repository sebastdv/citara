import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { backupStatus, systemAlerts, QueueStats } from '../../src/panel/system-health';
import { OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';

const NOW = new Date('2026-10-20T12:00:00Z');
const dirs: string[] = [];
const stateDir = (content?: string) => {
  const d = mkdtempSync(join(tmpdir(), 'citara-backup-status-')); dirs.push(d);
  if (content !== undefined) writeFileSync(join(d, 'last-nightly'), content);
  return d;
};
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
afterAll(() => { for (const d of dirs) { chmodSync(d, 0o755); rmSync(d, { recursive: true, force: true }); } });

describe('respaldos (archivo de estado del nocturno)', () => {
  it('sin carpeta configurada no se sabe (desarrollo)', () => {
    expect(backupStatus(undefined, NOW)).toEqual({ configured: false });
  });
  it('lee el nombre y la hora del último nocturno', () => {
    expect(backupStatus(stateDir(`daily-20261020-083000.dump ${epoch(hoursAgo(3.5))}\n`), NOW))
      .toEqual({ configured: true, last: 'daily-20261020-083000.dump', ageHours: 3 });
  });
  it('sin archivo (nunca corrió) o carpeta inexistente: sin respaldos', () => {
    expect(backupStatus(stateDir(), NOW)).toEqual({ configured: true, last: null, ageHours: null });
    expect(backupStatus('/no/existe/citara', NOW)).toEqual({ configured: true, last: null, ageHours: null });
  });
  it('un archivo ilegible o mal formado es un error, no "sin respaldos"', () => {
    const d = stateDir('daily-x.dump 1');
    chmodSync(join(d, 'last-nightly'), 0o000);
    expect(backupStatus(d, NOW)).toEqual({ configured: true, last: null, ageHours: null, error: expect.stringContaining('EACCES') });
    expect(backupStatus(stateDir('basura'), NOW)).toMatchObject({ configured: true, error: expect.stringContaining('mal formado') });
  });
});

describe('avisos generales', () => {
  const ok = { backup: { configured: true as const, last: 'daily-x.dump', ageHours: 5 }, queues: [{ queue: 'outbound', failed: 0 }],
              agentsWithoutKey: 0 };
  it('todo bien: sin avisos', () => {
    expect(systemAlerts(ok)).toEqual([]);
  });
  it('un error leyendo el estado de los respaldos es crítico, con su propio mensaje', () => {
    const [a] = systemAlerts({ ...ok, backup: { configured: true, last: null, ageHours: null, error: 'EACCES' } });
    expect(a).toMatchObject({ severity: 'critical', message: expect.stringContaining('No se puede leer') });
  });
  it('respaldo de 26 h o más, o ninguno, es crítico; sin carpeta es info', () => {
    expect(systemAlerts({ ...ok, backup: { configured: true, last: 'd', ageHours: 26 } }).map((a) => a.severity)).toEqual(['critical']);
    expect(systemAlerts({ ...ok, backup: { configured: true, last: null, ageHours: null } }).map((a) => a.severity)).toEqual(['critical']);
    expect(systemAlerts({ ...ok, backup: { configured: false } }).map((a) => a.severity)).toEqual(['info']);
  });
  it('sin ANTHROPIC_API_KEY y con negocios que tienen el agente encendido, avisa: van solo con menús', () => {
    expect(systemAlerts({ ...ok, agentsWithoutKey: 2 })).toEqual([expect.objectContaining({
      severity: 'warning', message: expect.stringMatching(/ANTHROPIC_API_KEY.*2 negocios/) })]);
  });
  it('jobs fallidos son aviso; sin Redis es crítico', () => {
    expect(systemAlerts({ ...ok, queues: [{ queue: 'outbound', failed: 3 }] })[0])
      .toMatchObject({ severity: 'warning', message: expect.stringContaining('3 jobs fallidos en las últimas 24 h') });
    expect(systemAlerts({ ...ok, queues: null })[0]).toMatchObject({ severity: 'critical' });
  });
});

describe('QueueStats', () => {
  it('no abre conexiones a Redis hasta que se le pide un conteo (el worker la crea y nunca la usa)', async () => {
    const probe = new Queue(OUTBOUND_QUEUE, { connection: { url: process.env.REDIS_URL } });
    const client = await probe.client;
    const clients = async () => String(await client.client('LIST')).trim().split('\n').length;
    const before = await clients();
    const stats = new QueueStats(process.env.REDIS_URL!);
    await new Promise((r) => setTimeout(r, 300));
    expect(await clients()).toBe(before);
    await stats.failed();
    expect(await clients()).toBeGreaterThan(before);
    await stats.close(); await probe.close();
  });

  it('cuenta los jobs fallidos de las últimas 24 h de cada cola, y sin Redis devuelve null', async () => {
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

    // Un fallo de hace dos días no cuenta: el aviso se apaga solo.
    const client = await probe.client;
    await client.zadd(probe.toKey('failed'), Date.now() - 48 * 3600_000, 'falla-vieja');
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
