import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Una fila por llamada al modelo (spec §4.1): tokens, USD, latencia y
 * herramientas. Es la base del tope mensual y del costo por cita. Solo se
 * agrega: como la bitácora, nadie corrige lo que pasó.
 */
export class CreateAgentRuns1725700100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE agent_runs (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
        inbound_message_id uuid,
        kind               varchar(16) NOT NULL CHECK (kind IN ('agent', 'interpret')),
        model              varchar(64) NOT NULL,
        config_version     integer,
        input_tokens       integer NOT NULL DEFAULT 0,
        output_tokens      integer NOT NULL DEFAULT 0,
        cache_read_tokens  integer NOT NULL DEFAULT 0,
        cache_write_tokens integer NOT NULL DEFAULT 0,
        usd                numeric(12, 6) NOT NULL DEFAULT 0,
        latency_ms         integer NOT NULL DEFAULT 0,
        tools              text[] NOT NULL DEFAULT '{}',
        stop_reason        varchar(32),
        error              text,
        created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await q.query(`CREATE INDEX agent_runs_month ON agent_runs (tenant_id, created_at)`);
    for (const sql of tenantRlsSql('agent_runs')) await q.query(sql);
    await q.query(`REVOKE UPDATE, DELETE ON agent_runs FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE agent_runs`);
  }
}
