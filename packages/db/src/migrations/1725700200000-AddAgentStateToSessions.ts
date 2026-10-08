import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El estado de un segmento del agente vive en la sesión: el `system`, el
 * modelo y el effort se congelan al empezar (reconstruirlos a mitad
 * invalidaría la caché y los bloques de pensamiento), y la transcripción se
 * guarda como TEXTO, no jsonb, para reenviarla byte a byte. `agent_cursor` es
 * hasta dónde se respondió. El lease serializa al agente por conversación.
 */
export class AddAgentStateToSessions1725700200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE conversation_sessions
        ADD COLUMN agent_system text,
        ADD COLUMN agent_transcript text,
        ADD COLUMN agent_model varchar(64),
        ADD COLUMN agent_effort varchar(8),
        ADD COLUMN agent_config_version integer,
        ADD COLUMN agent_cursor timestamptz
    `);
    await q.query(`ALTER TABLE conversations ADD COLUMN agent_lease_until timestamptz`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE conversations DROP COLUMN agent_lease_until`);
    await q.query(`
      ALTER TABLE conversation_sessions
        DROP COLUMN agent_cursor, DROP COLUMN agent_config_version, DROP COLUMN agent_effort,
        DROP COLUMN agent_model, DROP COLUMN agent_transcript, DROP COLUMN agent_system
    `);
  }
}
