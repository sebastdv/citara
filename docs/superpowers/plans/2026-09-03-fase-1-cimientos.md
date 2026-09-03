# Fase 1 — Cimientos: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el esqueleto del monorepo y el camino completo de un mensaje de WhatsApp — de Meta al motor de flujos y de vuelta al usuario — con aislamiento multi-tenant garantizado por la base de datos.

**Architecture:** Monorepo pnpm con `apps/api` (HTTP: webhook de Meta + API del panel) y `apps/worker` (procesadores BullMQ), que comparten el código de `apps/api` y difieren solo en el bootstrap. El webhook valida HMAC, deduplica por `wamid`, encola y responde `200` en menos de 100 ms; todo el procesamiento ocurre en el worker. El aislamiento entre tenants lo impone PostgreSQL con Row Level Security, no el código de aplicación.

**Tech Stack:** Node 22+, pnpm 9+, TypeScript 5.6+, NestJS 11, TypeORM 0.3, PostgreSQL 16 (`btree_gist`), Redis 7, BullMQ 5, Vitest 2, Zod 3, libsodium-wrappers.

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md`

## Global Constraints

- **Node 22+**, **pnpm 9+**, TypeScript en modo `strict`.
- **La app NUNCA se conecta a Postgres como superusuario ni como dueño de las tablas.** Los superusuarios y los dueños de tabla saltan RLS por defecto. Rol de aplicación: `citara_app`.
- Toda tabla con `tenant_id` lleva `ENABLE ROW LEVEL SECURITY` **y** `FORCE ROW LEVEL SECURITY`.
- El webhook de Meta responde `200` en <100 ms. Prohibido llamar a un LLM, a Google o a la lógica de negocio dentro de ese request.
- La idempotencia de entrada es una restricción única sobre `webhook_events.wamid`, nunca un `SELECT ... IF`.
- Zona horaria: todo instante se almacena en `timestamptz`. La zona de presentación sale de `tenants.timezone`, jamás de la del servidor. `TZ=UTC` en todos los procesos.
- Los secretos por tenant se guardan cifrados con libsodium `secretbox` (XSalsa20-Poly1305) con envelope versionado. Nunca en texto plano, nunca en logs.
- Commits: Conventional Commits en español, `tipo(scope): descripción`, **un solo `-m`, sin cuerpo ni trailers**.

---

## File Structure

```
citara/
├─ package.json                       workspace root, scripts
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ docker-compose.yml                 postgres + redis para desarrollo
├─ .env.example
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ main.ts                   bootstrap HTTP (rawBody activado)
│  │  │  ├─ app.module.ts
│  │  │  ├─ config/                   configuración tipada con Zod
│  │  │  ├─ crypto/                   EncryptionService (secretbox)
│  │  │  ├─ tenancy/                  TenantContext, runInTenant, resolución
│  │  │  ├─ whatsapp/                 gateway: verificación, controlador, normalizer, sender
│  │  │  ├─ conversations/            contactos, conversaciones, mensajes
│  │  │  ├─ flow-engine/              definición, ejecutor, pasos
│  │  │  └─ queues/                   registro BullMQ, productores, procesadores
│  │  └─ test/                        integración y E2E del motor
│  └─ worker/
│     └─ src/main.ts                  bootstrap solo-procesadores
└─ packages/
   ├─ db/
   │  ├─ src/data-source.ts           DataSource de TypeORM
   │  ├─ src/entities/                entidades
   │  └─ src/migrations/              una migración por tabla
   └─ shared/
      └─ src/                         tipos y contratos compartidos
```

**Responsabilidad por archivo clave:**

| Archivo | Responsabilidad única |
|---|---|
| `whatsapp/signature.ts` | Verificar HMAC del header `x-hub-signature-256`. Función pura, sin dependencias de Nest. |
| `whatsapp/normalizer.ts` | Traducir el payload de Meta a `InboundMessage`. Función pura. **El único lugar del sistema que conoce el formato de Meta al entrar.** |
| `whatsapp/sender.ts` | Traducir `OutboundMessage` al formato de Meta y enviarlo. **El único lugar que lo conoce al salir.** |
| `tenancy/tenant-context.ts` | `runInTenant()`: transacción con `SET LOCAL app.tenant_id`. Toda lectura/escritura tenant-scoped pasa por aquí. |
| `flow-engine/executor.ts` | Dado sesión + input, decidir el siguiente paso y los mensajes a emitir. Puro: no envía, no persiste. |

---

## Tareas

### Task 1: Andamiaje del monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.env.example`, `docker-compose.yml`
- Create: `packages/shared/package.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/index.test.ts`

**Interfaces:**
- Consumes: nada (primera tarea)
- Produces: workspace con `pnpm test` funcional; `@citara/shared` importable desde cualquier app.

- [ ] **Step 1: Escribir el test que falla**

`packages/shared/src/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PROJECT_NAME } from './index';

describe('shared', () => {
  it('expone el nombre del proyecto', () => {
    expect(PROJECT_NAME).toBe('citara');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run packages/shared`
Expected: FAIL — no existe `./index` ni el workspace.

- [ ] **Step 3: Crear el andamiaje mínimo**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`package.json` (raíz):
```json
{
  "name": "citara",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "db:up": "docker compose up -d postgres redis",
    "db:down": "docker compose down"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.7.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
```

`packages/shared/package.json`:
```json
{
  "name": "@citara/shared",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
```

`packages/shared/src/index.ts`:
```ts
export const PROJECT_NAME = 'citara';
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: citara
      TZ: UTC
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      retries: 10
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
volumes:
  pgdata:
```

`.env.example`:
```
NODE_ENV=development
TZ=UTC
PORT=3000

DATABASE_URL=postgres://citara_app:citara_app@localhost:5432/citara
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/citara
REDIS_URL=redis://localhost:6379

DB_ENCRYPTION_KEY=

META_APP_SECRET=
META_VERIFY_TOKEN=
META_GRAPH_VERSION=v21.0
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm install && pnpm vitest run packages/shared`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(setup): crear andamiaje del monorepo con pnpm workspaces y vitest"
```

---

### Task 2: DataSource, rol de aplicación y primera migración

**Files:**
- Create: `packages/db/package.json`, `packages/db/src/data-source.ts`, `packages/db/src/migrations/1725300000000-CreateAppRole.ts`, `packages/db/src/migrations/1725300100000-CreateTenants.ts`, `packages/db/src/entities/tenant.entity.ts`
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Consumes: workspace de Task 1.
- Produces: `createDataSource(url: string): DataSource`, entidad `Tenant`, y el rol `citara_app` (sin `BYPASSRLS`, sin ser dueño de tablas). Migraciones corren con `DATABASE_ADMIN_URL`; la app usa `DATABASE_URL`.

- [ ] **Step 1: Escribir el test que falla**

`packages/db/test/migrations.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDataSource } from '../src/data-source';
import type { DataSource } from 'typeorm';

let ds: DataSource;

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await ds.initialize();
  await ds.runMigrations();
});

afterAll(async () => { await ds.destroy(); });

describe('migraciones', () => {
  it('crea la tabla tenants', async () => {
    const rows = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'tenants' ORDER BY column_name`,
    );
    const cols = rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'slug', 'name', 'timezone', 'status', 'created_at']),
    );
  });

  it('crea el rol citara_app sin privilegio de saltar RLS', async () => {
    const [role] = await ds.query(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'citara_app'`,
    );
    expect(role).toBeDefined();
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolsuper).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm db:up && pnpm vitest run packages/db`
Expected: FAIL — `createDataSource` no existe.

- [ ] **Step 3: Implementar**

`packages/db/package.json`:
```json
{
  "name": "@citara/db",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "typeorm": "^0.3.20",
    "pg": "^8.13.0",
    "reflect-metadata": "^0.2.2"
  }
}
```

`packages/db/src/data-source.ts`:
```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Tenant } from './entities/tenant.entity';

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: [Tenant],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
    logging: false,
  });
}
```

`packages/db/src/entities/tenant.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  slug!: string;

  @Column()
  name!: string;

  /** IANA, p.ej. America/Bogota. Fuente de verdad para presentar horarios. */
  @Column({ default: 'America/Bogota' })
  timezone!: string;

  @Column({ default: 'active' })
  status!: 'active' | 'suspended';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
```

`packages/db/src/migrations/1725300000000-CreateAppRole.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAppRole1725300000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'citara_app') THEN
          CREATE ROLE citara_app LOGIN PASSWORD 'citara_app' NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await q.query(`GRANT USAGE ON SCHEMA public TO citara_app`);
    await q.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO citara_app
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM citara_app
    `);
    await q.query(`REVOKE USAGE ON SCHEMA public FROM citara_app`);
    await q.query(`DROP ROLE IF EXISTS citara_app`);
  }
}
```

`packages/db/src/migrations/1725300100000-CreateTenants.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTenants1725300100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE tenants (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug       varchar(64) NOT NULL UNIQUE,
        name       varchar(255) NOT NULL,
        timezone   varchar(64) NOT NULL DEFAULT 'America/Bogota',
        status     varchar(32) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // tenants NO lleva RLS: es la tabla raíz, se lee para resolver el contexto.
    await q.query(`GRANT SELECT ON tenants TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE tenants`);
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run packages/db`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): crear datasource, rol de aplicación sin bypass de rls y tabla tenants"
```

---

### Task 3: Aislamiento por RLS y `runInTenant`

Esta es la tarea de seguridad más importante de la fase. El test que la acompaña
demuestra que un olvido de contexto devuelve **cero filas**, no datos ajenos.

**Files:**
- Create: `packages/db/src/migrations/1725300200000-CreateContacts.ts`, `packages/db/src/entities/contact.entity.ts`
- Create: `apps/api/src/tenancy/tenant-context.ts`
- Test: `apps/api/test/tenancy/rls.test.ts`

**Interfaces:**
- Consumes: `createDataSource` (Task 2).
- Produces: `runInTenant<T>(ds: DataSource, tenantId: string, fn: (m: EntityManager) => Promise<T>): Promise<T>` y `enableTenantRls(q: QueryRunner, table: string)` reutilizable por toda migración con `tenant_id`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/tenancy/rls.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { Contact } from '@citara/db';

let admin: DataSource;
let app: DataSource;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await admin.initialize();
  await admin.runMigrations();

  const [a] = await admin.query(
    `INSERT INTO tenants (slug, name) VALUES ('a', 'A') RETURNING id`);
  const [b] = await admin.query(
    `INSERT INTO tenants (slug, name) VALUES ('b', 'B') RETURNING id`);
  tenantA = a.id; tenantB = b.id;

  await admin.query(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1,'573001','Ana')`, [tenantA]);
  await admin.query(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1,'573002','Beto')`, [tenantB]);

  app = createDataSource(process.env.DATABASE_URL!);
  await app.initialize();
});

afterAll(async () => {
  await admin.query(`DELETE FROM contacts`);
  await admin.query(`DELETE FROM tenants`);
  await admin.destroy();
  await app.destroy();
});

describe('aislamiento por RLS', () => {
  it('dentro del contexto de A solo se ven los contactos de A', async () => {
    const rows = await runInTenant(app, tenantA, (m) => m.find(Contact));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Ana');
  });

  it('dentro del contexto de B solo se ven los contactos de B', async () => {
    const rows = await runInTenant(app, tenantB, (m) => m.find(Contact));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Beto');
  });

  it('SIN contexto de tenant devuelve cero filas — falla cerrado', async () => {
    const rows = await app.getRepository(Contact).find();
    expect(rows).toHaveLength(0);
  });

  it('el contexto no se filtra entre transacciones consecutivas', async () => {
    await runInTenant(app, tenantA, (m) => m.find(Contact));
    const rows = await app.getRepository(Contact).find();
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/tenancy`
Expected: FAIL — no existe `runInTenant`.

