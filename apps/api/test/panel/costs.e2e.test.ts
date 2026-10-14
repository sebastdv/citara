import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadCosts, parseMonth } from '../../src/panel/costs';
import { createTestApp, resetDb, seedCatalog, seedContact, seedAgentConfig, adminQuery, closeHelpers } from '../helpers';
import { seedBiz } from './seed';
import { panelSession } from './session';

let app: INestApplication, ds: DataSource, s: Awaited<ReturnType<typeof panelSession>>;

beforeAll(async () => { app = await createTestApp(); ds = app.get(DataSource); });
beforeEach(async () => { await resetDb(); s = await panelSession(app); });
afterAll(async () => { await app.close(); await closeHelpers(); });

const run = (tenantId: string, at: string, usd: number, kind = 'agent', error: string | null = null) => adminQuery(
  `INSERT INTO agent_runs (tenant_id, kind, model, usd, error, created_at) VALUES ($1, $2, 'claude-opus-5-5', $3, $4, $5)`,
  [tenantId, kind, usd, error, at]);

/** Una cita creada en `createdAt` (cuenta por su creación, no por cuándo es). */
async function seedAppointments(tenantId: string, list: { createdAt: string; bookedBy: string; status?: string }[]) {
  const { serviceId, resourceId } = await seedCatalog(tenantId);
  const contactId = await seedContact(tenantId);
  for (const [i, a] of list.entries()) {
    const start = new Date(Date.UTC(2026, 10, 2, 14 + i));
    await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, status, booked_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, resourceId, serviceId, contactId, start, new Date(start.getTime() + 1800_000), a.status ?? 'confirmed', a.bookedBy, a.createdAt]);
  }
}

describe('costos', () => {
  it('suma el mes en la zona de cada negocio y divide por las citas creadas', async () => {
    const a = await seedBiz('a', '1');           // America/Bogota (UTC-5)
    await seedAgentConfig(a.tenantId, { monthlyBudgetUsd: 20 });
    await run(a.tenantId, '2026-10-01T04:59:00Z', 9);        // 30 sep 23:59 en Bogotá: no cuenta
    await run(a.tenantId, '2026-10-01T05:00:00Z', 1.5);
    await run(a.tenantId, '2026-10-20T12:00:00Z', 0.5, 'interpret');
    await run(a.tenantId, '2026-10-21T12:00:00Z', 0, 'agent', 'timeout');
    await run(a.tenantId, '2026-11-01T05:00:00Z', 7);        // noviembre: no cuenta
    await seedAppointments(a.tenantId, [
      { createdAt: '2026-10-05T15:00:00Z', bookedBy: 'agent' },
      { createdAt: '2026-10-06T15:00:00Z', bookedBy: 'flow', status: 'cancelled' },
      { createdAt: '2026-11-01T04:00:00Z', bookedBy: 'agent' },   // 31 oct 23:00 en Bogotá: cuenta
      { createdAt: '2026-09-30T12:00:00Z', bookedBy: 'agent' },   // septiembre: no cuenta
    ]);
    const [row] = await loadCosts(ds, { year: 2026, month: 10 });
    expect(row).toMatchObject({ agentUsd: 1.5, interpretUsd: 0.5, calls: 3, failed: 1, budgetUsd: 20, enabled: true,
                                appointments: 3, byAgent: 2, byFlow: 1 });
    expect(row.usdPerAppointment).toBeCloseTo(2 / 3, 6);
  });
  it('sin citas el costo por cita es null; sin configuración el tope es null', async () => {
    await seedBiz('a', '1');
    const [row] = await loadCosts(ds, { year: 2026, month: 10 });
    expect(row).toMatchObject({ agentUsd: 0, calls: 0, appointments: 0, usdPerAppointment: null, budgetUsd: null, enabled: null });
  });
  it('cada negocio con lo suyo', async () => {
    const a = await seedBiz('a', '1'), b = await seedBiz('b', '2');
    await run(a.tenantId, '2026-10-10T12:00:00Z', 1);
    await run(b.tenantId, '2026-10-10T12:00:00Z', 3);
    const rows = await loadCosts(ds, { year: 2026, month: 10 });
    expect(rows.map((r) => [r.tenant.slug, r.agentUsd])).toEqual([['a', 1], ['b', 3]]);
  });
  it('parseMonth acepta YYYY-MM y si no, el mes actual en Bogotá', () => {
    expect(parseMonth('2026-03')).toEqual({ year: 2026, month: 3 });
    expect(parseMonth('2026-13', new Date('2026-11-01T04:00:00Z'))).toEqual({ year: 2026, month: 10 });
    expect(parseMonth(undefined, new Date('2026-11-01T05:00:00Z'))).toEqual({ year: 2026, month: 11 });
    expect(parseMonth('1999-01', new Date('2026-11-01T05:00:00Z'))).toEqual({ year: 1999, month: 1 });
  });
  it('la pantalla muestra «—» sin citas y el gasto con el tope', async () => {
    const a = await seedBiz('a', '1');
    await seedAgentConfig(a.tenantId, { monthlyBudgetUsd: 20 });
    await run(a.tenantId, '2026-10-10T12:00:00Z', 5);
    const res = await s.get('/panel/costos?mes=2026-10').expect(200);
    expect(res.text).toMatch(/<td>—<\/td>/);
    expect(res.text).toContain('25 %');
    expect(res.text).toContain('value="2026-10"');
  });
});
