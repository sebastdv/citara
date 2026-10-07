import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, seedChannel, seedCatalog, seedHours, adminQuery, closeHelpers } from '../helpers';

let tenantId: string, resourceId: string;

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
});
afterAll(async () => { await closeHelpers(); });

describe('horarios y ausencias', () => {
  it('registra horario de lunes a viernes para todo el negocio', async () => {
    await seedHours(tenantId);
    const rows = await adminQuery(
      `SELECT weekday, start_time, end_time, resource_id FROM business_hours ORDER BY weekday`);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ weekday: 1, start_time: '09:00:00', end_time: '18:00:00', resource_id: null });
  });

  it('rechaza un horario que termina antes de empezar', async () => {
    await expect(adminQuery(
      `INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 1, '18:00', '09:00')`, [tenantId])).rejects.toThrow(/check/i);
  });

  it('rechaza un día fuera de 0..6', async () => {
    await expect(adminQuery(
      `INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 7, '09:00', '18:00')`, [tenantId])).rejects.toThrow(/check/i);
  });

  it('permite una ausencia acotada a un recurso', async () => {
    await adminQuery(
      `INSERT INTO time_off (tenant_id, resource_id, starts_at, ends_at, reason)
       VALUES ($1, $2, '2026-09-10T13:00:00Z', '2026-09-10T18:00:00Z', 'Cita médica')`,
      [tenantId, resourceId]);
    const [row] = await adminQuery(`SELECT resource_id FROM time_off`);
    expect(row.resource_id).toBe(resourceId);
  });

  it('rechaza una ausencia que termina antes de empezar', async () => {
    await expect(adminQuery(
      `INSERT INTO time_off (tenant_id, starts_at, ends_at)
       VALUES ($1, '2026-09-10T18:00:00Z', '2026-09-10T13:00:00Z')`, [tenantId])).rejects.toThrow(/check/i);
  });
});
