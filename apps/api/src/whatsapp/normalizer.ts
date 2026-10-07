import type {
  AccountUpdate, ContactSync, HistoryChunk, HistoryMessage, InboundMessage,
  InboundStatus, InboundType, PhoneEcho,
} from '@citara/shared';

const MEDIA_TYPES = ['image', 'audio', 'document', 'video'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const isMedia = (t: string): t is MediaType =>
  (MEDIA_TYPES as readonly string[]).includes(t);

const toDate = (unixSeconds: string): Date => new Date(Number(unixSeconds) * 1000);

/**
 * Meta manda arreglos en todas partes, pero este normalizador es la frontera
 * del sistema: lo que entra no está bajo nuestro control. `for...of` sobre un
 * objeto lanza TypeError, así que basta un campo con la forma equivocada para
 * tumbar el handler del webhook. Esto degrada lo que no sea arreglo a lista vacía.
 */
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** wa_id sin '+': el mismo cliente llega con y sin prefijo según el evento. */
const waId = (v: unknown): string => String(v ?? '').replace(/^\+/, '');

function parseContent(m: any): { type: InboundType; text: string | null; mediaId: string | null } {
  const rawType = String(m?.type ?? '');
  if (rawType === 'text') return { type: 'text', text: m?.text?.body ?? null, mediaId: null };
  if (rawType === 'interactive') {
    // Botón y lista se aplanan a su id: el motor de flujos ramifica por id.
    const id = m?.interactive?.button_reply?.id ?? m?.interactive?.list_reply?.id ?? null;
    return { type: 'interactive', text: id, mediaId: null };
  }
  if (isMedia(rawType)) return { type: rawType, text: null, mediaId: m?.[rawType]?.id ?? null };
  return { type: 'unsupported', text: null, mediaId: null };
}

export interface NormalizedWebhook {
  messages: InboundMessage[];
  statuses: InboundStatus[];
  echoes: PhoneEcho[];
  history: HistoryChunk[];
  contacts: ContactSync[];
  accountUpdates: AccountUpdate[];
}

/**
 * Traduce el payload de Meta a eventos internos, enrutando por
 * `changes[].field`. Este es el ÚNICO lugar del sistema que conoce el formato
 * de Meta al entrar. Nunca lanza: un payload irreconocible produce listas vacías.
 */
export function normalizeWebhook(payload: unknown): NormalizedWebhook {
  const out: NormalizedWebhook = {
    messages: [], statuses: [], echoes: [], history: [], contacts: [], accountUpdates: [],
  };

  for (const entry of asArray((payload as any)?.entry)) {
    const wabaId = String(entry?.id ?? '');
    for (const change of asArray(entry?.changes)) {
      const value = change?.value;
      if (!value || typeof value !== 'object') continue;
      const phoneNumberId = String(value?.metadata?.phone_number_id ?? '');

      switch (change?.field) {
        case 'smb_message_echoes': collectEchoes(out, value, wabaId, phoneNumberId); break;
        case 'history': collectHistory(out, value, wabaId, phoneNumberId); break;
        case 'smb_app_state_sync': collectContacts(out, value, wabaId, phoneNumberId); break;
        case 'account_update': collectAccountUpdate(out, value, wabaId); break;
        // Sin `field` se trata como `messages`, que es lo que Meta manda desde siempre.
        case 'messages': case undefined: collectMessages(out, value, wabaId, phoneNumberId); break;
        default: break; // campos a los que no estamos suscritos
      }
    }
  }
  return out;
}

function collectMessages(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  const profileByWaId = new Map<string, string | null>(
    asArray(value?.contacts).map((c: any) => [waId(c?.wa_id), c?.profile?.name ?? null]),
  );
  for (const m of asArray(value?.messages)) {
    out.messages.push({
      wamid: String(m?.id ?? ''),
      phoneNumberId,
      wabaId,
      from: waId(m?.from),
      profileName: profileByWaId.get(waId(m?.from)) ?? null,
      ...parseContent(m),
      timestamp: toDate(m?.timestamp ?? '0'),
      raw: m,
    });
  }
  for (const s of asArray(value?.statuses)) {
    out.statuses.push({
      wamid: String(s?.id ?? ''),
      phoneNumberId,
      wabaId,
      status: String(s?.status ?? ''),
      timestamp: toDate(s?.timestamp ?? '0'),
    });
  }
}

function collectEchoes(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  for (const m of asArray(value?.message_echoes)) {
    out.echoes.push({
      wamid: String(m?.id ?? ''),
      phoneNumberId,
      wabaId,
      to: waId(m?.to),
      ...parseContent(m),
      // Sin timestamp no es "de 1970": es actividad del dueño que acaba de llegar.
      timestamp: m?.timestamp ? toDate(m.timestamp) : new Date(),
      raw: m,
    });
  }
}

function collectHistory(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  for (const h of asArray(value?.history)) {
    const meta = h?.metadata;
    // VERIFICAR: Meta señala el rechazo a compartir con `errors` en el chunk.
    const declined = asArray(h?.errors).length > 0;
    out.history.push({
      phoneNumberId,
      wabaId,
      phase: typeof meta?.phase === 'number' ? meta.phase : null,
      progress: typeof meta?.progress === 'number' ? meta.progress : null,
      declined,
      threads: declined ? [] : asArray(h?.threads).map((t: any) => ({
        waId: waId(t?.id),
        messages: asArray(t?.messages).map((m: any): HistoryMessage => ({
          wamid: String(m?.id ?? ''),
          from: waId(m?.from),
          ...parseContent(m),
          timestamp: toDate(m?.timestamp ?? '0'),
          raw: m,
        })),
      })),
    });
  }
}

function collectContacts(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  for (const s of asArray(value?.state_sync)) {
    if (s?.type !== 'contact') continue;
    const action = s?.action === 'add' || s?.action === 'remove' ? s.action : null;
    const phone = waId(s?.contact?.phone_number);
    if (!action || !phone) continue;
    out.contacts.push({
      phoneNumberId, wabaId, waId: phone, action,
      name: s?.contact?.full_name ?? s?.contact?.first_name ?? null,
    });
  }
}

function collectAccountUpdate(out: NormalizedWebhook, value: any, wabaId: string) {
  if (typeof value?.event !== 'string' || !value.event) return;
  out.accountUpdates.push({
    wabaId, event: value.event,
    phoneNumber: value?.phone_number ? String(value.phone_number) : null,
  });
}
