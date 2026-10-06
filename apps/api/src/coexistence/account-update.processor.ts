import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';
import type { AccountUpdateJob } from '../queues/inbound.queue';

/** VERIFICAR contra la documentación: eventos que significan "este número ya no está conectado". */
export const DISCONNECT_EVENTS = new Set(['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED']);

@Injectable()
export class AccountUpdateProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: AccountUpdateJob): Promise<{ disconnected: number }> {
    const { wabaId, event } = job.update;
    if (!DISCONNECT_EVENTS.has(event)) return { disconnected: 0 };

    // Sin RLS: whatsapp_channels se resuelve antes de conocer el tenant. La app
    // solo puede tocar `status` e `history_sync` (GRANT por columna). Con
    // UPDATE, TypeORM devuelve [filas, conteo].
    const [rows] = (await this.ds.query(
      `UPDATE whatsapp_channels SET status = 'disconnected'
        WHERE waba_id = $1 AND status <> 'disconnected'
        RETURNING id, tenant_id`,
      [wabaId])) as [{ id: string; tenant_id: string }[], number];

    for (const ch of rows) {
      await runInTenant(this.ds, ch.tenant_id, (m) => recordAudit(m, {
        tenantId: ch.tenant_id, actor: 'meta', action: 'channel.disconnected',
        details: { channelId: ch.id, event },
      }));
    }
    return { disconnected: rows.length };
  }
}
