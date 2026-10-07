import type { OutboundContent } from '@citara/shared';

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

/**
 * ¿Este contenido solo puede salir con la ventana abierta? Switch exhaustivo a
 * propósito: el día que el contrato gane un `kind` de plantilla, esto deja de
 * compilar hasta que alguien decida su caso, en vez de bloquearlo en silencio.
 */
export function requiresOpenWindow(content: OutboundContent): boolean {
  switch (content.kind) {
    case 'text':
    case 'buttons':
    case 'list':
      return true;
    case 'template':
      // Las plantillas aprobadas por Meta son justo lo que puede salir fuera de las 24 h.
      return false;
    default: {
      const unhandled: never = content;
      throw new Error(`kind de salida sin regla de ventana: ${JSON.stringify(unhandled)}`);
    }
  }
}
