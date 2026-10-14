import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quién agendó la cita, para el costo de IA por cita del panel (spec §3.7.2).
 * Mover una cita la actualiza en su lugar: no cuenta como otra. Las filas que
 * ya existen son del flujo: el agente aún no corrió en producción.
 */
export class AddBookedByToAppointments1725800300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE appointments ADD COLUMN booked_by varchar(16) NOT NULL DEFAULT 'flow'
        CHECK (booked_by IN ('flow', 'agent'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE appointments DROP COLUMN booked_by`);
  }
}
