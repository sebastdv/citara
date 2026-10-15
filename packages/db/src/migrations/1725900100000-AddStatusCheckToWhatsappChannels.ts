import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los estados de un canal son tres y el código decide por ellos (el resolutor
 * solo enruta `active` y `disconnected`): un typo en un UPDATE manual dejaba un
 * canal en un estado que nadie entiende, sin entrar ni salir nada.
 */
export class AddStatusCheckToWhatsappChannels1725900100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE whatsapp_channels ADD CONSTRAINT whatsapp_channels_status_check
        CHECK (status IN ('active', 'disconnected', 'inactive'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE whatsapp_channels DROP CONSTRAINT whatsapp_channels_status_check`);
  }
}
