import { DateTime, Interval } from 'luxon';

export interface HoursBlock { weekday: number; start: string; end: string }
export interface BusyInterval { start: Date; end: Date }
export interface Slot { start: Date; end: Date }

export interface SlotInput {
  from: Date;
  to: Date;
  /** IANA, de tenants.timezone. Toda la aritmética de calendario depende de esto. */
  timezone: string;
  durationMin: number;
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

/**
 * Franjas libres de UN recurso. Función PURA: no consulta ni persiste.
 *
 * Trabaja en la zona del negocio y deja que Luxon resuelva los offsets: sumar
 * 24 h en milisegundos se rompe en los cambios de horario de verano; avanzar un
 * día de calendario, no. Recorre todos los días LOCALES que toca [from, to],
 * incluido el del límite superior, y descarta lo que se salga del rango.
 */
export function computeSlots(input: SlotInput): Slot[] {
  const { timezone, durationMin, bufferMin, granularityMin, hours } = input;
  const from = DateTime.fromJSDate(input.from);
  const to = DateTime.fromJSDate(input.to);
  const now = DateTime.fromJSDate(input.now).setZone(timezone);
  const earliest = now.plus({ minutes: input.minLeadMin });
  const latest = now.plus({ days: input.horizonDays });

  // Lo ocupado se expande con el buffer a ambos lados.
  const blocked = input.busy.map((b) => Interval.fromDateTimes(
    DateTime.fromJSDate(b.start).minus({ minutes: bufferMin }),
    DateTime.fromJSDate(b.end).plus({ minutes: bufferMin }),
  ));

  const seen = new Set<number>();
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
        if (blocked.some((b) => b.overlaps(candidate))) continue;
        if (seen.has(start.toMillis())) continue; // bloques solapados
        seen.add(start.toMillis());
        slots.push({ start: start.toJSDate(), end: end.toJSDate() });
      }
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}
