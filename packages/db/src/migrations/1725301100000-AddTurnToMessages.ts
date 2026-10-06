import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enlaza cada saliente del bot con el entrante que lo produjo (`reply_to_id`)
 * y fija su orden dentro del turno (`seq`). Con eso las filas `pending` son la
 * fuente de verdad de lo que falta enviar (outbox): la cola solo lleva el id
 * del turno, se encola DESPUÉS del commit, y un reintento puede re-encolar lo
 * pendiente sin riesgo de que un job apunte a filas que se revirtieron.
 *
 * Además `created_at` pasa a `clock_timestamp()`: el entrante y sus respuestas
 * se guardan en UNA transacción, y `now()` es la hora de inicio de esa
 * transacción, así que todos empataban y el orden de la conversación quedaba
 * al azar.
 */
export class AddTurnToMessages1725301100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE messages
        ADD COLUMN reply_to_id uuid REFERENCES messages(id) ON DELETE CASCADE,
        ADD COLUMN seq smallint
    `);
    await q.query(`ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT clock_timestamp()`);
    await q.query(`
      CREATE INDEX messages_turn_idx ON messages (reply_to_id, seq)
        WHERE reply_to_id IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX messages_turn_idx`);
    await q.query(`ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT now()`);
    await q.query(`ALTER TABLE messages DROP COLUMN seq, DROP COLUMN reply_to_id`);
  }
}