- [ ] **Step 3: Implementar**

`apps/api/src/tenancy/tenant-context.ts`:
```ts
import type { DataSource, EntityManager } from 'typeorm';

/**
 * Ejecuta `fn` dentro de una transacción con `app.tenant_id` fijado.
 * SET LOCAL es transaccional: se revierte solo al terminar, así que el
 * contexto no puede filtrarse a la siguiente operación de la misma conexión.
 */
export async function runInTenant<T>(
  ds: DataSource,
  tenantId: string,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // set_config parametrizado: evita inyección al interpolar el uuid.
    await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(runner.manager);
    await runner.commitTransaction();
    return result;
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }
}

/** SQL reutilizable: activa RLS tenant-scoped sobre una tabla. */
export function tenantRlsSql(table: string): string[] {
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    // FORCE es indispensable: sin él, el dueño de la tabla salta la política.
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${table}
       USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
       WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO citara_app`,
  ];
}
```

`packages/db/src/entities/contact.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('contacts')
@Index(['tenantId', 'waId'], { unique: true })
export class Contact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  /** Número en formato E.164 sin '+', tal como lo entrega Meta. */
  @Column({ name: 'wa_id' })
  waId!: string;

  @Column({ type: 'varchar', nullable: true })
  name!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
```

`packages/db/src/migrations/1725300200000-CreateContacts.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateContacts1725300200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE contacts (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        wa_id      varchar(32) NOT NULL,
        name       varchar(255),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wa_id)
      )
    `);
    for (const sql of tenantRlsSql('contacts')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE contacts`);
  }
}
```

Mover `tenantRlsSql` a `packages/db/src/rls.ts` y reexportarlo desde
`apps/api/src/tenancy/tenant-context.ts` para que migraciones y app compartan la
misma definición. Exportar `Contact`, `Tenant` y `createDataSource` desde
`packages/db/src/index.ts`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/tenancy`
Expected: PASS, 4 tests. **Si el tercer test devuelve filas, la app se está conectando como superusuario o como dueño de las tablas — revisar `DATABASE_URL` antes de seguir.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tenancy): imponer aislamiento multi-tenant con row level security"
```

---

### Task 4: Cifrado de secretos

**Files:**
- Create: `apps/api/src/crypto/encryption.service.ts`
- Test: `apps/api/test/crypto/encryption.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `EncryptionService` con `encrypt(plain: string): Buffer` y `decrypt(envelope: Buffer): string`. El envelope es `[version:1][nonce:24][ciphertext:N]`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/crypto/encryption.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { EncryptionService } from '../../src/crypto/encryption.service';

let svc: EncryptionService;

beforeAll(async () => {
  // 32 bytes en base64
  const key = Buffer.alloc(32, 7).toString('base64');
  svc = new EncryptionService(key);
  await svc.ready();
});

