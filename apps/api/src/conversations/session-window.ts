const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * La ventana de atención al cliente de WhatsApp: fuera de las 24 h desde el
 * último mensaje ENTRANTE solo se puede escribir con plantilla aprobada.
 * Se verifica ANTES de cada envío, no después de que Meta rechace.
 */
export function canSendFreeform(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}
