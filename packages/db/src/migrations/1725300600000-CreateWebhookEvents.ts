import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookEvents1725300600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE webhook_events (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        wamid        varchar(128) NOT NULL UNIQUE,
        tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
        payload      jsonb NOT NULL,
        received_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Sin RLS: es la puerta de idempotencia, se escribe ANTES de resolver tenant.
    await q.query(`GRANT SELECT, INSERT ON webhook_events TO citara_app`);
    // Igual que en whatsapp_channels: sin este REVOKE, `ALTER DEFAULT
    // PRIVILEGES` deja UPDATE/DELETE abiertos por defecto. Un evento ya visto
    // es historia, no estado mutable — citara_app no tiene por qué poder
    // tocarlo una vez insertado.
    await q.query(`REVOKE UPDATE, DELETE ON webhook_events FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE webhook_events`);
  }
}
