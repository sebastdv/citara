import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTenants1725300100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE tenants (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug       varchar(64) NOT NULL UNIQUE,
        name       varchar(255) NOT NULL,
        timezone   varchar(64) NOT NULL DEFAULT 'America/Bogota',
        status     varchar(32) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // tenants NO lleva RLS: es la tabla raíz, se lee para resolver el contexto.
    await q.query(`GRANT SELECT ON tenants TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE tenants`);
  }
}
