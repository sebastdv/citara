import type { DataSource, EntityManager } from 'typeorm';

export { tenantRlsSql } from '@citara/db';

/**
 * Ejecuta `fn` dentro de una transacción con `app.tenant_id` fijado.
 * SET LOCAL es transaccional: se revierte solo al terminar, así que el
 * contexto no puede filtrarse a la siguiente operación de la misma conexión.
 */
export async function runInTenant<T>(
  ds: DataSource,
  tenantId: string,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // set_config parametrizado: evita inyección al interpolar el uuid.
    await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(runner.manager);
    await runner.commitTransaction();
    return result;
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }
}
