import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import { resetDb, seedChannel, seedCatalog, seedContact, addResource, adminQuery, closeHelpers } from '../helpers';

let tenantId: string, serviceId: string, resourceId: string, contactId: string;

const insert = (starts: string, ends: string, status = 'confirmed', resource = resourceId) =>
  adminQuery(
    `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tenantId, resource, serviceId, contactId, starts, ends, status]);

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  contactId = await seedContact(tenantId);
});
afterAll(async () => { await closeHelpers(); });

describe('restricción anti-doble-reserva', () => {
  it('acepta dos citas consecutivas que no se solapan', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z');
    await expect(insert('2026-09-10T14:30:00Z', '2026-09-10T15:00:00Z')).resolves.toBeDefined();
  });

  it('rechaza una cita que se solapa con otra del mismo recurso', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z');
    await expect(insert('2026-09-10T14:15:00Z', '2026-09-10T14:45:00Z')).rejects.toMatchObject({ code: '23P01' });
  });

  it('rechaza una cita contenida dentro de otra', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T15:00:00Z');
    await expect(insert('2026-09-10T14:10:00Z', '2026-09-10T14:20:00Z')).rejects.toMatchObject({ code: '23P01' });
  });

  it('una cita cancelada libera la franja', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z', 'cancelled');
    await expect(insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z')).resolves.toBeDefined();
  });

  it('permite el mismo horario en recursos distintos', async () => {
    const pedro = await addResource(tenantId, 'pedro', 'Pedro', serviceId);
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z');
    await expect(insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z', 'confirmed', pedro)).resolves.toBeDefined();
  });

  it('EL CASO REAL: dos transacciones concurrentes por la misma franja, solo una gana', async () => {
    const a = createDataSource(process.env.DATABASE_ADMIN_URL!);
    const b = createDataSource(process.env.DATABASE_ADMIN_URL!);
    await a.initialize(); await b.initialize();
    const ra = a.createQueryRunner(); const rb = b.createQueryRunner();
    await ra.connect(); await rb.connect();
    await ra.startTransaction(); await rb.startTransaction();
    try {
      const sql = `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
                   VALUES ($1, $2, $3, $4, '2026-09-10T15:00:00Z', '2026-09-10T15:30:00Z')`;
      const args = [tenantId, resourceId, serviceId, contactId];

      // A inserta y NO confirma: B queda bloqueada en la restricción hasta que A decida.
      await ra.query(sql, args);
      const bInsert = rb.query(sql, args);
      await ra.commitTransaction();
      await expect(bInsert).rejects.toMatchObject({ code: '23P01' });
      await rb.rollbackTransaction();

      const [{ n }] = await adminQuery(
        `SELECT count(*)::int AS n FROM appointments WHERE starts_at = '2026-09-10T15:00:00Z'`);
      expect(n).toBe(1);
    } finally {
      await ra.release(); await rb.release();
      await a.destroy(); await b.destroy();
    }
  });
});
