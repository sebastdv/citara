import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Exportado para el test del relleno. */
export const BACKFILL_SQL = `
  UPDATE conversations c SET last_message_at = m.at
    FROM (SELECT conversation_id, max(occurred_at) AS at FROM messages GROUP BY conversation_id) m
   WHERE m.conversation_id = c.id`;

/**
 * Última actividad de cada conversación, para ordenar la bandeja del panel
 * (spec §3.7.2) sin recorrer `messages`. La mantiene un trigger: cubre todos
 * los puntos que insertan mensajes (turno, eco, historial, recordatorios,
 * agente, operador) sin tocar ninguno. Con `occurred_at` y la condición `<`,
 * un mensaje viejo del historial no la mueve.
 *
 * El UPDATE toma el lock de la fila de la conversación. El turno ya lo tiene
 * (upsert de `persist`) y el agente lo toma antes de escribir (`finish`), así
 * que ahí no cambia nada. Un barrido de recordatorios que choque con un turno
 * puede dar un deadlock que Postgres detecta y la cola reintenta; nunca un
 * cuelgue, porque ningún camino espera en Node a otra conexión con la fila tomada.
 */
export class AddLastMessageAtToConversations1725800200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE conversations ADD COLUMN last_message_at timestamptz`);
    await q.query(BACKFILL_SQL);
    await q.query(
      `CREATE INDEX conversations_last_message ON conversations (tenant_id, last_message_at DESC, id DESC)`);
    await q.query(`
      CREATE FUNCTION touch_conversation_last_message() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        UPDATE public.conversations SET last_message_at = NEW.occurred_at
         WHERE id = NEW.conversation_id
           AND (last_message_at IS NULL OR last_message_at < NEW.occurred_at);
        RETURN NULL;
      END $$
    `);
    await q.query(`
      CREATE TRIGGER messages_touch_conversation AFTER INSERT ON messages
        FOR EACH ROW EXECUTE FUNCTION touch_conversation_last_message()
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER messages_touch_conversation ON messages`);
    await q.query(`DROP FUNCTION touch_conversation_last_message()`);
    await q.query(`ALTER TABLE conversations DROP COLUMN last_message_at`);
  }
}
