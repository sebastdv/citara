import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `origin='reminder'`: lo envía el sistema por agenda, no como respuesta de un
 * turno. Por eso no queda `superseded` cuando el dueño está atendiendo (spec §6.3).
 */
export class AddReminderOriginToMessages1725400700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE messages DROP CONSTRAINT messages_origin_check,
        ADD CONSTRAINT messages_origin_check
          CHECK (origin IN ('customer', 'bot', 'phone', 'operator', 'history', 'reminder'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE messages DROP CONSTRAINT messages_origin_check,
        ADD CONSTRAINT messages_origin_check
          CHECK (origin IN ('customer', 'bot', 'phone', 'operator', 'history'))
    `);
  }
}
