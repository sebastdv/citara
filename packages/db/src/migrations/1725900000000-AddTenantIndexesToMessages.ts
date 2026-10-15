import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índices por negocio sobre messages para el resumen de cada negocio (pantalla
 * de estado del panel y `pnpm tenant list`): el último eco del dueño, el último
 * mensaje del cliente y los salientes que no llegaron en 24 h. Sin ellos, cada
 * carga de la pantalla recorría la tabla entera tres veces por negocio.
 */
export class AddTenantIndexesToMessages1725900000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX messages_tenant_origin_occurred ON messages (tenant_id, origin, occurred_at DESC)`);
    // Parcial: solo los que no llegaron, que son pocos.
    await q.query(`
      CREATE INDEX messages_tenant_undelivered ON messages (tenant_id, created_at)
        WHERE direction = 'out' AND status IN ('failed', 'unconfirmed')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX messages_tenant_undelivered`);
    await q.query(`DROP INDEX messages_tenant_origin_occurred`);
  }
}
