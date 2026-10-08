import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Configuración del agente por negocio (spec §4.1), versionada con rollback.
 * La escribe el operador desde el YAML (conexión admin); la app solo la lee.
 * `config_hash` identifica lo que cambia el comportamiento (modelo, effort,
 * instrucciones, prompt base): es la llave del banco de regresión.
 */
export class CreateAgentConfigs1725700000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE agent_configs (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        version            integer NOT NULL,
        enabled            boolean NOT NULL DEFAULT true,
        model              varchar(64) NOT NULL,
        effort             varchar(8) NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
        interpreter_model  varchar(64) NOT NULL,
        instructions       text NOT NULL DEFAULT '',
        monthly_budget_usd numeric(10, 2) NOT NULL CHECK (monthly_budget_usd >= 0),
        config_hash        char(64) NOT NULL,
        is_active          boolean NOT NULL DEFAULT false,
        created_at         timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, version)
      )
    `);
    await q.query(`CREATE UNIQUE INDEX agent_configs_one_active ON agent_configs (tenant_id) WHERE is_active`);
    for (const sql of tenantRlsSql('agent_configs')) await q.query(sql);
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON agent_configs FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE agent_configs`);
  }
}
