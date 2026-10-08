import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { googleEventId } from '../../src/google/event-id';
import { GoogleApiError, GoogleAuthError } from '../../src/google/google.client';
import { CalendarPushProcessor } from '../../src/google/calendar-push.processor';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, seedGoogleAccount, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;
let google: Record<'insertEvent' | 'patchEvent' | 'deleteEvent', ReturnType<typeof vi.fn>>;
let push: CalendarPushProcessor;

const AHORA = new Date('2026-09-08T12:00:00Z');
const JUEVES_10AM = new Date('2026-09-10T15:00:00Z');
const CAL = 'citas123@group.calendar.google.com';
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const book = () => inTenant((m) => buildScheduling().booking.book(m, tenantId,
  { serviceId, resourceId, contactId, startsAt: JUEVES_10AM, customerName: 'Ana', now: AHORA }));
const sync = async (id: string) => (await adminQuery(
  `SELECT google_sync_status AS s, google_sync_version AS v, google_event_id AS e FROM appointments WHERE id = $1`, [id]))[0];

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  google = { insertEvent: vi.fn().mockResolvedValue('created'), patchEvent: vi.fn().mockResolvedValue(undefined),
             deleteEvent: vi.fn().mockResolvedValue(undefined) };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  push = new CalendarPushProcessor(app, tokens as never, google as never);
});

describe('CalendarPushProcessor', () => {
  it('sube la cita al calendario "Citas" con su id y la marca sincronizada', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'created' });

    const [token, cal, eventId, body] = google.insertEvent.mock.calls[0];
    expect([token, cal, eventId]).toEqual(['ya29.prueba', CAL, googleEventId(cita.id)]);
    expect(body).toMatchObject({
      summary: 'Corte de cabello — Ana',
      start: { dateTime: '2026-09-10T15:00:00.000Z', timeZone: 'America/Bogota' },
      end: { dateTime: '2026-09-10T15:30:00.000Z', timeZone: 'America/Bogota' },
      extendedProperties: { private: { citaraAppointmentId: cita.id } } });
    expect(body.description).toContain('+573001112233');
    expect(await sync(cita.id)).toEqual({ s: 'synced', v: 0, e: googleEventId(cita.id) });
  });

  it('si el evento ya existía (un reintento), lo pone al día en vez de duplicarlo', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockResolvedValue('exists');

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'updated' });
    expect(google.patchEvent).toHaveBeenCalledWith('ya29.prueba', CAL, googleEventId(cita.id), expect.any(Object));
  });

  it('cancelar y reprogramar por WhatsApp dejan la cita pendiente con una versión nueva', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    const s = buildScheduling();
    await inTenant((m) => s.booking.reschedule(m, tenantId, cita.id, contactId, new Date('2026-09-10T16:00:00Z'), AHORA));
    expect(await sync(cita.id)).toMatchObject({ s: 'pending', v: 1 });
    await inTenant((m) => s.booking.cancel(m, cita.id, contactId));
    expect(await sync(cita.id)).toMatchObject({ s: 'pending', v: 2 });
  });

  it('una cita cancelada se borra de Google', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    await inTenant((m) => buildScheduling().booking.cancel(m, cita.id, contactId));

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 1 })).toEqual({ result: 'deleted' });
    expect(google.deleteEvent).toHaveBeenCalledWith('ya29.prueba', CAL, googleEventId(cita.id));
    expect((await sync(cita.id)).s).toBe('synced');
  });

  it('si la cita cambió mientras subía, queda pendiente para la versión nueva', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockImplementation(async () => {
      await adminQuery(`UPDATE appointments SET google_sync_version = google_sync_version + 1`);
      return 'created';
    });

    await push.process({ tenantId, appointmentId: cita.id, version: 0 });

    expect(await sync(cita.id)).toMatchObject({ s: 'pending', v: 1 });
  });

  it('un job de una versión vieja no hace nada', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 7 })).toEqual({ result: 'skipped' });
    expect(google.insertEvent).not.toHaveBeenCalled();
  });

  it('sin cuenta de Google, o con la cuenta caída, la cita queda pendiente sin llamar a Google', async () => {
    const cita = await book();
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'skipped' });
    await seedGoogleAccount(tenantId, resourceId, { status: 'needs_reauth' });
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'skipped' });
    expect(google.insertEvent).not.toHaveBeenCalled();
    expect((await sync(cita.id)).s).toBe('pending');
  });

  it('un acceso revocado deja la cuenta para reconectar y la cita pendiente', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockRejectedValue(new GoogleAuthError('renovación del token: Google respondió invalid_grant'));

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'skipped' });

    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
    expect((await sync(cita.id)).s).toBe('pending');
  });

  it('si el dueño borró el calendario "Citas", la cuenta queda sin calendario para recrearlo', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockRejectedValue(new GoogleApiError('creación del evento: Google respondió 404', 404));

    await push.process({ tenantId, appointmentId: cita.id, version: 0 });

    expect(await adminQuery(`SELECT calendar_id FROM google_accounts`)).toEqual([{ calendar_id: null }]);
    expect((await sync(cita.id)).s).toBe('pending');
  });

  it('un rechazo permanente marca la cita como fallida; uno pasajero se reintenta', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockRejectedValueOnce(new GoogleApiError('creación del evento: Google respondió 503', 503));
    await expect(push.process({ tenantId, appointmentId: cita.id, version: 0 })).rejects.toThrow(/503/);
    expect((await sync(cita.id)).s).toBe('pending');

    google.insertEvent.mockRejectedValueOnce(new GoogleApiError('creación del evento: Google respondió 400', 400));
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'failed' });
    expect((await sync(cita.id)).s).toBe('failed');
  });
});
