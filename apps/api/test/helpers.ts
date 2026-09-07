// Debe cargarse antes que cualquier módulo decorado (AppModule, entidades de
// TypeORM, etc.) para que `emitDecoratorMetadata` tenga Reflect disponible.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../src/crypto/encryption.service';
import { AppModule } from '../src/app.module';

let admin: DataSource | null = null;

async function adminDs(): Promise<DataSource> {
  if (!admin) {
    admin = createDataSource(process.env.DATABASE_ADMIN_URL!);
    await admin.initialize();
    await admin.runMigrations();
  }
  return admin;
}

/**
 * Vacía todo lo tenant-scoped. El orden lo resuelve CASCADE.
 *
 * NOTA: `conversation_sessions` y `flows` NO están en este TRUNCATE aunque el
 * plan original las incluía. Esas tablas las crea la Task 11; hasta entonces
 * no existen, y un TRUNCATE contra una tabla inexistente tumba con
 * "relation does not exist" el `beforeAll` de TODOS los tests de esta suite.
 * Cuando la Task 11 cree esas tablas, se añaden aquí.
 */
export async function resetDb(): Promise<void> {
  const ds = await adminDs();
  await ds.query(`
    TRUNCATE webhook_events, messages, conversations,
             contacts, whatsapp_channels, tenants
    RESTART IDENTITY CASCADE
  `);
}

export async function seedChannel(): Promise<{ tenantId: string; channelId: string }> {
  const ds = await adminDs();
  const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
  await enc.ready();

  const [t] = await ds.query(
    `INSERT INTO tenants (slug, name, timezone)
     VALUES ('salon', 'Salón X', 'America/Bogota') RETURNING id`);
  const [c] = await ds.query(
    `INSERT INTO whatsapp_channels
       (tenant_id, waba_id, phone_number_id, access_token_encrypted)
     VALUES ($1, '102290', '106540', $2) RETURNING id`,
    [t.id, enc.encrypt('EAAG-token-de-prueba')],
  );
  return { tenantId: t.id, channelId: c.id };
}

/**
 * Su tabla (`flows`) todavía no existe — la crea la Task 11. Se deja escrita
 * para esa tarea; NO llamar desde ningún test hasta entonces, o el INSERT
 * falla con "relation does not exist".
 */
export async function seedFlow(tenantId: string, definition: unknown): Promise<string> {
  const ds = await adminDs();
  const [f] = await ds.query(
    `INSERT INTO flows (tenant_id, key, version, definition, is_active, is_default)
     VALUES ($1, $2, '1.0.0', $3, true, true) RETURNING id`,
    [tenantId, (definition as { key: string }).key, JSON.stringify(definition)],
  );
  return f.id;
}

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  return app;
}

export async function closeHelpers(): Promise<void> {
  await admin?.destroy();
  admin = null;
}
