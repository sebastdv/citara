import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { CalendarSweep } from '../../src/google/calendar-sweep.service';
import { resetDb, seedChannel, seedCatalog, seedContact, seedGoogleAccount, addResource, adminQuery,
         closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;
let sweep: CalendarSweep;

const AHORA = new Date('2026-09-08T12:00:00Z');
const appointment = async (resource: string, startsAt: string) => (await adminQuery(
  `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
   VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '30 minutes') RETURNING id`,
  [tenantId, resource, serviceId, contactId, startsAt]))[0].id as string;
const pushes = async () => (await sweep.run(AHORA)).filter((j) => j.name === 'push');

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  contactId = await seedContact(tenantId);
  sweep = new CalendarSweep(app);
});

describe('CalendarSweep: subidas', () => {
  it('encola lo pendiente de recursos conectados, con un jobId por versión', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const id = await appointment(resourceId, '2026-09-10T15:00:00Z');
    expect(await pushes()).toEqual([{ name: 'push', data: { tenantId, appointmentId: id, version: 0 }, jobId: `push-${id}-0` }]);
  });

  it('no encola lo de recursos sin cuenta, con la cuenta caída o sin calendario', async () => {
    const pedro = await addResource(tenantId, 'pedro', 'Pedro', serviceId);
    await appointment(pedro, '2026-09-10T15:00:00Z');
    await seedGoogleAccount(tenantId, resourceId, { calendarId: null });
    await appointment(resourceId, '2026-09-10T15:00:00Z');
    expect(await pushes()).toEqual([]);
    await adminQuery(`UPDATE google_accounts SET calendar_id = 'c', status = 'needs_reauth'`);
    expect(await pushes()).toEqual([]);
  });

  it('no sube historia ni lo de un negocio suspendido', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    await appointment(resourceId, '2026-09-01T15:00:00Z');
    expect(await pushes()).toEqual([]);
    await appointment(resourceId, '2026-09-10T15:00:00Z');
    await adminQuery(`UPDATE tenants SET status = 'suspended'`);
    expect(await pushes()).toEqual([]);
  });
});
