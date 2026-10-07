import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Ciclo de vida del negocio (spec §8): nace en alta, opera activo, se suspende. */
export class AddStatusCheckToTenants1725500000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
        CHECK (status IN ('onboarding', 'active', 'suspended'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tenants DROP CONSTRAINT tenants_status_check`);
  }
}
