import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

export class CreateContacts1725300200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE contacts (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        wa_id      varchar(32) NOT NULL,
        name       varchar(255),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wa_id)
      )
    `);
    for (const sql of tenantRlsSql('contacts')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE contacts`);
  }
}
