import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `origin` dice QUIÉN escribió (`direction` solo dice hacia dónde fue), y
 * `occurred_at` CUÁNDO pasó según Meta. Con el historial se insertan hoy
 * mensajes de hace meses: ordenar por `created_at` dejaría la conversación al
 * revés. `origin` no lleva default a propósito: un INSERT que lo olvide falla.
 */
export class AddOriginToMessages1725301600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE messages ADD COLUMN origin varchar(16), ADD COLUMN occurred_at timestamptz`);
    await q.query(`
      UPDATE messages
         SET origin = CASE WHEN direction = 'in' THEN 'customer' ELSE 'bot' END,
             occurred_at = created_at
    `);
    await q.query(`
      ALTER TABLE messages
        ALTER COLUMN origin SET NOT NULL,
        ADD CONSTRAINT messages_origin_check
          CHECK (origin IN ('customer', 'bot', 'phone', 'operator', 'history')),
        ALTER COLUMN occurred_at SET NOT NULL,
        ALTER COLUMN occurred_at SET DEFAULT clock_timestamp(),
        ADD CONSTRAINT messages_status_check CHECK (status IS NULL OR status IN (
          'pending', 'sending', 'sent', 'delivered', 'read',
          'window_closed', 'failed', 'unconfirmed', 'superseded'))
    `);
    await q.query(`CREATE INDEX messages_conversation_occurred_idx ON messages (conversation_id, occurred_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX messages_conversation_occurred_idx`);
    await q.query(`
      ALTER TABLE messages
        DROP CONSTRAINT messages_status_check, DROP CONSTRAINT messages_origin_check,
        DROP COLUMN occurred_at, DROP COLUMN origin
    `);
  }
}
