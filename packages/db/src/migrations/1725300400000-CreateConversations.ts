import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

export class CreateConversations1725300400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE conversations (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel_id      uuid NOT NULL REFERENCES whatsapp_channels(id),
        status          varchar(32) NOT NULL DEFAULT 'bot',
        assigned_to     uuid,
        last_inbound_at timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Una sola conversación abierta por contacto y canal.
    await q.query(`
      CREATE UNIQUE INDEX conversations_open_unique
        ON conversations (tenant_id, contact_id, channel_id)
        WHERE status <> 'closed'
    `);
    for (const sql of tenantRlsSql('conversations')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE conversations`);
  }
}
