import type { EntityManager } from 'typeorm';
import type { OutboundContent } from '@citara/shared';
import { messageTypeOf } from '../conversations/message-type';

/**
 * Salientes del bot en `pending`, enlazados al entrante que los produjo. El
 * `seq` continúa lo que el turno ya tenga: el flujo y el agente pueden
 * escribir en el mismo turno en momentos distintos.
 */
export async function insertBotReplies(
  m: EntityManager, tenantId: string, conversationId: string, replyToId: string, contents: OutboundContent[],
): Promise<void> {
  if (!contents.length) return;
  const [{ next }] = await m.query(
    `SELECT COALESCE(max(seq) + 1, 0)::int AS next FROM messages WHERE reply_to_id = $1`, [replyToId]);
  for (const [i, content] of contents.entries()) {
    // `type` con el MISMO vocabulario que el entrante (el de Meta); el `kind` fino viaja en `payload`.
    await m.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload,
                             status, reply_to_id, seq)
       VALUES ($1, $2, 'out', 'bot', $3, $4, $5, 'pending', $6, $7)`,
      [tenantId, conversationId, messageTypeOf(content), 'body' in content ? content.body : null,
       JSON.stringify(content), replyToId, next + i]);
  }
}
