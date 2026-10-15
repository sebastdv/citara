import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { recordAudit } from '../audit/audit';
import type { AccountUpdateJob } from '../queues/inbound.queue';

/** VERIFICAR contra la documentación: eventos que significan "este número ya no está conectado". */
export const DISCONNECT_EVENTS = new Set(['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED']);
/** VERIFICAR contra la documentación: el número volvió a quedar conectado. */
export const RECONNECT_EVENTS = new Set(['ACCOUNT_RECONNECTED']);

@Injectable()
export class AccountUpdateProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: AccountUpdateJob): Promise<{ disconnected: number; reconnected: number }> {
    const { wabaId, event } = job.update;
    const reconnect = RECONNECT_EVENTS.has(event);
    if (!reconnect && !DISCONNECT_EVENTS.has(event)) return { disconnected: 0, reconnected: 0 };

    // Una sola transacción: el cambio de estado y su auditoría quedan juntos o
    // no quedan (un fallo entre los dos dejaba un canal desconectado sin rastro).
    // Sin RLS: whatsapp_channels se resuelve antes de conocer el tenant. La app
    // solo puede tocar `status` e `history_sync` (GRANT por columna). Una
    // desconexión solo toca canales activos, y una reconexión solo devuelve lo
    // que Meta desconectó: un canal que el operador dejó inactivo no revive.
    const rows = await this.ds.transaction(async (m) => {
      // Con UPDATE, TypeORM devuelve [filas, conteo].
      const [changed] = (await m.query(
        reconnect
          ? `UPDATE whatsapp_channels SET status = 'active'
              WHERE waba_id = $1 AND status = 'disconnected' RETURNING id, tenant_id`
          : `UPDATE whatsapp_channels SET status = 'disconnected'
              WHERE waba_id = $1 AND status = 'active' RETURNING id, tenant_id`,
        [wabaId])) as [{ id: string; tenant_id: string }[], number];

      for (const ch of changed) {
        // set_config local a la transacción: el audit_log tiene RLS por negocio.
        await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [ch.tenant_id]);
        await recordAudit(m, {
          tenantId: ch.tenant_id, actor: 'meta', action: reconnect ? 'channel.reconnected' : 'channel.disconnected',
          details: { channelId: ch.id, event },
        });
        // Un negocio que quedó a medio alta cuando Meta lo desconectó termina de activarse.
        if (reconnect) await m.query(`SELECT refresh_tenant_status($1)`, [ch.tenant_id]);
      }
      return changed;
    });
    return reconnect ? { disconnected: 0, reconnected: rows.length } : { disconnected: rows.length, reconnected: 0 };
  }
}
