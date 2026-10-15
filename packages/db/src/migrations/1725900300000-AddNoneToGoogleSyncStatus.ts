import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `none`: el recurso no tiene Google conectado, así que no hay nada que subir.
 * Antes esas citas nacían `pending` y se quedaban así para siempre, engordando
 * el índice parcial de pendientes que recorre el barrido cada minuto. Al
 * conectar Google, attachNewCalendar las pasa a `pending` (las futuras).
 */
export class AddNoneToGoogleSyncStatus1725900300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE appointments
        DROP CONSTRAINT appointments_google_sync_status_check,
        ADD CONSTRAINT appointments_google_sync_status_check
          CHECK (google_sync_status IN ('none', 'pending', 'synced', 'failed'))
    `);
    await q.query(`
      UPDATE appointments a SET google_sync_status = 'none'
       WHERE a.google_sync_status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM google_accounts g WHERE g.resource_id = a.resource_id)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE appointments SET google_sync_status = 'pending' WHERE google_sync_status = 'none'`);
    await q.query(`
      ALTER TABLE appointments
        DROP CONSTRAINT appointments_google_sync_status_check,
        ADD CONSTRAINT appointments_google_sync_status_check
          CHECK (google_sync_status IN ('pending', 'synced', 'failed'))
    `);
  }
}
