import { DateTime } from 'luxon';

/** "jueves 10 de septiembre, 09:00" en la zona del negocio: lo que lee el cliente. */
export function labelFor(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).setLocale('es').toFormat("cccc d 'de' LLLL, HH:mm");
}

/** ISO-8601 con el offset del negocio, sin milisegundos: lo que reciben las herramientas. */
export function isoIn(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toISO({ suppressMilliseconds: true })!;
}
