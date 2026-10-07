import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { ContactsSyncJob } from '../queues/sync.queue';

/** El nombre con que el negocio guarda a cada cliente en su celular (smb_app_state_sync). */
@Injectable()
export class ContactsSyncProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: ContactsSyncJob): Promise<void> {
    await runInTenant(this.ds, job.tenantId, async (m) => {
      for (const c of job.contacts) {
        if (c.action === 'add') {
          await m.query(
            `INSERT INTO contacts (tenant_id, wa_id, saved_name) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, wa_id) DO UPDATE SET saved_name = EXCLUDED.saved_name`,
            [job.tenantId, c.waId, c.name]);
        } else {
          await m.query(`UPDATE contacts SET saved_name = NULL WHERE wa_id = $1`, [c.waId]);
        }
      }
    });
  }
}
