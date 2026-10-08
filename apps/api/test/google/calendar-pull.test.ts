import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { googleEventId } from '../../src/google/event-id';
import { GoogleApiError, GoogleAuthError } from '../../src/google/google.client';
import { CalendarPullProcessor } from '../../src/google/calendar-pull.processor';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, seedGoogleAccount, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string, accountId: string;
let google: { listEvents: ReturnType<typeof vi.fn> };
let pull: CalendarPullProcessor;

const AHORA = new Date('2026-09-08T12:00:00Z');
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const book = (startsAt = new Date('2026-09-10T15:00:00Z')) => inTenant((m) => buildScheduling().booking.book(m, tenantId,
  { serviceId, resourceId, contactId, startsAt, customerName: 'Ana', now: AHORA }));
const synced = (id: string) => adminQuery(`UPDATE appointments SET google_sync_status = 'synced' WHERE id = $1`, [id]);
const page = (items: object[], next: { nextPageToken?: string; nextSyncToken?: string } = { nextSyncToken: 'S2' }) =>
  ({ items, nextPageToken: next.nextPageToken ?? null, nextSyncToken: next.nextSyncToken ?? null });
const moved = (id: string, start: string, end: string) =>
  ({ id: googleEventId(id), status: 'confirmed', start: { dateTime: start }, end: { dateTime: end } });
const run = () => pull.process({ tenantId, accountId }, AHORA);
const cita = async (id: string) => (await adminQuery(
  `SELECT status, starts_at, google_sync_status AS s, google_sync_version AS v FROM appointments WHERE id = $1`, [id]))[0];

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  google = { listEvents: vi.fn() };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  pull = new CalendarPullProcessor(app, tokens as never, google as never, buildScheduling(app).reminders);
});

describe('CalendarPullProcessor', () => {
  it('borrar la cita en Google la cancela en Citara, con sus recordatorios, y guarda el syncToken', async () => {
    const a = await book(); await synced(a.id);
    google.listEvents.mockResolvedValue(page([{ id: googleEventId(a.id), status: 'cancelled' }]));

    expect(await run()).toEqual({ cancelled: 1, moved: 0, rejected: 0 });

    expect((await cita(a.id)).status).toBe('cancelled');
    expect(await adminQuery(`SELECT DISTINCT status FROM reminders`)).toEqual([{ status: 'cancelled' }]);
    expect((await adminQuery(`SELECT actor, action FROM audit_log`))).toEqual(
      [{ actor: 'google', action: 'appointment.cancelled_in_google' }]);
    expect(await adminQuery(`SELECT sync_token FROM google_accounts`)).toEqual([{ sync_token: 'S2' }]);
    expect(google.listEvents).toHaveBeenCalledWith('ya29.prueba', 'citas123@group.calendar.google.com',
                                                   { syncToken: null, pageToken: null });
  });

  it('moverla en Google la mueve en Citara y reprograma los recordatorios', async () => {
    const a = await book(); await synced(a.id);
    google.listEvents.mockResolvedValue(page([moved(a.id, '2026-09-11T16:00:00Z', '2026-09-11T16:30:00Z')]));

    expect(await run()).toMatchObject({ moved: 1 });

    expect(new Date((await cita(a.id)).starts_at).toISOString()).toBe('2026-09-11T16:00:00.000Z');
    expect((await cita(a.id)).s).toBe('synced');
    const [r] = await adminQuery(`SELECT send_at FROM reminders WHERE kind = '24h'`);
    expect(new Date(r.send_at).toISOString()).toBe('2026-09-10T16:00:00.000Z');
  });

  it('si la cita tiene un cambio local pendiente, gana lo local', async () => {
    const a = await book();   // queda pending: todavía no subió
    google.listEvents.mockResolvedValue(page([{ id: googleEventId(a.id), status: 'cancelled' }]));
    expect(await run()).toEqual({ cancelled: 0, moved: 0, rejected: 0 });
    expect((await cita(a.id)).status).toBe('confirmed');
  });

  it('lo que no es una cita de Citara se ignora', async () => {
    google.listEvents.mockResolvedValue(page([{ id: '7kvq2h0s1d2o9c3jtn4u0tqk1c', status: 'confirmed',
      start: { dateTime: '2026-09-10T15:00:00Z' }, end: { dateTime: '2026-09-10T16:00:00Z' } }]));
    expect(await run()).toEqual({ cancelled: 0, moved: 0, rejected: 0 });
  });

  it('un movimiento que choca con otra cita no se aplica y la hora de Citara vuelve a Google', async () => {
    const a = await book(); await synced(a.id);
    const b = await book(new Date('2026-09-10T17:00:00Z')); await synced(b.id);
    google.listEvents.mockResolvedValue(page([moved(a.id, '2026-09-10T17:00:00Z', '2026-09-10T17:30:00Z')]));

    expect(await run()).toMatchObject({ rejected: 1 });

    expect(await cita(a.id)).toMatchObject({ status: 'confirmed', s: 'pending', v: 1 });
    expect(new Date((await cita(a.id)).starts_at).toISOString()).toBe('2026-09-10T15:00:00.000Z');
    expect((await adminQuery(`SELECT action FROM audit_log`))[0].action).toBe('appointment.move_rejected');
  });

  it('usa el syncToken guardado y recorre todas las páginas', async () => {
    await adminQuery(`UPDATE google_accounts SET sync_token = 'S1'`);
    google.listEvents
      .mockResolvedValueOnce(page([], { nextPageToken: 'P2' }))
      .mockResolvedValueOnce(page([], { nextSyncToken: 'S3' }));
    await run();
    expect(google.listEvents.mock.calls.map((c) => c[2])).toEqual([
      { syncToken: 'S1', pageToken: null }, { syncToken: 'S1', pageToken: 'P2' }]);
    expect(await adminQuery(`SELECT sync_token FROM google_accounts`)).toEqual([{ sync_token: 'S3' }]);
  });

  it('con el syncToken vencido (410), rehace la lectura desde cero', async () => {
    await adminQuery(`UPDATE google_accounts SET sync_token = 'VIEJO'`);
    google.listEvents
      .mockRejectedValueOnce(new GoogleApiError('lectura de cambios: Google respondió 410', 410))
      .mockResolvedValueOnce(page([]));
    await run();
    expect(google.listEvents.mock.calls.map((c) => c[2].syncToken)).toEqual(['VIEJO', null]);
  });

  it('un acceso revocado deja la cuenta para reconectar', async () => {
    google.listEvents.mockRejectedValue(new GoogleAuthError('renovación del token: Google respondió invalid_grant'));
    await run();
    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
  });
});