describe('EncryptionService', () => {
  it('cifra y descifra ida y vuelta', () => {
    const secret = 'EAAG...token-de-meta';
    const envelope = svc.encrypt(secret);
    expect(svc.decrypt(envelope)).toBe(secret);
  });

  it('nunca produce el mismo cifrado dos veces (nonce aleatorio)', () => {
    const a = svc.encrypt('mismo-valor');
    const b = svc.encrypt('mismo-valor');
    expect(a.equals(b)).toBe(false);
  });

  it('marca la versión del envelope en el primer byte', () => {
    expect(svc.encrypt('x')[0]).toBe(1);
  });

  it('rechaza un envelope alterado', () => {
    const envelope = svc.encrypt('x');
    envelope[envelope.length - 1] ^= 0xff;
    expect(() => svc.decrypt(envelope)).toThrow();
  });

  it('rechaza una llave que no mida 32 bytes', () => {
    expect(() => new EncryptionService(Buffer.alloc(16).toString('base64')))
      .toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/crypto`
Expected: FAIL — no existe `EncryptionService`.

- [ ] **Step 3: Implementar**

```bash
pnpm --filter @citara/api add libsodium-wrappers
pnpm --filter @citara/api add -D @types/libsodium-wrappers
```

`apps/api/src/crypto/encryption.service.ts`:
```ts
import sodium from 'libsodium-wrappers';

const VERSION = 1;
const NONCE_BYTES = 24; // crypto_secretbox_NONCEBYTES
const KEY_BYTES = 32;   // crypto_secretbox_KEYBYTES

export class EncryptionService {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`DB_ENCRYPTION_KEY debe medir 32 bytes, midió ${key.length}`);
    }
    this.key = key;
  }

  async ready(): Promise<void> {
    await sodium.ready;
  }

  encrypt(plain: string): Buffer {
    const nonce = sodium.randombytes_buf(NONCE_BYTES);
    const cipher = sodium.crypto_secretbox_easy(
      sodium.from_string(plain), nonce, this.key,
    );
    return Buffer.concat([Buffer.from([VERSION]), Buffer.from(nonce), Buffer.from(cipher)]);
  }

  decrypt(envelope: Buffer): string {
    const version = envelope[0];
    if (version !== VERSION) {
      throw new Error(`Versión de envelope no soportada: ${version}`);
    }
    const nonce = envelope.subarray(1, 1 + NONCE_BYTES);
    const cipher = envelope.subarray(1 + NONCE_BYTES);
    const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, this.key);
    return sodium.to_string(plain);
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/crypto`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/crypto apps/api/test/crypto
git commit -m "feat(crypto): cifrar secretos por tenant con libsodium secretbox y envelope versionado"
```

---

### Task 5: Verificación de firma del webhook

**Files:**
- Create: `apps/api/src/whatsapp/signature.ts`
- Test: `apps/api/test/whatsapp/signature.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/whatsapp/signature.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from '../../src/whatsapp/signature';

const SECRET = 'app-secret-de-prueba';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
const valid = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

describe('verifyMetaSignature', () => {
  it('acepta una firma válida', () => {
    expect(verifyMetaSignature(body, valid, SECRET)).toBe(true);
  });

  it('rechaza una firma con secreto equivocado', () => {
    const bad = 'sha256=' + createHmac('sha256', 'otro').update(body).digest('hex');
    expect(verifyMetaSignature(body, bad, SECRET)).toBe(false);
  });

  it('rechaza si el cuerpo cambió aunque sea un byte', () => {
    const tampered = Buffer.from(JSON.stringify({ object: 'otra_cosa' }));
    expect(verifyMetaSignature(tampered, valid, SECRET)).toBe(false);
  });

  it('rechaza cuando falta el header', () => {
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rechaza un header sin el prefijo sha256=', () => {
    expect(verifyMetaSignature(body, 'abc123', SECRET)).toBe(false);
  });

  it('rechaza un header de longitud distinta sin lanzar', () => {
    expect(verifyMetaSignature(body, 'sha256=deadbeef', SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/whatsapp/signature`
Expected: FAIL — no existe `verifyMetaSignature`.

- [ ] **Step 3: Implementar**

`apps/api/src/whatsapp/signature.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifica el header `x-hub-signature-256` de Meta contra el cuerpo CRUDO.
 * Debe recibir el Buffer sin parsear: cualquier reserialización del JSON
 * cambia bytes y rompe la firma.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');

  // timingSafeEqual lanza si difieren en longitud: comparar antes.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/whatsapp/signature`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/whatsapp/signature.ts apps/api/test/whatsapp/signature.test.ts
git commit -m "feat(whatsapp): verificar firma hmac del webhook de meta en tiempo constante"
```

---

### Task 6: Normalizador del payload de Meta

**Files:**
- Create: `packages/shared/src/inbound-message.ts`
- Create: `apps/api/src/whatsapp/normalizer.ts`
- Create: `apps/api/test/whatsapp/fixtures/` (payloads reales de Meta)
- Test: `apps/api/test/whatsapp/normalizer.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
```ts
type InboundMessage = {
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
  from: string;              // wa_id, E.164 sin '+'
  profileName: string | null;
  type: 'text' | 'interactive' | 'image' | 'audio' | 'document' | 'video' | 'unsupported';
  text: string | null;       // botón/lista aplanados a su id
  mediaId: string | null;
  timestamp: Date;
  raw: unknown;
};
type InboundStatus = { wamid: string; status: string; timestamp: Date };
normalizeWebhook(payload: unknown): { messages: InboundMessage[]; statuses: InboundStatus[] }
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/whatsapp/normalizer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { normalizeWebhook } from '../../src/whatsapp/normalizer';

const envelope = (value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290129340398', changes: [{ field: 'messages', value }] }],
});

const metadata = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '15550001', phone_number_id: '106540352242922' },
  contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
};

describe('normalizeWebhook', () => {
  it('normaliza un mensaje de texto', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.ABC', timestamp: '1756900000',
        type: 'text', text: { body: 'Hola' },
      }],
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      wamid: 'wamid.ABC',
      phoneNumberId: '106540352242922',
      wabaId: '102290129340398',
      from: '573001112233',
      profileName: 'Ana',
      type: 'text',
      text: 'Hola',
    });
    expect(messages[0].timestamp).toEqual(new Date(1756900000 * 1000));
  });

  it('aplana la respuesta de un botón a su id', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.BTN', timestamp: '1756900001',
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'agendar', title: 'Agendar cita' } },
      }],
    }));
    expect(messages[0].type).toBe('interactive');
    expect(messages[0].text).toBe('agendar');
  });

  it('aplana la selección de una lista a su id', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.LST', timestamp: '1756900002',
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'srv_corte', title: 'Corte' } },
      }],
    }));
    expect(messages[0].text).toBe('srv_corte');
  });

  it('extrae el media_id de una imagen', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.IMG', timestamp: '1756900003',
        type: 'image', image: { id: 'media-123', mime_type: 'image/jpeg' },
      }],
    }));
    expect(messages[0].type).toBe('image');
    expect(messages[0].mediaId).toBe('media-123');
    expect(messages[0].text).toBeNull();
  });

  it('normaliza los acuses de estado', () => {
    const { statuses, messages } = normalizeWebhook(envelope({
      ...metadata,
      statuses: [{ id: 'wamid.OUT', status: 'delivered', timestamp: '1756900004' }],
    }));
    expect(messages).toHaveLength(0);
    expect(statuses[0]).toMatchObject({ wamid: 'wamid.OUT', status: 'delivered' });
  });

  it('marca como unsupported un tipo desconocido en vez de lanzar', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{ from: '573001112233', id: 'wamid.X', timestamp: '1756900005', type: 'sticker' }],
    }));
    expect(messages[0].type).toBe('unsupported');
  });

  it('devuelve listas vacías ante un payload irreconocible', () => {
    expect(normalizeWebhook({ hola: 'mundo' })).toEqual({ messages: [], statuses: [] });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/whatsapp/normalizer`
Expected: FAIL — no existe `normalizeWebhook`.

- [ ] **Step 3: Implementar**

`packages/shared/src/inbound-message.ts`:
```ts
export type InboundType =
  | 'text' | 'interactive' | 'image' | 'audio' | 'document' | 'video' | 'unsupported';

export interface InboundMessage {
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
  from: string;
  profileName: string | null;
  type: InboundType;
  text: string | null;
  mediaId: string | null;
  timestamp: Date;
  raw: unknown;
}

export interface InboundStatus {
  wamid: string;
  status: string;
  timestamp: Date;
}
```

`apps/api/src/whatsapp/normalizer.ts`:
```ts
import type { InboundMessage, InboundStatus, InboundType } from '@citara/shared';

const MEDIA_TYPES = ['image', 'audio', 'document', 'video'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const isMedia = (t: string): t is MediaType =>
  (MEDIA_TYPES as readonly string[]).includes(t);

const toDate = (unixSeconds: string): Date => new Date(Number(unixSeconds) * 1000);

/**
 * Traduce el payload de Meta a nuestro contrato interno.
 * Este es el ÚNICO lugar del sistema que conoce el formato de Meta al entrar.
 * Nunca lanza: un payload irreconocible produce listas vacías.
 */
export function normalizeWebhook(payload: unknown): {
  messages: InboundMessage[];
  statuses: InboundStatus[];
} {
  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];

  const entries = (payload as any)?.entry;
  if (!Array.isArray(entries)) return { messages, statuses };

  for (const entry of entries) {
    const wabaId = String(entry?.id ?? '');
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value) continue;

      const phoneNumberId = String(value?.metadata?.phone_number_id ?? '');
      const profileByWaId = new Map<string, string | null>(
        (value?.contacts ?? []).map((c: any) => [String(c?.wa_id), c?.profile?.name ?? null]),
      );

      for (const m of value?.messages ?? []) {
        const rawType = String(m?.type ?? '');
        let type: InboundType = 'unsupported';
        let text: string | null = null;
        let mediaId: string | null = null;

        if (rawType === 'text') {
          type = 'text';
          text = m?.text?.body ?? null;
        } else if (rawType === 'interactive') {
          type = 'interactive';
          // Botón y lista se aplanan a su id: el motor de flujos ramifica por id.
          text = m?.interactive?.button_reply?.id
            ?? m?.interactive?.list_reply?.id
            ?? null;
        } else if (isMedia(rawType)) {
          type = rawType;
          mediaId = m?.[rawType]?.id ?? null;
        }

        messages.push({
          wamid: String(m?.id ?? ''),
          phoneNumberId,
          wabaId,
          from: String(m?.from ?? ''),
          profileName: profileByWaId.get(String(m?.from)) ?? null,
          type,
          text,
          mediaId,
          timestamp: toDate(m?.timestamp ?? '0'),
          raw: m,
        });
      }

      for (const s of value?.statuses ?? []) {
        statuses.push({
          wamid: String(s?.id ?? ''),
          status: String(s?.status ?? ''),
          timestamp: toDate(s?.timestamp ?? '0'),
        });
      }
    }
  }

  return { messages, statuses };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/whatsapp/normalizer`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api/src/whatsapp/normalizer.ts apps/api/test/whatsapp/normalizer.test.ts
git commit -m "feat(whatsapp): normalizar el payload de meta a un contrato interno de mensaje"
```

---

### Task 7: Canales, resolución de tenant y migraciones de conversación

**Files:**
- Create: `packages/db/src/entities/whatsapp-channel.entity.ts`, `conversation.entity.ts`, `message.entity.ts`, `webhook-event.entity.ts`
- Create: migraciones `1725300300000-CreateWhatsappChannels.ts`, `1725300400000-CreateConversations.ts`, `1725300500000-CreateMessages.ts`, `1725300600000-CreateWebhookEvents.ts`
- Create: `apps/api/src/tenancy/channel-resolver.service.ts`
- Test: `apps/api/test/tenancy/channel-resolver.test.ts`

**Interfaces:**
- Consumes: `createDataSource`, `runInTenant`, `tenantRlsSql`, `EncryptionService`.
- Produces: `ChannelResolver.resolveByPhoneNumberId(phoneNumberId: string): Promise<ResolvedChannel | null>` donde `ResolvedChannel = { tenantId: string; channelId: string; wabaId: string; phoneNumberId: string; accessToken: string }`. El `accessToken` vuelve **descifrado**; el llamador nunca lo registra en logs.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/tenancy/channel-resolver.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';

let admin: DataSource, app: DataSource, enc: EncryptionService, resolver: ChannelResolver;
let tenantId: string;

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await admin.initialize();
  await admin.runMigrations();

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
});
```

> El segundo test codifica una lección operativa cara: un gateway que ante un
> número no resuelto cae a un tenant "por defecto" termina enviando mensajes con
> las credenciales de otro cliente. Aquí no resolver es un error, no un fallback.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/tenancy/channel-resolver`
Expected: FAIL — no existe `ChannelResolver`.

- [ ] **Step 3: Implementar**

Migración `1725300300000-CreateWhatsappChannels.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateWhatsappChannels1725300300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE whatsapp_channels (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        waba_id                varchar(64) NOT NULL,
        phone_number_id        varchar(64) NOT NULL UNIQUE,
        display_phone_number   varchar(32),
        access_token_encrypted bytea NOT NULL,
        status                 varchar(32) NOT NULL DEFAULT 'active',
        created_at             timestamptz NOT NULL DEFAULT now()
      )
    `);
    // La resolución de canal ocurre ANTES de conocer el tenant, así que esta
    // tabla no lleva RLS; se lee por phone_number_id, que es único global.
    await q.query(`GRANT SELECT ON whatsapp_channels TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE whatsapp_channels`);
  }
}
```

Migración `1725300400000-CreateConversations.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateConversations1725300400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE conversations (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel_id      uuid NOT NULL REFERENCES whatsapp_channels(id),
        status          varchar(32) NOT NULL DEFAULT 'bot',
        assigned_to     uuid,
        last_inbound_at timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Una sola conversación abierta por contacto y canal.
    await q.query(`
      CREATE UNIQUE INDEX conversations_open_unique
        ON conversations (tenant_id, contact_id, channel_id)
        WHERE status <> 'closed'
    `);
    for (const sql of tenantRlsSql('conversations')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE conversations`);
  }
}
```

Migración `1725300500000-CreateMessages.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateMessages1725300500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE messages (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        wamid           varchar(128),
        direction       varchar(8) NOT NULL CHECK (direction IN ('in','out')),
        type            varchar(32) NOT NULL,
        body            text,
        payload         jsonb,
        status          varchar(32),
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX messages_wamid_unique ON messages (wamid) WHERE wamid IS NOT NULL`);
    await q.query(`CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC)`);
    for (const sql of tenantRlsSql('messages')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE messages`);
  }
}
```

Migración `1725300600000-CreateWebhookEvents.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookEvents1725300600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE webhook_events (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        wamid        varchar(128) NOT NULL UNIQUE,
        tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
        payload      jsonb NOT NULL,
        received_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Sin RLS: es la puerta de idempotencia, se escribe ANTES de resolver tenant.
    await q.query(`GRANT SELECT, INSERT ON webhook_events TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE webhook_events`);
  }
}
```

`apps/api/src/tenancy/channel-resolver.service.ts`:
```ts
import type { DataSource } from 'typeorm';
import type { EncryptionService } from '../crypto/encryption.service';

export interface ResolvedChannel {
  tenantId: string;
  channelId: string;
  wabaId: string;
  /** Necesario al enviar: el endpoint de Graph se construye con él. */
  phoneNumberId: string;
  accessToken: string;
}

export class ChannelResolver {
  constructor(
    private readonly ds: DataSource,
    private readonly enc: EncryptionService,
  ) {}

