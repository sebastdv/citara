import { describe, it, expect } from 'vitest';
import { computeSlots, type SlotInput } from '../../src/scheduling/availability';

const BOGOTA = 'America/Bogota'; // UTC-5 todo el año
const NY = 'America/New_York';   // con horario de verano

// Jueves 10 de septiembre de 2026, 09:00-12:00 local.
const base: SlotInput = {
  timezone: BOGOTA,
  durationMin: 30, bufferMin: 0, granularityMin: 30, minLeadMin: 0, horizonDays: 365,
  now: new Date('2026-09-01T00:00:00Z'),
  hours: [{ weekday: 4, start: '09:00', end: '12:00' }],
  busy: [],
  from: new Date('2026-09-10T00:00:00Z'),
  to: new Date('2026-09-11T00:00:00Z'),
};

const hhmm = (d: Date, tz = BOGOTA) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const starts = (input: SlotInput, tz = BOGOTA) => computeSlots(input).map((s) => hhmm(s.start, tz));

describe('computeSlots', () => {
  it('genera franjas de 30 min entre 09:00 y 12:00 hora local', () => {
    expect(starts(base)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('la última franja termina justo al cierre, nunca después', () => {
    const slots = computeSlots({ ...base, durationMin: 45, granularityMin: 45 });
    expect(slots.map((s) => hhmm(s.start))).toEqual(['09:00', '09:45', '10:30', '11:15']);
    expect(hhmm(slots.at(-1)!.end)).toBe('12:00');
  });

  it('excluye las franjas ocupadas por una cita existente', () => {
    expect(starts({ ...base, busy: [{ start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z') }] }))
      .toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']); // 15:00Z = 10:00 Bogotá
  });

  it('el buffer es limpieza después de cada cita: la de antes y la nueva necesitan el suyo', () => {
    expect(starts({ ...base, bufferMin: 15,
      busy: [{ start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z'), bufferMin: 15 }] }))
      .toEqual(['09:00', '11:00', '11:30']);
  });

  it('cada cita ocupada usa SU buffer, no el del servicio que se pide', () => {
    const cita = { start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z') }; // 10:00-10:30
    // La de 10:00 no necesita limpieza: 10:30 queda libre aunque el servicio pedido tenga buffer.
    expect(starts({ ...base, bufferMin: 0, busy: [{ ...cita, bufferMin: 0 }] }))
      .toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
    // La de 10:00 deja 20 min de limpieza: 10:30 ya no cabe, aunque el pedido no tenga buffer.
    expect(starts({ ...base, bufferMin: 0, busy: [{ ...cita, bufferMin: 20 }] }))
      .toEqual(['09:00', '09:30', '11:00', '11:30']);
  });

  it('una ausencia no se agranda con el buffer: se trata como el cierre', () => {
    const ausencia = { start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z'), absence: true };
    expect(starts({ ...base, bufferMin: 15, busy: [ausencia] }))
      .toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('un bloque que cierra a las 24:00 ofrece la última franja de la noche', () => {
    const slots = computeSlots({ ...base, hours: [{ weekday: 4, start: '22:30', end: '24:00' }],
      to: new Date('2026-09-12T00:00:00Z') });
    expect(slots.map((s) => hhmm(s.start))).toEqual(['22:30', '23:00', '23:30']);
    expect(slots.at(-1)!.end.toISOString()).toBe('2026-09-11T05:00:00.000Z'); // medianoche en Bogotá
  });

  it('dos bloques pegados del mismo día se unen: una cita puede cruzar el borde', () => {
    const slots = starts({ ...base, durationMin: 60, granularityMin: 30,
      hours: [{ weekday: 4, start: '09:00', end: '10:30' }, { weekday: 4, start: '10:30', end: '12:00' }] });
    expect(slots).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('respeta la anticipación mínima', () => {
    expect(starts({ ...base, now: new Date('2026-09-10T14:40:00Z'), minLeadMin: 60 }))
      .toEqual(['11:00', '11:30']); // 09:40 local + 60 min
  });

  it('respeta el horizonte máximo', () => {
    expect(computeSlots({ ...base, horizonDays: 5 })).toEqual([]); // el 10 está a 9 días del 1
  });

  it('devuelve vacío en un día sin horario', () => {
    expect(computeSlots({ ...base, from: new Date('2026-09-12T00:00:00Z'), to: new Date('2026-09-13T00:00:00Z') }))
      .toEqual([]);
  });

  it('cubre todos los días locales del rango, incluido el del límite superior', () => {
    // Hasta el sábado 00:00Z = viernes 19:00 en Bogotá: el viernes entra.
    const slots = computeSlots({ ...base,
      hours: [{ weekday: 4, start: '09:00', end: '10:00' }, { weekday: 5, start: '09:00', end: '10:00' }],
      to: new Date('2026-09-12T00:00:00Z') });
    expect(slots).toHaveLength(4);
  });

  it('no devuelve franjas fuera del rango pedido', () => {
    expect(starts({ ...base, from: new Date('2026-09-10T15:00:00Z'), to: new Date('2026-09-10T16:00:00Z') }))
      .toEqual(['10:00', '10:30']);
  });

  it('bloques que se solapan no duplican franjas', () => {
    expect(starts({ ...base, hours: [{ weekday: 4, start: '09:00', end: '11:00' }, { weekday: 4, start: '10:00', end: '12:00' }] }))
      .toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('honra el horario LOCAL a través de un cambio de horario de verano', () => {
    // Nueva York vuelve a hora estándar el domingo 1 de noviembre de 2026.
    const slots = computeSlots({ ...base, timezone: NY,
      hours: [{ weekday: 1, start: '09:00', end: '10:00' }],
      from: new Date('2026-10-25T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z'),
      now: new Date('2026-10-01T00:00:00Z') });
    expect(slots.map((s) => hhmm(s.start, NY))).toEqual(['09:00', '09:30', '09:00', '09:30']);
    expect(slots[0].start.toISOString()).toBe('2026-10-26T13:00:00.000Z');
    expect(slots[2].start.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('devuelve vacío si la duración no cabe en ningún bloque', () => {
    expect(computeSlots({ ...base, durationMin: 240 })).toEqual([]);
  });
});
