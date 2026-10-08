import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
// Import de VALOR: BookingService es @Injectable() y Nest resuelve
// AvailabilityService por el design:paramtype que emite el decorador.
import { AvailabilityService, type Bookability } from './availability.service';
import { RemindersService } from './reminders.service';
import {
  NotFoundError, OutsideHoursError, SlotTakenError, TooFarError, TooSoonError,
} from './scheduling.errors';

const PG_EXCLUSION_VIOLATION = '23P01';
const COLUMNS = `id, service_id, resource_id, contact_id, conversation_id, starts_at, ends_at,
                 status, customer_name, notes, google_sync_status`;

export interface BookInput {
  serviceId: string; resourceId: string; contactId: string; startsAt: Date;
  customerName: string; conversationId?: string | null; notes?: string | null; now: Date;
}

export interface Appointment {
  id: string; serviceId: string; resourceId: string; contactId: string; conversationId: string | null;
  startsAt: Date; endsAt: Date; status: string; customerName: string | null; notes: string | null;
  googleSyncStatus: string;
}

export interface AppointmentView { id: string; startsAt: Date; endsAt: Date; serviceName: string; resourceName: string }

type Row = Record<string, any>;

@Injectable()
export class BookingService {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly reminders: RemindersService,
  ) {}

  async book(m: EntityManager, tenantId: string, input: BookInput): Promise<Appointment> {
    const verdict = await this.availability.check(m, tenantId, {
      serviceId: input.serviceId, resourceId: input.resourceId, start: input.startsAt, now: input.now });
    await this.throwUnlessOk(m, tenantId, verdict);

    const [service] = await m.query(`SELECT duration_min FROM services WHERE id = $1`, [input.serviceId]);
    const endsAt = new Date(input.startsAt.getTime() + service.duration_min * 60_000);

    // SAVEPOINT: la violación de exclusión aborta la transacción entera. Dentro
    // de un turno eso tumbaría todo el turno; con el savepoint solo se revierte
    // el INSERT y el flujo puede responder "esa franja se acaba de ocupar".
    await m.query(`SAVEPOINT reservar_cita`);
    try {
      const [row] = await m.query(
        `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, conversation_id,
                                   starts_at, ends_at, customer_name, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [tenantId, input.resourceId, input.serviceId, input.contactId, input.conversationId ?? null,
         input.startsAt, endsAt, input.customerName, input.notes ?? null]);
      await m.query(`RELEASE SAVEPOINT reservar_cita`);
      const cita = toAppointment(row);
      await this.reminders.scheduleFor(m, tenantId, cita.id, cita.startsAt, input.now);
      return cita;
    } catch (err) {
      await m.query(`ROLLBACK TO SAVEPOINT reservar_cita`);
      // La carrera consultar→reservar la resuelve el motor, no un if previo.
      if ((err as { code?: string }).code === PG_EXCLUSION_VIOLATION) throw new SlotTakenError();
      throw err;
    }
  }

  async cancel(m: EntityManager, appointmentId: string, contactId: string): Promise<Appointment> {
    // La propiedad se verifica en SQL (R3). Con UPDATE, TypeORM devuelve [filas, conteo].
    const [rows] = (await m.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = now(),
              google_sync_status = 'pending', google_sync_version = google_sync_version + 1
        WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'
        RETURNING ${COLUMNS}`, [appointmentId, contactId])) as [Row[], number];
    if (!rows[0]) throw new NotFoundError('esa cita');
    await this.reminders.cancelFor(m, appointmentId);
    return toAppointment(rows[0]);
  }

  /**
   * Mueve la MISMA cita (conserva su id: es su identidad, y la del evento de
   * Google en la Fase 4). La propia cita no cuenta como ocupado, así que puede
   * moverse 15 minutos aunque se solape consigo misma. Atómico: si algo falla,
   * la cita queda como estaba.
   */
  async reschedule(
    m: EntityManager, tenantId: string, appointmentId: string, contactId: string, newStart: Date, now: Date,
  ): Promise<Appointment> {
    const existing = await this.findForContact(m, appointmentId, contactId);
    if (!existing) throw new NotFoundError('esa cita');
    const verdict = await this.availability.check(m, tenantId, {
      serviceId: existing.serviceId, resourceId: existing.resourceId, start: newStart, now,
      excludeAppointmentId: appointmentId });
    await this.throwUnlessOk(m, tenantId, verdict);

    const [service] = await m.query(`SELECT duration_min FROM services WHERE id = $1`, [existing.serviceId]);
    const endsAt = new Date(newStart.getTime() + service.duration_min * 60_000);

    await m.query(`SAVEPOINT reprogramar_cita`);
    try {
      // Con UPDATE, TypeORM devuelve [filas, conteo]. La exclusión compara
      // contra las OTRAS filas, así que actualizar en sitio no choca consigo.
      const [rows] = (await m.query(
        `UPDATE appointments SET starts_at = $3, ends_at = $4, updated_at = now(),
                google_sync_status = 'pending', google_sync_version = google_sync_version + 1
          WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'
          RETURNING ${COLUMNS}`, [appointmentId, contactId, newStart, endsAt])) as [Row[], number];
      if (!rows[0]) throw new NotFoundError('esa cita');
      const cita = toAppointment(rows[0]);
      await this.reminders.rescheduleFor(m, tenantId, cita.id, cita.startsAt, now);
      await m.query(`RELEASE SAVEPOINT reprogramar_cita`);
      return cita;
    } catch (err) {
      await m.query(`ROLLBACK TO SAVEPOINT reprogramar_cita`);
      if ((err as { code?: string }).code === PG_EXCLUSION_VIOLATION) throw new SlotTakenError();
      throw err;
    }
  }

  private async throwUnlessOk(m: EntityManager, tenantId: string, verdict: Bookability): Promise<void> {
    if (verdict === 'ok') return;
    const settings = await this.availability.settings(m, tenantId);
    if (verdict === 'too_soon') throw new TooSoonError(settings.minLeadMin);
    if (verdict === 'too_far') throw new TooFarError(settings.horizonDays);
    if (verdict === 'taken') throw new SlotTakenError();
    throw new OutsideHoursError();
  }

  async listForContact(m: EntityManager, contactId: string, now: Date): Promise<AppointmentView[]> {
    const rows: Row[] = await m.query(
      `SELECT a.id, a.starts_at, a.ends_at, s.name AS service_name, r.name AS resource_name
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         JOIN resources r ON r.id = a.resource_id
        WHERE a.contact_id = $1 AND a.status = 'confirmed' AND a.starts_at >= $2
        ORDER BY a.starts_at`, [contactId, now]);
    return rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at,
                              serviceName: r.service_name, resourceName: r.resource_name }));
  }

  async findForContact(m: EntityManager, appointmentId: string, contactId: string): Promise<Appointment | null> {
    const [row] = await m.query(
      `SELECT ${COLUMNS} FROM appointments WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'`,
      [appointmentId, contactId]);
    return row ? toAppointment(row) : null;
  }
}

function toAppointment(r: Row): Appointment {
  return {
    id: r.id, serviceId: r.service_id, resourceId: r.resource_id, contactId: r.contact_id,
    conversationId: r.conversation_id, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status,
    customerName: r.customer_name, notes: r.notes, googleSyncStatus: r.google_sync_status,
  };
}
