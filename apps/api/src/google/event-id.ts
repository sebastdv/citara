const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OURS = /^[0-9a-f]{32}$/;

/**
 * El id del evento de Google para una cita (spec §7.3): el UUID en hex sin
 * guiones. Google acepta base32hex (0-9, a-v), y hex es un subconjunto. Con un
 * id nuestro, reintentar la creación devuelve 409 en vez de duplicar.
 */
export function googleEventId(appointmentId: string): string {
  const id = appointmentId.toLowerCase();
  if (!UUID.test(id)) throw new Error(`No es un uuid: ${appointmentId}`);
  return id.replace(/-/g, '');
}

/** La cita detrás de un evento, o null si el evento no lo creó Citara. */
export function appointmentIdFromEventId(eventId: string): string | null {
  if (!OURS.test(eventId)) return null;
  return `${eventId.slice(0, 8)}-${eventId.slice(8, 12)}-${eventId.slice(12, 16)}-${eventId.slice(16, 20)}-${eventId.slice(20)}`;
}
