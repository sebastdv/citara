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
             flows, business_hours, time_off, resource_services, resources, services, contacts, whatsapp_channels, tenants
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

/** Un servicio de 30 min ("corte") que presta un recurso ("maria"). */
export async function seedCatalog(
  tenantId: string,
  over: { durationMin?: number; bufferMin?: number } = {},
): Promise<{ serviceId: string; resourceId: string }> {
  const ds = await adminDs();
  const [s] = await ds.query(
    `INSERT INTO services (tenant_id, key, name, duration_min, buffer_min)
     VALUES ($1, 'corte', 'Corte de cabello', $2, $3) RETURNING id`,
    [tenantId, over.durationMin ?? 30, over.bufferMin ?? 0]);
  const resourceId = await addResource(tenantId, 'maria', 'María', s.id);
  return { serviceId: s.id, resourceId };
}

/** Otro recurso que presta el servicio dado. */
export async function addResource(
  tenantId: string, key: string, name: string, serviceId: string,
): Promise<string> {
  const ds = await adminDs();
  const [r] = await ds.query(
    `INSERT INTO resources (tenant_id, key, name) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, key, name]);
  await ds.query(
    `INSERT INTO resource_services (tenant_id, resource_id, service_id) VALUES ($1, $2, $3)`,
    [tenantId, r.id, serviceId]);
  return r.id;
}

/** Lunes a viernes, 09:00-18:00 en hora local del negocio. */
export async function seedHours(tenantId: string, resourceId?: string): Promise<void> {
  const ds = await adminDs();
  for (const weekday of [1, 2, 3, 4, 5]) {
    await ds.query(
      `INSERT INTO business_hours (tenant_id, resource_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, '09:00', '18:00')`, [tenantId, resourceId ?? null, weekday]);
  }
}
