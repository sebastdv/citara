import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Una sola lectura de Google por cuenta a la vez. El aviso de Google y el
 * barrido encolan lecturas con jobIds distintos, y dos lecturas cruzadas
 * aplicaban la misma página dos veces y guardaban syncTokens fuera de orden.
 * Es un plazo, no un candado de sesión: la lectura llama a Google entre
 * transacciones y no debe retener una conexión mientras tanto.
 */
export class AddPullLeaseToGoogleAccounts1725900200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE google_accounts ADD COLUMN pull_lease_until timestamptz`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE google_accounts DROP COLUMN pull_lease_until`);
  }
}
