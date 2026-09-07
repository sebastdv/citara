import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

export class CreateFlows1725300900000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE flows (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key        varchar(64) NOT NULL,
        version    varchar(32) NOT NULL,
        definition jsonb NOT NULL,
        triggers   jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_default boolean NOT NULL DEFAULT false,
        is_active  boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, key, version)
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX flows_one_default ON flows (tenant_id)
        WHERE is_default AND is_active
    `);
    for (const sql of tenantRlsSql('flows')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE flows`);
  }
}
