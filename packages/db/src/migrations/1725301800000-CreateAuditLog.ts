import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Bitácora de lo que cambia quién habla y de las acciones del operador. Nace
 * aquí y no en el panel porque los cambios de control empiezan en esta fase.
 * Solo inserción para la app: una bitácora que se puede corregir no prueba nada.
 */
export class CreateAuditLog1725301800000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE audit_log (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor           varchar(64) NOT NULL,
        action          varchar(64) NOT NULL,
        conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
        details         jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await q.query(`CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC)`);
    for (const sql of tenantRlsSql('audit_log')) await q.query(sql);
    // tenantRlsSql otorga los cuatro privilegios; la bitácora se queda en dos.
    await q.query(`REVOKE UPDATE, DELETE ON audit_log FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE audit_log`);
  }
}
