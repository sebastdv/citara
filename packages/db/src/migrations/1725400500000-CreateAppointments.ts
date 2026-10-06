import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * La fuente de verdad de las citas (D4). La doble reserva la impide Postgres
 * con una restricción de exclusión (D5): consultar y luego reservar es una
 * carrera inevitable, y un `if` no la resuelve.
 */
export class CreateAppointments1725400500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE appointments (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id        uuid NOT NULL REFERENCES resources(id),
        service_id         uuid NOT NULL REFERENCES services(id),
        contact_id         uuid NOT NULL REFERENCES contacts(id),
        conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
        starts_at          timestamptz NOT NULL,
        ends_at            timestamptz NOT NULL,
        status             varchar(16) NOT NULL DEFAULT 'confirmed'
                             CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
        customer_name      varchar(255),
        notes              text,
        -- Fase 4 (Google Calendar): proyección de la cita.
        google_event_id    varchar(1024),
        google_sync_status varchar(16) NOT NULL DEFAULT 'pending',
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CHECK (ends_at > starts_at)
      )
    `);
    // btree_gist lo creó la migración del rol (Fase 1). Solo las confirmadas
    // ocupan la franja: cancelar la libera.
    await q.query(`
      ALTER TABLE appointments ADD CONSTRAINT no_overlap
        EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
        WHERE (status = 'confirmed')
    `);
    await q.query(`
      CREATE INDEX appointments_lookup ON appointments (tenant_id, resource_id, starts_at)
        WHERE status = 'confirmed'
    `);
    await q.query(`CREATE INDEX appointments_by_contact ON appointments (contact_id, starts_at DESC)`);
    for (const sql of tenantRlsSql('appointments')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE appointments`);
  }
}
