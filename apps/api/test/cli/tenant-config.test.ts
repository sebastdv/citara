import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { applyTenantConfig } from '../../src/cli/tenant-config';
import { resetDb, seedChannel, seedContact, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource;
let tenantId: string;

const config = (over: Record<string, unknown> = {}) => ({
  tenant: 'salon',
  timezone: 'America/Bogota',
  booking: { min_lead_minutes: 120, horizon_days: 30, slot_granularity_minutes: 30 },
  services: [
    { key: 'corte', name: 'Corte de cabello', duration_min: 30, buffer_min: 10, price_cents: 3500000 },
    { key: 'tinte', name: 'Tinte', duration_min: 90 },
  ],
  resources: [
    { key: 'maria', name: 'María', services: ['corte', 'tinte'] },
    { key: 'pedro', name: 'Pedro', services: ['corte'],
      hours: [{ days: ['sat'], start: '09:00', end: '13:00' }] },
  ],
  hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }],
  time_off: [{ from: '2026-12-24T00:00:00-05:00', to: '2026-12-26T00:00:00-05:00', reason: 'Navidad' }],
  flow: 'agenda',
  ...over,
});

beforeAll(async () => { admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize(); });
afterAll(async () => { await admin.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('applyTenantConfig', () => {
  it('carga catálogo, horarios, ausencias, reglas y flujo', async () => {
    const r = await applyTenantConfig(admin, config());
    expect(r).toMatchObject({ tenantId, services: 2, resources: 2, hours: 6, timeOff: 1, flow: 'agenda' });

    const [t] = await adminQuery(`SELECT min_lead_minutes, horizon_days, slot_granularity_minutes FROM tenants`);
    expect(t).toEqual({ min_lead_minutes: 120, horizon_days: 30, slot_granularity_minutes: 30 });
    const pedro = await adminQuery(
      `SELECT bh.weekday FROM business_hours bh JOIN resources r ON r.id = bh.resource_id WHERE r.key = 'pedro'`);
    expect(pedro).toEqual([{ weekday: 6 }]);
    const [f] = await adminQuery(`SELECT key FROM flows WHERE is_active AND is_default`);
    expect(f.key).toBe('agenda');
  });

  it('aplicarlo dos veces deja exactamente lo mismo', async () => {
    await applyTenantConfig(admin, config());
    const before = await adminQuery(`SELECT id, key FROM services ORDER BY key`);
    await applyTenantConfig(admin, config());
    expect(await adminQuery(`SELECT id, key FROM services ORDER BY key`)).toEqual(before);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM business_hours`);
    expect(n).toBe(6);
  });

  it('quitar un servicio con citas lo desactiva sin borrar las citas', async () => {
    await applyTenantConfig(admin, config());
    const [tinte] = await adminQuery(`SELECT id FROM services WHERE key = 'tinte'`);
    const [maria] = await adminQuery(`SELECT id FROM resources WHERE key = 'maria'`);
    const contactId = await seedContact(tenantId);
    await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, '2026-11-10T15:00:00Z', '2026-11-10T16:30:00Z')`,
      [tenantId, maria.id, tinte.id, contactId]);

    const cfg = config();
    await applyTenantConfig(admin, { ...cfg,
      services: (cfg.services as unknown[]).slice(0, 1),
      resources: [{ key: 'maria', name: 'María', services: ['corte'] }] });

    const [s] = await adminQuery(`SELECT active FROM services WHERE key = 'tinte'`);
    expect(s.active).toBe(false);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM appointments`);
    expect(n).toBe(1);
  });

  it('un recurso que presta un servicio que no existe falla nombrándolo, sin tocar nada', async () => {
    await expect(applyTenantConfig(admin, config({
      resources: [{ key: 'maria', name: 'María', services: ['masaje'] }] }))).rejects.toThrow(/masaje/);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM services`);
    expect(n).toBe(0);
  });

  it('rechaza un horario que termina antes de empezar y una zona horaria inválida', async () => {
    await expect(applyTenantConfig(admin, config({ hours: [{ days: ['mon'], start: '18:00', end: '09:00' }] })))
      .rejects.toThrow(/end/);
    await expect(applyTenantConfig(admin, config({ timezone: 'America/Bogata' }))).rejects.toThrow(/zona/);
  });

  it('falla si el negocio no existe', async () => {
    await expect(applyTenantConfig(admin, config({ tenant: 'no-existe' }))).rejects.toThrow(/no-existe/);
  });
});
