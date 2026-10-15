import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { AccountUpdateProcessor } from '../../src/coexistence/account-update.processor';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow, adminQuery, closeHelpers } from '../helpers';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';

let ds: DataSource;
let processor: AccountUpdateProcessor;
let tenantId: string;

const update = (event: string, wabaId = '102290') =>
  processor.process({ update: { wabaId, event, phoneNumber: '15550001' } });
const statuses = async () =>
  (await adminQuery(`SELECT status FROM whatsapp_channels ORDER BY phone_number_id`)).map((r: { status: string }) => r.status);

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new AccountUpdateProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('AccountUpdateProcessor', () => {
  it('una desconexión marca el canal como desconectado y lo audita', async () => {
    const r = await update('PARTNER_REMOVED');

    expect(r.disconnected).toBe(1);
    expect(await statuses()).toEqual(['disconnected']);
    const [a] = await adminQuery(`SELECT actor, action, tenant_id FROM audit_log`);
    expect(a).toEqual({ actor: 'meta', action: 'channel.disconnected', tenant_id: tenantId });
  });

  it('desconecta todos los números de la misma cuenta', async () => {
    const [ch] = await adminQuery(`SELECT access_token_encrypted FROM whatsapp_channels`);
    await adminQuery(
      `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, access_token_encrypted)
       VALUES ($1, '102290', '106541', $2)`, [tenantId, ch.access_token_encrypted]);

    expect((await update('PARTNER_REMOVED')).disconnected).toBe(2);
    expect(await statuses()).toEqual(['disconnected', 'disconnected']);
  });

  it('ignora los eventos que no son desconexión y las cuentas ajenas', async () => {
    expect((await update('VERIFIED_ACCOUNT')).disconnected).toBe(0);
    expect((await update('PARTNER_REMOVED', '999999')).disconnected).toBe(0);
    expect(await statuses()).toEqual(['active']);
  });

  it('repetir el aviso no vuelve a auditar', async () => {
    await update('PARTNER_REMOVED');
    await update('PARTNER_REMOVED');
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM audit_log`);
    expect(n).toBe(1);
  });

  it('una reconexión devuelve a operación el canal desconectado', async () => {
    await update('PARTNER_REMOVED');
    const r = await update('ACCOUNT_RECONNECTED');
    expect(r).toMatchObject({ reconnected: 1 });
    expect(await statuses()).toEqual(['active']);
    const actions = (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['channel.disconnected', 'channel.reconnected']);
  });

  it('si la auditoría falla, el canal no cambia: estado y rastro van juntos', async () => {
    await adminQuery(`CREATE FUNCTION audit_boom() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await adminQuery(`CREATE TRIGGER audit_boom BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_boom()`);
    try {
      await expect(update('PARTNER_REMOVED')).rejects.toThrow(/boom/);
      expect(await statuses()).toEqual(['active']);
    } finally {
      await adminQuery(`DROP TRIGGER audit_boom ON audit_log`);
      await adminQuery(`DROP FUNCTION audit_boom()`);
    }
  });

  it('una reconexión termina el alta de un negocio que había quedado a medias', async () => {
    await seedCatalog(tenantId);
    await seedHours(tenantId);
    await seedFlow(tenantId, AGENDA_FLOW);
    await update('PARTNER_REMOVED');
    await adminQuery(`UPDATE tenants SET status = 'onboarding'`);
    await update('ACCOUNT_RECONNECTED');
    expect(await adminQuery(`SELECT status FROM tenants`)).toEqual([{ status: 'active' }]);
  });

  it('la base rechaza un estado de canal que el código no conoce', async () => {
    await expect(adminQuery(`UPDATE whatsapp_channels SET status = 'activo'`)).rejects.toThrow(/status_check/);
  });

  it('una reconexión no reactiva un canal que el operador dejó inactivo', async () => {
    await adminQuery(`UPDATE whatsapp_channels SET status = 'inactive'`);
    expect(await update('ACCOUNT_RECONNECTED')).toMatchObject({ reconnected: 0 });
    expect(await statuses()).toEqual(['inactive']);
  });

  it('desconectar y reconectar tampoco revive un canal que el operador dejó inactivo', async () => {
    await adminQuery(`UPDATE whatsapp_channels SET status = 'inactive'`);
    expect(await update('PARTNER_REMOVED')).toMatchObject({ disconnected: 0 });
    await update('ACCOUNT_RECONNECTED');
    expect(await statuses()).toEqual(['inactive']);
  });
});
