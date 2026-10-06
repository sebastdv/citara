import type { OutboundContent } from '@citara/shared';
import type { ResolvedChannel } from '../tenancy/channel-resolver.service';

const BUTTON_TITLE_MAX = 20;  // límite duro de Meta
const MAX_BUTTONS = 3;        // más de 3 no caben en un interactive de tipo button
const SEND_TIMEOUT_MS = 15_000;

export type MetaSendErrorKind = 'permanent' | 'retry' | 'window' | 'ambiguous';

/**
 * Por qué falló un envío, en los términos que le importan a quien decide qué
 * hacer después:
 * - `permanent`: Meta lo rechazó y lo rechazaría igual en cada intento.
 * - `retry`: Meta NO lo aceptó, pero el siguiente intento puede salir bien.
 * - `window`: pasaron las 24 h; solo una plantilla puede salir.
 * - `ambiguous`: pudo haber llegado (timeout, conexión cortada tras enviar,
 *   200 sin wamid). Reenviarlo arriesga duplicarle el mensaje al usuario.
 */
export class MetaSendError extends Error {
  constructor(
    message: string,
    readonly kind: MetaSendErrorKind,
    readonly status: number | null = null,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'MetaSendError';
  }
}

// Meta devuelve sus límites de tasa con HTTP 400, así que el código HTTP no
// basta. Lista tomada de la tabla de códigos de error de la Cloud API
// (throttling y "servicio no disponible"); VERIFICAR contra la tabla oficial
// cuando se grabe el primer rechazo real.
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 133004]);
const WINDOW_CLOSED_CODE = 131047;
// Errores de red en los que la petición ni siquiera salió: seguro reintentar.
const NOT_SENT_NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);

function classifyRejection(status: number, code: number | null): MetaSendErrorKind {
  if (code === WINDOW_CLOSED_CODE) return 'window';
  if (code !== null && RETRYABLE_CODES.has(code)) return 'retry';
  if (status === 429 || status >= 500) return 'retry';
  return 'permanent';
}

/**
 * Traduce nuestro contrato de salida al formato de Meta y lo envía.
 * Este es el ÚNICO lugar del sistema que conoce el formato de Meta al salir.
 */
export class MetaSender {
  // El phone_number_id NO va aquí: es propiedad del canal, y una instancia
  // compartida atiende a todos los tenants.
  constructor(private readonly graphVersion: string) {}

  async send(
    channel: ResolvedChannel,
    to: string,
    content: OutboundContent,
  ): Promise<{ wamid: string }> {
    const body = this.buildBody(to, content);

    let res: Response;
    try {
      res = await fetch(
        `https://graph.facebook.com/${this.graphVersion}/${channel.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${channel.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          // Sin tope, un Graph colgado retiene el slot del worker para siempre
          // y bloquea su cierre limpio en SIGTERM.
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
    } catch (err) {
      const netCode = (err as { cause?: { code?: string } }).cause?.code;
      const notSent = netCode !== undefined && NOT_SENT_NET_CODES.has(netCode);
      throw new MetaSendError(
        `Fallo de red al enviar a Meta: ${(err as Error).message}${netCode ? ` (${netCode})` : ''}`,
        notSent ? 'retry' : 'ambiguous',
      );
    }

    // Un 502 del balanceador de Meta llega en HTML: no debe convertirse en un
    // SyntaxError que esconda el status real.
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const code = typeof json?.error?.code === 'number' ? json.error.code : null;
      // El token jamás entra al mensaje de error: estos textos van a logs.
      throw new MetaSendError(
        `Meta rechazó el envío (${res.status}${code ? `, código ${code}` : ''}): ${json?.error?.message ?? 'sin detalle'}`,
        classifyRejection(res.status, code),
        res.status,
        code,
      );
    }
    // 200 sin `messages`: Meta lo procesó de algún modo que no entendemos.
    // Puede haber salido, así que no es un rechazo que se pueda reintentar.
    const wamid = json?.messages?.[0]?.id;
    if (!wamid) {
      throw new MetaSendError(`Meta respondió 200 sin wamid: ${JSON.stringify(json)}`, 'ambiguous', 200);
    }
    return { wamid };
  }

  private buildBody(to: string, content: OutboundContent): Record<string, unknown> {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };

    if (content.kind === 'text') {
      return { ...base, type: 'text', text: { body: content.body, preview_url: false } };
    }

    if (content.kind === 'buttons') {
      if (content.buttons.length > MAX_BUTTONS) {
        // Degradación: texto numerado. El normalizer del inbound recibirá el
        // número como texto y el motor lo resolverá por posición.
        const lines = content.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
        return { ...base, type: 'text',
                 text: { body: `${content.body}\n\n${lines}`, preview_url: false } };
      }
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: content.body },
          action: {
            buttons: content.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, BUTTON_TITLE_MAX) },
            })),
          },
        },
      };
    }

    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: content.body },
        action: { button: content.button.slice(0, BUTTON_TITLE_MAX), sections: content.sections },
      },
    };
  }
}
