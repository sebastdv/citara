import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { GoogleApiError } from '../../src/google/google.client';
import { GoogleBusyService } from '../../src/google/google-busy.service';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, resourceId: string;
let google: { freeBusy: ReturnType<typeof vi.fn> };
let service: GoogleBusyService;

const FROM = new Date('2026-09-08T00:00:00Z'), TO = new Date('2026-09-20T00:00:00Z');
const BLOCK = { start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T16:00:00Z') };
const busy = (from = FROM, to = TO, now?: number) =>
  runInTenant(app, tenantId, (m: EntityManager) => service.busyFor(m, resourceId, from, to, now));

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  google = { freeBusy: vi.fn().mockResolvedValue([BLOCK]) };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  service = new GoogleBusyService(tokens as never, google as never);
});

describe('GoogleBusyService', () => {
  it('sin cuenta conectada no le pregunta a Google', async () => {
    expect(await busy()).toEqual([]);
    expect(google.freeBusy).not.toHaveBeenCalled();
  });

  it('una cuenta que hay que reconectar no se consulta', async () => {
    await seedGoogleAccount(tenantId, resourceId, { status: 'needs_reauth' });
    expect(await busy()).toEqual([]);
    expect(google.freeBusy).not.toHaveBeenCalled();
  });

  it('consulta el ocupado con un timeout corto', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    expect(await busy()).toEqual([BLOCK]);
    expect(google.freeBusy).toHaveBeenCalledWith('ya29.prueba', FROM, TO, 3000);
  });

  it('un rango dentro del ya consultado sale de la caché durante un minuto', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const t0 = Date.now();
    await busy(FROM, TO, t0);
    expect(await busy(new Date('2026-09-10T00:00:00Z'), new Date('2026-09-11T00:00:00Z'), t0 + 30_000)).toEqual([BLOCK]);
    expect(google.freeBusy).toHaveBeenCalledTimes(1);
    await busy(FROM, TO, t0 + 61_000);
    expect(google.freeBusy).toHaveBeenCalledTimes(2);
  });

  it('si Google falla, devuelve vacío en vez de lanzar', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    google.freeBusy.mockRejectedValue(new GoogleApiError('consulta de ocupado: fallo de red (TimeoutError)', null));
    expect(await busy()).toEqual([]);
  });
});
