import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Las cuentas del panel (spec §3.7.1). Global, sin RLS: no pertenece a ningún
 * negocio. La app solo la lee para el login; crear operadores y cambiar
 * contraseñas va por la conexión admin del CLI.
 */
export class CreateOperators1725800000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE operators (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         varchar(255) NOT NULL,
        password_hash text NOT NULL,
        disabled_at   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX operators_email_lower ON operators (lower(email))`);
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON operators FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE operators`);
  }
}
