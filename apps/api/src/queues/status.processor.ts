import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { StatusJob } from './inbound.queue';

/**
 * De qué estados puede venir cada uno. Solo hacia adelante: Meta no garantiza
 * el orden de los acuses, y un `delivered` tardío no puede deshacer un `read`.
 * Las filas sin estado (ecos, historial) quedan fuera porque NULL no está en
 * ninguna lista.
 */
const PREDECESSORS: Record<string, string[]> = {
  delivered: ['sent'],
  read: ['sent', 'delivered'],
  failed: ['sent', 'delivered'],
};

@Injectable()
export class StatusProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: StatusJob): Promise<{ updated: boolean }> {
    const from = PREDECESSORS[job.status.status];
    if (!from) return { updated: false };

    // Con UPDATE, TypeORM devuelve [filas, conteo].
    const [, affected] = (await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE messages SET status = $2
        WHERE wamid = $1 AND status = ANY($3::varchar[])`,
      [job.status.wamid, job.status.status, from]))) as [unknown[], number];
    return { updated: affected > 0 };
  }
}
