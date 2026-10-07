import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { createLink, peekLink } from '../../src/onboarding/links';
import { MetaOnboardingError, type MetaOnboardingClient } from '../../src/onboarding/meta-onboarding.client';
import { LinkInvalidError, OnboardingInputError, OnboardingService } from '../../src/onboarding/onboarding.service';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource, enc: EncryptionService;
let tenantId: string, token: string;
let meta: { [K in keyof MetaOnboardingClient]: ReturnType<typeof vi.fn> };
let service: OnboardingService;

const complete = (over: Record<string, unknown> = {}) =>
  service.completeWhatsapp({ token, code: 'CODIGO', wabaId: '777', ...over });

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  const [t] = await adminQuery(
    `INSERT INTO tenants (slug, name, status) VALUES ('nuevo', 'Peluquería Nueva', 'onboarding') RETURNING id`);
  tenantId = t.id;
  token = await createLink(admin, tenantId, 'whatsapp');
  meta = {
    exchangeCode: vi.fn().mockResolvedValue('EAAG-del-negocio'),
    phoneNumbers: vi.fn().mockResolvedValue([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]),
    subscribeApp: vi.fn().mockResolvedValue(undefined),
    requestSync: vi.fn().mockResolvedValue(undefined),
  } as never;
  service = new OnboardingService(app, enc, meta as never);
});

describe('OnboardingService.completeWhatsapp', () => {
  it('registra el canal en coexistencia con el token cifrado, suscribe y pide las dos sincronizaciones', async () => {
    const r = await complete();

    expect(r).toMatchObject({ tenantId, phoneNumberId: '106999', syncs: { smb_app_state_sync: 'requested', history: 'requested' } });
    const resolved = await new ChannelResolver(app, enc).resolveByPhoneNumberId('106999');
    expect(resolved).toMatchObject({ tenantId, accessToken: 'EAAG-del-negocio' });
    expect(meta.subscribeApp).toHaveBeenCalledWith('777', 'EAAG-del-negocio');
    expect(meta.requestSync.mock.calls.map((c) => c[2]).sort()).toEqual(['history', 'smb_app_state_sync']);
    const actions = (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['channel.connected', 'channel.sync_requested', 'channel.sync_requested']);
  });

  it('el enlace queda usado: un segundo intento no registra otro canal', async () => {
    await complete();
    await expect(complete()).rejects.toBeInstanceOf(LinkInvalidError);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM whatsapp_channels`);
    expect(n).toBe(1);
  });

  it('con varios números y sin indicar cuál, falla claro y el enlace sigue sirviendo', async () => {
    meta.phoneNumbers.mockResolvedValue([{ id: '1', displayPhoneNumber: null }, { id: '2', displayPhoneNumber: null }]);
    await expect(complete()).rejects.toBeInstanceOf(OnboardingInputError);
    expect(await peekLink(app, token, 'whatsapp')).not.toBeNull();
    // Con el número indicado (la sesión lo trae), funciona.
    await expect(complete({ phoneNumberId: '2' })).resolves.toMatchObject({ phoneNumberId: '2' });
  });

  it('si Meta rechaza el código, no se registra nada y el enlace sigue sirviendo', async () => {
    meta.exchangeCode.mockRejectedValue(new MetaOnboardingError('canje del código: Meta respondió 400', 400));
    await expect(complete()).rejects.toBeInstanceOf(MetaOnboardingError);
    expect(await adminQuery(`SELECT id FROM whatsapp_channels`)).toEqual([]);
    expect(await peekLink(app, token, 'whatsapp')).not.toBeNull();
  });

  it('si falla la sincronización, el alta se conserva y queda registrado para reintentar', async () => {
    meta.requestSync.mockRejectedValue(new MetaOnboardingError('sincronización: Meta respondió 500', 500));
    const r = await complete();
    expect(r.syncs).toEqual({ smb_app_state_sync: 'failed', history: 'failed' });
    expect(await adminQuery(`SELECT id FROM whatsapp_channels`)).toHaveLength(1);
    const failed = await adminQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'channel.sync_failed'`);
    expect(failed[0].n).toBe(2);
  });

  it('un enlace inválido no llega a hablar con Meta', async () => {
    await expect(service.completeWhatsapp({ token: 'inventado', code: 'X', wabaId: '777' }))
      .rejects.toBeInstanceOf(LinkInvalidError);
    expect(meta.exchangeCode).not.toHaveBeenCalled();
  });
});
