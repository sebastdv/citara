import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/** Ausencias: festivos del negocio (resource_id NULL) o de un recurso. */
export class CreateTimeOff1725400400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE time_off (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
        starts_at   timestamptz NOT NULL,
        ends_at     timestamptz NOT NULL,
        reason      varchar(255),
        CHECK (ends_at > starts_at)
      )
    `);
    await q.query(`CREATE INDEX time_off_lookup ON time_off (tenant_id, starts_at, ends_at)`);
    for (const sql of tenantRlsSql('time_off')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE time_off`);
  }
}
