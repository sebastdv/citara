import type { InboundMessage, InboundStatus, InboundType } from '@citara/shared';

const MEDIA_TYPES = ['image', 'audio', 'document', 'video'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const isMedia = (t: string): t is MediaType =>
  (MEDIA_TYPES as readonly string[]).includes(t);

const toDate = (unixSeconds: string): Date => new Date(Number(unixSeconds) * 1000);

/**
 * Meta manda arreglos en `changes`, `messages`, `statuses` y `contacts`, pero
 * este normalizador es la frontera del sistema: lo que entra no está bajo
 * nuestro control. `for...of` sobre un objeto lanza TypeError, así que basta
 * un campo con la forma equivocada para tumbar el handler del webhook. Esto
 * degrada cualquier cosa que no sea un arreglo a lista vacía.
 */
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/**
 * Traduce el payload de Meta a nuestro contrato interno.
 * Este es el ÚNICO lugar del sistema que conoce el formato de Meta al entrar.
 * Nunca lanza: un payload irreconocible produce listas vacías.
 */
export function normalizeWebhook(payload: unknown): {
  messages: InboundMessage[];
  statuses: InboundStatus[];
} {
  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];

  for (const entry of asArray((payload as any)?.entry)) {
    const wabaId = String(entry?.id ?? '');
    for (const change of asArray(entry?.changes)) {
      const value = change?.value;
      if (!value) continue;

      const phoneNumberId = String(value?.metadata?.phone_number_id ?? '');
      const profileByWaId = new Map<string, string | null>(
        asArray(value?.contacts).map((c: any) => [String(c?.wa_id), c?.profile?.name ?? null]),
      );

      for (const m of asArray(value?.messages)) {
        const rawType = String(m?.type ?? '');
        let type: InboundType = 'unsupported';
        let text: string | null = null;
        let mediaId: string | null = null;

        if (rawType === 'text') {
          type = 'text';
          text = m?.text?.body ?? null;
        } else if (rawType === 'interactive') {
          type = 'interactive';
          // Botón y lista se aplanan a su id: el motor de flujos ramifica por id.
          text = m?.interactive?.button_reply?.id
            ?? m?.interactive?.list_reply?.id
            ?? null;
        } else if (isMedia(rawType)) {
          type = rawType;
          mediaId = m?.[rawType]?.id ?? null;
        }

        messages.push({
          wamid: String(m?.id ?? ''),
          phoneNumberId,
          wabaId,
          from: String(m?.from ?? ''),
          profileName: profileByWaId.get(String(m?.from)) ?? null,
          type,
          text,
          mediaId,
          timestamp: toDate(m?.timestamp ?? '0'),
          raw: m,
        });
      }

      for (const s of asArray(value?.statuses)) {
        statuses.push({
          wamid: String(s?.id ?? ''),
          status: String(s?.status ?? ''),
          timestamp: toDate(s?.timestamp ?? '0'),
        });
      }
    }
  }

  return { messages, statuses };
}
