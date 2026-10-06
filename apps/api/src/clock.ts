/**
 * Hora para las decisiones de AGENDA (qué franjas ofrecer, si una cita está a
 * tiempo). Inyectable para que los tests fijen el día. La regla de control no
 * lo usa: compara contra now() de Postgres y debe ir con la hora real.
 */
export interface Clock { now(): Date }
export const CLOCK = Symbol('CLOCK');
export const systemClock: Clock = { now: () => new Date() };
