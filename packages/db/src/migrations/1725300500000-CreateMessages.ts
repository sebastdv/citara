import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

export class CreateMessages1725300500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE messages (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        wamid           varchar(128),
        direction       varchar(8) NOT NULL CHECK (direction IN ('in','out')),
        type            varchar(32) NOT NULL,
        body            text,
        payload         jsonb,
        status          varchar(32),
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX messages_wamid_unique ON messages (wamid) WHERE wamid IS NOT NULL`);
    await q.query(`CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC)`);
    for (const sql of tenantRlsSql('messages')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE messages`);
  }
}
