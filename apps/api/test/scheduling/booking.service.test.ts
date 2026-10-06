import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { NotFoundError, OutsideHoursError, SlotTakenError, TooFarError, TooSoonError }
  from '../../src/scheduling/scheduling.errors';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, addResource,
         adminQuery, closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;
let s: ReturnType<typeof buildScheduling>;

const JUEVES_10AM = new Date('2026-09-10T15:00:00Z'); // 10:00 en Bogotá
const AHORA = new Date('2026-09-08T12:00:00Z');
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const input = (startsAt = JUEVES_10AM, now = AHORA) =>
  ({ serviceId, resourceId, contactId, startsAt, customerName: 'Ana', now });

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  s = buildScheduling();
});

describe('BookingService.book', () => {
  it('reserva una franja libre y calcula el fin con la duración del servicio', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    expect(cita.startsAt.toISOString()).toBe(JUEVES_10AM.toISOString());
    expect(cita.endsAt.toISOString()).toBe('2026-09-10T15:30:00.000Z');
    expect([cita.status, cita.googleSyncStatus]).toEqual(['confirmed', 'pending']);
  });

  it('lanza SlotTakenError si la franja ya está ocupada', async () => {
    await inTenant((m) => s.booking.book(m, tenantId, input()));
    await expect(inTenant((m) => s.booking.book(m, tenantId, input()))).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('el buffer del servicio cuenta como ocupado', async () => {
    await adminQuery(`UPDATE services SET buffer_min = 15`);
    await inTenant((m) => s.booking.book(m, tenantId, input()));
    await expect(inTenant((m) => s.booking.book(m, tenantId, input(new Date('2026-09-10T15:30:00Z')))))
      .rejects.toBeInstanceOf(SlotTakenError);
  });

  it('si Postgres rechaza por solapamiento, la transacción de quien llama sigue viva', async () => {
    // Simula la carrera: la verificación dice "libre" pero otro ya insertó.
    await inTenant((m) => s.booking.book(m, tenantId, input()));
    vi.spyOn(s.availability, 'check').mockResolvedValue('ok');
    const n = await inTenant(async (m) => {
      await expect(s.booking.book(m, tenantId, input())).rejects.toBeInstanceOf(SlotTakenError);
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM appointments`);
      return n;
    });
    expect(n).toBe(1);
  });

  it('rechaza fuera del horario: domingo, pasado el cierre o de madrugada', async () => {
    for (const at of ['2026-09-13T15:00:00Z', '2026-09-10T22:45:00Z', '2026-09-10T08:00:00Z']) {
      await expect(inTenant((m) => s.booking.book(m, tenantId, input(new Date(at)))))
        .rejects.toBeInstanceOf(OutsideHoursError);
    }
  });

  it('rechaza sin la anticipación mínima y más allá del horizonte', async () => {
    await expect(inTenant((m) => s.booking.book(m, tenantId, input(JUEVES_10AM, new Date('2026-09-10T14:50:00Z')))))
      .rejects.toBeInstanceOf(TooSoonError);
    await expect(inTenant((m) => s.booking.book(m, tenantId, input(new Date('2027-03-04T15:00:00Z')))))
      .rejects.toBeInstanceOf(TooFarError);
  });

  it('reserva una franja que cruza la medianoche UTC', async () => {
    // 19:00 en Bogotá = 00:00Z del día siguiente.
    await adminQuery(`INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
                      VALUES ($1, 4, '18:00', '21:00')`, [tenantId]);
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input(new Date('2026-09-11T00:00:00Z'))));
    expect(cita.status).toBe('confirmed');
  });
});

describe('AvailabilityService.slotsFor', () => {
  it('con varios recursos, lo ocupado de uno no oculta lo libre del otro', async () => {
    const pedro = await addResource(tenantId, 'pedro', 'Pedro', serviceId);
    await inTenant((m) => s.booking.book(m, tenantId, input())); // María a las 10:00

    const slots = await inTenant((m) => s.availability.slotsFor(m, tenantId, {
      serviceId, resourceId: null, from: JUEVES_10AM, to: new Date('2026-09-10T15:30:00Z'), now: AHORA }));

    expect(slots.map((x) => x.resourceId)).toEqual([pedro]);
  });

  it('un recurso con horario propio usa el suyo y no el del negocio', async () => {
    await adminQuery(`INSERT INTO business_hours (tenant_id, resource_id, weekday, start_time, end_time)
                      VALUES ($1, $2, 4, '14:00', '15:00')`, [tenantId, resourceId]);
    const slots = await inTenant((m) => s.availability.slotsFor(m, tenantId, {
      serviceId, resourceId, from: new Date('2026-09-10T05:00:00Z'), to: new Date('2026-09-11T05:00:00Z'), now: AHORA }));
    expect(slots).toHaveLength(3); // bloque de una hora, 30 min cada 15: 14:00, 14:15 y 14:30
  });
});

describe('BookingService.cancel y reschedule', () => {
  it('cancela una cita propia y libera la franja', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const cancelada = await inTenant((m) => s.booking.cancel(m, cita.id, contactId));
    expect(cancelada.status).toBe('cancelled');
    await expect(inTenant((m) => s.booking.book(m, tenantId, input()))).resolves.toBeDefined();
  });

  it('no deja cancelar la cita de otro contacto', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const otro = await seedContact(tenantId, '573009998877');
    await expect(inTenant((m) => s.booking.cancel(m, cita.id, otro))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reprogramar mueve la MISMA cita: conserva id y nombre', async () => {
    // El id es la identidad de la cita (y el del evento de Google en la Fase 4):
    // moverla no es cancelar una y crear otra.
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const nueva = await inTenant((m) => s.booking.reschedule(
      m, tenantId, cita.id, contactId, new Date('2026-09-10T16:00:00Z'), AHORA));
    expect([nueva.id, nueva.customerName]).toEqual([cita.id, 'Ana']);
    const rows = await adminQuery(`SELECT status, starts_at FROM appointments`);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].starts_at).toISOString()).toBe('2026-09-10T16:00:00.000Z');
  });

  it('reprogramar puede mover la cita sobre su propio horario', async () => {
    await adminQuery(`UPDATE services SET buffer_min = 10`);
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    for (const at of ['2026-09-10T15:15:00Z', '2026-09-10T15:45:00Z']) { // se solapa / queda pegada
      const movida = await inTenant((m) => s.booking.reschedule(m, tenantId, cita.id, contactId, new Date(at), AHORA));
      expect(movida.startsAt.toISOString()).toBe(new Date(at).toISOString());
    }
  });

  it('si el horario nuevo está ocupado, la cita original sigue en pie', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const otro = await seedContact(tenantId, '573009998877');
    await inTenant((m) => s.booking.book(m, tenantId, { ...input(new Date('2026-09-10T16:00:00Z')), contactId: otro }));

    // Dentro de UNA transacción, como en un turno: si la del llamador se
    // revirtiera entera, el test pasaría sin probar el savepoint.
    const status = await inTenant(async (m) => {
      await expect(s.booking.reschedule(m, tenantId, cita.id, contactId, new Date('2026-09-10T16:00:00Z'), AHORA))
        .rejects.toBeInstanceOf(SlotTakenError);
      const [r] = await m.query(`SELECT status FROM appointments WHERE id = $1`, [cita.id]);
      return r.status;
    });
    expect(status).toBe('confirmed');
  });

  it('lista solo las citas futuras confirmadas del contacto', async () => {
    const futura = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const otra = await inTenant((m) => s.booking.book(m, tenantId, input(new Date('2026-09-11T15:00:00Z'))));
    await inTenant((m) => s.booking.cancel(m, otra.id, contactId));

    const citas = await inTenant((m) => s.booking.listForContact(m, contactId, AHORA));
    expect(citas.map((c) => c.id)).toEqual([futura.id]);
    expect(citas[0]).toMatchObject({ serviceName: 'Corte de cabello', resourceName: 'María' });
  });
});
