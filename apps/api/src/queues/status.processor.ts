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

/**
 * El acuse le ganó al UPDATE que guarda el wamid: Meta puede avisar `delivered`
 * antes de que el worker de salida termine de registrar el envío. Lanzar hace
 * que BullMQ lo reintente con backoff en vez de perderlo.
 */
export class AckAheadError extends Error {}

@Injectable()
export class StatusProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: StatusJob): Promise<{ updated: boolean }> {
    const from = PREDECESSORS[job.status.status];
    if (!from) return { updated: false };

    return runInTenant(this.ds, job.tenantId, async (m) => {
      // Con UPDATE, TypeORM devuelve [filas, conteo].
      const [, affected] = (await m.query(
        `UPDATE messages SET status = $2
          WHERE wamid = $1 AND status = ANY($3::varchar[])`,
        [job.status.wamid, job.status.status, from])) as [unknown[], number];
      if (affected > 0) return { updated: true };
      // Un wamid que no conocemos y nada en vuelo: no es nuestro (o ya no importa).
      const [{ ahead }] = await m.query(
        `SELECT NOT EXISTS (SELECT 1 FROM messages WHERE wamid = $1)
            AND EXISTS (SELECT 1 FROM messages WHERE direction = 'out' AND status = 'sending') AS ahead`,
        [job.status.wamid]);
      if (ahead) throw new AckAheadError(`acuse ${job.status.status} de ${job.status.wamid} antes de su envío; se reintenta`);
      return { updated: false };
    });
  }
}
