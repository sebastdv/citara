// Deja un negocio de desarrollo listo para recibir mensajes reales de
// WhatsApp: migra, y da de alta tenant, canal (token cifrado) y flujo demo.
// Los datos salen del entorno (`.env`); el token jamás se imprime.
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { createDataSource } from '@citara/db';
import { EncryptionService } from '../crypto/encryption.service';
import { DEMO_FLOW, provisionDevTenant } from './provision';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} no está definida en el entorno`);
  return value;
}

async function main() {
  const enc = new EncryptionService(required('DB_ENCRYPTION_KEY'));
  await enc.ready();
  const ds = createDataSource(required('DATABASE_ADMIN_URL'));
  await ds.initialize();
  try {
    await ds.runMigrations();
    const out = await provisionDevTenant(ds, enc, {
      slug: process.env.SEED_TENANT_SLUG ?? 'demo',
      name: process.env.SEED_TENANT_NAME ?? 'Negocio Demo',
      timezone: process.env.SEED_TENANT_TIMEZONE ?? 'America/Bogota',
      wabaId: required('META_WABA_ID'),
      phoneNumberId: required('META_PHONE_NUMBER_ID'),
      accessToken: required('META_ACCESS_TOKEN'),
      displayPhoneNumber: process.env.META_DISPLAY_PHONE_NUMBER,
      flow: DEMO_FLOW,
    });
    console.log(`Negocio listo — tenant ${out.tenantId}, canal ${out.channelId}, flujo ${out.flowId}`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
