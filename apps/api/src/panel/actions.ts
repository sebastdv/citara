import type { EntityManager } from 'typeorm';
import { recordAudit } from '../audit/audit';
import { giveControlToHuman, humanInControl, readControl, returnControlToBot } from '../conversations/control';
import { canSendFreeform } from '../conversations/session-window';
import type { MessageOutboundJob } from '../queues/outbound.queue';

export const MAX_TEXT = 4096;

export class PanelActionError extends Error {
  constructor(readonly code: 'no_encontrada' | 'texto' | 'ventana' | 'negocio' | 'canal') { super(code); }
}

export const ACTION_NOTICE: Record<PanelActionError['code'], string> = {
  no_encontrada: 'Esa conversación no existe.',
  texto: `Escribe entre 1 y ${MAX_TEXT} caracteres.`,
  ventana: 'El cliente no ha escrito en las últimas 24 h: WhatsApp solo deja escribirle con una plantilla.',
  negocio: 'El negocio no está activo: no sale nada.',
  canal: 'El canal de WhatsApp está desconectado.',
};

interface Locked {
  id: string; channel_id: string; last_inbound_at: Date | null; wa_id: string;
  channel_status: string; tenant_status: string;
}

/**
 * Bloquea la conversación como el agente: FOR NO KEY UPDATE, no FOR UPDATE,
 * que choca con el FOR KEY SHARE de los inserts que la referencian. Corre
 * dentro de runInTenant: una conversación de otro negocio no aparece.
 */
async function lock(m: EntityManager, conversationId: string): Promise<Locked> {
  const [c] = await m.query(
    `SELECT c.id, c.channel_id, c.last_inbound_at, ct.wa_id, ch.status AS channel_status, t.status AS tenant_status
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       JOIN whatsapp_channels ch ON ch.id = c.channel_id
       JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = $1 FOR NO KEY UPDATE OF c`, [conversationId]);
  if (!c) throw new PanelActionError('no_encontrada');
  return c;
}

const actor = (operatorId: string) => `operator:${operatorId}`;

export async function takeControl(
  m: EntityManager, a: { tenantId: string; conversationId: string; operatorId: string; now: Date },
): Promise<void> {
  await lock(m, a.conversationId);
  const before = await readControl(m, a.conversationId);
  await giveControlToHuman(m, { tenantId: a.tenantId, conversationId: a.conversationId, from: a.now,
                                reason: 'operator', actor: actor(a.operatorId) });
  // giveControlToHuman audita el paso de bot a humano; pasar de otro humano al
  // operador también es una acción del panel y queda registrada.
  if (humanInControl(before, a.now) && before.reason !== 'operator') {
    await recordAudit(m, { tenantId: a.tenantId, actor: actor(a.operatorId), action: 'control.to_operator',
                           conversationId: a.conversationId, details: { from: before.reason } });
  }
}

export async function returnControl(
  m: EntityManager, a: { tenantId: string; conversationId: string; operatorId: string },
): Promise<void> {
  await lock(m, a.conversationId);
  await returnControlToBot(m, { tenantId: a.tenantId, conversationId: a.conversationId,
                                cause: 'operator', actor: actor(a.operatorId) });
}

/**
 * La respuesta del operador entra al outbox como `origin='operator'` (spec
 * §3.7.2); quien llama la encola tras el commit. Idempotente por envío: el
 * mismo formulario enviado dos veces (doble clic, recarga) no crea otra fila.
 */
export async function sendOperatorMessage(
  m: EntityManager,
  a: { tenantId: string; conversationId: string; operatorId: string; text: string; submissionId: string; now: Date },
): Promise<{ job: MessageOutboundJob; created: boolean }> {
  const text = a.text.trim();
  if (!text || text.length > MAX_TEXT) throw new PanelActionError('texto');
  const c = await lock(m, a.conversationId);
  const job = (messageId: string): MessageOutboundJob =>
    ({ tenantId: a.tenantId, channelId: c.channel_id, conversationId: c.id, to: c.wa_id, messageId });

  // Con la fila bloqueada, dos POST del mismo envío no pueden pasar a la vez.
  const [dup] = await m.query(
    `SELECT id FROM messages WHERE conversation_id = $1 AND origin = 'operator' AND payload->>'submissionId' = $2`,
    [c.id, a.submissionId]);
  if (dup) return { job: job(dup.id), created: false };

  if (c.tenant_status !== 'active') throw new PanelActionError('negocio');
  if (c.channel_status !== 'active') throw new PanelActionError('canal');
  if (!canSendFreeform(c.last_inbound_at, a.now)) throw new PanelActionError('ventana');

  // El bot no puede contestarle encima: enviar da (o alarga) el control del operador.
  await takeControl(m, a);
  const [row] = await m.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload, status)
     VALUES ($1, $2, 'out', 'operator', 'text', $3, $4, 'pending') RETURNING id`,
    [a.tenantId, c.id, text, JSON.stringify({ kind: 'text', body: text, submissionId: a.submissionId })]);
  await recordAudit(m, { tenantId: a.tenantId, actor: actor(a.operatorId), action: 'message.operator_sent',
                         conversationId: c.id, details: { messageId: row.id } });
  return { job: job(row.id), created: true };
}

/** Solo lo que nunca salió: un `unconfirmed` pudo llegar y no se reenvía a ciegas. */
export async function pendingOperatorJobs(
  m: EntityManager, a: { tenantId: string; conversationId: string },
): Promise<MessageOutboundJob[]> {
  const rows: { id: string; channel_id: string; wa_id: string }[] = await m.query(
    `SELECT msg.id, c.channel_id, ct.wa_id
       FROM messages msg
       JOIN conversations c ON c.id = msg.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
      WHERE msg.conversation_id = $1 AND msg.origin = 'operator' AND msg.status = 'pending'
      ORDER BY msg.created_at`, [a.conversationId]);
  return rows.map((r) => ({ tenantId: a.tenantId, channelId: r.channel_id, conversationId: a.conversationId,
                            to: r.wa_id, messageId: r.id }));
}
