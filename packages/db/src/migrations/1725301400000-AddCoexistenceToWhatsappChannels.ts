import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Modalidad del canal (D6) y estado de la importación del historial.
 *
 * El GRANT es por COLUMNA: la app necesita marcar un canal como desconectado
 * (`account_update`) y registrar el avance del historial, pero esta es la única
 * tabla sin RLS que guarda el token de todos los clientes. Un UPDATE de tabla
 * completa le permitiría reescribir el token o el phone_number_id de otro.
 */
export class AddCoexistenceToWhatsappChannels1725301400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE whatsapp_channels
        ADD COLUMN mode varchar(16) NOT NULL DEFAULT 'cloud_api'
          CHECK (mode IN ('cloud_api', 'coexistence')),
        ADD COLUMN history_sync varchar(16) NOT NULL DEFAULT 'not_applicable'
          CHECK (history_sync IN ('not_applicable', 'pending', 'done', 'declined'))
    `);
    await q.query(`GRANT UPDATE (status, history_sync) ON whatsapp_channels TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE UPDATE (status, history_sync) ON whatsapp_channels FROM citara_app`);
    await q.query(`ALTER TABLE whatsapp_channels DROP COLUMN history_sync, DROP COLUMN mode`);
  }
}
