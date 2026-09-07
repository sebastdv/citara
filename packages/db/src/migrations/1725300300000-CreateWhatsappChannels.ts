import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWhatsappChannels1725300300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE whatsapp_channels (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        waba_id                varchar(64) NOT NULL,
        phone_number_id        varchar(64) NOT NULL UNIQUE,
        display_phone_number   varchar(32),
        access_token_encrypted bytea NOT NULL,
        status                 varchar(32) NOT NULL DEFAULT 'active',
        created_at             timestamptz NOT NULL DEFAULT now()
      )
    `);
    // La resolución de canal ocurre ANTES de conocer el tenant, así que esta
    // tabla no lleva RLS; se lee por phone_number_id, que es único global.
    await q.query(`GRANT SELECT ON whatsapp_channels TO citara_app`);
    // El GRANT de arriba no basta: `ALTER DEFAULT PRIVILEGES` de la migración
    // del rol ya le dio a citara_app INSERT/UPDATE/DELETE por defecto sobre
    // toda tabla nueva. Esta es la única tabla sin RLS que guarda el token
    // cifrado de TODOS los tenants; si la aplicación pudiera escribirla, un
    // fallo en ese camino podría reescribir el token o el phone_number_id de
    // otro cliente y desviarle el tráfico de WhatsApp. REVOKE explícito deja
    // el privilegio real en solo SELECT, como exige el guardia de
    // `rls-inventory.test.ts`.
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON whatsapp_channels FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE whatsapp_channels`);
  }
}