  /**
   * Resuelve el canal por phone_number_id. Devuelve null si no existe.
   * NO existe un tenant por defecto: enviar con credenciales ajenas es peor
   * que no enviar.
   */
  async resolveByPhoneNumberId(phoneNumberId: string): Promise<ResolvedChannel | null> {
    const [row] = await this.ds.query(
      `SELECT id, tenant_id, waba_id, phone_number_id, access_token_encrypted
         FROM whatsapp_channels
        WHERE phone_number_id = $1 AND status = 'active'`,
      [phoneNumberId],
    );
    if (!row) return null;

    return {
      tenantId: row.tenant_id,
      channelId: row.id,
      wabaId: row.waba_id,
      phoneNumberId: row.phone_number_id,
      accessToken: this.enc.decrypt(row.access_token_encrypted),
    };
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/tenancy`
Expected: PASS — los 4 tests de RLS más los 2 del resolver.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tenancy): resolver canal y tenant por phone_number_id sin fallback a default"
```

---

### Task 8: Endpoint del webhook con idempotencia

**Files:**
- Create: `apps/api/src/whatsapp/whatsapp.controller.ts`, `apps/api/src/whatsapp/ingest.service.ts`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/queues/inbound.queue.ts` (el productor; el consumidor llega en la Task 9)
- Create: `apps/api/test/helpers.ts` (usado por todos los tests de aquí en adelante)
- Test: `apps/api/test/whatsapp/webhook.e2e.test.ts`

**Interfaces:**
- Consumes: `verifyMetaSignature`, `normalizeWebhook`, `ChannelResolver`.
- Produces: `GET /webhooks/whatsapp` (verificación) y `POST /webhooks/whatsapp` (ingesta); `IngestService.ingest(payload): Promise<{ enqueued: number; duplicates: number }>`; `InboundQueue.add(job: InboundJob)`; y los helpers de test `resetDb()`, `seedChannel()`, `seedFlow()`, `createTestApp()`.
- `InboundJob = { tenantId: string; channelId: string; message: InboundMessage }` se declara aquí, en `apps/api/src/queues/inbound.queue.ts`, y la Task 9 lo importa.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/whatsapp/webhook.e2e.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, seedChannel } from '../helpers';

const SECRET = process.env.META_APP_SECRET!;
let app: INestApplication;

const sign = (body: object) =>
  'sha256=' + createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

const inbound = (wamid: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: wamid, timestamp: '1756900000',
                 type: 'text', text: { body: 'Hola' } }],
  } }] }],
});

beforeAll(async () => { await resetDb(); await seedChannel(); app = await createTestApp(); });
afterAll(async () => { await app.close(); });

describe('GET /webhooks/whatsapp', () => {
  it('devuelve el challenge cuando el verify_token coincide', async () => {
    await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe',
               'hub.verify_token': process.env.META_VERIFY_TOKEN,
               'hub.challenge': '123456' })
      .expect(200).expect('123456');
  });

  it('devuelve 403 cuando el verify_token no coincide', async () => {
    await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': '1' })
      .expect(403);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('rechaza con 401 si la firma es inválida', async () => {
    const body = inbound('wamid.SIGN');
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send(body).expect(401);
  });

  it('acepta un mensaje firmado y lo encola', async () => {
    const body = inbound('wamid.OK1');
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body))
      .send(body).expect(200);
    expect(res.body).toEqual({ enqueued: 1, duplicates: 0 });
  });

  it('deduplica: el mismo wamid reenviado no se encola dos veces', async () => {
    const body = inbound('wamid.DUP');
    const sig = sign(body);
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sig).send(body).expect(200);
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sig).send(body).expect(200);
    expect(res.body).toEqual({ enqueued: 0, duplicates: 1 });
  });

  it('responde 200 aunque el phone_number_id sea desconocido', async () => {
    const body = inbound('wamid.UNK');
    body.entry[0].changes[0].value.metadata.phone_number_id = '999999';
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sign(body)).send(body).expect(200);
  });

  it('responde en menos de 100 ms', async () => {
    const body = inbound('wamid.FAST');
    const t0 = Date.now();
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sign(body)).send(body).expect(200);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
```

> El quinto test importa: si un `phone_number_id` desconocido devolviera un error,
> Meta reintentaría indefinidamente. Se responde `200`, se registra y se descarta.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/whatsapp/webhook`
Expected: FAIL — no existe la app de Nest.

- [ ] **Step 3: Implementar**

`apps/api/src/main.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true es indispensable — la firma HMAC se calcula sobre los bytes
  // originales, y reserializar el JSON los cambia.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

`apps/api/src/whatsapp/whatsapp.controller.ts`:
```ts
import {
  Controller, Get, Post, Query, Req, Res, HttpStatus, ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { verifyMetaSignature } from './signature';
import { IngestService } from './ingest.service';

@Controller('webhooks/whatsapp')
export class WhatsappController {
  constructor(private readonly ingest: IngestService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    if (mode !== 'subscribe' || token !== process.env.META_VERIFY_TOKEN) {
      throw new ForbiddenException();
    }
    res.status(HttpStatus.OK).send(challenge);
  }

  @Post()
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    const ok = verifyMetaSignature(
      req.rawBody ?? Buffer.alloc(0),
      req.header('x-hub-signature-256'),
      process.env.META_APP_SECRET!,
    );
    if (!ok) throw new UnauthorizedException('firma inválida');

    // Todo lo pesado va a la cola. Aquí solo se persiste y se encola.
    return this.ingest.ingest(req.body);
  }
}
```

```bash
pnpm --filter @citara/api add @nestjs/common @nestjs/core @nestjs/platform-express bullmq ioredis
pnpm --filter @citara/api add -D supertest @types/supertest
```

`apps/api/src/queues/inbound.queue.ts`:
```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { InboundMessage } from '@citara/shared';

export const INBOUND_QUEUE = 'inbound';

export interface InboundJob {
  tenantId: string;
  channelId: string;
  message: InboundMessage;
}

@Injectable()
export class InboundQueue implements OnModuleDestroy {
  private readonly queue = new Queue<InboundJob>(INBOUND_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false, // los fallidos quedan para inspección
    },
  });

  add(job: InboundJob) {
    // jobId = wamid: segunda barrera de idempotencia, ahora en la cola.
    return this.queue.add('process', job, { jobId: job.message.wamid });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
```

`apps/api/test/helpers.ts` — usado por todos los tests de integración de aquí en
adelante:
```ts
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

/** Vacía todo lo tenant-scoped. El orden lo resuelve CASCADE. */
export async function resetDb(): Promise<void> {
  const ds = await adminDs();
  await ds.query(`
    TRUNCATE webhook_events, conversation_sessions, messages, conversations,
             contacts, flows, whatsapp_channels, tenants
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
```

`apps/api/src/whatsapp/ingest.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { normalizeWebhook } from './normalizer';
import { ChannelResolver } from '../tenancy/channel-resolver.service';
import { InboundQueue } from '../queues/inbound.queue';

@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly channels: ChannelResolver,
    private readonly queue: InboundQueue,
  ) {}

  async ingest(payload: unknown): Promise<{ enqueued: number; duplicates: number }> {
    const { messages } = normalizeWebhook(payload);
    let enqueued = 0;
    let duplicates = 0;

    for (const msg of messages) {
      const channel = await this.channels.resolveByPhoneNumberId(msg.phoneNumberId);
      if (!channel) {
        // 200 igual: un error haría que Meta reintente para siempre.
        this.log.warn(`phone_number_id sin canal: ${msg.phoneNumberId}`);
        continue;
      }

      // La idempotencia es la restricción única, no un SELECT previo.
      const inserted = await this.ds.query(
        `INSERT INTO webhook_events (wamid, tenant_id, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (wamid) DO NOTHING
         RETURNING id`,
        [msg.wamid, channel.tenantId, JSON.stringify(msg.raw)],
      );

      if (inserted.length === 0) { duplicates++; continue; }

      await this.queue.add({ tenantId: channel.tenantId, channelId: channel.channelId, message: msg });
      enqueued++;
    }

    return { enqueued, duplicates };
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/whatsapp/webhook`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(whatsapp): recibir webhook de meta con firma verificada e idempotencia por wamid"
```

---

### Task 9: Colas BullMQ y proceso worker separado

**Files:**
- Create: `apps/api/src/queues/queue.module.ts`, `outbound.queue.ts`, `inbound.processor.ts`
- Create: `apps/worker/package.json`, `apps/worker/src/main.ts`
- Test: `apps/api/test/queues/inbound.processor.test.ts`

**Interfaces:**
- Consumes: `ChannelResolver`, `runInTenant`, `InboundQueue` e `InboundJob` (Task 8).
- Produces: `InboundProcessor.process(job: InboundJob)`, `OutboundQueue.add(job: OutboundJob)` con
```ts
type OutboundJob = { tenantId: string; channelId: string; conversationId: string;
                     to: string; idempotencyKey: string; content: OutboundContent };
```
y `InboundProcessor.process(job)` que persiste contacto, conversación y mensaje.

**Por qué worker aparte:** compartir proceso entre HTTP y procesadores es un cuello
de botella conocido — los workers compiten con el event loop del servidor y saturan
el pool de conexiones mientras la base de datos queda ociosa. `apps/worker` importa
los mismos módulos pero **no** levanta el servidor HTTP.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/queues/inbound.processor.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { InboundProcessor } from '../../src/queues/inbound.processor';
import { resetDb, seedChannel } from '../helpers';
import type { InboundMessage } from '@citara/shared';

let app: DataSource, processor: InboundProcessor;
let tenantId: string, channelId: string;

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  wamid: 'wamid.P1', phoneNumberId: '106540', wabaId: '102290',
  from: '573001112233', profileName: 'Ana', type: 'text', text: 'Hola',
  mediaId: null, timestamp: new Date('2026-09-03T15:00:00Z'), raw: {}, ...over,
});

beforeAll(async () => {
  app = createDataSource(process.env.DATABASE_URL!);
  await app.initialize();
  processor = new InboundProcessor(app);
});
beforeEach(async () => { await resetDb(); ({ tenantId, channelId } = await seedChannel()); });
afterAll(async () => { await app.destroy(); });

