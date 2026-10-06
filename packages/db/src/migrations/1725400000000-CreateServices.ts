import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/** Lo que el negocio ofrece. `key` es la identidad estable que usa `tenant:apply`. */
export class CreateServices1725400000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE services (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key          varchar(64) NOT NULL,
        name         varchar(255) NOT NULL,
        duration_min integer NOT NULL CHECK (duration_min > 0),
        buffer_min   integer NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
        price_cents  integer CHECK (price_cents >= 0),
        active       boolean NOT NULL DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, key)
      )
    `);
    for (const sql of tenantRlsSql('services')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE services`);
  }
}
