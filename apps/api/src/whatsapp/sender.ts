import type { OutboundContent } from '@citara/shared';
import type { ResolvedChannel } from '../tenancy/channel-resolver.service';

const BUTTON_TITLE_MAX = 20;  // límite duro de Meta
const MAX_BUTTONS = 3;        // más de 3 no caben en un interactive de tipo button
const SEND_TIMEOUT_MS = 15_000;

/**
 * Rechazo de Meta. `permanent` decide si vale la pena reintentar: un 4xx
 * (token inválido, fuera de ventana, payload mal armado) se repetiría igual
 * en cada intento; un 429 o un 5xx puede salir bien en el siguiente.
 */
export class MetaSendError extends Error {
  constructor(message: string, readonly status: number, readonly permanent: boolean) {
    super(message);
    this.name = 'MetaSendError';
  }
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

    const res = await fetch(
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

    // Un 502 del balanceador de Meta llega en HTML: no debe convertirse en un
    // SyntaxError que esconda el status real.
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // El token jamás entra al mensaje de error: estos textos van a logs.
      throw new MetaSendError(
        `Meta rechazó el envío (${res.status}): ${json?.error?.message ?? 'sin detalle'}`,
        res.status,
        res.status >= 400 && res.status < 500 && res.status !== 429,
      );
    }
    // Meta puede responder 200 sin `messages` (p.ej. cambios de forma del
    // API que no hemos visto todavía). Sin esta guarda, `json.messages[0].id`
    // revienta con un TypeError opaco ("Cannot read properties of
    // undefined") que no dice nada sobre qué respondió Meta.
    const wamid = json?.messages?.[0]?.id;
    if (!wamid) {
      throw new Error(
        `Meta respondió 200 sin wamid: ${JSON.stringify(json)}`,
      );
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
