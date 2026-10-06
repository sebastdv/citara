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
 * `conversation_sessions` y `flows` volvieron aquí en la Task 11, que es la
 * que crea esas tablas.
 */
export async function resetDb(): Promise<void> {
  const ds = await adminDs();
  await ds.query(`
    TRUNCATE webhook_events, audit_log, messages, conversation_sessions, conversations,
             flows, contacts, whatsapp_channels, tenants
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

/** Inserta un flujo activo y por defecto para el tenant dado. */
export async function seedFlow(tenantId: string, definition: unknown): Promise<string> {
  const ds = await adminDs();
  const [f] = await ds.query(
    `INSERT INTO flows (tenant_id, key, version, definition, is_active, is_default)
     VALUES ($1, $2, '1.0.0', $3, true, true) RETURNING id`,
    [tenantId, (definition as { key: string }).key, JSON.stringify(definition)],
  );
  return f.id;
}

/** Consulta con la conexión admin (sin RLS): para afirmar sobre el estado real. */
export async function adminQuery(sql: string, params: unknown[] = []) {
  const ds = await adminDs();
  return ds.query(sql, params);
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