describe('InboundProcessor', () => {
  it('crea contacto, conversación y mensaje en la primera interacción', async () => {
    await processor.process({ tenantId, channelId, message: msg() });

    const rows = await runInTenant(app, tenantId, async (m) => ({
      contacts: await m.query(`SELECT * FROM contacts`),
      conversations: await m.query(`SELECT * FROM conversations`),
      messages: await m.query(`SELECT * FROM messages`),
    }));

    expect(rows.contacts).toHaveLength(1);
    expect(rows.contacts[0].wa_id).toBe('573001112233');
    expect(rows.conversations).toHaveLength(1);
    expect(rows.messages).toHaveLength(1);
    expect(rows.messages[0].direction).toBe('in');
    expect(rows.messages[0].body).toBe('Hola');
  });

  it('reutiliza contacto y conversación en la segunda interacción', async () => {
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.A' }) });
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.B', text: 'Otra' }) });

    const rows = await runInTenant(app, tenantId, async (m) => ({
      contacts: await m.query(`SELECT * FROM contacts`),
      conversations: await m.query(`SELECT * FROM conversations`),
      messages: await m.query(`SELECT * FROM messages ORDER BY created_at`),
    }));

    expect(rows.contacts).toHaveLength(1);
    expect(rows.conversations).toHaveLength(1);
    expect(rows.messages).toHaveLength(2);
  });

  it('actualiza last_inbound_at para la ventana de 24 horas', async () => {
    const at = new Date('2026-09-03T15:00:00Z');
    await processor.process({ tenantId, channelId, message: msg({ timestamp: at }) });

    const [conv] = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT last_inbound_at FROM conversations`));
    expect(new Date(conv.last_inbound_at).toISOString()).toBe(at.toISOString());
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/queues`
Expected: FAIL — no existe `InboundProcessor`.

- [ ] **Step 3: Implementar**

`apps/api/src/queues/inbound.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { InboundJob } from './inbound.queue';

@Injectable()
export class InboundProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: InboundJob): Promise<{ conversationId: string; messageId: string }> {
    const { tenantId, channelId, message } = job;

    return runInTenant(this.ds, tenantId, async (m) => {
      const [contact] = await m.query(
        `INSERT INTO contacts (tenant_id, wa_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, wa_id)
           DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name)
         RETURNING id`,
        [tenantId, message.from, message.profileName],
      );

      const [conversation] = await m.query(
        `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed'
           DO UPDATE SET last_inbound_at = EXCLUDED.last_inbound_at,
                         updated_at = now()
         RETURNING id`,
        [tenantId, contact.id, channelId, message.timestamp],
      );

      const [saved] = await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, type, body, payload)
         VALUES ($1, $2, $3, 'in', $4, $5, $6)
         ON CONFLICT (wamid) DO NOTHING
         RETURNING id`,
        [tenantId, conversation.id, message.wamid, message.type,
         message.text, JSON.stringify(message.raw)],
      );

      return { conversationId: conversation.id, messageId: saved?.id ?? '' };
    });
  }
}
```

`apps/worker/src/main.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from '@citara/api/src/app.module';
import { InboundProcessor } from '@citara/api/src/queues/inbound.processor';
import { INBOUND_QUEUE, type InboundJob } from '@citara/api/src/queues/inbound.queue';

async function bootstrap() {
  // createApplicationContext: sin servidor HTTP. Este proceso SOLO procesa colas.
  const ctx = await NestFactory.createApplicationContext(AppModule);
  const processor = ctx.get(InboundProcessor);

  const worker = new Worker<InboundJob>(
    INBOUND_QUEUE,
    (job) => processor.process(job.data),
    {
      connection: { url: process.env.REDIS_URL },
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[inbound] job ${job?.id} falló: ${err.message}`);
  });

  const shutdown = async () => { await worker.close(); await ctx.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
void bootstrap();
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/queues`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(queues): procesar mensajes entrantes en un worker separado del proceso http"
```

---

### Task 10: Envío hacia Meta con idempotencia

**Files:**
- Create: `apps/api/src/whatsapp/sender.ts`, `apps/api/src/queues/outbound.processor.ts`
- Create: `packages/shared/src/outbound-message.ts`
- Test: `apps/api/test/whatsapp/sender.test.ts`

**Interfaces:**
- Consumes: `ChannelResolver`.
- Produces:
```ts
type OutboundContent =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
  | { kind: 'list'; body: string; button: string;
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] };

class MetaSender {
  constructor(graphVersion: string);
  send(channel: ResolvedChannel, to: string, content: OutboundContent): Promise<{ wamid: string }>;
}
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/whatsapp/sender.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetaSender } from '../../src/whatsapp/sender';

const channel = { tenantId: 't', channelId: 'c', wabaId: 'w',
                  phoneNumberId: '106540', accessToken: 'TOKEN' };
let fetchMock: ReturnType<typeof vi.fn>;
let sender: MetaSender;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  sender = new MetaSender('v21.0');
});

