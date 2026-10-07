import type { MigrationInterface, QueryRunner } from 'typeorm';

/** La N de la regla de control (spec §6.1): horas que manda el humano tras intervenir. */
export class AddTakeoverHoursToTenants1725301300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants ADD COLUMN human_takeover_hours smallint NOT NULL DEFAULT 12
        CHECK (human_takeover_hours BETWEEN 1 AND 168)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tenants DROP COLUMN human_takeover_hours`);
  }
}
