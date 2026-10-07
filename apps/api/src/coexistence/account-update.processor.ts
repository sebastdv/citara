import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
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

    // Sin RLS: whatsapp_channels se resuelve antes de conocer el tenant. La app
    // solo puede tocar `status` e `history_sync` (GRANT por columna). Una
    // desconexión solo toca canales activos, y una reconexión solo devuelve lo
    // que Meta desconectó: un canal que el operador dejó inactivo no revive. Con UPDATE, TypeORM devuelve [filas, conteo].
    const [rows] = (await this.ds.query(
      reconnect
        ? `UPDATE whatsapp_channels SET status = 'active'
            WHERE waba_id = $1 AND status = 'disconnected' RETURNING id, tenant_id`
        : `UPDATE whatsapp_channels SET status = 'disconnected'
            WHERE waba_id = $1 AND status = 'active' RETURNING id, tenant_id`,
      [wabaId])) as [{ id: string; tenant_id: string }[], number];

    for (const ch of rows) {
      await runInTenant(this.ds, ch.tenant_id, (m) => recordAudit(m, {
        tenantId: ch.tenant_id, actor: 'meta', action: reconnect ? 'channel.reconnected' : 'channel.disconnected',
        details: { channelId: ch.id, event },
      }));
    }
    return reconnect ? { disconnected: 0, reconnected: rows.length } : { disconnected: rows.length, reconnected: 0 };
  }
}