describe('MetaSender', () => {
  it('envía texto al endpoint correcto con el token del canal', async () => {
    const res = await sender.send(channel, '573001112233', { kind: 'text', body: 'Hola' });

    expect(res.wamid).toBe('wamid.OUT1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/106540/messages');
    expect(init.headers.Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '573001112233',
      type: 'text',
      text: { body: 'Hola', preview_url: false },
    });
  });

  it('arma el objeto interactive de botones', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'buttons', body: '¿En qué te ayudo?',
      buttons: [{ id: 'agendar', title: 'Agendar cita' }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('interactive');
    expect(body.interactive.type).toBe('button');
    expect(body.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'agendar', title: 'Agendar cita' } },
    ]);
  });

  it('cae a texto numerado cuando hay más de 3 botones', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'buttons', body: 'Elige',
      buttons: [1, 2, 3, 4].map((n) => ({ id: `o${n}`, title: `Opción ${n}` })),
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('text');
    expect(body.text.body).toContain('1. Opción 1');
    expect(body.text.body).toContain('4. Opción 4');
  });

  it('trunca los títulos de botón a los 20 caracteres que admite Meta', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'buttons', body: 'x',
      buttons: [{ id: 'a', title: 'Un título larguísimo que no cabe' }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.action.buttons[0].reply.title).toHaveLength(20);
  });

  it('lanza un error legible cuando Meta responde con fallo', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ error: { message: 'Invalid parameter', code: 100 } }),
    });
    await expect(sender.send(channel, '573001112233', { kind: 'text', body: 'x' }))
      .rejects.toThrow(/Invalid parameter/);
  });

  it('nunca incluye el token en el mensaje de error', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: { message: 'bad token' } }),
    });
    // `toThrow` no acepta matchers asimétricos: se captura y se afirma sobre el mensaje.
    const err = await sender.send(channel, '573001112233', { kind: 'text', body: 'x' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('TOKEN');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/whatsapp/sender`
Expected: FAIL — no existe `MetaSender`.

- [ ] **Step 3: Implementar**

`apps/api/src/whatsapp/sender.ts`:
```ts
import type { OutboundContent } from '@citara/shared';
import type { ResolvedChannel } from '../tenancy/channel-resolver.service';

const BUTTON_TITLE_MAX = 20;  // límite duro de Meta
const MAX_BUTTONS = 3;        // más de 3 no caben en un interactive de tipo button

/**
 * Traduce nuestro contrato de salida al formato de Meta y lo envía.
 * Este es el ÚNICO lugar del sistema que conoce el formato de Meta al salir.
 */
export class MetaSender {
  // El phone_number_id NO va aquí: es propiedad del canal, y una instancia
  // compartida atiende a todos los tenants.
  constructor(private readonly graphVersion: string) {}

  async send(
    channel: ResolvedChannel,
    to: string,
    content: OutboundContent,
  ): Promise<{ wamid: string }> {
    const body = this.buildBody(to, content);

    const res = await fetch(
      `https://graph.facebook.com/${this.graphVersion}/${channel.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    const json = await res.json();
    if (!res.ok) {
      // El token jamás entra al mensaje de error: estos textos van a logs.
      throw new Error(
        `Meta rechazó el envío (${res.status}): ${json?.error?.message ?? 'sin detalle'}`,
      );
    }
    return { wamid: json.messages[0].id };
  }

  private buildBody(to: string, content: OutboundContent): Record<string, unknown> {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };

    if (content.kind === 'text') {
      return { ...base, type: 'text', text: { body: content.body, preview_url: false } };
    }

    if (content.kind === 'buttons') {
      if (content.buttons.length > MAX_BUTTONS) {
        // Degradación: texto numerado. El normalizer del inbound recibirá el
        // número como texto y el motor lo resolverá por posición.
        const lines = content.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
        return { ...base, type: 'text',
                 text: { body: `${content.body}\n\n${lines}`, preview_url: false } };
      }
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: content.body },
          action: {
            buttons: content.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, BUTTON_TITLE_MAX) },
            })),
          },
        },
      };
    }

    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: content.body },
        action: { button: content.button.slice(0, BUTTON_TITLE_MAX), sections: content.sections },
      },
    };
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/whatsapp/sender`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(whatsapp): enviar mensajes de texto e interactivos a la cloud api de meta"
```

---

### Task 11: Motor de flujos — pasos `message` y `end`

**Files:**
- Create: `packages/shared/src/flow.ts`, `apps/api/src/flow-engine/executor.ts`
- Create: migración `1725300700000-CreateFlows.ts`, `1725300800000-CreateConversationSessions.ts`
- Test: `apps/api/test/flow-engine/executor.test.ts`

**Interfaces:**
- Consumes: nada (el ejecutor es puro).
- Produces:
```ts
type FlowStep =
  | { type: 'message'; text: string; next: string }
  | { type: 'choice'; text: string; kind?: 'interactive_buttons' | 'interactive_list';
      buttons: { id: string; title: string; next: string }[]; ai_fallback?: boolean }
  | { type: 'capture'; text: string; var: string; validate?: 'text' | 'number' | 'email';
      next: string; on_invalid?: string }
  | { type: 'handoff'; text: string }
  | { type: 'end'; text?: string };

type FlowDefinition = { key: string; entry: string; steps: Record<string, FlowStep> };
type SessionState   = { stepKey: string; vars: Record<string, string>; status: 'active'|'handoff'|'ended' };
type ExecResult     = { state: SessionState; outbound: OutboundContent[] };

advance(flow: FlowDefinition, state: SessionState | null, input: string | null): ExecResult
```

**El ejecutor es una función pura:** no envía, no persiste, no consulta. Recibe estado
e input, devuelve estado nuevo y mensajes a emitir. Esto es lo que hace testeable el
motor completo sin red ni base de datos.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/flow-engine/executor.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'demo',
  entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Soy el asistente.', next: 'despedida' },
    despedida: { type: 'end', text: 'Hasta luego.' },
  },
};

describe('advance — message y end', () => {
  it('sin estado previo arranca en el paso de entrada y emite su mensaje', () => {
    const res = advance(flow, null, null);
    // El primer mensaje es el del paso de entrada. Que haya más se comprueba
    // en el test siguiente: message encadena con el paso que le sigue.
    expect(res.outbound[0]).toEqual({ kind: 'text', body: '¡Hola! Soy el asistente.' });
  });

  it('encadena message → end en un solo turno, emitiendo ambos textos', () => {
    const res = advance(flow, null, null);
    expect(res.outbound).toHaveLength(2);
    expect(res.outbound[1]).toEqual({ kind: 'text', body: 'Hasta luego.' });
    expect(res.state.status).toBe('ended');
  });

  it('un end sin texto no emite mensaje pero sí cierra la sesión', () => {
    const silencioso: FlowDefinition = {
      key: 'x', entry: 'fin', steps: { fin: { type: 'end' } },
    };
    const res = advance(silencioso, null, null);
    expect(res.outbound).toEqual([]);
    expect(res.state.status).toBe('ended');
  });

  it('conserva las variables de la sesión al avanzar', () => {
    const state = { stepKey: 'saludo', vars: { nombre: 'Ana' }, status: 'active' as const };
    const res = advance(flow, state, 'lo que sea');
    expect(res.state.vars).toEqual({ nombre: 'Ana' });
  });

  it('interpola variables en el texto del mensaje', () => {
    const saludo: FlowDefinition = {
      key: 'x', entry: 'hola',
      steps: { hola: { type: 'message', text: 'Hola {{nombre}}', next: 'f' },
               f: { type: 'end' } },
    };
    const state = { stepKey: 'hola', vars: { nombre: 'Ana' }, status: 'active' as const };
    const res = advance(saludo, state, null);
    expect(res.outbound[0]).toEqual({ kind: 'text', body: 'Hola Ana' });
  });

  it('deja el placeholder intacto si la variable no existe', () => {
    const saludo: FlowDefinition = {
      key: 'x', entry: 'hola',
      steps: { hola: { type: 'message', text: 'Hola {{nombre}}', next: 'f' },
               f: { type: 'end' } },
    };
    const res = advance(saludo, { stepKey: 'hola', vars: {}, status: 'active' }, null);
    expect(res.outbound[0]).toEqual({ kind: 'text', body: 'Hola {{nombre}}' });
  });

  it('corta un ciclo infinito de mensajes encadenados', () => {
    const ciclo: FlowDefinition = {
      key: 'x', entry: 'a',
      steps: { a: { type: 'message', text: 'A', next: 'b' },
               b: { type: 'message', text: 'B', next: 'a' } },
    };
    expect(() => advance(ciclo, null, null)).toThrow(/ciclo/i);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/flow-engine`
Expected: FAIL — no existe `advance`.

- [ ] **Step 3: Implementar**

`apps/api/src/flow-engine/executor.ts`:
```ts
import type {
  FlowDefinition, FlowStep, SessionState, OutboundContent,
} from '@citara/shared';

const MAX_CHAIN = 20; // pasos encadenados sin input antes de declarar ciclo

export interface ExecResult {
  state: SessionState;
  outbound: OutboundContent[];
}

/** Interpola {{var}} con las variables de sesión; deja intacto lo no resuelto. */
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}

/**
 * Avanza la conversación un turno. Función PURA: no envía, no persiste, no consulta.
 */
export function advance(
  flow: FlowDefinition,
  state: SessionState | null,
  _input: string | null,
): ExecResult {
  let current: SessionState = state ?? { stepKey: flow.entry, vars: {}, status: 'active' };
  const outbound: OutboundContent[] = [];

  for (let hops = 0; ; hops++) {
    if (hops >= MAX_CHAIN) {
      throw new Error(`Ciclo detectado en el flujo '${flow.key}' tras ${MAX_CHAIN} pasos`);
    }

    const step: FlowStep | undefined = flow.steps[current.stepKey];
    if (!step) throw new Error(`Paso inexistente: '${current.stepKey}' en flujo '${flow.key}'`);

    if (step.type === 'message') {
      outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
      current = { ...current, stepKey: step.next };
      continue; // encadena sin esperar input
    }

    if (step.type === 'end') {
      if (step.text) outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
      return { state: { ...current, status: 'ended' }, outbound };
    }

    // Los demás tipos se implementan en las tareas 12 y 13.
    return { state: current, outbound };
  }
}
```

Migraciones `1725300700000-CreateFlows.ts` y `1725300800000-CreateConversationSessions.ts`:
```ts
// CreateFlows
await q.query(`
  CREATE TABLE flows (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key        varchar(64) NOT NULL,
    version    varchar(32) NOT NULL,
    definition jsonb NOT NULL,
    triggers   jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_default boolean NOT NULL DEFAULT false,
    is_active  boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key, version)
  )
`);
await q.query(`
  CREATE UNIQUE INDEX flows_one_default ON flows (tenant_id)
    WHERE is_default AND is_active
`);
for (const sql of tenantRlsSql('flows')) await q.query(sql);

// CreateConversationSessions
await q.query(`
  CREATE TABLE conversation_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    flow_id         uuid NOT NULL REFERENCES flows(id),
    step_key        varchar(64) NOT NULL,
    vars            jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          varchar(32) NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
  )
`);
// Una sola sesión activa por conversación: evita el rebote entre sesiones
// duplicadas creadas por mensajes concurrentes.
await q.query(`
  CREATE UNIQUE INDEX sessions_one_active ON conversation_sessions (conversation_id)
    WHERE status = 'active'
`);
for (const sql of tenantRlsSql('conversation_sessions')) await q.query(sql);
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/flow-engine`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(flow-engine): ejecutar pasos de mensaje y cierre con interpolación de variables"
```

---

### Task 12: Motor de flujos — paso `choice`

**Files:**
- Modify: `apps/api/src/flow-engine/executor.ts`
- Test: `apps/api/test/flow-engine/choice.test.ts`

**Interfaces:**
- Consumes: `advance`, `interpolate` (Task 11).
- Produces: `advance` maneja `choice`. Ramifica por id de botón, por título exacto sin distinguir mayúsculas, o por posición numérica (para la degradación a texto de la Task 10).

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/flow-engine/choice.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'menu', entry: 'menu',
  steps: {
    menu: {
      type: 'choice',
      kind: 'interactive_buttons',
      text: '¿En qué te ayudo?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita', next: 'ok_agendar' },
        { id: 'citas',   title: 'Mis citas',    next: 'ok_citas' },
      ],
    },
    ok_agendar: { type: 'end', text: 'Vamos a agendar.' },
    ok_citas:   { type: 'end', text: 'Estas son tus citas.' },
  },
};

const inMenu = { stepKey: 'menu', vars: {}, status: 'active' as const };

describe('advance — choice', () => {
  it('al llegar al paso emite el menú como botones interactivos', () => {
    const res = advance(flow, null, null);
    expect(res.outbound).toEqual([{
      kind: 'buttons', body: '¿En qué te ayudo?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita' },
        { id: 'citas',   title: 'Mis citas' },
      ],
    }]);
    expect(res.state.stepKey).toBe('menu');
    expect(res.state.status).toBe('active');
  });

  it('ramifica por el id del botón', () => {
    const res = advance(flow, inMenu, 'agendar');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Vamos a agendar.' }]);
    expect(res.state.status).toBe('ended');
  });

  it('ramifica por el título exacto, ignorando mayúsculas y espacios', () => {
    const res = advance(flow, inMenu, '  MIS CITAS  ');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Estas son tus citas.' }]);
  });

  it('ramifica por posición numérica (degradación a texto numerado)', () => {
    const res = advance(flow, inMenu, '2');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Estas son tus citas.' }]);
  });

  it('ante una entrada que no coincide, repite el menú sin avanzar', () => {
    const res = advance(flow, inMenu, 'quiero un helado');
    expect(res.state.stepKey).toBe('menu');
    expect(res.state.status).toBe('active');
    expect(res.outbound[0].kind).toBe('buttons');
  });

  it('un número fuera de rango no avanza', () => {
    const res = advance(flow, inMenu, '9');
    expect(res.state.stepKey).toBe('menu');
  });

  it('emite lista interactiva cuando kind es interactive_list', () => {
    const lista: FlowDefinition = {
      key: 'l', entry: 'sel',
      steps: {
        sel: {
          type: 'choice', kind: 'interactive_list', text: 'Elige servicio',
          buttons: [{ id: 'corte', title: 'Corte', next: 'f' }],
        },
        f: { type: 'end' },
      },
    };
    const res = advance(lista, null, null);
    expect(res.outbound[0]).toMatchObject({
      kind: 'list', body: 'Elige servicio',
      sections: [{ title: 'Opciones', rows: [{ id: 'corte', title: 'Corte' }] }],
    });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/flow-engine/choice`
Expected: FAIL — `choice` cae al `return` genérico y no emite nada.

- [ ] **Step 3: Implementar**

En `apps/api/src/flow-engine/executor.ts`, reemplazar el `return` genérico por el
manejo de `choice`, e insertarlo antes:

```ts
const norm = (s: string) => s.trim().toLowerCase();

/** Resuelve la entrada del usuario contra las opciones: id, título o posición. */
function matchChoice(
  buttons: { id: string; title: string; next: string }[],
  input: string,
): string | null {
  const value = norm(input);

  const byId = buttons.find((b) => norm(b.id) === value);
  if (byId) return byId.next;

  const byTitle = buttons.find((b) => norm(b.title) === value);
  if (byTitle) return byTitle.next;

  // Posición numérica: la degradación a texto numerado de MetaSender.
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    if (index >= 0 && index < buttons.length) return buttons[index].next;
  }

  return null;
}

function renderChoice(
  step: Extract<FlowStep, { type: 'choice' }>,
  vars: Record<string, string>,
): OutboundContent {
  const body = interpolate(step.text, vars);

  if (step.kind === 'interactive_list') {
    return {
      kind: 'list', body, button: 'Ver opciones',
      sections: [{
        title: 'Opciones',
        rows: step.buttons.map((b) => ({ id: b.id, title: b.title })),
      }],
    };
  }

  return { kind: 'buttons', body, buttons: step.buttons.map((b) => ({ id: b.id, title: b.title })) };
}
```

Y dentro del bucle de `advance`, antes del `return` genérico:

```ts
if (step.type === 'choice') {
  // Sin input: es la primera vez que se llega al paso. Emitir el menú y esperar.
  if (_input === null) {
    outbound.push(renderChoice(step, current.vars));
    return { state: current, outbound };
  }

  const next = matchChoice(step.buttons, _input);
  if (next === null) {
    // No coincide: repetir el menú sin avanzar.
    // (En la Fase 4, ai_fallback interceptará justo aquí.)
    outbound.push(renderChoice(step, current.vars));
    return { state: current, outbound };
  }

  current = { ...current, stepKey: next };
  _input = null; // el input ya se consumió; los siguientes pasos encadenan
  continue;
}
```

> Nota para el implementador: `_input` deja de ser solo-lectura, así que renómbralo
> a `input` (sin guion bajo) en la firma y declara `let input = _input`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/flow-engine`
Expected: PASS, 14 tests (7 de Task 11 + 7 de esta).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(flow-engine): ramificar por botones resolviendo id, título y posición"
```

---

### Task 13: Motor de flujos — paso `capture`

**Files:**
- Modify: `apps/api/src/flow-engine/executor.ts`
- Create: `apps/api/src/flow-engine/validators.ts`
- Test: `apps/api/test/flow-engine/capture.test.ts`

**Interfaces:**
- Consumes: `advance` (Tasks 11-12).
- Produces: `advance` maneja `capture`; `validateInput(kind, value): { ok: true; value: string } | { ok: false; reason: string }`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/flow-engine/capture.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import { validateInput } from '../../src/flow-engine/validators';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'reg', entry: 'pide_nombre',
  steps: {
    pide_nombre: {
      type: 'capture', text: '¿Cuál es tu nombre?', var: 'nombre',
      validate: 'text', next: 'saluda', on_invalid: 'nombre_invalido',
    },
    saluda: { type: 'end', text: 'Gracias, {{nombre}}.' },
    nombre_invalido: { type: 'end', text: 'Nombre no válido.' },
  },
};

const enPaso = { stepKey: 'pide_nombre', vars: {}, status: 'active' as const };

describe('validateInput', () => {
  it('acepta texto no vacío', () => {
    expect(validateInput('text', 'Ana')).toEqual({ ok: true, value: 'Ana' });
  });
  it('rechaza texto vacío o solo espacios', () => {
    expect(validateInput('text', '   ').ok).toBe(false);
  });
  it('acepta un número y lo normaliza sin espacios', () => {
    expect(validateInput('number', ' 42 ')).toEqual({ ok: true, value: '42' });
  });
  it('rechaza un número con letras', () => {
    expect(validateInput('number', '4a2').ok).toBe(false);
  });
  it('acepta un email válido', () => {
    expect(validateInput('email', 'a@b.co')).toEqual({ ok: true, value: 'a@b.co' });
  });
  it('rechaza un email sin dominio', () => {
    expect(validateInput('email', 'a@').ok).toBe(false);
  });
  it('recorta el email a minúsculas', () => {
    expect(validateInput('email', ' A@B.CO ')).toEqual({ ok: true, value: 'a@b.co' });
  });
});

describe('advance — capture', () => {
  it('al llegar al paso pide el dato y espera', () => {
    const res = advance(flow, null, null);
    expect(res.outbound).toEqual([{ kind: 'text', body: '¿Cuál es tu nombre?' }]);
    expect(res.state.stepKey).toBe('pide_nombre');
  });

  it('guarda el valor válido en las variables y avanza', () => {
    const res = advance(flow, enPaso, 'Ana');
    expect(res.state.vars).toEqual({ nombre: 'Ana' });
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Gracias, Ana.' }]);
    expect(res.state.status).toBe('ended');
  });

  it('ante un valor inválido salta a on_invalid', () => {
    const res = advance(flow, enPaso, '   ');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Nombre no válido.' }]);
  });

  it('sin on_invalid, repite la pregunta sin avanzar', () => {
    const sinSalida: FlowDefinition = {
      key: 'x', entry: 'p',
      steps: { p: { type: 'capture', text: 'Dato?', var: 'd', validate: 'number', next: 'f' },
               f: { type: 'end' } },
    };
    const res = advance(sinSalida, { stepKey: 'p', vars: {}, status: 'active' }, 'abc');
    expect(res.state.stepKey).toBe('p');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Dato?' }]);
  });

  it('no pisa variables previas al capturar una nueva', () => {
    const res = advance(flow, { stepKey: 'pide_nombre', vars: { previa: 'x' }, status: 'active' }, 'Ana');
    expect(res.state.vars).toEqual({ previa: 'x', nombre: 'Ana' });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/flow-engine/capture`
Expected: FAIL — no existe `validateInput`.

- [ ] **Step 3: Implementar**

`apps/api/src/flow-engine/validators.ts`:
```ts
export type ValidatorKind = 'text' | 'number' | 'email';
export type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateInput(kind: ValidatorKind, raw: string): ValidationResult {
  const value = raw.trim();

  switch (kind) {
    case 'text':
      return value.length > 0
        ? { ok: true, value }
        : { ok: false, reason: 'vacío' };

    case 'number':
      return /^\d+$/.test(value)
        ? { ok: true, value }
        : { ok: false, reason: 'no es un número' };

    case 'email': {
      const lower = value.toLowerCase();
      return EMAIL.test(lower)
        ? { ok: true, value: lower }
        : { ok: false, reason: 'email inválido' };
    }
  }
}
```

En `advance`, dentro del bucle:

```ts
if (step.type === 'capture') {
  if (input === null) {
    outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
    return { state: current, outbound };
  }

  const result = validateInput(step.validate ?? 'text', input);

  if (!result.ok) {
    if (step.on_invalid) {
      current = { ...current, stepKey: step.on_invalid };
      input = null;
      continue;
    }
    // Sin salida definida: repetir la pregunta.
    outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
    return { state: current, outbound };
  }

  current = {
    ...current,
    vars: { ...current.vars, [step.var]: result.value },
    stepKey: step.next,
  };
  input = null;
  continue;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/flow-engine`
Expected: PASS, 26 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(flow-engine): capturar datos del usuario con validación y ruta de invalidez"
```

---

### Task 14: `handoff` y guardia de la ventana de 24 horas

**Files:**
- Modify: `apps/api/src/flow-engine/executor.ts`
- Create: `apps/api/src/conversations/session-window.ts`
- Test: `apps/api/test/flow-engine/handoff.test.ts`, `apps/api/test/conversations/session-window.test.ts`

**Interfaces:**
- Consumes: `advance`.
- Produces: `advance` maneja `handoff` (status `'handoff'`, deja de responder);
  `canSendFreeform(lastInboundAt: Date | null, now: Date): boolean`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/conversations/session-window.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { canSendFreeform } from '../../src/conversations/session-window';

const now = new Date('2026-09-03T15:00:00Z');

describe('canSendFreeform', () => {
  it('permite texto libre dentro de las 24 horas', () => {
    expect(canSendFreeform(new Date('2026-09-03T14:00:00Z'), now)).toBe(true);
  });

  it('permite justo antes del límite (23h 59m)', () => {
    expect(canSendFreeform(new Date('2026-09-02T15:01:00Z'), now)).toBe(true);
  });

  it('bloquea exactamente a las 24 horas', () => {
    expect(canSendFreeform(new Date('2026-09-02T15:00:00Z'), now)).toBe(false);
  });

  it('bloquea pasadas las 24 horas', () => {
    expect(canSendFreeform(new Date('2026-09-01T15:00:00Z'), now)).toBe(false);
  });

  it('bloquea si nunca hubo mensaje entrante', () => {
    expect(canSendFreeform(null, now)).toBe(false);
  });
});
```

`apps/api/test/flow-engine/handoff.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'h', entry: 'menu',
  steps: {
    menu: {
      type: 'choice', text: '¿Sí?',
      buttons: [{ id: 'asesor', title: 'Hablar con alguien', next: 'humano' }],
    },
    humano: { type: 'handoff', text: 'Te comunico con un asesor. Un momento.' },
  },
};

describe('advance — handoff', () => {
  it('emite el mensaje de traspaso y marca la sesión en handoff', () => {
    const res = advance(flow, { stepKey: 'menu', vars: {}, status: 'active' }, 'asesor');
    expect(res.outbound).toEqual([
      { kind: 'text', body: 'Te comunico con un asesor. Un momento.' },
    ]);
    expect(res.state.status).toBe('handoff');
  });

  it('una sesión en handoff no produce más respuestas automáticas', () => {
    const res = advance(flow, { stepKey: 'humano', vars: {}, status: 'handoff' }, 'hola?');
    expect(res.outbound).toEqual([]);
    expect(res.state.status).toBe('handoff');
  });
});
```

> El segundo test es la protección contra el bot que sigue contestando encima del
> agente humano: una vez traspasada, la conversación es del humano hasta que él la
> devuelva.

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm vitest run apps/api/test/conversations apps/api/test/flow-engine/handoff`
Expected: FAIL — no existe `canSendFreeform`; handoff no marca estado.

- [ ] **Step 3: Implementar**

`apps/api/src/conversations/session-window.ts`:
```ts
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * La ventana de atención al cliente de WhatsApp: fuera de las 24 h desde el
 * último mensaje ENTRANTE solo se puede escribir con plantilla aprobada.
 * Se verifica ANTES de cada envío, no después de que Meta rechace.
 */
export function canSendFreeform(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}
```

En `advance`, al inicio de la función, antes del bucle:

```ts
// Una conversación en manos de un humano no recibe respuestas del bot.
if (current.status === 'handoff') {
  return { state: current, outbound: [] };
}
```

Y dentro del bucle:

```ts
if (step.type === 'handoff') {
  if (step.text) outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
  return { state: { ...current, status: 'handoff' }, outbound };
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm vitest run apps/api/test`
Expected: PASS, todos.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(flow-engine): traspasar a humano y bloquear texto libre fuera de la ventana de 24h"
```

---

### Task 15: Arnés de conversación y cableado de punta a punta

Esta tarea une todo y entrega el **arnés de pruebas conversacionales** que las fases
siguientes van a reutilizar: se le alimenta una lista de mensajes de usuario y afirma
sobre las respuestas y el estado final de la base. Sin red, sin WhatsApp.

**Files:**
- Create: `apps/api/src/flow-engine/flow-runner.service.ts`
- Create: `apps/api/test/harness/conversation-harness.ts`
- Test: `apps/api/test/harness/agendamiento.e2e.test.ts`

**Interfaces:**
- Consumes: `advance`, `InboundProcessor`, `MetaSender`, `runInTenant`, `canSendFreeform`.
- Produces: `FlowRunner.handle(job: InboundJob): Promise<OutboundContent[]>` — carga flujo y sesión, ejecuta `advance`, persiste el estado nuevo y encola los mensajes de salida. Y `ConversationHarness` con `.say(text): Promise<OutboundContent[]>` y `.tap(id): Promise<OutboundContent[]>`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/harness/agendamiento.e2e.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { ConversationHarness } from './conversation-harness';
import { resetDb, seedChannel, seedFlow } from '../helpers';

const flow = {
  key: 'demo', entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Soy el asistente de Salón X 👋', next: 'menu' },
    menu: {
      type: 'choice', kind: 'interactive_buttons', text: '¿En qué te ayudo?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita', next: 'pide_nombre' },
        { id: 'asesor',  title: 'Hablar con alguien', next: 'humano' },
      ],
    },
    pide_nombre: { type: 'capture', text: '¿A nombre de quién?', var: 'nombre',
                   validate: 'text', next: 'listo' },
    listo: { type: 'end', text: 'Perfecto, {{nombre}}. Te contactamos pronto.' },
    humano: { type: 'handoff', text: 'Te comunico con alguien del equipo.' },
  },
};

let h: ConversationHarness;

beforeEach(async () => {
  await resetDb();
  const { tenantId, channelId } = await seedChannel();
  await seedFlow(tenantId, flow);
  h = await ConversationHarness.create({ tenantId, channelId, from: '573001112233' });
});

afterAll(async () => { await ConversationHarness.teardown(); });

describe('conversación de agendamiento (E2E del motor)', () => {
  it('recorre saludo → menú → captura → cierre', async () => {
    const primero = await h.say('Hola');
    expect(primero[0]).toEqual({ kind: 'text', body: '¡Hola! Soy el asistente de Salón X 👋' });
    expect(primero[1].kind).toBe('buttons');

    const traspulsar = await h.tap('agendar');
    expect(traspulsar).toEqual([{ kind: 'text', body: '¿A nombre de quién?' }]);

    const final = await h.say('Ana');
    expect(final).toEqual([
      { kind: 'text', body: 'Perfecto, Ana. Te contactamos pronto.' },
    ]);

    expect(await h.sessionStatus()).toBe('ended');
    // 3 entrantes + 4 salientes: el primer turno emite DOS (saludo y menú),
    // porque `message` encadena con el paso siguiente sin esperar input.
    expect(await h.messageCount()).toBe(7);
  });

  it('el traspaso a humano silencia al bot', async () => {
    await h.say('Hola');
    const salida = await h.tap('asesor');
    expect(salida).toEqual([{ kind: 'text', body: 'Te comunico con alguien del equipo.' }]);

    const despues = await h.say('¿Hay alguien ahí?');
    expect(despues).toEqual([]);
    expect(await h.sessionStatus()).toBe('handoff');
  });

  it('una entrada no reconocida repite el menú sin romper la sesión', async () => {
    await h.say('Hola');
    const salida = await h.say('quiero un helado');
    expect(salida[0].kind).toBe('buttons');
    expect(await h.sessionStatus()).toBe('active');
  });

  it('el mismo wamid reenviado no produce respuesta duplicada', async () => {
    await h.say('Hola');
    const repetido = await h.replayLast();
    expect(repetido).toEqual([]);
  });

  it('persiste las variables de la sesión entre turnos', async () => {
    await h.say('Hola');
    await h.tap('agendar');
    await h.say('Ana');
    expect(await h.sessionVars()).toEqual({ nombre: 'Ana' });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/harness`
Expected: FAIL — no existe `ConversationHarness`.

- [ ] **Step 3: Implementar**

`apps/api/src/flow-engine/flow-runner.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { OutboundContent, FlowDefinition, SessionState } from '@citara/shared';
import { advance } from './executor';
import { runInTenant } from '../tenancy/tenant-context';
import { InboundProcessor } from '../queues/inbound.processor';
import type { InboundJob } from '../queues/inbound.queue';

@Injectable()
export class FlowRunner {
  constructor(
    private readonly ds: DataSource,
    private readonly inbound: InboundProcessor,
  ) {}

  async handle(job: InboundJob): Promise<OutboundContent[]> {
    const { conversationId, messageId } = await this.inbound.process(job);

    // messageId vacío = wamid duplicado, ya procesado. No responder de nuevo.
    if (!messageId) return [];

    return runInTenant(this.ds, job.tenantId, async (m) => {
      const [flowRow] = await m.query(
        `SELECT id, definition FROM flows
          WHERE is_active AND is_default LIMIT 1`,
      );
      if (!flowRow) return [];
      const flow = flowRow.definition as FlowDefinition;

      const [sessionRow] = await m.query(
        `SELECT id, step_key, vars, status FROM conversation_sessions
          WHERE conversation_id = $1 AND status = 'active'
          ORDER BY id DESC LIMIT 1`,
        [conversationId],
      );

      const state: SessionState | null = sessionRow
        ? { stepKey: sessionRow.step_key, vars: sessionRow.vars, status: sessionRow.status }
        : null;

      // Sesión nueva → sin input, para que el flujo emita su paso de entrada.
      const input = state ? job.message.text : null;
      const result = advance(flow, state, input);

      if (sessionRow) {
        await m.query(
          `UPDATE conversation_sessions
              SET step_key = $1, vars = $2, status = $3, updated_at = now()
            WHERE id = $4`,
          [result.state.stepKey, JSON.stringify(result.state.vars), result.state.status, sessionRow.id],
        );
      } else {
        await m.query(
          `INSERT INTO conversation_sessions
             (tenant_id, conversation_id, flow_id, step_key, vars, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [job.tenantId, conversationId, flowRow.id, result.state.stepKey,
           JSON.stringify(result.state.vars), result.state.status],
        );
      }

      for (const [i, content] of result.outbound.entries()) {
        await m.query(
          `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, payload)
           VALUES ($1, $2, 'out', $3, $4, $5)`,
          [job.tenantId, conversationId, content.kind,
           'body' in content ? content.body : null, JSON.stringify({ ...content, seq: i })],
        );
      }

      return result.outbound;
    });
  }
}
```

`apps/api/test/harness/conversation-harness.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { FlowRunner } from '../../src/flow-engine/flow-runner.service';
import { InboundProcessor } from '../../src/queues/inbound.processor';
import { runInTenant } from '../../src/tenancy/tenant-context';
import type { InboundMessage, OutboundContent } from '@citara/shared';

let ds: DataSource | null = null;

/**
 * Arnés de conversación: alimenta mensajes de usuario al motor y devuelve lo
 * que el bot habría enviado. Sin red, sin WhatsApp, sin colas.
 * Reutilizable por todas las fases siguientes.
 */
export class ConversationHarness {
  private lastWamid = '';

  private constructor(
    private readonly runner: FlowRunner,
    private readonly ctx: { tenantId: string; channelId: string; from: string },
  ) {}

  static async create(ctx: { tenantId: string; channelId: string; from: string }) {
    if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
    return new ConversationHarness(new FlowRunner(ds, new InboundProcessor(ds)), ctx);
  }

  static async teardown() { await ds?.destroy(); ds = null; }

  /** Simula que el usuario escribe texto. */
  say(text: string): Promise<OutboundContent[]> {
    return this.deliver(this.message({ type: 'text', text }));
  }

  /** Simula que el usuario pulsa un botón (Meta entrega el id, no el título). */
  tap(buttonId: string): Promise<OutboundContent[]> {
    return this.deliver(this.message({ type: 'interactive', text: buttonId }));
  }

  /** Reenvía el último mensaje con el mismo wamid, como haría un reintento de Meta. */
  replayLast(): Promise<OutboundContent[]> {
    return this.runner.handle({
      tenantId: this.ctx.tenantId, channelId: this.ctx.channelId,
      message: this.message({ type: 'text', text: 'repetido', wamid: this.lastWamid }),
    });
  }

  async sessionStatus(): Promise<string | null> {
    const [row] = await runInTenant(ds!, this.ctx.tenantId, (m) =>
      m.query(`SELECT status FROM conversation_sessions ORDER BY id DESC LIMIT 1`));
    return row?.status ?? null;
  }

  async sessionVars(): Promise<Record<string, string>> {
    const [row] = await runInTenant(ds!, this.ctx.tenantId, (m) =>
      m.query(`SELECT vars FROM conversation_sessions ORDER BY id DESC LIMIT 1`));
    return row?.vars ?? {};
  }

  async messageCount(): Promise<number> {
    const [row] = await runInTenant(ds!, this.ctx.tenantId, (m) =>
      m.query(`SELECT count(*)::int AS n FROM messages`));
    return row.n;
  }

  private message(over: Partial<InboundMessage> & { type: InboundMessage['type'] }): InboundMessage {
    const wamid = over.wamid ?? `wamid.${randomUUID()}`;
    this.lastWamid = wamid;
    return {
      wamid, phoneNumberId: '106540', wabaId: '102290',
      from: this.ctx.from, profileName: 'Ana',
      text: null, mediaId: null, timestamp: new Date(), raw: {}, ...over, type: over.type,
    };
  }

  private deliver(message: InboundMessage) {
    return this.runner.handle({
      tenantId: this.ctx.tenantId, channelId: this.ctx.channelId, message,
    });
  }
}
```

Los helpers `resetDb()`, `seedChannel()` y `seedFlow()` ya existen desde la Task 8;
esta tarea solo los consume.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run`
Expected: PASS, toda la suite de la fase.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(flow-engine): cablear el motor de punta a punta con arnés de pruebas conversacionales"
```

---

## Criterios de salida de la Fase 1

La fase está terminada cuando:

- [ ] `pnpm test` pasa en verde, con la prueba de aislamiento por RLS incluida.
- [ ] `pnpm typecheck` no reporta errores.
- [ ] Un mensaje real desde WhatsApp llega al webhook, se encola, lo procesa el worker
      y el usuario recibe la respuesta del flujo.
- [ ] El proceso `api` y el proceso `worker` corren por separado y el segundo puede
      reiniciarse sin afectar la recepción de webhooks.
- [ ] Enviar el mismo `wamid` dos veces produce exactamente una respuesta.
- [ ] Un `phone_number_id` no registrado se responde con `200` y se descarta, sin
      enviar nada con credenciales de otro tenant.

## Lo que esta fase deliberadamente NO hace

Sin IA, sin Google Calendar, sin agenda, sin panel. El paso `ai_turn` no existe todavía;
`ai_fallback` se lee del JSON pero se ignora. Eso llega en la Fase 4, sobre las
herramientas que construye la Fase 2.
