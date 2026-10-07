import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enlaces de un solo uso que el operador le manda al cliente para conectar su
 * WhatsApp (y, en la Fase 4, Google Calendar). Sin RLS: se resuelven por el
 * token antes de saber de qué negocio son. Por eso la app solo puede leerlos y
 * marcarlos usados; crearlos es del operador (conexión admin).
 */
export class CreateOnboardingLinks1725500100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE onboarding_links (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        purpose    varchar(16) NOT NULL CHECK (purpose IN ('whatsapp', 'google')),
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at    timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON onboarding_links FROM citara_app`);
    await q.query(`GRANT SELECT ON onboarding_links TO citara_app`);
    await q.query(`GRANT UPDATE (used_at) ON onboarding_links TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE onboarding_links`);
  }
}
