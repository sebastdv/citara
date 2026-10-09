import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dueño del lease del agente. Un turno lento puede pasar del plazo: el dueño
 * lo renueva mientras trabaja, y solo él lo libera. Sin dueño, un job viejo
 * liberaba el lease que otro ya había tomado.
 */
export class AddAgentLeaseOwner1725700300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE conversations ADD COLUMN agent_lease_owner uuid`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE conversations DROP COLUMN agent_lease_owner`);
  }
}
