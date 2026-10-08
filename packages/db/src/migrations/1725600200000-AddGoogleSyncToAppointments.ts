import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Proyección de la cita en Google (spec §7.3). `google_sync_version` sube con
 * cada cambio que hay que reflejar: la subida marca `synced` solo si la
 * versión no cambió mientras hablaba con Google (compare-and-set).
 */
export class AddGoogleSyncToAppointments1725600200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE appointments
        ADD COLUMN google_sync_version integer NOT NULL DEFAULT 0,
        ADD COLUMN google_synced_at timestamptz,
        ADD CONSTRAINT appointments_google_sync_status_check
          CHECK (google_sync_status IN ('pending', 'synced', 'failed'))
    `);
    await q.query(`
      CREATE INDEX appointments_google_pending ON appointments (tenant_id, resource_id)
        WHERE google_sync_status = 'pending'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX appointments_google_pending`);
    await q.query(`
      ALTER TABLE appointments
        DROP CONSTRAINT appointments_google_sync_status_check,
        DROP COLUMN google_synced_at,
        DROP COLUMN google_sync_version
    `);
  }
}
