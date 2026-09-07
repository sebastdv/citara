import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

export class CreateConversationSessions1725301000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE conversation_sessions (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        flow_id         uuid NOT NULL REFERENCES flows(id),
        step_key        varchar(64) NOT NULL,
        vars            jsonb NOT NULL DEFAULT '{}'::jsonb,
        status          varchar(32) NOT NULL DEFAULT 'active',
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Una sola sesión activa por conversación: evita el rebote entre sesiones
    // duplicadas creadas por mensajes concurrentes.
    await q.query(`
      CREATE UNIQUE INDEX sessions_one_active ON conversation_sessions (conversation_id)
        WHERE status = 'active'
    `);
    for (const sql of tenantRlsSql('conversation_sessions')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE conversation_sessions`);
  }
}
