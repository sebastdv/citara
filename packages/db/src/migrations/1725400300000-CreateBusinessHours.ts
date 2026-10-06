import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Horario semanal en hora LOCAL del negocio. `resource_id` NULL es el horario
 * del negocio; con valor, el propio de ese recurso (que entonces reemplaza al
 * del negocio para ese recurso).
 */
export class CreateBusinessHours1725400300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE business_hours (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
        weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
        start_time  time NOT NULL,
        end_time    time NOT NULL,
        CHECK (end_time > start_time)
      )
    `);
    await q.query(`CREATE INDEX business_hours_lookup ON business_hours (tenant_id, resource_id, weekday)`);
    for (const sql of tenantRlsSql('business_hours')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE business_hours`);
  }
}
