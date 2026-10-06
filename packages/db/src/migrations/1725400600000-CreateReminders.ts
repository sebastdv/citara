import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Recordatorios de cita. Al vencer, el barrido los convierte en un mensaje
 * plantilla `pending` (outbox) y guarda su `message_id`: el estado de entrega
 * vive en el mensaje, no aquí.
 */
export class CreateReminders1725400600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE reminders (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        kind           varchar(8) NOT NULL CHECK (kind IN ('24h', '2h')),
        send_at        timestamptz NOT NULL,
        status         varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'cancelled')),
        message_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (appointment_id, kind)
      )
    `);
    await q.query(`CREATE INDEX reminders_due ON reminders (send_at) WHERE status = 'pending'`);
    for (const sql of tenantRlsSql('reminders')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE reminders`);
  }
}
