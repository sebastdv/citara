import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource } from 'typeorm';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { summarizeTenant, listTenants } from '../../src/cli/tenants';
import { resetDb, adminQuery, closeHelpers } from '../helpers';
import { seedBiz, seedConv, msg } from './seed';

let app: DataSource, admin: DataSource;
beforeEach(async () => {
  await resetDb();
  app ??= await createDataSource(process.env.DATABASE_URL!).initialize();
  admin ??= await createDataSource(process.env.DATABASE_ADMIN_URL!).initialize();
});
afterAll(async () => { await app?.destroy(); await admin?.destroy(); await closeHelpers(); });

describe('resumen de un negocio', () => {
  it('se lee en el contexto del negocio igual que con la conexión admin', async () => {
    const a = await seedBiz('a', '1', 'coexistence');
    const c = await seedConv(a, '571');
    await msg(a.tenantId, c, '2026-10-01T10:00:00Z', { direction: 'out', origin: 'phone', body: 'hola' });
    const inTenant = await runInTenant(app, a.tenantId, (m) => summarizeTenant(m, a.tenantId));
    const [viaAdmin] = await listTenants(admin);
    expect(inTenant).toEqual(viaAdmin);
    expect(inTenant).toMatchObject({ slug: 'a', mode: 'coexistence', channelStatus: 'active' });
    expect(inTenant!.lastPhoneEcho!.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(inTenant!.channelCreatedAt).toBeInstanceOf(Date);
  });

  it('cuenta los salientes failed o unconfirmed de las últimas 24 h, nada más', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571');
    const now = Date.now();
    const at = (h: number) => new Date(now - h * 3600_000).toISOString();
    await msg(a.tenantId, c, at(1), { direction: 'out', origin: 'bot', status: 'failed' });
    await msg(a.tenantId, c, at(2), { direction: 'out', origin: 'operator', status: 'unconfirmed' });
    await msg(a.tenantId, c, at(3), { direction: 'out', origin: 'bot', status: 'sent' });
    await msg(a.tenantId, c, at(30), { direction: 'out', origin: 'bot', status: 'failed' });
    await adminQuery(`UPDATE messages SET created_at = occurred_at`);
    const s = await runInTenant(app, a.tenantId, (m) => summarizeTenant(m, a.tenantId));
    expect(s!.failedOutbound24h).toBe(2);
  });

  it('con otro contexto de RLS no ve el negocio', async () => {
    const a = await seedBiz('a', '1'), b = await seedBiz('b', '2');
    const c = await seedConv(a, '571');
    await msg(a.tenantId, c, new Date().toISOString(), { direction: 'out', origin: 'bot', status: 'failed' });
    const s = await runInTenant(app, b.tenantId, (m) => summarizeTenant(m, a.tenantId));
    // tenants y whatsapp_channels no llevan RLS a propósito (se leen antes de saber
    // el negocio); los mensajes sí: desde otro contexto no se ve ninguno.
    expect(s).toMatchObject({ slug: 'a', failedOutbound24h: 0, lastPhoneEcho: null, lastCustomer: null });
  });
});
