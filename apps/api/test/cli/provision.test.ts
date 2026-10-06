import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { advance } from '../../src/flow-engine/executor';
import { provisionDevTenant, DEMO_FLOW, type ProvisionInput } from '../../src/cli/provision';
import { resetDb, closeHelpers } from '../helpers';

let admin: DataSource;
let app: DataSource;
let enc: EncryptionService;

const input = (over: Partial<ProvisionInput> = {}): ProvisionInput => ({
  slug: 'demo', name: 'Negocio Demo', timezone: 'America/Bogota',
  wabaId: '900100', phoneNumberId: '900200', accessToken: 'EAAG-dev-token',
  flow: DEMO_FLOW, ...over,
});

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!);
  await app.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
  await enc.ready();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); });

describe('provisionDevTenant', () => {
  it('deja un negocio que el webhook puede resolver por su phone_number_id', async () => {
    const out = await provisionDevTenant(admin, enc, input());

    // La prueba que importa: el mismo camino que usa el webhook, con el rol de
    // la aplicación, encuentra el canal y descifra el token.
    const channel = await new ChannelResolver(app, enc).resolveByPhoneNumberId('900200');
    expect(channel).toMatchObject({
      tenantId: out.tenantId, channelId: out.channelId, accessToken: 'EAAG-dev-token',
    });

    const [raw] = await admin.query(
      `SELECT access_token_encrypted FROM whatsapp_channels WHERE id = $1`, [out.channelId]);
    expect(raw.access_token_encrypted.toString('latin1')).not.toContain('EAAG-dev-token');

    const flows = await admin.query(
      `SELECT id FROM flows WHERE tenant_id = $1 AND is_active AND is_default`, [out.tenantId]);
    expect(flows).toEqual([{ id: out.flowId }]);
  });

  it('es idempotente y rota el token al repetirse', async () => {
    const first = await provisionDevTenant(admin, enc, input());
    const second = await provisionDevTenant(admin, enc, input({ accessToken: 'EAAG-rotado' }));

    expect(second).toEqual(first);
    const [{ n: tenants }] = await admin.query(`SELECT count(*)::int AS n FROM tenants`);
    const [{ n: channels }] = await admin.query(`SELECT count(*)::int AS n FROM whatsapp_channels`);
    const [{ n: flows }] = await admin.query(`SELECT count(*)::int AS n FROM flows`);
    expect([tenants, channels, flows]).toEqual([1, 1, 1]);

    const channel = await new ChannelResolver(app, enc).resolveByPhoneNumberId('900200');
    expect(channel?.accessToken).toBe('EAAG-rotado');
  });

  it('se niega a mover a otro negocio un número que ya tiene dueño', async () => {
    // Reasignar un phone_number_id desvía el tráfico de WhatsApp de un cliente
    // a otro. Ni en desarrollo se hace en silencio.
    await provisionDevTenant(admin, enc, input());
    await expect(provisionDevTenant(admin, enc, input({ slug: 'otro' })))
      .rejects.toThrow(/900200/);

    const channel = await new ChannelResolver(app, enc).resolveByPhoneNumberId('900200');
    const [t] = await admin.query(`SELECT slug FROM tenants WHERE id = $1`, [channel!.tenantId]);
    expect(t.slug).toBe('demo');
  });

  it('el flujo de demo arranca con saludo y menú', () => {
    const { outbound, state } = advance(DEMO_FLOW, null, null);
    expect(outbound.map((o) => o.kind)).toEqual(['text', 'buttons']);
    expect(state.status).toBe('active');
  });
});
