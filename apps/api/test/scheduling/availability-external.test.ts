import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { resetDb, seedChannel, seedCatalog, seedHours, addResource, closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const JUEVES = { from: new Date('2026-09-10T05:00:00Z'), to: new Date('2026-09-11T05:00:00Z') };  // jueves en Bogotá
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
// La persona tiene algo en su calendario de 10:00 a 11:00 (Bogotá).
const external = { busyFor: vi.fn().mockResolvedValue([
  { start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T16:00:00Z') }]) };

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  external.busyFor.mockClear();
});

describe('disponibilidad con lo ocupado fuera de Citara', () => {
  it('no ofrece las franjas que la persona tiene ocupadas en su calendario', async () => {
    const { availability } = buildScheduling(undefined, external);
    const slots = await inTenant((m) => availability.slotsFor(m, tenantId,
      { serviceId, resourceId: null, ...JUEVES, now: AHORA }));
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts).toContain('2026-09-10T14:30:00.000Z');       // 09:30
    expect(starts).not.toContain('2026-09-10T15:00:00.000Z');   // 10:00
    expect(starts).not.toContain('2026-09-10T15:30:00.000Z');   // 10:30
    expect(starts).toContain('2026-09-10T16:00:00.000Z');       // 11:00
    expect(external.busyFor).toHaveBeenCalledWith(expect.anything(), resourceId, expect.any(Date), expect.any(Date));
  });

  it('reservar sobre lo ocupado en Google se rechaza como "ocupado", no "fuera de horario"', async () => {
    const { availability } = buildScheduling(undefined, external);
    const verdict = await inTenant((m) => availability.check(m, tenantId,
      { serviceId, resourceId, start: new Date('2026-09-10T15:00:00Z'), now: AHORA }));
    expect(verdict).toBe('taken');
  });

  it('sin fuente externa, todo sigue como antes', async () => {
    const { availability } = buildScheduling();
    const slots = await inTenant((m) => availability.slotsFor(m, tenantId,
      { serviceId, resourceId: null, ...JUEVES, now: AHORA }));
    expect(slots.map((s) => s.start.toISOString())).toContain('2026-09-10T15:00:00.000Z');
  });

  it('consulta a Google por todos los recursos a la vez, no uno tras otro', async () => {
    await addResource(tenantId, 'pedro', 'Pedro', serviceId);
    const waiting: (() => void)[] = [];
    const slow = { busyFor: vi.fn(() => new Promise<[]>((r) => { waiting.push(() => r([])); })) };
    const { availability } = buildScheduling(undefined, slow);
    const done = inTenant((m) => availability.slotsFor(m, tenantId, { serviceId, resourceId: null, ...JUEVES, now: AHORA }));

    await new Promise((r) => setTimeout(r, 100));
    expect(slow.busyFor).toHaveBeenCalledTimes(2);
    waiting.forEach((resolve) => resolve());
    await done;
  });
});
