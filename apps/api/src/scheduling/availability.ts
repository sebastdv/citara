import { DateTime, Interval } from 'luxon';

export interface HoursBlock { weekday: number; start: string; end: string }
export interface BusyInterval {
  start: Date;
  end: Date;
  /** El buffer de la cita ocupada: su limpieza va después de ella. */
  bufferMin?: number;
  /** Una ausencia (time_off): como el cierre, ni se alarga ni la alarga la limpieza de la franja. */
  absence?: boolean;
}
export interface Slot { start: Date; end: Date }

export interface SlotInput {
  from: Date;
  to: Date;
  /** IANA, de tenants.timezone. Toda la aritmética de calendario depende de esto. */
  timezone: string;
  durationMin: number;
  /** El buffer del servicio pedido: la limpieza que necesita la franja nueva al terminar. */
  bufferMin: number;
  granularityMin: number;
  minLeadMin: number;
  horizonDays: number;
  now: Date;
  hours: HoursBlock[];
  busy: BusyInterval[];
}

const at = (day: DateTime, hhmm: string) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
};

/** Por día, los bloques solapados o pegados (09-12 y 12-18) se vuelven uno: una cita puede cruzar el borde. */
export function mergeBlocks(hours: HoursBlock[]): HoursBlock[] {
  const out: HoursBlock[] = [];
  const sorted = [...hours].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  for (const h of sorted) {
    const last = out.at(-1);
    if (last && last.weekday === h.weekday && h.start <= last.end) {
      if (h.end > last.end) last.end = h.end;
    } else {
      out.push({ ...h });
    }
  }
  return out;
}

/**
 * Franjas libres de UN recurso. Función PURA: no consulta ni persiste.
 *
 * Trabaja en la zona del negocio y deja que Luxon resuelva los offsets: sumar
 * 24 h en milisegundos se rompe en los cambios de horario de verano; avanzar un
 * día de calendario, no. Recorre todos los días LOCALES que toca [from, to],
 * incluido el del límite superior, y descarta lo que se salga del rango.
 */
export function computeSlots(input: SlotInput): Slot[] {
  const { timezone, durationMin, bufferMin, granularityMin } = input;
  const hours = mergeBlocks(input.hours);
  const from = DateTime.fromJSDate(input.from);
  const to = DateTime.fromJSDate(input.to);
  const now = DateTime.fromJSDate(input.now).setZone(timezone);
  const earliest = now.plus({ minutes: input.minLeadMin });
  const latest = now.plus({ days: input.horizonDays });

  // El buffer es limpieza DESPUÉS de cada cita: una cita ocupa hasta el fin de
  // su propio buffer, y la franja nueva necesita el suyo libre al terminar.
  const blocked = input.busy.map((b) => ({
    absence: b.absence ?? false,
    interval: Interval.fromDateTimes(
      DateTime.fromJSDate(b.start),
      DateTime.fromJSDate(b.end).plus({ minutes: b.absence ? 0 : b.bufferMin ?? 0 })),
  }));

  const slots: Slot[] = [];
  const lastDay = to.setZone(timezone).startOf('day');

  for (let day = from.setZone(timezone).startOf('day'); day <= lastDay; day = day.plus({ days: 1 }).startOf('day')) {
    // Luxon: 1 = lunes … 7 = domingo. Nuestro esquema: 0 = domingo … 6 = sábado.
    const weekday = day.weekday % 7;
    for (const block of hours.filter((h) => h.weekday === weekday)) {
      const blockEnd = at(day, block.end);
      for (let start = at(day, block.start); ; start = start.plus({ minutes: granularityMin })) {
        const end = start.plus({ minutes: durationMin });
        if (end > blockEnd) break;
        if (start < from || end > to) continue;
        if (start < earliest || start > latest) continue;
        const candidate = Interval.fromDateTimes(start, end);
        const withCleanup = Interval.fromDateTimes(start, end.plus({ minutes: bufferMin }));
        if (blocked.some((b) => b.interval.overlaps(b.absence ? candidate : withCleanup))) continue;
        slots.push({ start: start.toJSDate(), end: end.toJSDate() });
      }
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}
