import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/** Qué recurso presta qué servicio. */
export class CreateResourceServices1725400200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE resource_services (
        tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        PRIMARY KEY (resource_id, service_id)
      )
    `);
    for (const sql of tenantRlsSql('resource_services')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE resource_services`);
  }
}
