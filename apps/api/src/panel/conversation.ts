import type { EntityManager } from 'typeorm';
import type { OutboundContent } from '@citara/shared';

export const CHAT_LIMIT = 200;
/**
 * `pending` es también el estado normal mientras el worker lo toma: solo pasado
 * este margen un mensaje del operador cuenta como atascado (y se ofrece reintentar).
 */
export const STUCK_AFTER_SECONDS = 30;

export interface ChatMessage { id: string; direction: 'in' | 'out'; origin: string; status: string | null; at: Date; text: string }

export interface ChatView {
  conversationId: string; contactName: string | null; waId: string; mode: string; channelId: string;
  channelStatus: string; tenantStatus: string; control: 'bot' | 'human'; reason: string | null;
  humanUntil: Date | null; lastInboundAt: Date | null; messages: ChatMessage[]; hasPendingOperator: boolean;
}

/** Lo interactivo y las plantillas como texto legible; un adjunto como su tipo. */
export function describeMessage(r: { direction: string; type: string; body: string | null; payload: unknown }): string {
  // El payload de un entrante es el mensaje crudo de Meta, no un OutboundContent.
  const p = r.direction === 'out' ? (r.payload as OutboundContent | null) : null;
  switch (p?.kind) {
    case 'buttons': return `${p.body}\n${p.buttons.map((b) => `[${b.title}]`).join(' ')}`;
    case 'list': return `${p.body}\n${p.sections.flatMap((s) => s.rows).map((x) => `[${x.title}]`).join(' ')}`;
    case 'template': return `Plantilla «${p.name}»`;
    default: return r.body ?? `[${r.type}]`;
  }
}

/** Corre dentro de runInTenant: una conversación de otro negocio no existe (null). */
export async function loadConversation(m: EntityManager, conversationId: string): Promise<ChatView | null> {
  const [c] = await m.query(
    `SELECT c.id, c.control, c.human_until, c.control_reason, c.last_inbound_at, c.channel_id,
            ct.wa_id, coalesce(ct.saved_name, ct.name) AS contact_name,
            ch.mode, ch.status AS channel_status, t.status AS tenant_status
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       JOIN whatsapp_channels ch ON ch.id = c.channel_id
       JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = $1`, [conversationId]);
  if (!c) return null;
  const rows: { id: string; direction: 'in' | 'out'; origin: string; status: string | null; type: string;
                body: string | null; payload: unknown; occurred_at: Date }[] = await m.query(
    `SELECT * FROM (
       SELECT id, direction, origin, status, type, body, payload, occurred_at, created_at, seq
         FROM messages WHERE conversation_id = $1
        ORDER BY occurred_at DESC, created_at DESC, seq DESC NULLS LAST LIMIT $2) x
     ORDER BY occurred_at, created_at, seq NULLS FIRST`, [conversationId, CHAT_LIMIT]);
  const [{ pending }] = await m.query(
    `SELECT EXISTS (SELECT 1 FROM messages
                     WHERE conversation_id = $1 AND origin = 'operator' AND status = 'pending'
                       AND created_at < now() - make_interval(secs => $2)) AS pending`,
    [conversationId, STUCK_AFTER_SECONDS]);
  return {
    conversationId: c.id, contactName: c.contact_name, waId: c.wa_id, mode: c.mode, channelId: c.channel_id,
    channelStatus: c.channel_status, tenantStatus: c.tenant_status, control: c.control, reason: c.control_reason,
    humanUntil: c.human_until, lastInboundAt: c.last_inbound_at, hasPendingOperator: pending,
    messages: rows.map((r) => ({ id: r.id, direction: r.direction, origin: r.origin, status: r.status,
                                 at: r.occurred_at, text: describeMessage(r) })),
  };
}
