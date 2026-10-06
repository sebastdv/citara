import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cuándo reclamó un envío la fila (`pending` → `sending`). Distingue un envío
 * EN CURSO —otro intento del mismo job sigue esperando a Meta— de uno MUERTO,
 * que dejó la fila reclamada y nunca confirmó. Sin la hora, ambos se ven igual.
 */
export class AddClaimedAtToMessages1725301200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE messages ADD COLUMN claimed_at timestamptz`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE messages DROP COLUMN claimed_at`);
  }
}
