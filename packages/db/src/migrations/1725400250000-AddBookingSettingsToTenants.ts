import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reglas de reserva por negocio (R1): anticipación mínima, horizonte máximo y
 * cada cuántos minutos arranca una franja. Las fija `tenant:apply`.
 */
export class AddBookingSettingsToTenants1725400250000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants
        ADD COLUMN min_lead_minutes smallint NOT NULL DEFAULT 60 CHECK (min_lead_minutes >= 0),
        ADD COLUMN horizon_days smallint NOT NULL DEFAULT 60 CHECK (horizon_days BETWEEN 1 AND 365),
        ADD COLUMN slot_granularity_minutes smallint NOT NULL DEFAULT 15
          CHECK (slot_granularity_minutes IN (5, 10, 15, 20, 30, 60))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants
        DROP COLUMN slot_granularity_minutes, DROP COLUMN horizon_days, DROP COLUMN min_lead_minutes
    `);
  }
}
