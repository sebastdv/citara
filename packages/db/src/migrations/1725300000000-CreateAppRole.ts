import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAppRole1725300000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'citara_app') THEN
          CREATE ROLE citara_app LOGIN PASSWORD 'citara_app' NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await q.query(`GRANT USAGE ON SCHEMA public TO citara_app`);
    await q.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO citara_app
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM citara_app
    `);
    await q.query(`REVOKE USAGE ON SCHEMA public FROM citara_app`);
    await q.query(`DROP ROLE IF EXISTS citara_app`);
  }
}
