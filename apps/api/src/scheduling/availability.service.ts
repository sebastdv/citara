import { Inject, Injectable, Optional } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DateTime } from 'luxon';
import { computeSlots, type BusyInterval, type HoursBlock } from './availability';
import { NotFoundError } from './scheduling.errors';

export interface BookingSettings { timezone: string; minLeadMin: number; horizonDays: number; granularityMin: number }
export interface ResourceSlot { start: Date; end: Date; resourceId: string; resourceName: string }
export type Bookability = 'ok' | 'too_soon' | 'too_far' | 'outside_hours' | 'taken';

/** Lo ocupado fuera de Citara (el calendario principal en Google). Nunca lanza. */
export interface ExternalBusy {
  busyFor(m: EntityManager, resourceId: string, from: Date, to: Date): Promise<BusyInterval[]>;
}
export const EXTERNAL_BUSY = Symbol('EXTERNAL_BUSY');
const NO_EXTERNAL_BUSY: ExternalBusy = { busyFor: async () => [] };

const HOURS_COLUMNS = `weekday, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"`;

/**
 * Sin estado: recibe el EntityManager de quien llama. Dentro de un turno corre
 * en la transacción del turno (RLS fijado, conversación bloqueada) y no abre
 * conexiones propias: con el lock tomado, una segunda conexión que necesitara
 * la misma fila colgaría el job sin que Postgres lo viera como deadlock.
 */
@Injectable()
export class AvailabilityService {
  constructor(@Optional() @Inject(EXTERNAL_BUSY) private readonly external: ExternalBusy = NO_EXTERNAL_BUSY) {}

  async settings(m: EntityManager, tenantId: string): Promise<BookingSettings> {
    const [t] = await m.query(
      `SELECT timezone, min_lead_minutes, horizon_days, slot_granularity_minutes FROM tenants WHERE id = $1`,
      [tenantId]);
    if (!t) throw new NotFoundError('el negocio');
    return { timezone: t.timezone, minLeadMin: t.min_lead_minutes,
             horizonDays: t.horizon_days, granularityMin: t.slot_granularity_minutes };
  }

  listServices(m: EntityManager) {
    return m.query(
      `SELECT id, key, name AS nombre, duration_min AS duracion_min, price_cents AS precio_centavos
         FROM services WHERE active ORDER BY name`);
  }

  /** Franjas libres por recurso. Con `resourceId` NULL, de todos los que prestan el servicio. */
  async slotsFor(
    m: EntityManager, tenantId: string,
    q: { serviceId: string; resourceId: string | null; from: Date; to: Date; now: Date;
         ignoreBusy?: boolean; excludeAppointmentId?: string },
  ): Promise<ResourceSlot[]> {
    const settings = await this.settings(m, tenantId);
    const [service] = await m.query(
      `SELECT duration_min, buffer_min FROM services WHERE id = $1 AND active`, [q.serviceId]);
    if (!service) throw new NotFoundError('el servicio');

    const resources: { id: string; name: string }[] = await m.query(
      `SELECT r.id, r.name FROM resources r
         JOIN resource_services rs ON rs.resource_id = r.id
        WHERE rs.service_id = $1 AND r.active AND ($2::uuid IS NULL OR r.id = $2)
        ORDER BY r.name`, [q.serviceId, q.resourceId]);

    // Lo ocupado se busca con margen: el buffer de una cita justo fuera del
    // rango puede bloquear el borde de una franja de adentro.
    const margin = service.buffer_min * 60_000;
    const out: ResourceSlot[] = [];
    for (const r of resources) {
      const own: HoursBlock[] = await m.query(
        `SELECT ${HOURS_COLUMNS} FROM business_hours WHERE resource_id = $1`, [r.id]);
      // Un recurso con horario propio usa el suyo; si no, el del negocio.
      const hours: HoursBlock[] = own.length ? own : await m.query(
        `SELECT ${HOURS_COLUMNS} FROM business_hours WHERE resource_id IS NULL`);
      const busy: BusyInterval[] = q.ignoreBusy ? [] : await m.query(
        `SELECT starts_at AS start, ends_at AS "end" FROM appointments
          WHERE resource_id = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2
            AND ($4::uuid IS NULL OR id <> $4)
         UNION ALL
         SELECT starts_at, ends_at FROM time_off
          WHERE (resource_id = $1 OR resource_id IS NULL) AND starts_at < $3 AND ends_at > $2`,
        [r.id, new Date(q.from.getTime() - margin), new Date(q.to.getTime() + margin),
         q.excludeAppointmentId ?? null]);

      // Lo ocupado en Google se suma a lo de Citara. Con el mismo margen del buffer.
      const external = q.ignoreBusy ? [] : await this.external.busyFor(
        m, r.id, new Date(q.from.getTime() - margin), new Date(q.to.getTime() + margin));

      for (const slot of computeSlots({
        from: q.from, to: q.to, now: q.now, timezone: settings.timezone,
        durationMin: service.duration_min, bufferMin: service.buffer_min,
        granularityMin: settings.granularityMin, minLeadMin: settings.minLeadMin,
        horizonDays: settings.horizonDays, hours, busy: [...busy, ...external],
      })) {
        out.push({ ...slot, resourceId: r.id, resourceName: r.name });
      }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.resourceName.localeCompare(b.resourceName));
  }

  /**
   * Veredicto de reserva (R1: la herramienta valida por su cuenta). Distingue
   * "fuera de horario" de "ocupado" para que el usuario reciba el motivo real.
   */
  async check(
    m: EntityManager, tenantId: string,
    q: { serviceId: string; resourceId: string; start: Date; now: Date;
         /** Al mover una cita, ella misma no cuenta como ocupado. */
         excludeAppointmentId?: string },
  ): Promise<Bookability> {
    const settings = await this.settings(m, tenantId);
    if (q.start.getTime() < q.now.getTime() + settings.minLeadMin * 60_000) return 'too_soon';
    const latest = DateTime.fromJSDate(q.now).setZone(settings.timezone).plus({ days: settings.horizonDays });
    if (DateTime.fromJSDate(q.start) > latest) return 'too_far';

    const [service] = await m.query(`SELECT duration_min FROM services WHERE id = $1 AND active`, [q.serviceId]);
    if (!service) return 'outside_hours';
    const window = { from: q.start, to: new Date(q.start.getTime() + service.duration_min * 60_000) };
    const fits = (slots: ResourceSlot[]) => slots.some((x) => x.start.getTime() === q.start.getTime());

    if (!fits(await this.slotsFor(m, tenantId, { ...q, ...window, ignoreBusy: true }))) return 'outside_hours';
    if (!fits(await this.slotsFor(m, tenantId, { ...q, ...window }))) return 'taken';
    return 'ok';
  }
}
