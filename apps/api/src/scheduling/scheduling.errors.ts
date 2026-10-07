/** Errores que se le explican al usuario; cualquier otro es un fallo del sistema. */
export class SchedulingError extends Error {}

export class SlotTakenError extends SchedulingError {
  constructor() { super('Esa franja ya está ocupada'); }
}
export class OutsideHoursError extends SchedulingError {
  constructor() { super('Ese horario está fuera de la atención del negocio'); }
}
export class TooSoonError extends SchedulingError {
  constructor(minLeadMin: number) { super(`Se necesita al menos ${minLeadMin} minutos de anticipación`); }
}
export class TooFarError extends SchedulingError {
  constructor(horizonDays: number) { super(`Solo se agenda con hasta ${horizonDays} días de anticipación`); }
}
export class NotFoundError extends SchedulingError {
  constructor(what = 'recurso') { super(`No se encontró ${what}`); }
}
