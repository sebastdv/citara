import type { MigrationInterface, QueryRunner } from 'typeorm';

/** El nombre con que el negocio tiene guardado al cliente en su celular (smb_app_state_sync). */
export class AddSavedNameToContacts1725301700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE contacts ADD COLUMN saved_name varchar(255)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE contacts DROP COLUMN saved_name`);
  }
}
