import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { HistoryChunk } from '@citara/shared';
import { runInTenant } from '../tenancy/tenant-context';
import { giveControlToHuman } from '../conversations/control';
import type { HistoryJob } from '../queues/sync.queue';

/**
 * VERIFICAR contra la documentación: Meta manda el historial en fases (0: el
 * último día, 1: hasta 90 días, 2: hasta 180) y `progress` de 0 a 100. El
 * chunk de la última fase con progress 100 cierra la importación.
 */
export function historyComplete(chunk: HistoryChunk): boolean {
  return chunk.phase === 2 && chunk.progress === 100;
}

/**
 * Importa el historial de un número en coexistencia (spec §5.3) y, al
 * terminar, aplica la regla del dueño activo (§6.2). Corre en la cola `sync`
 * con concurrencia 1: llega en tandas grandes y no debe retrasar a nadie.
 */
@Injectable()
export class HistoryProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: HistoryJob): Promise<{ imported: number }> {
    const { tenantId, channelId, chunk } = job;

    return runInTenant(this.ds, tenantId, async (m) => {
      if (chunk.declined) {
        await m.query(`UPDATE whatsapp_channels SET history_sync = 'declined' WHERE id = $1`, [channelId]);
        return { imported: 0 };
      }

      let imported = 0;
      for (const thread of chunk.threads) {
        if (!thread.waId) continue;
        const fromCustomer = thread.messages.filter((x) => x.from === thread.waId);
        const lastInbound = fromCustomer.length
          ? new Date(Math.max(...fromCustomer.map((x) => x.timestamp.getTime())))
          : null;

        const [contact] = await m.query(
          `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2)
           ON CONFLICT (tenant_id, wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id
           RETURNING id`,
          [tenantId, thread.waId],
        );
        // GREATEST: la ventana de Meta cuenta mensajes reales del cliente,
        // aunque sean previos a Citara, y nunca se encoge.
        const [conversation] = await m.query(
          `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed'
             DO UPDATE SET last_inbound_at = GREATEST(conversations.last_inbound_at,
                                                      EXCLUDED.last_inbound_at),
                           updated_at = now()
           RETURNING id`,
          [tenantId, contact.id, channelId, lastInbound],
        );

        for (const msg of thread.messages) {
          if (!msg.wamid) continue;
          const rows = await m.query(
            `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type,
                                   body, payload, occurred_at)
             VALUES ($1, $2, $3, $4, 'history', $5, $6, $7, $8)
             ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
             RETURNING id`,
            [tenantId, conversation.id, msg.wamid, msg.from === thread.waId ? 'in' : 'out',
             msg.type, msg.text, JSON.stringify(msg.raw), msg.timestamp],
          );
          imported += rows.length;
        }
      }

      // La regla corre en el chunk final Y en cualquiera que llegue después:
      // con reentregas, el final puede procesarse antes que otros.
      const [channel] = await m.query(
        `SELECT history_sync FROM whatsapp_channels WHERE id = $1`, [channelId]);
      if (historyComplete(chunk) || channel?.history_sync === 'done') {
        await m.query(
          `UPDATE whatsapp_channels SET history_sync = 'done' WHERE id = $1 AND history_sync <> 'done'`,
          [channelId]);
        await this.applyRecentHumanRule(m, tenantId, channelId);
      }
      return { imported };
    });
  }

  /** El bot solo responde donde el dueño no estuvo activo en las últimas N horas. */
  private async applyRecentHumanRule(m: EntityManager, tenantId: string, channelId: string) {
    const recent: { conversation_id: string; last_out: Date }[] = await m.query(
      `SELECT msg.conversation_id, max(msg.occurred_at) AS last_out
         FROM messages msg
         JOIN conversations c ON c.id = msg.conversation_id
         JOIN tenants t ON t.id = c.tenant_id
        WHERE c.channel_id = $1 AND c.status = 'open'
          AND msg.direction = 'out' AND msg.origin IN ('history', 'phone')
        GROUP BY msg.conversation_id, t.human_takeover_hours
       HAVING max(msg.occurred_at) + make_interval(hours => t.human_takeover_hours) > now()`,
      [channelId],
    );
    for (const r of recent) {
      await giveControlToHuman(m, {
        tenantId, conversationId: r.conversation_id,
        from: new Date(r.last_out), reason: 'history', actor: 'history',
      });
    }
  }
}
