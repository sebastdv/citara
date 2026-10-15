import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { peekLink } from '../../src/onboarding/links';
import { connectUrl, createTenant, googleConnectUrl, listTenants, newGoogleLink, newLink, setSuspended, syncTenant }
  from '../../src/cli/tenants';
import { applyTenantConfig } from '../../src/cli/tenant-config';
import { resetDb, adminQuery, closeHelpers, seedGoogleAccount } from '../helpers';

let admin: DataSource, app: DataSource, enc: EncryptionService;

const agenda = {
  tenant: 'nuevo',
  services: [{ key: 'corte', name: 'Corte', duration_min: 30 }],
  resources: [{ key: 'maria', name: 'María', services: ['corte'] }],
  hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }],
  flow: 'agenda',
};
const connectChannel = async (tenantId: string) => adminQuery(
  `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, access_token_encrypted, mode, history_sync)
   VALUES ($1, '777', '106999', $2, 'coexistence', 'pending')`, [tenantId, enc.encrypt('EAAG-negocio')]);

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); });

describe('CLI del operador', () => {
  it('crear un negocio lo deja en alta con un enlace de conexión listo', async () => {
    const { tenantId, token } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    const [t] = await adminQuery(`SELECT status, timezone FROM tenants WHERE id = $1`, [tenantId]);
    expect(t).toEqual({ status: 'onboarding', timezone: 'America/Bogota' });
    expect(await peekLink(app, token, 'whatsapp')).toMatchObject({ tenantId });
    expect(connectUrl(token)).toMatch(/\/connect\/whatsapp\?t=/);
  });

  it('rechaza un slug repetido o inválido con un mensaje claro', async () => {
    await createTenant(admin, { slug: 'nuevo', name: 'X' });
    await expect(createTenant(admin, { slug: 'nuevo', name: 'Y' })).rejects.toThrow(/ya existe/);
    await expect(createTenant(admin, { slug: 'Con Espacios', name: 'Z' })).rejects.toThrow(/slug/);
  });

  it('con canal y agenda aplicada, el negocio pasa solo a activo', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    expect((await applyTenantConfig(admin, agenda)).status).toBe('onboarding'); // sin canal todavía
    await connectChannel(tenantId);
    expect((await applyTenantConfig(admin, agenda)).status).toBe('active');
  });

  it('suspender lo saca de operación y anula sus enlaces; reanudar lo devuelve', async () => {
    const { tenantId, token } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    await applyTenantConfig(admin, agenda);

    expect(await setSuspended(admin, 'nuevo', true, 'no pagó octubre')).toBe('suspended');
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
    expect(await setSuspended(admin, 'nuevo', false)).toBe('active');
    // Reanudar no revive los enlaces que había antes de suspender.
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
    const audits = await adminQuery(
      `SELECT action, details FROM audit_log WHERE action LIKE 'tenant.%' AND action <> 'tenant.created' ORDER BY created_at`);
    expect(audits).toEqual([
      { action: 'tenant.suspended', details: { status: 'suspended', reason: 'no pagó octubre' } },
      { action: 'tenant.resumed', details: { status: 'active' } }]);
  });

  it('crear el negocio y emitir enlaces queda en la bitácora', async () => {
    await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await newLink(admin, 'nuevo');
    expect(await adminQuery(`SELECT action, details FROM audit_log ORDER BY created_at, action DESC`)).toEqual([
      { action: 'tenant.created', details: { slug: 'nuevo', timezone: 'America/Bogota' } },
      { action: 'link.created', details: { purpose: 'whatsapp' } },
      { action: 'link.created', details: { purpose: 'whatsapp' } }]);
  });

  it('la lista muestra el canal que opera, no el último creado si quedó inactivo', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    await adminQuery(
      `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted, status)
       VALUES ($1, '777', '106000', '+57 300 999 9999', '\\x00'::bytea, 'inactive')`, [tenantId]);
    expect(await listTenants(admin)).toEqual([expect.objectContaining({ channelStatus: 'active', mode: 'coexistence' })]);
  });

  it('un enlace nuevo reemplaza al perdido', async () => {
    const { tenantId, token: perdido } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    expect(await peekLink(app, await newLink(admin, 'nuevo'), 'whatsapp')).toMatchObject({ tenantId });
    // El perdido pudo llegarle a otra persona: deja de servir.
    expect(await peekLink(app, perdido, 'whatsapp')).toBeNull();
    await expect(newLink(admin, 'no-existe')).rejects.toThrow(/no-existe/);
  });

  it('la lista muestra el estado de cada negocio y de su canal', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    expect(await listTenants(admin)).toEqual([expect.objectContaining({
      slug: 'nuevo', status: 'onboarding', mode: 'coexistence', channelStatus: 'active', historySync: 'pending' })]);
  });

  it('la lista dice qué sincronización falló, para reintentarla dentro de las 24 h', async () => {
    // Meta acepta cada una una sola vez: `historial pending` no distingue
    // "pedida, esperando a Meta" de "nunca se pudo pedir".
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    const meta = { requestSync: vi.fn().mockImplementation(async (_p: string, _t: string, type: string) => {
      if (type === 'history') throw new Error('Meta respondió 500');
    }) };
    await syncTenant(admin, enc, meta as never, 'nuevo');

    const [t] = await listTenants(admin);
    expect(t.syncs).toEqual({ smb_app_state_sync: 'requested', history: 'failed' });
  });

  it('sync reintenta solo lo que falló: volver a pedir lo que salió daría un fallo falso', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    const meta = { requestSync: vi.fn().mockImplementation(async (_p: string, _t: string, type: string) => {
      if (type === 'history') throw new Error('Meta respondió 500');
    }) };
    await syncTenant(admin, enc, meta as never, 'nuevo');
    meta.requestSync.mockReset().mockResolvedValue(undefined);

    expect(await syncTenant(admin, enc, meta as never, 'nuevo')).toEqual({ history: 'requested' });
    expect(meta.requestSync.mock.calls.map((c) => c[2])).toEqual(['history']);
    expect(await syncTenant(admin, enc, meta as never, 'nuevo')).toEqual({});
    const [t] = await listTenants(admin);
    expect(t.syncs).toEqual({ smb_app_state_sync: 'requested', history: 'requested' });
  });

  it('sync vuelve a pedir la sincronización con el token del canal', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    const meta = { requestSync: vi.fn().mockResolvedValue(undefined) };
    const r = await syncTenant(admin, enc, meta as never, 'nuevo');
    expect(r).toEqual({ smb_app_state_sync: 'requested', history: 'requested' });
    expect(meta.requestSync).toHaveBeenCalledWith('106999', 'EAAG-negocio', 'history');
  });

  it('un enlace de Google es por recurso y reemplaza solo al anterior de ese recurso', async () => {
    const { tenantId, token: whatsapp } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await applyTenantConfig(admin, agenda);
    const primero = await newGoogleLink(admin, 'nuevo', 'maria');
    const segundo = await newGoogleLink(admin, 'nuevo', 'maria');

    expect(await peekLink(admin, primero, 'google')).toBeNull();
    expect(await peekLink(admin, segundo, 'google')).toMatchObject({ tenantId, resourceName: 'María' });
    expect(await peekLink(app, whatsapp, 'whatsapp')).not.toBeNull();
    expect(googleConnectUrl(segundo)).toMatch(/\/connect\/google\?t=/);
    await expect(newGoogleLink(admin, 'nuevo', 'pedro')).rejects.toThrow(/pedro/);
  });

  it('un enlace nuevo de WhatsApp no anula los de Google', async () => {
    await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await applyTenantConfig(admin, agenda);
    const google = await newGoogleLink(admin, 'nuevo', 'maria');
    await newLink(admin, 'nuevo');
    expect(await peekLink(admin, google, 'google')).not.toBeNull();
  });

  it('la lista muestra la conexión de Google de cada recurso', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await applyTenantConfig(admin, agenda);
    const [r] = await adminQuery(`SELECT id FROM resources WHERE key = 'maria'`);
    await seedGoogleAccount(tenantId, r.id, { status: 'needs_reauth' });

    const [t] = await listTenants(admin);
    expect(t.google).toEqual([{ resource: 'maria', status: 'needs_reauth', calendar: true,
                                watchExpiresAt: null, watchError: false, unsynced: 0 }]);
  });
});
