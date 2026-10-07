import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { resetDb, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource, enc: EncryptionService, resolver: ChannelResolver;
let tenantId: string;

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await admin.initialize();
  await admin.runMigrations();
  // Sin esto el archivo heredaba el estado del anterior y dependía del orden
  // de ejecución: con un tenant 'salon' ya creado, el INSERT de abajo chocaba.
  await resetDb();

  enc = new EncryptionService(Buffer.alloc(32, 3).toString('base64'));
  await enc.ready();

  const [t] = await admin.query(
    `INSERT INTO tenants (slug, name) VALUES ('salon', 'Salón X') RETURNING id`);
  tenantId = t.id;

  await admin.query(
    `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, access_token_encrypted)
     VALUES ($1, '102290', '106540', $2)`,
    [tenantId, enc.encrypt('EAAG-token-secreto')],
  );

  app = createDataSource(process.env.DATABASE_URL!);
  await app.initialize();
  resolver = new ChannelResolver(app, enc);
});

afterAll(async () => {
  await admin.query(`DELETE FROM whatsapp_channels`);
  await admin.query(`DELETE FROM tenants`);
  await admin.destroy();
  await closeHelpers();
  await app.destroy();
});

describe('ChannelResolver', () => {
  it('resuelve tenant y token a partir del phone_number_id', async () => {
    const res = await resolver.resolveByPhoneNumberId('106540');
    expect(res).toMatchObject({
      tenantId, wabaId: '102290', phoneNumberId: '106540',
      accessToken: 'EAAG-token-secreto',
    });
  });

  it('devuelve null para un phone_number_id desconocido — NUNCA cae a un default', async () => {
    expect(await resolver.resolveByPhoneNumberId('999999')).toBeNull();
  });

  it('resuelve un canal desconectado para la entrada, pero no para enviar', async () => {
    // Lo que llegue a un número desconectado se guarda (y no se responde);
    // enviar con un canal desconectado no tiene sentido.
    await admin.query(`UPDATE whatsapp_channels SET status = 'disconnected'`);
    try {
      const inbound = await resolver.resolveByPhoneNumberId('106540');
      expect(inbound?.tenantId).toBe(tenantId);
      expect(await resolver.resolveById(inbound!.channelId)).toBeNull();
    } finally {
      await admin.query(`UPDATE whatsapp_channels SET status = 'active'`);
    }
  });
});
