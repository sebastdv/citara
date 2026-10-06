import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quién habla en la conversación (spec §6). De paso separa dos ideas que
 * `status` mezclaba: valía 'bot' por defecto y además servía para
 * abierta/cerrada. Ahora `status` es solo el ciclo de vida y `control` dice
 * quién responde. `assigned_to` (pensado para varios agentes) se elimina: el
 * panel es de un único operador.
 */
export class AddControlToConversations1725301500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE conversations SET status = 'open' WHERE status <> 'closed'`);
    await q.query(`ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'open'`);
    await q.query(`
      ALTER TABLE conversations
        ADD CONSTRAINT conversations_status_check CHECK (status IN ('open', 'closed')),
        DROP COLUMN assigned_to,
        ADD COLUMN control varchar(8) NOT NULL DEFAULT 'bot' CHECK (control IN ('bot', 'human')),
        ADD COLUMN human_until timestamptz,
        ADD COLUMN control_reason varchar(16)
          CHECK (control_reason IN ('phone', 'flow_handoff', 'operator', 'history'))
    `);
    // Una sesión que ya estaba en traspaso conserva el silencio bajo el modelo nuevo.
    await q.query(`
      UPDATE conversations c
         SET control = 'human', human_until = now() + interval '12 hours',
             control_reason = 'flow_handoff'
       WHERE EXISTS (SELECT 1 FROM conversation_sessions s
                      WHERE s.conversation_id = c.id AND s.status = 'handoff')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE conversations
        DROP COLUMN control_reason, DROP COLUMN human_until, DROP COLUMN control,
        ADD COLUMN assigned_to uuid,
        DROP CONSTRAINT conversations_status_check
    `);
    await q.query(`ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'bot'`);
    await q.query(`UPDATE conversations SET status = 'bot' WHERE status = 'open'`);
  }
}
