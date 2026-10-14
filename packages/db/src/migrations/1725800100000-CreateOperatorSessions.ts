import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sesiones del panel. Solo se guarda el SHA-256 del token: quien lea la tabla
 * no puede entrar. Vencen a las 12 h sin uso y a los 7 días en todo caso
 * (las dos condiciones viven en la consulta, no en un job).
 */
export class CreateOperatorSessions1725800100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE operator_sessions (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        operator_id  uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        token_hash   bytea NOT NULL UNIQUE,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at   timestamptz NOT NULL,
        ip           varchar(64),
        user_agent   varchar(512)
      )
    `);
    await q.query(`CREATE INDEX operator_sessions_operator ON operator_sessions (operator_id)`);
    // El default de la migración del rol ya da SELECT/INSERT/UPDATE/DELETE: es
    // justo lo que el login necesita para iniciar, renovar y cerrar sesiones.
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE operator_sessions`);
  }
}
