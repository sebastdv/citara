import { Injectable } from '@nestjs/common';
// Import de VALOR, no `import type`: EchoProcessor es @Injectable() y Nest
// resuelve DataSource por el design:paramtype que emite el decorador.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { giveControlToHuman } from '../conversations/control';
import type { EchoJob } from '../queues/inbound.queue';

/**
 * El dueño escribió desde su app de WhatsApp Business. Se guarda en la
 * conversación (es parte de ella) y el control pasa al humano (spec §6.1).
 * Corre en la cola `inbound`: el upsert de la conversación toma el mismo lock
 * que los mensajes del cliente, así que un eco y un mensaje simultáneos no se
 * procesan en desorden.
 */
@Injectable()
export class EchoProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: EchoJob): Promise<{ messageId: string; duplicate: boolean }> {
    const { tenantId, channelId, echo } = job;

    return runInTenant(this.ds, tenantId, async (m) => {
      // El duplicado se reconoce antes de tocar contactos y conversaciones. Aun
      // así le da el control al dueño: el mismo mensaje pudo llegar primero por
      // el historial (origin='history'), y descartarlo dejaría al bot hablando
      // encima de quien acaba de escribir. Es idempotente: GREATEST no acorta
      // el plazo y la bitácora solo registra cambios.
      const [seen] = await m.query(
        `SELECT id, conversation_id, direction FROM messages WHERE wamid = $1`, [echo.wamid]);
      if (seen) {
        if (seen.direction === 'out') {
          await giveControlToHuman(m, {
            tenantId, conversationId: seen.conversation_id,
            from: echo.timestamp, reason: 'phone', actor: 'phone',
          });
        }
        return { messageId: seen.id, duplicate: true };
      }

      // DO UPDATE (no DO NOTHING) para que RETURNING devuelva el id existente.
      const [contact] = await m.query(
        `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2)
         ON CONFLICT (tenant_id, wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id
         RETURNING id`,
        [tenantId, echo.to],
      );

      // Sin last_inbound_at: lo que escribe el negocio no abre la ventana de 24 h.
      const [conversation] = await m.query(
        `INSERT INTO conversations (tenant_id, contact_id, channel_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed'
           DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, contact.id, channelId],
      );

      const [saved] = await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type, body,
                               payload, occurred_at)
         VALUES ($1, $2, $3, 'out', 'phone', $4, $5, $6, $7)
         ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantId, conversation.id, echo.wamid, echo.type, echo.text,
         JSON.stringify(echo.raw), echo.timestamp],
      );
      if (!saved) return { messageId: '', duplicate: true }; // ganó otro intento

      await giveControlToHuman(m, {
        tenantId, conversationId: conversation.id,
        from: echo.timestamp, reason: 'phone', actor: 'phone',
      });
      return { messageId: saved.id, duplicate: false };
    });
  }
}
