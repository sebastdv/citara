# Fase 2 — Agenda: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revisión 2026-10-06.** Reescrito sobre el código real de las fases 1 y 1.5 y el spec v2. La
> versión del 2026-09-03 sigue en el historial de git; no se ejecuta. Qué cambió y por qué:
> los servicios de agenda trabajan con el `EntityManager` del turno (antes abrían
> transacciones propias, que con el lock de la conversación colgaban el worker); la reserva
> va dentro de un `SAVEPOINT`; reprogramar es atómico; "cualquier recurso" calcula por
> recurso; el cálculo de franjas respeta el rango pedido (la versión anterior rechazaba
> reservas válidas en Bogotá); hay horizonte máximo; las herramientas son una clase
> inyectable; los tokens de confirmación van ligados a la herramienta; los recordatorios
> salen por el outbox con `origin='reminder'`; y `tenant:apply` llega a esta fase.

**Goal:** Un negocio con servicios, recursos y horarios cargados por `tenant:apply` recibe citas reales por WhatsApp usando menús deterministas —sin IA y sin Google Calendar—, nunca con dos citas en la misma franja del mismo recurso, y sus clientes reciben recordatorios por plantilla.

**Architecture:** `appointments` es la fuente de verdad, protegida por una restricción de exclusión de PostgreSQL. El cálculo de franjas es una función pura en la zona horaria del negocio. Los servicios de agenda no tienen estado y reciben el `EntityManager` de quien los llama: dentro de un turno corren en la transacción del turno (con la conversación bloqueada y RLS fijado). El motor gana dos pasos, `tool` (invoca una herramienta del `ToolRegistry`) y `pick` (elige de una lista por número). Los recordatorios los barre un job cada minuto, que los deja como mensajes plantilla `pending` (outbox) y los encola uno por uno.

**Tech Stack:** lo de las fases 1 y 1.5, más Luxon 3 (zonas horarias), Zod 3 (argumentos de herramientas y configuración) y `yaml` (configuración de negocios).

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md` (v2) — §4.1-4.2 agenda, §5.4 reglas de herramientas (R1-R4), §6 control, §7.1 outbox, §8.5 `tenant:apply`, §10 roadmap.

**Depende de:** fases 1 y 1.5 en `main`.

## Global Constraints

- Todo lo de las fases 1 y 1.5 sigue vigente: RLS `ENABLE`+`FORCE` en toda tabla con `tenant_id`, `TZ=UTC`, webhook con `200` en menos de 100 ms, regla de control antes de responder, outbox de salida.
- **Toda aritmética de fechas de calendario usa Luxon en la zona del negocio** (`tenants.timezone`). Se avanzan días de calendario, nunca 24 h en milisegundos. Los instantes se guardan en `timestamptz`.
- **Las herramientas validan sus propios argumentos** (R1): horario, ausencias, duración real, buffer, anticipación mínima y horizonte máximo. No se asume que el llamador respetó nada.
- **Fechas de entrada en ISO-8601 con offset** (R2): una fecha sin zona se rechaza.
- **`tenant_id` y `contact_id` nunca son argumentos de una herramienta** (R3): los inyecta el runtime. La propiedad de una cita se verifica en SQL.
- **Lo destructivo se confirma en dos tiempos** (R4): cancelar y reprogramar devuelven primero un token; solo la segunda llamada aplica.
- **Una cita confirmada nunca se solapa con otra del mismo recurso.** Lo garantiza la base de datos. El buffer se garantiza al ofrecer y al validar; bajo una carrera, dos citas pegadas dentro del buffer son posibles (nunca superpuestas).
- **Servicios de agenda sin estado:** reciben `m: EntityManager`, nunca abren `runInTenant` propio cuando corren dentro de un turno.
- **Migraciones:** `import type { MigrationInterface, QueryRunner } from 'typeorm'` y `import { tenantRlsSql } from '../rls.ts'`. Una por tabla.
- **Servicios Nest:** parámetros del constructor importados como valor, nunca `import type`. Todo provider nuevo se registra en `apps/api/src/app.module.ts` en la tarea que lo crea.
- **Toda tabla nueva se declara en `PRESUPUESTO`** de `packages/db/test/rls-inventory.test.ts`. Jamás se debilita el guardia.
- **TypeORM con `UPDATE`/`DELETE` devuelve `[filas, conteo]`**, también con `RETURNING`: `const [rows] = (await m.query(...)) as [Row[], number]`.
- **Tests:** `pnpm test <ruta>` (usa `citara_test` y Redis db 1). Helpers existentes en `apps/api/test/helpers.ts`: `resetDb`, `seedChannel` (tenant `salon`, zona `America/Bogota`, canal `106540`), `seedFlow`, `adminQuery`, `createTestApp`, `closeHelpers`.
- **Commits:** Conventional Commits en español, un solo `-m`, sin cuerpo ni trailer `Co-Authored-By`. `git add` con rutas explícitas, nunca `-A`.

## Review Focus

1. **Una franja que cruza la medianoche UTC** (19:00 en Bogotá = 00:00Z del día siguiente) debe poder reservarse. → Task 5.
2. **Un negocio con dos recursos:** si María está ocupada a las 10:00, la franja de Pedro a las 10:00 debe ofrecerse. → Task 5.
3. **Si el turno falla después de agendar** (un paso posterior del flujo lanza), la cita no debe quedar creada. → Task 7.
4. **Reprogramar una cita** no debe dejar salir el recordatorio de la hora vieja. → Task 9.
5. **`tenant:apply` que quita un servicio con citas futuras** lo desactiva sin borrar las citas. → Task 10.

---

## File Structure

```
packages/db/src/migrations/
├─ 1725400000000-CreateServices.ts
├─ 1725400100000-CreateResources.ts
├─ 1725400200000-CreateResourceServices.ts
├─ 1725400250000-AddBookingSettingsToTenants.ts
├─ 1725400300000-CreateBusinessHours.ts
├─ 1725400400000-CreateTimeOff.ts
├─ 1725400500000-CreateAppointments.ts
├─ 1725400600000-CreateReminders.ts
└─ 1725400700000-AddReminderOriginToMessages.ts
apps/api/src/
├─ clock.ts                          reloj inyectable (solo para decisiones de agenda)
├─ scheduling/
│  ├─ availability.ts                computeSlots — función PURA
│  ├─ availability.service.ts        carga datos, slotsFor, check (veredicto de reserva)
│  ├─ booking.service.ts             book / cancel / reschedule / listForContact / findForContact
│  ├─ reminders.service.ts           scheduleFor / cancelFor / sweep
│  ├─ scheduling.errors.ts           errores de dominio
│  ├─ format.ts                      etiquetas legibles de fecha en la zona del negocio
│  └─ tools/registry.ts              ToolRegistry: las seis herramientas
├─ flow-engine/flows/agenda.ts       AGENDA_FLOW: el flujo de menús que se entrega
├─ conversations/message-type.ts     tipo de `messages` a partir del contenido
├─ queues/reminders.queue.ts         cola `reminders` con su scheduler de un minuto
└─ cli/{tenant-config,tenant-apply}.ts
docs/ejemplos/negocio.yaml           ejemplo de configuración
```

---

## Tareas

### Task 1: Catálogo y reglas de reserva

**Files:**
- Create: migraciones `1725400000000-CreateServices.ts`, `1725400100000-CreateResources.ts`, `1725400200000-CreateResourceServices.ts`, `1725400250000-AddBookingSettingsToTenants.ts`
- Modify: `packages/db/test/rls-inventory.test.ts` (`PRESUPUESTO`)
- Modify: `apps/api/test/helpers.ts` (`resetDb`, `seedCatalog`, `addResource`)
- Test: `apps/api/test/scheduling/catalog.test.ts`

**Interfaces:**
- Produces: tablas `services` (`id, tenant_id, key, name, duration_min, buffer_min, price_cents, active`; `UNIQUE (tenant_id, key)`), `resources` (`id, tenant_id, key, name, active`; `UNIQUE (tenant_id, key)`), `resource_services` (`tenant_id, resource_id, service_id`); columnas `tenants.min_lead_minutes` (60), `horizon_days` (60), `slot_granularity_minutes` (15).
- Produces (helpers): `seedCatalog(tenantId, over?: { durationMin?: number; bufferMin?: number }): Promise<{ serviceId: string; resourceId: string }>` (servicio `corte` "Corte de cabello", recurso `maria` "María"); `addResource(tenantId, key, name, serviceId): Promise<string>`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/catalog.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { resetDb, seedChannel, seedCatalog, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('catálogo de agenda', () => {
  it('enlaza un servicio con el recurso que lo presta', async () => {
    const { serviceId, resourceId } = await seedCatalog(tenantId);

    const rows = await runInTenant(app, tenantId, (m) => m.query(
      `SELECT s.name AS servicio, s.duration_min, r.name AS recurso
         FROM resource_services rs
         JOIN services s ON s.id = rs.service_id
         JOIN resources r ON r.id = rs.resource_id
        WHERE rs.service_id = $1 AND rs.resource_id = $2`, [serviceId, resourceId]));

    expect(rows).toEqual([{ servicio: 'Corte de cabello', duration_min: 30, recurso: 'María' }]);
  });

  it('rechaza una duración de cero o negativa', async () => {
    await expect(adminQuery(
      `INSERT INTO services (tenant_id, key, name, duration_min) VALUES ($1, 'x', 'X', 0)`, [tenantId]))
      .rejects.toThrow(/check/i);
  });

  it('los servicios quedan aislados por negocio', async () => {
    await seedCatalog(tenantId);
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    const rows = await runInTenant(app, otro.id, (m) => m.query(`SELECT * FROM services`));
    expect(rows).toEqual([]);
  });

  it('la clave de un servicio es única dentro del negocio, no entre negocios', async () => {
    await seedCatalog(tenantId);
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    await expect(seedCatalog(otro.id)).resolves.toBeDefined();
    await expect(adminQuery(
      `INSERT INTO services (tenant_id, key, name, duration_min) VALUES ($1, 'corte', 'Otro', 20)`,
      [tenantId])).rejects.toThrow(/duplicate key/);
  });

  it('un negocio trae reglas de reserva por defecto', async () => {
    const [t] = await adminQuery(
      `SELECT min_lead_minutes, horizon_days, slot_granularity_minutes FROM tenants WHERE id = $1`, [tenantId]);
    expect(t).toEqual({ min_lead_minutes: 60, horizon_days: 60, slot_granularity_minutes: 15 });
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/scheduling/catalog.test.ts`
Expected: FAIL — `seedCatalog` no existe en los helpers.

- [ ] **Step 3: Escribir las migraciones**

`packages/db/src/migrations/1725400000000-CreateServices.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/** Lo que el negocio ofrece. `key` es la identidad estable que usa `tenant:apply`. */
export class CreateServices1725400000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE services (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key          varchar(64) NOT NULL,
        name         varchar(255) NOT NULL,
        duration_min integer NOT NULL CHECK (duration_min > 0),
        buffer_min   integer NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
        price_cents  integer CHECK (price_cents >= 0),
        active       boolean NOT NULL DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, key)
      )
    `);
    for (const sql of tenantRlsSql('services')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE services`);
  }
}
```

`packages/db/src/migrations/1725400100000-CreateResources.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/** Quién atiende: la estilista, el médico, la bahía del taller. */
export class CreateResources1725400100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE resources (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key        varchar(64) NOT NULL,
        name       varchar(255) NOT NULL,
        active     boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, key)
      )
    `);
    for (const sql of tenantRlsSql('resources')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE resources`);
  }
}
```

`packages/db/src/migrations/1725400200000-CreateResourceServices.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/** Qué recurso presta qué servicio. */
export class CreateResourceServices1725400200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE resource_services (
        tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        PRIMARY KEY (resource_id, service_id)
      )
    `);
    for (const sql of tenantRlsSql('resource_services')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE resource_services`);
  }
}
```

`packages/db/src/migrations/1725400250000-AddBookingSettingsToTenants.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reglas de reserva por negocio (R1): anticipación mínima, horizonte máximo y
 * cada cuántos minutos arranca una franja. Las fija `tenant:apply`.
 */
export class AddBookingSettingsToTenants1725400250000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants
        ADD COLUMN min_lead_minutes smallint NOT NULL DEFAULT 60 CHECK (min_lead_minutes >= 0),
        ADD COLUMN horizon_days smallint NOT NULL DEFAULT 60 CHECK (horizon_days BETWEEN 1 AND 365),
        ADD COLUMN slot_granularity_minutes smallint NOT NULL DEFAULT 15
          CHECK (slot_granularity_minutes IN (5, 10, 15, 20, 30, 60))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants
        DROP COLUMN slot_granularity_minutes, DROP COLUMN horizon_days, DROP COLUMN min_lead_minutes
    `);
  }
}
```

- [ ] **Step 4: Declarar las tablas en el guardia y escribir los helpers**

En `packages/db/test/rls-inventory.test.ts`, dentro de `PRESUPUESTO`, después de `audit_log`:
```ts
  // Agenda: tenant-scoped con RLS.
  services: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  resources: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  resource_services: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
```

En `apps/api/test/helpers.ts`, el `TRUNCATE` de `resetDb` gana las tablas nuevas (antes de `tenants`):
```ts
    TRUNCATE webhook_events, audit_log, messages, conversation_sessions, conversations,
             flows, resource_services, resources, services, contacts, whatsapp_channels, tenants
    RESTART IDENTITY CASCADE
```
y al final del archivo:
```ts
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
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/scheduling/catalog.test.ts packages/db/test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/migrations packages/db/test/rls-inventory.test.ts apps/api/test/helpers.ts apps/api/test/scheduling/catalog.test.ts
git commit -m "feat(scheduling): modelar servicios, recursos y reglas de reserva por negocio"
```

---

### Task 2: Horarios de atención y ausencias

**Files:**
- Create: migraciones `1725400300000-CreateBusinessHours.ts`, `1725400400000-CreateTimeOff.ts`
- Modify: `packages/db/test/rls-inventory.test.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/scheduling/business-hours.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `business_hours` (`tenant_id, resource_id NULL, weekday 0-6 (0 = domingo), start_time, end_time`) y `time_off` (`tenant_id, resource_id NULL, starts_at, ends_at, reason`). `resource_id NULL` = todo el negocio. Helper `seedHours(tenantId, resourceId?)`: lunes a viernes 09:00-18:00.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/business-hours.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, seedChannel, seedCatalog, seedHours, adminQuery, closeHelpers } from '../helpers';

let tenantId: string, resourceId: string;

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
});
afterAll(async () => { await closeHelpers(); });

describe('horarios y ausencias', () => {
  it('registra horario de lunes a viernes para todo el negocio', async () => {
    await seedHours(tenantId);
    const rows = await adminQuery(
      `SELECT weekday, start_time, end_time, resource_id FROM business_hours ORDER BY weekday`);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ weekday: 1, start_time: '09:00:00', end_time: '18:00:00', resource_id: null });
  });

  it('rechaza un horario que termina antes de empezar', async () => {
    await expect(adminQuery(
      `INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 1, '18:00', '09:00')`, [tenantId])).rejects.toThrow(/check/i);
  });

  it('rechaza un día fuera de 0..6', async () => {
    await expect(adminQuery(
      `INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 7, '09:00', '18:00')`, [tenantId])).rejects.toThrow(/check/i);
  });

  it('permite una ausencia acotada a un recurso', async () => {
    await adminQuery(
      `INSERT INTO time_off (tenant_id, resource_id, starts_at, ends_at, reason)
       VALUES ($1, $2, '2026-09-10T13:00:00Z', '2026-09-10T18:00:00Z', 'Cita médica')`,
      [tenantId, resourceId]);
    const [row] = await adminQuery(`SELECT resource_id FROM time_off`);
    expect(row.resource_id).toBe(resourceId);
  });

  it('rechaza una ausencia que termina antes de empezar', async () => {
    await expect(adminQuery(
      `INSERT INTO time_off (tenant_id, starts_at, ends_at)
       VALUES ($1, '2026-09-10T18:00:00Z', '2026-09-10T13:00:00Z')`, [tenantId])).rejects.toThrow(/check/i);
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/scheduling/business-hours.test.ts`
Expected: FAIL — `seedHours` no existe.

- [ ] **Step 3: Escribir las migraciones**

`packages/db/src/migrations/1725400300000-CreateBusinessHours.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Horario semanal en hora LOCAL del negocio. `resource_id` NULL es el horario
 * del negocio; con valor, el propio de ese recurso (que entonces reemplaza al
 * del negocio para ese recurso).
 */
export class CreateBusinessHours1725400300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE business_hours (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
        weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
        start_time  time NOT NULL,
        end_time    time NOT NULL,
        CHECK (end_time > start_time)
      )
    `);
    await q.query(`CREATE INDEX business_hours_lookup ON business_hours (tenant_id, resource_id, weekday)`);
    for (const sql of tenantRlsSql('business_hours')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE business_hours`);
  }
}
```

`packages/db/src/migrations/1725400400000-CreateTimeOff.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/** Ausencias: festivos del negocio (resource_id NULL) o de un recurso. */
export class CreateTimeOff1725400400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE time_off (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
        starts_at   timestamptz NOT NULL,
        ends_at     timestamptz NOT NULL,
        reason      varchar(255),
        CHECK (ends_at > starts_at)
      )
    `);
    await q.query(`CREATE INDEX time_off_lookup ON time_off (tenant_id, starts_at, ends_at)`);
    for (const sql of tenantRlsSql('time_off')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE time_off`);
  }
}
```

- [ ] **Step 4: Guardia y helper**

En `PRESUPUESTO`:
```ts
  business_hours: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  time_off: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
```
En `resetDb`, añadir `business_hours, time_off` a la lista del `TRUNCATE` (antes de `resource_services`). En `helpers.ts`:
```ts
/** Lunes a viernes, 09:00-18:00 en hora local del negocio. */
export async function seedHours(tenantId: string, resourceId?: string): Promise<void> {
  const ds = await adminDs();
  for (const weekday of [1, 2, 3, 4, 5]) {
    await ds.query(
      `INSERT INTO business_hours (tenant_id, resource_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, '09:00', '18:00')`, [tenantId, resourceId ?? null, weekday]);
  }
}
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/scheduling packages/db/test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/migrations packages/db/test/rls-inventory.test.ts apps/api/test/helpers.ts apps/api/test/scheduling/business-hours.test.ts
git commit -m "feat(scheduling): registrar horarios de atención y ausencias por negocio o recurso"
```

---

### Task 3: `appointments` y la restricción anti-doble-reserva

La tarea central de la fase: el test de concurrencia demuestra que la prevención vive en el motor de base de datos.

**Files:**
- Create: migración `1725400500000-CreateAppointments.ts`
- Modify: `packages/db/test/rls-inventory.test.ts`, `apps/api/test/helpers.ts` (`seedContact`, `resetDb`)
- Test: `apps/api/test/scheduling/appointments-overlap.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: tabla `appointments` (`id, tenant_id, resource_id, service_id, contact_id, conversation_id NULL, starts_at, ends_at, status ('confirmed'|'cancelled'|'completed'|'no_show'), customer_name, notes, google_event_id, google_sync_status, created_at, updated_at`) con la restricción `no_overlap`; el código `23P01` (`exclusion_violation`) como contrato. Helper `seedContact(tenantId, waId = '573001112233'): Promise<string>`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/appointments-overlap.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import { resetDb, seedChannel, seedCatalog, seedContact, addResource, adminQuery, closeHelpers } from '../helpers';

let tenantId: string, serviceId: string, resourceId: string, contactId: string;

const insert = (starts: string, ends: string, status = 'confirmed', resource = resourceId) =>
  adminQuery(
    `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tenantId, resource, serviceId, contactId, starts, ends, status]);

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  contactId = await seedContact(tenantId);
});
afterAll(async () => { await closeHelpers(); });

describe('restricción anti-doble-reserva', () => {
  it('acepta dos citas consecutivas que no se solapan', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z');
    await expect(insert('2026-09-10T14:30:00Z', '2026-09-10T15:00:00Z')).resolves.toBeDefined();
  });

  it('rechaza una cita que se solapa con otra del mismo recurso', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z');
    await expect(insert('2026-09-10T14:15:00Z', '2026-09-10T14:45:00Z')).rejects.toMatchObject({ code: '23P01' });
  });

  it('rechaza una cita contenida dentro de otra', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T15:00:00Z');
    await expect(insert('2026-09-10T14:10:00Z', '2026-09-10T14:20:00Z')).rejects.toMatchObject({ code: '23P01' });
  });

  it('una cita cancelada libera la franja', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z', 'cancelled');
    await expect(insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z')).resolves.toBeDefined();
  });

  it('permite el mismo horario en recursos distintos', async () => {
    const pedro = await addResource(tenantId, 'pedro', 'Pedro', serviceId);
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z');
    await expect(insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z', 'confirmed', pedro)).resolves.toBeDefined();
  });

  it('EL CASO REAL: dos transacciones concurrentes por la misma franja, solo una gana', async () => {
    const a = createDataSource(process.env.DATABASE_ADMIN_URL!);
    const b = createDataSource(process.env.DATABASE_ADMIN_URL!);
    await a.initialize(); await b.initialize();
    const ra = a.createQueryRunner(); const rb = b.createQueryRunner();
    await ra.connect(); await rb.connect();
    await ra.startTransaction(); await rb.startTransaction();
    try {
      const sql = `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
                   VALUES ($1, $2, $3, $4, '2026-09-10T15:00:00Z', '2026-09-10T15:30:00Z')`;
      const args = [tenantId, resourceId, serviceId, contactId];

      // A inserta y NO confirma: B queda bloqueada en la restricción hasta que A decida.
      await ra.query(sql, args);
      const bInsert = rb.query(sql, args);
      await ra.commitTransaction();
      await expect(bInsert).rejects.toMatchObject({ code: '23P01' });
      await rb.rollbackTransaction();

      const [{ n }] = await adminQuery(
        `SELECT count(*)::int AS n FROM appointments WHERE starts_at = '2026-09-10T15:00:00Z'`);
      expect(n).toBe(1);
    } finally {
      await ra.release(); await rb.release();
      await a.destroy(); await b.destroy();
    }
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/scheduling/appointments-overlap.test.ts`
Expected: FAIL — `seedContact` no existe.

- [ ] **Step 3: Escribir la migración**

`packages/db/src/migrations/1725400500000-CreateAppointments.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * La fuente de verdad de las citas (D4). La doble reserva la impide Postgres
 * con una restricción de exclusión (D5): consultar y luego reservar es una
 * carrera inevitable, y un `if` no la resuelve.
 */
export class CreateAppointments1725400500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE appointments (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id        uuid NOT NULL REFERENCES resources(id),
        service_id         uuid NOT NULL REFERENCES services(id),
        contact_id         uuid NOT NULL REFERENCES contacts(id),
        conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
        starts_at          timestamptz NOT NULL,
        ends_at            timestamptz NOT NULL,
        status             varchar(16) NOT NULL DEFAULT 'confirmed'
                             CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
        customer_name      varchar(255),
        notes              text,
        -- Fase 4 (Google Calendar): proyección de la cita.
        google_event_id    varchar(1024),
        google_sync_status varchar(16) NOT NULL DEFAULT 'pending',
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CHECK (ends_at > starts_at)
      )
    `);
    // btree_gist lo creó la migración del rol (Fase 1). Solo las confirmadas
    // ocupan la franja: cancelar la libera.
    await q.query(`
      ALTER TABLE appointments ADD CONSTRAINT no_overlap
        EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
        WHERE (status = 'confirmed')
    `);
    await q.query(`
      CREATE INDEX appointments_lookup ON appointments (tenant_id, resource_id, starts_at)
        WHERE status = 'confirmed'
    `);
    await q.query(`CREATE INDEX appointments_by_contact ON appointments (contact_id, starts_at DESC)`);
    for (const sql of tenantRlsSql('appointments')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE appointments`);
  }
}
```

- [ ] **Step 4: Guardia y helpers**

En `PRESUPUESTO`:
```ts
  appointments: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
```
En `resetDb`, añadir `appointments` al `TRUNCATE` (antes de `business_hours`). En `helpers.ts`:
```ts
export async function seedContact(tenantId: string, waId = '573001112233'): Promise<string> {
  const ds = await adminDs();
  const [c] = await ds.query(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1, $2, 'Ana') RETURNING id`, [tenantId, waId]);
  return c.id;
}
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/scheduling packages/db/test`
Expected: PASS, incluido el de concurrencia.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/migrations packages/db/test/rls-inventory.test.ts apps/api/test/helpers.ts apps/api/test/scheduling/appointments-overlap.test.ts
git commit -m "feat(scheduling): impedir la doble reserva con una restricción de exclusión sobre appointments"
```

---

### Task 4: Cálculo de franjas — función pura

**Files:**
- Create: `apps/api/src/scheduling/availability.ts`
- Test: `apps/api/test/scheduling/availability.test.ts`

**Interfaces:**
- Produces:
```ts
export interface HoursBlock { weekday: number; start: string; end: string } // hora LOCAL 'HH:MM', 0 = domingo
export interface BusyInterval { start: Date; end: Date }
export interface Slot { start: Date; end: Date }
export interface SlotInput {
  from: Date; to: Date; timezone: string;
  durationMin: number; bufferMin: number; granularityMin: number;
  minLeadMin: number; horizonDays: number;
  now: Date; hours: HoursBlock[]; busy: BusyInterval[];
}
export function computeSlots(input: SlotInput): Slot[]; // UN recurso; ordenadas y sin duplicados
```
Semántica: una franja empieza en `bloque.start + k·granularity`, termina antes o justo al cierre del bloque, cae entera dentro de `[from, to]`, empieza no antes de `now + minLead` ni después de `now + horizonDays` días, y no toca lo ocupado expandido por `bufferMin` a ambos lados.

- [ ] **Step 1: Instalar Luxon**

```bash
pnpm --filter @citara/api add luxon@^3
```
```bash
pnpm --filter @citara/api add -D @types/luxon@^3
```

- [ ] **Step 2: Escribir el test que falla**

`apps/api/test/scheduling/availability.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeSlots, type SlotInput } from '../../src/scheduling/availability';

const BOGOTA = 'America/Bogota'; // UTC-5 todo el año
const NY = 'America/New_York';   // con horario de verano

// Jueves 10 de septiembre de 2026, 09:00-12:00 local.
const base: SlotInput = {
  timezone: BOGOTA,
  durationMin: 30, bufferMin: 0, granularityMin: 30, minLeadMin: 0, horizonDays: 365,
  now: new Date('2026-09-01T00:00:00Z'),
  hours: [{ weekday: 4, start: '09:00', end: '12:00' }],
  busy: [],
  from: new Date('2026-09-10T00:00:00Z'),
  to: new Date('2026-09-11T00:00:00Z'),
};

const hhmm = (d: Date, tz = BOGOTA) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const starts = (input: SlotInput, tz = BOGOTA) => computeSlots(input).map((s) => hhmm(s.start, tz));

describe('computeSlots', () => {
  it('genera franjas de 30 min entre 09:00 y 12:00 hora local', () => {
    expect(starts(base)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('la última franja termina justo al cierre, nunca después', () => {
    const slots = computeSlots({ ...base, durationMin: 45, granularityMin: 45 });
    expect(slots.map((s) => hhmm(s.start))).toEqual(['09:00', '09:45', '10:30', '11:15']);
    expect(hhmm(slots.at(-1)!.end)).toBe('12:00');
  });

  it('excluye las franjas ocupadas por una cita existente', () => {
    expect(starts({ ...base, busy: [{ start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z') }] }))
      .toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']); // 15:00Z = 10:00 Bogotá
  });

  it('el buffer del servicio bloquea también los bordes de lo ocupado', () => {
    expect(starts({ ...base, bufferMin: 15,
      busy: [{ start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z') }] }))
      .toEqual(['09:00', '11:00', '11:30']);
  });

  it('respeta la anticipación mínima', () => {
    expect(starts({ ...base, now: new Date('2026-09-10T14:40:00Z'), minLeadMin: 60 }))
      .toEqual(['11:00', '11:30']); // 09:40 local + 60 min
  });

  it('respeta el horizonte máximo', () => {
    expect(computeSlots({ ...base, horizonDays: 5 })).toEqual([]); // el 10 está a 9 días del 1
  });

  it('devuelve vacío en un día sin horario', () => {
    expect(computeSlots({ ...base, from: new Date('2026-09-12T00:00:00Z'), to: new Date('2026-09-13T00:00:00Z') }))
      .toEqual([]);
  });

  it('cubre todos los días locales del rango, incluido el del límite superior', () => {
    // Hasta el sábado 00:00Z = viernes 19:00 en Bogotá: el viernes entra.
    const slots = computeSlots({ ...base,
      hours: [{ weekday: 4, start: '09:00', end: '10:00' }, { weekday: 5, start: '09:00', end: '10:00' }],
      to: new Date('2026-09-12T00:00:00Z') });
    expect(slots).toHaveLength(4);
  });

  it('no devuelve franjas fuera del rango pedido', () => {
    expect(starts({ ...base, from: new Date('2026-09-10T15:00:00Z'), to: new Date('2026-09-10T16:00:00Z') }))
      .toEqual(['10:00', '10:30']);
  });

  it('bloques que se solapan no duplican franjas', () => {
    expect(starts({ ...base, hours: [{ weekday: 4, start: '09:00', end: '11:00' }, { weekday: 4, start: '10:00', end: '12:00' }] }))
      .toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('honra el horario LOCAL a través de un cambio de horario de verano', () => {
    // Nueva York vuelve a hora estándar el domingo 1 de noviembre de 2026.
    const slots = computeSlots({ ...base, timezone: NY,
      hours: [{ weekday: 1, start: '09:00', end: '10:00' }],
      from: new Date('2026-10-25T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z'),
      now: new Date('2026-10-01T00:00:00Z') });
    expect(slots.map((s) => hhmm(s.start, NY))).toEqual(['09:00', '09:30', '09:00', '09:30']);
    expect(slots[0].start.toISOString()).toBe('2026-10-26T13:00:00.000Z');
    expect(slots[2].start.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('devuelve vacío si la duración no cabe en ningún bloque', () => {
    expect(computeSlots({ ...base, durationMin: 240 })).toEqual([]);
  });
});
```

- [ ] **Step 3: Correr y verlo fallar**

Run: `pnpm test apps/api/test/scheduling/availability.test.ts`
Expected: FAIL — no existe `availability.ts`.

- [ ] **Step 4: Escribir la función**

`apps/api/src/scheduling/availability.ts`:
```ts
import { DateTime, Interval } from 'luxon';

export interface HoursBlock { weekday: number; start: string; end: string }
export interface BusyInterval { start: Date; end: Date }
export interface Slot { start: Date; end: Date }

export interface SlotInput {
  from: Date;
  to: Date;
  /** IANA, de tenants.timezone. Toda la aritmética de calendario depende de esto. */
  timezone: string;
  durationMin: number;
  bufferMin: number;
  granularityMin: number;
  minLeadMin: number;
  horizonDays: number;
  now: Date;
  hours: HoursBlock[];
  busy: BusyInterval[];
}

const at = (day: DateTime, hhmm: string) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
};

/**
 * Franjas libres de UN recurso. Función PURA: no consulta ni persiste.
 *
 * Trabaja en la zona del negocio y deja que Luxon resuelva los offsets: sumar
 * 24 h en milisegundos se rompe en los cambios de horario de verano; avanzar un
 * día de calendario, no. Recorre todos los días LOCALES que toca [from, to],
 * incluido el del límite superior, y descarta lo que se salga del rango.
 */
export function computeSlots(input: SlotInput): Slot[] {
  const { timezone, durationMin, bufferMin, granularityMin, hours } = input;
  const from = DateTime.fromJSDate(input.from);
  const to = DateTime.fromJSDate(input.to);
  const now = DateTime.fromJSDate(input.now).setZone(timezone);
  const earliest = now.plus({ minutes: input.minLeadMin });
  const latest = now.plus({ days: input.horizonDays });

  // Lo ocupado se expande con el buffer a ambos lados.
  const blocked = input.busy.map((b) => Interval.fromDateTimes(
    DateTime.fromJSDate(b.start).minus({ minutes: bufferMin }),
    DateTime.fromJSDate(b.end).plus({ minutes: bufferMin }),
  ));

  const seen = new Set<number>();
  const slots: Slot[] = [];
  const lastDay = to.setZone(timezone).startOf('day');

  for (let day = from.setZone(timezone).startOf('day'); day <= lastDay; day = day.plus({ days: 1 }).startOf('day')) {
    // Luxon: 1 = lunes … 7 = domingo. Nuestro esquema: 0 = domingo … 6 = sábado.
    const weekday = day.weekday % 7;
    for (const block of hours.filter((h) => h.weekday === weekday)) {
      const blockEnd = at(day, block.end);
      for (let start = at(day, block.start); ; start = start.plus({ minutes: granularityMin })) {
        const end = start.plus({ minutes: durationMin });
        if (end > blockEnd) break;
        if (start < from || end > to) continue;
        if (start < earliest || start > latest) continue;
        const candidate = Interval.fromDateTimes(start, end);
        if (blocked.some((b) => b.overlaps(candidate))) continue;
        if (seen.has(start.toMillis())) continue; // bloques solapados
        seen.add(start.toMillis());
        slots.push({ start: start.toJSDate(), end: end.toJSDate() });
      }
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/scheduling/availability.test.ts && pnpm typecheck`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/scheduling/availability.ts apps/api/test/scheduling/availability.test.ts
git commit -m "feat(scheduling): calcular franjas libres en la zona horaria del negocio"
```

---

### Task 5: Disponibilidad y reservas sobre la transacción del llamador

**Files:**
- Create: `apps/api/src/scheduling/scheduling.errors.ts`, `availability.service.ts`, `booking.service.ts`
- Modify: `apps/api/src/app.module.ts` (providers), `apps/api/test/helpers.ts` (`buildScheduling`)
- Test: `apps/api/test/scheduling/booking.service.test.ts`

**Interfaces:**
- Consumes: `computeSlots` (Task 4), tablas de las Tasks 1-3.
- Produces:
```ts
// scheduling.errors.ts
export class SchedulingError extends Error {}
export class SlotTakenError extends SchedulingError {}
export class OutsideHoursError extends SchedulingError {}
export class TooSoonError extends SchedulingError {}
export class TooFarError extends SchedulingError {}
export class NotFoundError extends SchedulingError {}

// availability.service.ts
export interface BookingSettings { timezone: string; minLeadMin: number; horizonDays: number; granularityMin: number }
export interface ResourceSlot { start: Date; end: Date; resourceId: string; resourceName: string }
export type Bookability = 'ok' | 'too_soon' | 'too_far' | 'outside_hours' | 'taken';
class AvailabilityService {
  settings(m: EntityManager, tenantId: string): Promise<BookingSettings>;
  listServices(m: EntityManager): Promise<{ id: string; key: string; nombre: string; duracion_min: number; precio_centavos: number | null }[]>;
  slotsFor(m, tenantId, q: { serviceId: string; resourceId: string | null; from: Date; to: Date; now: Date; ignoreBusy?: boolean }): Promise<ResourceSlot[]>;
  check(m, tenantId, q: { serviceId: string; resourceId: string; start: Date; now: Date }): Promise<Bookability>;
}

// booking.service.ts
export interface BookInput { serviceId: string; resourceId: string; contactId: string; startsAt: Date;
  customerName: string; conversationId?: string | null; notes?: string | null; now: Date }
export interface Appointment { id: string; serviceId: string; resourceId: string; contactId: string;
  conversationId: string | null; startsAt: Date; endsAt: Date; status: string;
  customerName: string | null; notes: string | null; googleSyncStatus: string }
export interface AppointmentView { id: string; startsAt: Date; endsAt: Date; serviceName: string; resourceName: string }
class BookingService {
  book(m, tenantId, input: BookInput): Promise<Appointment>;
  cancel(m, appointmentId: string, contactId: string): Promise<Appointment>;
  reschedule(m, tenantId, appointmentId: string, contactId: string, newStart: Date, now: Date): Promise<Appointment>;
  listForContact(m, contactId: string, now: Date): Promise<AppointmentView[]>;
  findForContact(m, appointmentId: string, contactId: string): Promise<Appointment | null>;
}
```
- Produces (helper): `buildScheduling(): { availability: AvailabilityService; booking: BookingService }`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/booking.service.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { NotFoundError, OutsideHoursError, SlotTakenError, TooFarError, TooSoonError }
  from '../../src/scheduling/scheduling.errors';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, addResource,
         adminQuery, closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;
let s: ReturnType<typeof buildScheduling>;

const JUEVES_10AM = new Date('2026-09-10T15:00:00Z'); // 10:00 en Bogotá
const AHORA = new Date('2026-09-08T12:00:00Z');
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const input = (startsAt = JUEVES_10AM, now = AHORA) =>
  ({ serviceId, resourceId, contactId, startsAt, customerName: 'Ana', now });

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  s = buildScheduling();
});

describe('BookingService.book', () => {
  it('reserva una franja libre y calcula el fin con la duración del servicio', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    expect(cita.startsAt.toISOString()).toBe(JUEVES_10AM.toISOString());
    expect(cita.endsAt.toISOString()).toBe('2026-09-10T15:30:00.000Z');
    expect([cita.status, cita.googleSyncStatus]).toEqual(['confirmed', 'pending']);
  });

  it('lanza SlotTakenError si la franja ya está ocupada', async () => {
    await inTenant((m) => s.booking.book(m, tenantId, input()));
    await expect(inTenant((m) => s.booking.book(m, tenantId, input()))).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('el buffer del servicio cuenta como ocupado', async () => {
    await adminQuery(`UPDATE services SET buffer_min = 15`);
    await inTenant((m) => s.booking.book(m, tenantId, input()));
    await expect(inTenant((m) => s.booking.book(m, tenantId, input(new Date('2026-09-10T15:30:00Z')))))
      .rejects.toBeInstanceOf(SlotTakenError);
  });

  it('si Postgres rechaza por solapamiento, la transacción de quien llama sigue viva', async () => {
    // Simula la carrera: la verificación dice "libre" pero otro ya insertó.
    await inTenant((m) => s.booking.book(m, tenantId, input()));
    vi.spyOn(s.availability, 'check').mockResolvedValue('ok');
    const n = await inTenant(async (m) => {
      await expect(s.booking.book(m, tenantId, input())).rejects.toBeInstanceOf(SlotTakenError);
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM appointments`);
      return n;
    });
    expect(n).toBe(1);
  });

  it('rechaza fuera del horario: domingo, pasado el cierre o de madrugada', async () => {
    for (const at of ['2026-09-13T15:00:00Z', '2026-09-10T22:45:00Z', '2026-09-10T08:00:00Z']) {
      await expect(inTenant((m) => s.booking.book(m, tenantId, input(new Date(at)))))
        .rejects.toBeInstanceOf(OutsideHoursError);
    }
  });

  it('rechaza sin la anticipación mínima y más allá del horizonte', async () => {
    await expect(inTenant((m) => s.booking.book(m, tenantId, input(JUEVES_10AM, new Date('2026-09-10T14:50:00Z')))))
      .rejects.toBeInstanceOf(TooSoonError);
    await expect(inTenant((m) => s.booking.book(m, tenantId, input(new Date('2027-03-04T15:00:00Z')))))
      .rejects.toBeInstanceOf(TooFarError);
  });

  it('reserva una franja que cruza la medianoche UTC', async () => {
    // 19:00 en Bogotá = 00:00Z del día siguiente.
    await adminQuery(`INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
                      VALUES ($1, 4, '18:00', '21:00')`, [tenantId]);
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input(new Date('2026-09-11T00:00:00Z'))));
    expect(cita.status).toBe('confirmed');
  });
});

describe('AvailabilityService.slotsFor', () => {
  it('con varios recursos, lo ocupado de uno no oculta lo libre del otro', async () => {
    const pedro = await addResource(tenantId, 'pedro', 'Pedro', serviceId);
    await inTenant((m) => s.booking.book(m, tenantId, input())); // María a las 10:00

    const slots = await inTenant((m) => s.availability.slotsFor(m, tenantId, {
      serviceId, resourceId: null, from: JUEVES_10AM, to: new Date('2026-09-10T15:30:00Z'), now: AHORA }));

    expect(slots.map((x) => x.resourceId)).toEqual([pedro]);
  });

  it('un recurso con horario propio usa el suyo y no el del negocio', async () => {
    await adminQuery(`INSERT INTO business_hours (tenant_id, resource_id, weekday, start_time, end_time)
                      VALUES ($1, $2, 4, '14:00', '15:00')`, [tenantId, resourceId]);
    const slots = await inTenant((m) => s.availability.slotsFor(m, tenantId, {
      serviceId, resourceId, from: new Date('2026-09-10T05:00:00Z'), to: new Date('2026-09-11T05:00:00Z'), now: AHORA }));
    expect(slots).toHaveLength(3); // bloque de una hora, 30 min cada 15: 14:00, 14:15 y 14:30
  });
});

describe('BookingService.cancel y reschedule', () => {
  it('cancela una cita propia y libera la franja', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const cancelada = await inTenant((m) => s.booking.cancel(m, cita.id, contactId));
    expect(cancelada.status).toBe('cancelled');
    await expect(inTenant((m) => s.booking.book(m, tenantId, input()))).resolves.toBeDefined();
  });

  it('no deja cancelar la cita de otro contacto', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const otro = await seedContact(tenantId, '573009998877');
    await expect(inTenant((m) => s.booking.cancel(m, cita.id, otro))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reprogramar mueve la cita y conserva el nombre', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const nueva = await inTenant((m) => s.booking.reschedule(
      m, tenantId, cita.id, contactId, new Date('2026-09-10T16:00:00Z'), AHORA));
    expect(nueva.customerName).toBe('Ana');
    const rows = await adminQuery(`SELECT status, starts_at FROM appointments ORDER BY created_at`);
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['cancelled', 'confirmed']);
  });

  it('si el horario nuevo está ocupado, la cita original sigue en pie', async () => {
    const cita = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const otro = await seedContact(tenantId, '573009998877');
    await inTenant((m) => s.booking.book(m, tenantId, { ...input(new Date('2026-09-10T16:00:00Z')), contactId: otro }));

    // Dentro de UNA transacción, como en un turno: si la del llamador se
    // revirtiera entera, el test pasaría sin probar el savepoint.
    const status = await inTenant(async (m) => {
      await expect(s.booking.reschedule(m, tenantId, cita.id, contactId, new Date('2026-09-10T16:00:00Z'), AHORA))
        .rejects.toBeInstanceOf(SlotTakenError);
      const [r] = await m.query(`SELECT status FROM appointments WHERE id = $1`, [cita.id]);
      return r.status;
    });
    expect(status).toBe('confirmed');
  });

  it('lista solo las citas futuras confirmadas del contacto', async () => {
    const futura = await inTenant((m) => s.booking.book(m, tenantId, input()));
    const otra = await inTenant((m) => s.booking.book(m, tenantId, input(new Date('2026-09-11T15:00:00Z'))));
    await inTenant((m) => s.booking.cancel(m, otra.id, contactId));

    const citas = await inTenant((m) => s.booking.listForContact(m, contactId, AHORA));
    expect(citas.map((c) => c.id)).toEqual([futura.id]);
    expect(citas[0]).toMatchObject({ serviceName: 'Corte de cabello', resourceName: 'María' });
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/scheduling/booking.service.test.ts`
Expected: FAIL — `buildScheduling` no existe.

- [ ] **Step 3: Errores de dominio**

`apps/api/src/scheduling/scheduling.errors.ts`:
```ts
/** Errores que se le explican al usuario; cualquier otro es un fallo del sistema. */
export class SchedulingError extends Error {}

export class SlotTakenError extends SchedulingError {
  constructor() { super('Esa franja ya está ocupada'); }
}
export class OutsideHoursError extends SchedulingError {
  constructor() { super('Ese horario está fuera de la atención del negocio'); }
}
export class TooSoonError extends SchedulingError {
  constructor(minLeadMin: number) { super(`Se necesita al menos ${minLeadMin} minutos de anticipación`); }
}
export class TooFarError extends SchedulingError {
  constructor(horizonDays: number) { super(`Solo se agenda con hasta ${horizonDays} días de anticipación`); }
}
export class NotFoundError extends SchedulingError {
  constructor(what = 'recurso') { super(`No se encontró ${what}`); }
}
```

- [ ] **Step 4: Disponibilidad**

`apps/api/src/scheduling/availability.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DateTime } from 'luxon';
import { computeSlots, type BusyInterval, type HoursBlock } from './availability';
import { NotFoundError } from './scheduling.errors';

export interface BookingSettings { timezone: string; minLeadMin: number; horizonDays: number; granularityMin: number }
export interface ResourceSlot { start: Date; end: Date; resourceId: string; resourceName: string }
export type Bookability = 'ok' | 'too_soon' | 'too_far' | 'outside_hours' | 'taken';

const HOURS_COLUMNS = `weekday, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"`;

/**
 * Sin estado: recibe el EntityManager de quien llama. Dentro de un turno corre
 * en la transacción del turno (RLS fijado, conversación bloqueada) y no abre
 * conexiones propias: con el lock tomado, una segunda conexión que necesitara
 * la misma fila colgaría el job sin que Postgres lo viera como deadlock.
 */
@Injectable()
export class AvailabilityService {
  async settings(m: EntityManager, tenantId: string): Promise<BookingSettings> {
    const [t] = await m.query(
      `SELECT timezone, min_lead_minutes, horizon_days, slot_granularity_minutes FROM tenants WHERE id = $1`,
      [tenantId]);
    if (!t) throw new NotFoundError('el negocio');
    return { timezone: t.timezone, minLeadMin: t.min_lead_minutes,
             horizonDays: t.horizon_days, granularityMin: t.slot_granularity_minutes };
  }

  listServices(m: EntityManager) {
    return m.query(
      `SELECT id, key, name AS nombre, duration_min AS duracion_min, price_cents AS precio_centavos
         FROM services WHERE active ORDER BY name`);
  }

  /** Franjas libres por recurso. Con `resourceId` NULL, de todos los que prestan el servicio. */
  async slotsFor(
    m: EntityManager, tenantId: string,
    q: { serviceId: string; resourceId: string | null; from: Date; to: Date; now: Date; ignoreBusy?: boolean },
  ): Promise<ResourceSlot[]> {
    const settings = await this.settings(m, tenantId);
    const [service] = await m.query(
      `SELECT duration_min, buffer_min FROM services WHERE id = $1 AND active`, [q.serviceId]);
    if (!service) throw new NotFoundError('el servicio');

    const resources: { id: string; name: string }[] = await m.query(
      `SELECT r.id, r.name FROM resources r
         JOIN resource_services rs ON rs.resource_id = r.id
        WHERE rs.service_id = $1 AND r.active AND ($2::uuid IS NULL OR r.id = $2)
        ORDER BY r.name`, [q.serviceId, q.resourceId]);

    // Lo ocupado se busca con margen: el buffer de una cita justo fuera del
    // rango puede bloquear el borde de una franja de adentro.
    const margin = service.buffer_min * 60_000;
    const out: ResourceSlot[] = [];
    for (const r of resources) {
      const own: HoursBlock[] = await m.query(
        `SELECT ${HOURS_COLUMNS} FROM business_hours WHERE resource_id = $1`, [r.id]);
      // Un recurso con horario propio usa el suyo; si no, el del negocio.
      const hours: HoursBlock[] = own.length ? own : await m.query(
        `SELECT ${HOURS_COLUMNS} FROM business_hours WHERE resource_id IS NULL`);
      const busy: BusyInterval[] = q.ignoreBusy ? [] : await m.query(
        `SELECT starts_at AS start, ends_at AS "end" FROM appointments
          WHERE resource_id = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2
         UNION ALL
         SELECT starts_at, ends_at FROM time_off
          WHERE (resource_id = $1 OR resource_id IS NULL) AND starts_at < $3 AND ends_at > $2`,
        [r.id, new Date(q.from.getTime() - margin), new Date(q.to.getTime() + margin)]);

      for (const slot of computeSlots({
        from: q.from, to: q.to, now: q.now, timezone: settings.timezone,
        durationMin: service.duration_min, bufferMin: service.buffer_min,
        granularityMin: settings.granularityMin, minLeadMin: settings.minLeadMin,
        horizonDays: settings.horizonDays, hours, busy,
      })) {
        out.push({ ...slot, resourceId: r.id, resourceName: r.name });
      }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.resourceName.localeCompare(b.resourceName));
  }

  /**
   * Veredicto de reserva (R1: la herramienta valida por su cuenta). Distingue
   * "fuera de horario" de "ocupado" para que el usuario reciba el motivo real.
   */
  async check(
    m: EntityManager, tenantId: string,
    q: { serviceId: string; resourceId: string; start: Date; now: Date },
  ): Promise<Bookability> {
    const settings = await this.settings(m, tenantId);
    if (q.start.getTime() < q.now.getTime() + settings.minLeadMin * 60_000) return 'too_soon';
    const latest = DateTime.fromJSDate(q.now).setZone(settings.timezone).plus({ days: settings.horizonDays });
    if (DateTime.fromJSDate(q.start) > latest) return 'too_far';

    const [service] = await m.query(`SELECT duration_min FROM services WHERE id = $1 AND active`, [q.serviceId]);
    if (!service) return 'outside_hours';
    const window = { from: q.start, to: new Date(q.start.getTime() + service.duration_min * 60_000) };
    const fits = (slots: ResourceSlot[]) => slots.some((x) => x.start.getTime() === q.start.getTime());

    if (!fits(await this.slotsFor(m, tenantId, { ...q, ...window, ignoreBusy: true }))) return 'outside_hours';
    if (!fits(await this.slotsFor(m, tenantId, { ...q, ...window }))) return 'taken';
    return 'ok';
  }
}
```

- [ ] **Step 5: Reservas**

`apps/api/src/scheduling/booking.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
// Import de VALOR: BookingService es @Injectable() y Nest resuelve
// AvailabilityService por el design:paramtype que emite el decorador.
import { AvailabilityService } from './availability.service';
import {
  NotFoundError, OutsideHoursError, SlotTakenError, TooFarError, TooSoonError,
} from './scheduling.errors';

const PG_EXCLUSION_VIOLATION = '23P01';
const COLUMNS = `id, service_id, resource_id, contact_id, conversation_id, starts_at, ends_at,
                 status, customer_name, notes, google_sync_status`;

export interface BookInput {
  serviceId: string; resourceId: string; contactId: string; startsAt: Date;
  customerName: string; conversationId?: string | null; notes?: string | null; now: Date;
}

export interface Appointment {
  id: string; serviceId: string; resourceId: string; contactId: string; conversationId: string | null;
  startsAt: Date; endsAt: Date; status: string; customerName: string | null; notes: string | null;
  googleSyncStatus: string;
}

export interface AppointmentView { id: string; startsAt: Date; endsAt: Date; serviceName: string; resourceName: string }

type Row = Record<string, any>;

@Injectable()
export class BookingService {
  constructor(private readonly availability: AvailabilityService) {}

  async book(m: EntityManager, tenantId: string, input: BookInput): Promise<Appointment> {
    const verdict = await this.availability.check(m, tenantId, {
      serviceId: input.serviceId, resourceId: input.resourceId, start: input.startsAt, now: input.now });
    if (verdict !== 'ok') {
      const settings = await this.availability.settings(m, tenantId);
      if (verdict === 'too_soon') throw new TooSoonError(settings.minLeadMin);
      if (verdict === 'too_far') throw new TooFarError(settings.horizonDays);
      if (verdict === 'taken') throw new SlotTakenError();
      throw new OutsideHoursError();
    }

    const [service] = await m.query(`SELECT duration_min FROM services WHERE id = $1`, [input.serviceId]);
    const endsAt = new Date(input.startsAt.getTime() + service.duration_min * 60_000);

    // SAVEPOINT: la violación de exclusión aborta la transacción entera. Dentro
    // de un turno eso tumbaría todo el turno; con el savepoint solo se revierte
    // el INSERT y el flujo puede responder "esa franja se acaba de ocupar".
    await m.query(`SAVEPOINT reservar_cita`);
    try {
      const [row] = await m.query(
        `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, conversation_id,
                                   starts_at, ends_at, customer_name, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [tenantId, input.resourceId, input.serviceId, input.contactId, input.conversationId ?? null,
         input.startsAt, endsAt, input.customerName, input.notes ?? null]);
      await m.query(`RELEASE SAVEPOINT reservar_cita`);
      return toAppointment(row);
    } catch (err) {
      await m.query(`ROLLBACK TO SAVEPOINT reservar_cita`);
      // La carrera consultar→reservar la resuelve el motor, no un if previo.
      if ((err as { code?: string }).code === PG_EXCLUSION_VIOLATION) throw new SlotTakenError();
      throw err;
    }
  }

  async cancel(m: EntityManager, appointmentId: string, contactId: string): Promise<Appointment> {
    // La propiedad se verifica en SQL (R3). Con UPDATE, TypeORM devuelve [filas, conteo].
    const [rows] = (await m.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'
        RETURNING ${COLUMNS}`, [appointmentId, contactId])) as [Row[], number];
    if (!rows[0]) throw new NotFoundError('esa cita');
    return toAppointment(rows[0]);
  }

  /** Atómico: si el horario nuevo falla, la cita original queda como estaba. */
  async reschedule(
    m: EntityManager, tenantId: string, appointmentId: string, contactId: string, newStart: Date, now: Date,
  ): Promise<Appointment> {
    const existing = await this.findForContact(m, appointmentId, contactId);
    if (!existing) throw new NotFoundError('esa cita');

    await m.query(`SAVEPOINT reprogramar_cita`);
    try {
      // Cancelar primero libera la franja vieja: mover la cita 15 minutos debe poder.
      await this.cancel(m, appointmentId, contactId);
      const nueva = await this.book(m, tenantId, {
        serviceId: existing.serviceId, resourceId: existing.resourceId, contactId,
        startsAt: newStart, customerName: existing.customerName ?? '',
        conversationId: existing.conversationId, notes: existing.notes, now,
      });
      await m.query(`RELEASE SAVEPOINT reprogramar_cita`);
      return nueva;
    } catch (err) {
      await m.query(`ROLLBACK TO SAVEPOINT reprogramar_cita`);
      throw err;
    }
  }

  async listForContact(m: EntityManager, contactId: string, now: Date): Promise<AppointmentView[]> {
    const rows: Row[] = await m.query(
      `SELECT a.id, a.starts_at, a.ends_at, s.name AS service_name, r.name AS resource_name
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         JOIN resources r ON r.id = a.resource_id
        WHERE a.contact_id = $1 AND a.status = 'confirmed' AND a.starts_at >= $2
        ORDER BY a.starts_at`, [contactId, now]);
    return rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at,
                              serviceName: r.service_name, resourceName: r.resource_name }));
  }

  async findForContact(m: EntityManager, appointmentId: string, contactId: string): Promise<Appointment | null> {
    const [row] = await m.query(
      `SELECT ${COLUMNS} FROM appointments WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'`,
      [appointmentId, contactId]);
    return row ? toAppointment(row) : null;
  }
}

function toAppointment(r: Row): Appointment {
  return {
    id: r.id, serviceId: r.service_id, resourceId: r.resource_id, contactId: r.contact_id,
    conversationId: r.conversation_id, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status,
    customerName: r.customer_name, notes: r.notes, googleSyncStatus: r.google_sync_status,
  };
}
```

- [ ] **Step 6: Registrar y helper**

En `apps/api/src/app.module.ts`, importar y añadir a `providers`:
```ts
import { AvailabilityService } from './scheduling/availability.service';
import { BookingService } from './scheduling/booking.service';
```
```ts
    // Agenda (Fase 2). Sin estado: reciben el EntityManager de quien llama.
    AvailabilityService,
    BookingService,
```
En `apps/api/test/helpers.ts`:
```ts
import { AvailabilityService } from '../src/scheduling/availability.service';
import { BookingService } from '../src/scheduling/booking.service';
```
```ts
/** Los servicios de agenda, cableados como en AppModule. Sin estado ni conexiones. */
export function buildScheduling() {
  const availability = new AvailabilityService();
  const booking = new BookingService(availability);
  return { availability, booking };
}
```

- [ ] **Step 7: Correr los tests**

Run: `pnpm test apps/api/test/scheduling && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/scheduling apps/api/src/app.module.ts apps/api/test/helpers.ts apps/api/test/scheduling/booking.service.test.ts
git commit -m "feat(scheduling): reservar, cancelar y reprogramar dentro de la transacción de quien llama"
```

---

### Task 6: Las herramientas de agenda

El contrato que la Fase 5 (agente) entregará al modelo sin modificarlo. Hoy lo invoca un menú.

**Files:**
- Create: `apps/api/src/scheduling/format.ts`, `apps/api/src/scheduling/tools/registry.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/test/helpers.ts` (`buildScheduling` gana `tools`)
- Test: `apps/api/test/scheduling/tools.test.ts`

**Interfaces:**
- Consumes: `AvailabilityService`, `BookingService` (Task 5).
- Produces:
```ts
export interface ToolContext { m: EntityManager; tenantId: string; contactId: string; conversationId: string; now: Date }
export interface ToolResult { ok: boolean; data?: unknown; error?: string; confirmationToken?: string }
export interface ToolDefinition { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>;
  destructive: boolean; run(args: any, ctx: ToolContext): Promise<ToolResult> }
class ToolRegistry { readonly tools: Record<string, ToolDefinition>; run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> }
export function labelFor(date: Date, timezone: string): string; // format.ts — "jueves 10 de septiembre, 09:00"
```
Herramientas y su salida:
- `consultar_servicios()` → `[{ id, key, nombre, duracion_min, precio_centavos }]`
- `consultar_disponibilidad(servicio_id, recurso_id?, desde?, hasta?, limite?)` → `[{ inicio, fin, recurso_id, recurso, etiqueta }]`; `desde` por defecto hoy (zona del negocio), `hasta` por defecto `desde + 6 días`, `limite` 20.
- `consultar_mis_citas()` → `[{ id, inicio, servicio, recurso, etiqueta }]`
- `agendar_cita(servicio_id, recurso_id, inicio, nombre, notas?)` → `{ id, inicio, estado, etiqueta }`
- `cancelar_cita(cita_id, confirmation_token?, motivo?)` y `reprogramar_cita(cita_id, nuevo_inicio, confirmation_token?)`: en dos tiempos.

- [ ] **Step 1: Instalar Zod**

```bash
pnpm --filter @citara/api add zod@^3
```

- [ ] **Step 2: Escribir el test que falla**

`apps/api/test/scheduling/tools.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import type { ToolContext, ToolResult } from '../../src/scheduling/tools/registry';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let s: ReturnType<typeof buildScheduling>;
let tenantId: string, contactId: string, conversationId: string, serviceId: string, resourceId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const run = (name: string, args: unknown, who = contactId): Promise<ToolResult> =>
  runInTenant(app, tenantId, (m) =>
    s.tools.run(name, args, { m, tenantId, contactId: who, conversationId, now: AHORA } satisfies ToolContext));
const agendar = () => run('agendar_cita', {
  servicio_id: serviceId, recurso_id: resourceId, inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana' });

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  let channelId: string;
  ({ tenantId, channelId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
     VALUES ($1, $2, $3, now()) RETURNING id`, [tenantId, contactId, channelId]);
  conversationId = c.id;
  s = buildScheduling();
});

describe('registro de herramientas', () => {
  it('marca como destructivas solo cancelar y reprogramar', () => {
    const destructivas = Object.values(s.tools.tools).filter((t) => t.destructive).map((t) => t.name);
    expect(destructivas.sort()).toEqual(['cancelar_cita', 'reprogramar_cita']);
  });

  it('ninguna herramienta acepta la identidad como argumento (R3)', () => {
    for (const tool of Object.values(s.tools.tools)) {
      const keys = Object.keys(tool.schema.shape);
      for (const k of ['tenant_id', 'contact_id', 'tenantId', 'contactId']) expect(keys).not.toContain(k);
    }
  });

  it('una herramienta desconocida o argumentos inválidos vuelven como error, sin lanzar', async () => {
    expect((await run('borrar_todo', {})).ok).toBe(false);
    expect((await run('consultar_disponibilidad', { servicio_id: 'no-es-uuid' })).ok).toBe(false);
  });
});

describe('consultas', () => {
  it('consultar_servicios lista los servicios activos', async () => {
    const res = await run('consultar_servicios', {});
    expect(res.data).toEqual([expect.objectContaining({ id: serviceId, nombre: 'Corte de cabello', duracion_min: 30 })]);
  });

  it('consultar_disponibilidad devuelve franjas con offset, recurso y etiqueta', async () => {
    const res = await run('consultar_disponibilidad', { servicio_id: serviceId, desde: '2026-09-10', hasta: '2026-09-10' });
    const [primera] = res.data as { inicio: string; recurso_id: string; etiqueta: string }[];
    expect(primera.inicio).toBe('2026-09-10T09:00:00-05:00');
    expect(primera.recurso_id).toBe(resourceId);
    expect(primera.etiqueta).toContain('09:00');
  });

  it('sin fechas mira desde hoy, y respeta el límite', async () => {
    const res = await run('consultar_disponibilidad', { servicio_id: serviceId, limite: '3' });
    const franjas = res.data as { inicio: string }[];
    expect(franjas).toHaveLength(3);
    expect(franjas[0].inicio).toBe('2026-09-08T09:00:00-05:00'); // martes 07:00 local + 60 min de anticipación
  });

  it('rechaza un rango invertido con un error legible', async () => {
    const res = await run('consultar_disponibilidad', { servicio_id: serviceId, desde: '2026-09-11', hasta: '2026-09-10' });
    expect(res.error).toMatch(/rango/i);
  });
});

describe('agendar_cita', () => {
  it('agenda y devuelve la cita', async () => {
    const res = await agendar();
    expect(res.data).toMatchObject({ estado: 'confirmed', inicio: '2026-09-10T10:00:00-05:00' });
  });

  it('si la franja está ocupada, responde con un mensaje útil', async () => {
    await agendar();
    const res = await agendar();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ocupada/i);
  });

  it('rechaza una fecha sin offset: nunca adivina la zona (R2)', async () => {
    const res = await run('agendar_cita', { servicio_id: serviceId, recurso_id: resourceId,
                                            inicio: '2026-09-10T10:00:00', nombre: 'Ana' });
    expect(res.error).toMatch(/offset/i);
  });

  it('rechaza una fecha en el pasado', async () => {
    const res = await run('agendar_cita', { servicio_id: serviceId, recurso_id: resourceId,
                                            inicio: '2020-01-01T10:00:00-05:00', nombre: 'Ana' });
    expect(res.ok).toBe(false);
  });
});

describe('confirmación en dos tiempos (R4)', () => {
  it('la primera llamada a cancelar NO cancela: devuelve detalles y un token', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const primera = await run('cancelar_cita', { cita_id: id });
    expect(primera.confirmationToken).toBeTruthy();
    expect(primera.data).toMatchObject({ requiere_confirmacion: true });
    expect(((await run('consultar_mis_citas', {})).data as unknown[])).toHaveLength(1);
  });

  it('la segunda llamada con el token sí cancela', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const { confirmationToken } = await run('cancelar_cita', { cita_id: id });
    expect((await run('cancelar_cita', { cita_id: id, confirmation_token: confirmationToken })).ok).toBe(true);
    expect(((await run('consultar_mis_citas', {})).data as unknown[])).toHaveLength(0);
  });

  it('rechaza un token inventado', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    expect((await run('cancelar_cita', { cita_id: id, confirmation_token: 'inventado' })).ok).toBe(false);
  });

  it('el token de cancelar no sirve para reprogramar', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const { confirmationToken } = await run('cancelar_cita', { cita_id: id });
    const res = await run('reprogramar_cita', { cita_id: id, nuevo_inicio: '2026-09-10T11:00:00-05:00',
                                                confirmation_token: confirmationToken });
    expect(res.ok).toBe(false);
  });

  it('no cancela la cita de otro contacto ni con un token válido', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const { confirmationToken } = await run('cancelar_cita', { cita_id: id });
    const intruso = await seedContact(tenantId, '573009990000');
    expect((await run('cancelar_cita', { cita_id: id, confirmation_token: confirmationToken }, intruso)).ok).toBe(false);
  });

  it('reprogramar avisa antes de pedir confirmación si el horario nuevo no sirve', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const res = await run('reprogramar_cita', { cita_id: id, nuevo_inicio: '2026-09-13T10:00:00-05:00' }); // domingo
    expect(res.ok).toBe(false);
    expect(res.confirmationToken).toBeUndefined();
  });

  it('reprogramar con el token mueve la cita', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const args = { cita_id: id, nuevo_inicio: '2026-09-10T11:00:00-05:00' };
    const { confirmationToken } = await run('reprogramar_cita', args);
    const res = await run('reprogramar_cita', { ...args, confirmation_token: confirmationToken });
    expect(res.data).toMatchObject({ inicio: '2026-09-10T11:00:00-05:00' });
  });
});
```

- [ ] **Step 3: Correr y verlo fallar**

Run: `pnpm test apps/api/test/scheduling/tools.test.ts`
Expected: FAIL — no existe `tools/registry`.

- [ ] **Step 4: Etiquetas legibles**

`apps/api/src/scheduling/format.ts`:
```ts
import { DateTime } from 'luxon';

/** "jueves 10 de septiembre, 09:00" en la zona del negocio: lo que lee el cliente. */
export function labelFor(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).setLocale('es').toFormat("cccc d 'de' LLLL, HH:mm");
}

/** ISO-8601 con el offset del negocio, sin milisegundos: lo que reciben las herramientas. */
export function isoIn(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toISO({ suppressMilliseconds: true })!;
}
```

- [ ] **Step 5: El registro**

`apps/api/src/scheduling/tools/registry.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
// Imports de VALOR: ToolRegistry es @Injectable() y Nest los resuelve por tipo.
import { AvailabilityService } from '../availability.service';
import { BookingService } from '../booking.service';
import { SchedulingError, SlotTakenError } from '../scheduling.errors';
import { isoIn, labelFor } from '../format';

export interface ToolContext {
  /** La transacción del turno: RLS fijado y la conversación bloqueada. */
  m: EntityManager;
  tenantId: string;
  contactId: string;
  conversationId: string;
  now: Date;
}

export interface ToolResult { ok: boolean; data?: unknown; error?: string; confirmationToken?: string }

export interface ToolDefinition {
  name: string;
  /** Se le entrega al modelo en la fase del agente. */
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  destructive: boolean;
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

/** ISO-8601 que EXIGE offset (R2): nunca se adivina la zona de una fecha suelta. */
const isoWithOffset = z.string().refine(
  (v) => /([+-]\d{2}:\d{2}|Z)$/.test(v) && DateTime.fromISO(v, { setZone: true }).isValid,
  'La fecha debe incluir offset de zona, p. ej. 2026-09-10T10:00:00-05:00');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

/**
 * Token de confirmación (R4) ligado a la herramienta, la cita, quien pregunta
 * y lo que se va a aplicar: el de cancelar no sirve para reprogramar, ni el de
 * un horario para otro. Llave derivada (no la de cifrado tal cual) y sin estado
 * que guardar.
 */
function tokenFor(parts: string[]): string {
  const key = createHmac('sha256', process.env.DB_ENCRYPTION_KEY!).update('citara/tool-confirmation').digest();
  return createHmac('sha256', key).update(parts.join('|')).digest('hex').slice(0, 32);
}
function sameToken(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

@Injectable()
export class ToolRegistry {
  readonly tools: Record<string, ToolDefinition>;

  constructor(
    private readonly availability: AvailabilityService,
    private readonly booking: BookingService,
  ) {
    this.tools = Object.fromEntries(this.definitions().map((t) => [t.name, t]));
  }

  /**
   * Valida, ejecuta y normaliza. Un error de dominio vuelve como
   * `{ ok: false, error }` para que el menú (o el modelo) lo explique; cualquier
   * otro error es un fallo del sistema y se propaga: el turno se revierte y se
   * reintenta.
   */
  async run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools[name];
    if (!tool) return { ok: false, error: `Herramienta desconocida: ${name}` };
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
    try {
      return await tool.run(parsed.data, ctx);
    } catch (err) {
      if (err instanceof SlotTakenError) return { ok: false, error: 'Esa franja ya está ocupada. Ofrece otro horario.' };
      if (err instanceof SchedulingError) return { ok: false, error: err.message };
      throw err;
    }
  }

  private definitions(): ToolDefinition[] {
    const { availability, booking } = this;
    return [
      {
        name: 'consultar_servicios',
        description: 'Lista los servicios que ofrece el negocio, con duración y precio.',
        schema: z.object({}),
        destructive: false,
        async run(_args, ctx) {
          return { ok: true, data: await availability.listServices(ctx.m) };
        },
      },
      {
        name: 'consultar_disponibilidad',
        description: 'Franjas libres para un servicio. Sin fechas, los próximos 7 días.',
        schema: z.object({
          servicio_id: z.string().uuid(),
          recurso_id: z.string().uuid().optional(),
          desde: day.optional(),
          hasta: day.optional(),
          limite: z.coerce.number().int().min(1).max(50).default(20),
        }),
        destructive: false,
        async run(a, ctx) {
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          const desde = a.desde ? DateTime.fromISO(a.desde, { zone: timezone })
                                : DateTime.fromJSDate(ctx.now).setZone(timezone);
          const hasta = a.hasta ? DateTime.fromISO(a.hasta, { zone: timezone }) : desde.plus({ days: 6 });
          if (hasta < desde.startOf('day')) return { ok: false, error: 'El rango de fechas está invertido' };

          const slots = await availability.slotsFor(ctx.m, ctx.tenantId, {
            serviceId: a.servicio_id, resourceId: a.recurso_id ?? null,
            from: desde.startOf('day').toJSDate(), to: hasta.endOf('day').toJSDate(), now: ctx.now });
          return {
            ok: true,
            data: slots.slice(0, a.limite).map((x) => ({
              inicio: isoIn(x.start, timezone), fin: isoIn(x.end, timezone),
              recurso_id: x.resourceId, recurso: x.resourceName, etiqueta: labelFor(x.start, timezone),
            })),
          };
        },
      },
      {
        name: 'consultar_mis_citas',
        description: 'Lista las próximas citas confirmadas de quien escribe.',
        schema: z.object({}),
        destructive: false,
        async run(_args, ctx) {
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          const citas = await booking.listForContact(ctx.m, ctx.contactId, ctx.now);
          return {
            ok: true,
            data: citas.map((c) => ({ id: c.id, inicio: isoIn(c.startsAt, timezone), servicio: c.serviceName,
                                      recurso: c.resourceName, etiqueta: labelFor(c.startsAt, timezone) })),
          };
        },
      },
      {
        name: 'agendar_cita',
        description: 'Reserva una cita en una franja disponible.',
        schema: z.object({
          servicio_id: z.string().uuid(),
          recurso_id: z.string().uuid(),
          inicio: isoWithOffset,
          nombre: z.string().trim().min(1).max(255),
          notas: z.string().max(1000).optional(),
        }),
        destructive: false,
        async run(a, ctx) {
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          const cita = await booking.book(ctx.m, ctx.tenantId, {
            serviceId: a.servicio_id, resourceId: a.recurso_id, contactId: ctx.contactId,
            conversationId: ctx.conversationId, startsAt: new Date(a.inicio),
            customerName: a.nombre, notes: a.notas ?? null, now: ctx.now });
          return { ok: true, data: { id: cita.id, inicio: isoIn(cita.startsAt, timezone), estado: cita.status,
                                     etiqueta: labelFor(cita.startsAt, timezone) } };
        },
      },
      {
        name: 'cancelar_cita',
        description: 'Cancela una cita. Requiere confirmación explícita del usuario.',
        schema: z.object({
          cita_id: z.string().uuid(),
          confirmation_token: z.string().optional(),
          motivo: z.string().max(500).optional(),
        }),
        destructive: true,
        async run(a, ctx) {
          const expected = tokenFor(['cancelar_cita', a.cita_id, ctx.contactId]);
          const cita = await booking.findForContact(ctx.m, a.cita_id, ctx.contactId);
          if (!cita) return { ok: false, error: 'No encontré esa cita a tu nombre' };
          if (a.confirmation_token === undefined) {
            const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
            return { ok: true, confirmationToken: expected,
                     data: { requiere_confirmacion: true, etiqueta: labelFor(cita.startsAt, timezone) } };
          }
          if (!sameToken(a.confirmation_token, expected)) return { ok: false, error: 'Token de confirmación inválido' };
          await booking.cancel(ctx.m, a.cita_id, ctx.contactId);
          return { ok: true, data: { cancelada: true } };
        },
      },
      {
        name: 'reprogramar_cita',
        description: 'Mueve una cita a otro horario. Requiere confirmación explícita del usuario.',
        schema: z.object({
          cita_id: z.string().uuid(),
          nuevo_inicio: isoWithOffset,
          confirmation_token: z.string().optional(),
        }),
        destructive: true,
        async run(a, ctx) {
          const nuevo = new Date(a.nuevo_inicio);
          const expected = tokenFor(['reprogramar_cita', a.cita_id, ctx.contactId, nuevo.toISOString()]);
          const cita = await booking.findForContact(ctx.m, a.cita_id, ctx.contactId);
          if (!cita) return { ok: false, error: 'No encontré esa cita a tu nombre' };
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          if (a.confirmation_token === undefined) {
            // Se verifica ANTES de pedir confirmación: confirmar un horario que no
            // sirve haría que el usuario diga "sí" para recibir un error.
            const verdict = nuevo.getTime() === cita.startsAt.getTime() ? 'ok'
              : await availability.check(ctx.m, ctx.tenantId,
                  { serviceId: cita.serviceId, resourceId: cita.resourceId, start: nuevo, now: ctx.now });
            if (verdict !== 'ok' && verdict !== 'taken') return { ok: false, error: 'Ese horario no está disponible' };
            if (verdict === 'taken') return { ok: false, error: 'Esa franja ya está ocupada. Ofrece otro horario.' };
            return { ok: true, confirmationToken: expected,
                     data: { requiere_confirmacion: true, etiqueta: labelFor(nuevo, timezone) } };
          }
          if (!sameToken(a.confirmation_token, expected)) return { ok: false, error: 'Token de confirmación inválido' };
          const movida = await booking.reschedule(ctx.m, ctx.tenantId, a.cita_id, ctx.contactId, nuevo, ctx.now);
          return { ok: true, data: { id: movida.id, inicio: isoIn(movida.startsAt, timezone),
                                     etiqueta: labelFor(movida.startsAt, timezone) } };
        },
      },
    ];
  }
}
```

- [ ] **Step 6: Registrar y ampliar el helper**

En `app.module.ts`, importar `ToolRegistry` y añadirlo a `providers` después de `BookingService`. En `helpers.ts`, `buildScheduling` pasa a:
```ts
import { ToolRegistry } from '../src/scheduling/tools/registry';
```
```ts
export function buildScheduling() {
  const availability = new AvailabilityService();
  const booking = new BookingService(availability);
  const tools = new ToolRegistry(availability, booking);
  return { availability, booking, tools };
}
```

- [ ] **Step 7: Correr los tests**

Run: `pnpm test apps/api/test/scheduling && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/scheduling apps/api/src/app.module.ts apps/api/test/helpers.ts apps/api/test/scheduling/tools.test.ts
git commit -m "feat(scheduling): exponer la agenda como herramientas validadas con confirmación en dos tiempos"
```

---

### Task 7: Pasos `tool` y `pick`, y el flujo de agenda por menús

**Files:**
- Create: `apps/api/src/clock.ts`, `apps/api/src/flow-engine/flows/agenda.ts`
- Modify: `packages/shared/src/flow.ts`, `apps/api/src/flow-engine/executor.ts`, `apps/api/src/flow-engine/flow-runner.service.ts`, `apps/api/src/queues/inbound.processor.ts` (`persist` devuelve `contactId`), `apps/api/src/app.module.ts`
- Modify: `apps/api/test/harness/conversation-harness.ts`, `apps/api/test/flow-engine/flow-runner.test.ts` (constructor de `FlowRunner`)
- Test: `apps/api/test/flow-engine/tool-pick.test.ts`, `apps/api/test/harness/agendar-por-menus.e2e.test.ts`

**Interfaces:**
- Consumes: `ToolRegistry` (Task 6).
- Produces:
```ts
// @citara/shared, FlowStep gana:
| { type: 'tool'; tool: string; args: Record<string, string>; save_list?: string; render?: string;
    on_success: string; on_empty?: string; on_error: string }
| { type: 'pick'; text: string; from: string; var: string; next: string }
// executor.ts
export interface ExecResult { state: SessionState; outbound: OutboundContent[];
  pending?: { tool: string; args: Record<string, string>; stepKey: string } }
// clock.ts
export interface Clock { now(): Date }
export const CLOCK = Symbol('CLOCK');
export const systemClock: Clock;
// FlowRunner: constructor(ds, inbound, outboundQueue, tools: ToolRegistry, clock: Clock)
// InboundProcessor.persist → { conversationId, messageId, contactId, duplicate }
// flows/agenda.ts
export const AGENDA_FLOW: FlowDefinition;
```
Semántica de `pick`: guarda en `vars[var]` el `id` (o si no tiene, el `inicio`) del elemento elegido, y cada campo como `vars[var + '_' + campo]`. Semántica de `tool` con `save_list`: guarda la lista cruda en `vars['__' + save_list]` y la versión numerada (`1. ...`, con `render`) en `vars[save_list]`; lista vacía → `on_empty ?? on_success`. Un error de la herramienta queda en `vars.__tool_error`. **El reloj inyectable gobierna solo las decisiones de agenda**; la regla de control sigue con la hora real, porque se compara contra `now()` de Postgres.

- [ ] **Step 1: Escribir los tests del ejecutor que fallan**

`apps/api/test/flow-engine/tool-pick.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { FlowDefinition } from '@citara/shared';
import { advance } from '../../src/flow-engine/executor';

const flow: FlowDefinition = {
  key: 't', entry: 'cargar',
  steps: {
    cargar: { type: 'tool', tool: 'consultar_disponibilidad', args: { servicio_id: '{{servicio}}' },
              save_list: 'franjas', on_success: 'elegir', on_error: 'fin' },
    elegir: { type: 'pick', text: 'Elige:\n{{franjas}}', from: 'franjas', var: 'franja', next: 'fin' },
    fin: { type: 'end', text: 'Elegiste {{franja_etiqueta}}' },
  },
};
const lista = JSON.stringify([
  { inicio: '2026-09-10T09:00:00-05:00', recurso_id: 'r1', etiqueta: 'jueves 09:00' },
  { inicio: '2026-09-10T09:15:00-05:00', recurso_id: 'r2', etiqueta: 'jueves 09:15' },
]);
const enPick = { stepKey: 'elegir', status: 'active' as const,
                 vars: { __franjas: lista, franjas: '1. jueves 09:00\n2. jueves 09:15' } };

describe('advance — tool y pick', () => {
  it('un paso tool no ejecuta nada: declara la herramienta con sus argumentos interpolados', () => {
    const r = advance(flow, { stepKey: 'cargar', vars: { servicio: 's1' }, status: 'active' }, null);
    expect(r.pending).toEqual({ tool: 'consultar_disponibilidad', args: { servicio_id: 's1' }, stepKey: 'cargar' });
    expect(r.outbound).toEqual([]);
  });

  it('pick sin input muestra la lista', () => {
    expect(advance(flow, enPick, null).outbound).toEqual([{ kind: 'text', body: 'Elige:\n1. jueves 09:00\n2. jueves 09:15' }]);
  });

  it('pick guarda el elegido y cada uno de sus campos', () => {
    const r = advance(flow, enPick, '2');
    expect(r.state.vars).toMatchObject({ franja: '2026-09-10T09:15:00-05:00', franja_recurso_id: 'r2' });
    expect(r.outbound).toEqual([{ kind: 'text', body: 'Elegiste jueves 09:15' }]);
  });

  it('pick con un número fuera de la lista, o con texto, repite la pregunta', () => {
    for (const input of ['3', '0', 'el de las nueve']) {
      const r = advance(flow, enPick, input);
      expect(r.state.stepKey).toBe('elegir');
      expect(r.outbound[0]).toMatchObject({ body: expect.stringContaining('Elige:') });
    }
  });
});
```

- [ ] **Step 2: Escribir el e2e que falla**

`apps/api/test/harness/agendar-por-menus.e2e.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FlowDefinition } from '@citara/shared';
import { ConversationHarness } from './conversation-harness';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow, seedContact, adminQuery, closeHelpers } from '../helpers';

// Lunes 7 de septiembre, 22:00 en Bogotá: la primera franja es el martes 09:00 (14:00Z).
const AHORA = new Date('2026-09-08T03:00:00Z');
let h: ConversationHarness, tenantId: string, channelId: string, serviceId: string, resourceId: string;

async function start(flow: FlowDefinition = AGENDA_FLOW) {
  await seedFlow(tenantId, flow);
  h = await ConversationHarness.create({ tenantId, channelId, from: '573001112233', now: AHORA });
}
const hastaElNombre = async () => {
  await h.say('Hola');
  await h.tap('agendar');
  await h.say('1');            // servicio
  await h.say('1');            // primera franja
};

beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
});
afterAll(async () => { await ConversationHarness.teardown(); await closeHelpers(); });

describe('agendar una cita solo con menús', () => {
  it('recorre menú → servicio → franja → nombre → cita creada', async () => {
    await start();
    const servicios = await h.say('Hola').then(() => h.tap('agendar'));
    expect(servicios.at(-1)).toMatchObject({ body: expect.stringContaining('1. Corte de cabello (30 min)') });

    const franjas = await h.say('1');
    expect(franjas[0]).toMatchObject({ body: expect.stringContaining('09:00 con María') });

    await h.say('1');
    const fin = await h.say('Ana');
    expect(fin[0]).toMatchObject({ body: expect.stringMatching(/^¡Listo, Ana! Tu cita quedó para el martes .* con María\.$/) });

    const citas = await adminQuery(`SELECT starts_at, customer_name, status, conversation_id FROM appointments`);
    expect(citas).toHaveLength(1);
    expect(new Date(citas[0].starts_at).toISOString()).toBe('2026-09-08T14:00:00.000Z');
    expect([citas[0].customer_name, citas[0].status]).toEqual(['Ana', 'confirmed']);
    expect(citas[0].conversation_id).toBeTruthy();
  });

  it('si la franja se ocupa entre la elección y la reserva, lo dice sin romper el turno', async () => {
    await start();
    await hastaElNombre();
    const otro = await seedContact(tenantId, '573000000000');
    await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, '2026-09-08T14:00:00Z', '2026-09-08T14:30:00Z')`,
      [tenantId, resourceId, serviceId, otro]);

    const fin = await h.say('Ana');
    expect(fin[0]).toMatchObject({ body: expect.stringContaining('se acaba de ocupar') });
  });

  it('si el turno falla después de agendar, la cita no queda creada', async () => {
    await start({ ...AGENDA_FLOW, steps: { ...AGENDA_FLOW.steps,
      reservar: { ...(AGENDA_FLOW.steps.reservar as any), on_success: 'paso_que_no_existe' } } });
    await hastaElNombre();

    await expect(h.say('Ana')).rejects.toThrow(/Paso inexistente/);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM appointments`);
    expect(n).toBe(0);
  });

  it('elegir un número fuera de la lista repite la pregunta', async () => {
    await start();
    await h.say('Hola'); await h.tap('agendar');
    const res = await h.say('99');
    expect(res[0]).toMatchObject({ body: expect.stringContaining('¿Qué servicio necesitas?') });
  });

  it('sin horarios libres lo dice en vez de mostrar una lista vacía', async () => {
    await adminQuery(`DELETE FROM business_hours`);
    await start();
    await h.say('Hola'); await h.tap('agendar');
    const res = await h.say('1');
    expect(res[0]).toMatchObject({ body: expect.stringContaining('No encontré horarios libres') });
  });

  it('mis citas lista las próximas', async () => {
    await start();
    await hastaElNombre();
    await h.say('Ana');
    await h.say('Hola');
    const res = await h.tap('mis_citas');
    expect(res[0]).toMatchObject({ body: expect.stringContaining('Corte de cabello') });
  });
});
```

- [ ] **Step 3: Correr y verlos fallar**

Run: `pnpm test apps/api/test/flow-engine/tool-pick.test.ts apps/api/test/harness/agendar-por-menus.e2e.test.ts`
Expected: FAIL — `advance` no conoce `tool` ni `pick`; no existe `flows/agenda`.

- [ ] **Step 4: Tipos de paso**

En `packages/shared/src/flow.ts`, añadir a la unión `FlowStep` (antes del `;` final):
```ts
  | { type: 'tool'; tool: string; args: Record<string, string>; save_list?: string; render?: string;
      on_success: string; on_empty?: string; on_error: string }
  | { type: 'pick'; text: string; from: string; var: string; next: string }
```

- [ ] **Step 5: El ejecutor**

En `apps/api/src/flow-engine/executor.ts`, ampliar `ExecResult`:
```ts
export interface ExecResult {
  state: SessionState;
  outbound: OutboundContent[];
  /** Intención de invocar una herramienta. El ejecutor sigue siendo PURO: no la ejecuta. */
  pending?: { tool: string; args: Record<string, string>; stepKey: string };
}
```
e insertar antes del bloque `if (step.type === 'handoff')`:
```ts
    if (step.type === 'tool') {
      const args = Object.fromEntries(
        Object.entries(step.args).map(([k, v]) => [k, interpolate(v, current.vars)]));
      return { state: current, outbound, pending: { tool: step.tool, args, stepKey: current.stepKey } };
    }

    if (step.type === 'pick') {
      const options: Record<string, unknown>[] = JSON.parse(current.vars[`__${step.from}`] ?? '[]');
      const index = input !== null && /^\d+$/.test(input.trim()) ? Number(input.trim()) - 1 : -1;
      if (index < 0 || index >= options.length) {
        // Sin input (primera vez) o fuera de la lista: mostrar o repetir la pregunta.
        outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
        return { state: current, outbound };
      }
      const chosen = options[index];
      const fields = Object.fromEntries(
        Object.entries(chosen).map(([k, v]) => [`${step.var}_${k}`, String(v)]));
      current = {
        ...current,
        vars: { ...current.vars, ...fields, [step.var]: String(chosen.id ?? chosen.inicio ?? '') },
        stepKey: step.next,
      };
      input = null;
      continue;
    }
```

- [ ] **Step 6: El reloj y el flujo de agenda**

`apps/api/src/clock.ts`:
```ts
/**
 * Hora para las decisiones de AGENDA (qué franjas ofrecer, si una cita está a
 * tiempo). Inyectable para que los tests fijen el día. La regla de control no
 * lo usa: compara contra now() de Postgres y debe ir con la hora real.
 */
export interface Clock { now(): Date }
export const CLOCK = Symbol('CLOCK');
export const systemClock: Clock = { now: () => new Date() };
```

`apps/api/src/flow-engine/flows/agenda.ts`:
```ts
import type { FlowDefinition } from '@citara/shared';

/** El flujo de menús que se entrega a cada negocio (`tenant:apply` con `flow: agenda`). */
export const AGENDA_FLOW: FlowDefinition = {
  key: 'agenda',
  entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Soy el asistente de citas 👋', next: 'menu' },
    menu: {
      type: 'choice', kind: 'interactive_buttons', text: '¿Qué necesitas?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita', next: 'cargar_servicios' },
        { id: 'mis_citas', title: 'Mis citas', next: 'cargar_citas' },
        { id: 'asesor', title: 'Hablar con alguien', next: 'humano' },
      ],
    },
    cargar_servicios: {
      type: 'tool', tool: 'consultar_servicios', args: {},
      save_list: 'servicios', render: '{{nombre}} ({{duracion_min}} min)',
      on_success: 'elegir_servicio', on_empty: 'sin_servicios', on_error: 'error',
    },
    elegir_servicio: {
      type: 'pick', text: '¿Qué servicio necesitas? Responde con el número.\n{{servicios}}',
      from: 'servicios', var: 'servicio', next: 'cargar_franjas',
    },
    cargar_franjas: {
      type: 'tool', tool: 'consultar_disponibilidad', args: { servicio_id: '{{servicio}}', limite: '9' },
      save_list: 'franjas', render: '{{etiqueta}} con {{recurso}}',
      on_success: 'elegir_franja', on_empty: 'sin_franjas', on_error: 'error',
    },
    elegir_franja: {
      type: 'pick', text: 'Estos son los próximos horarios. Responde con el número.\n{{franjas}}',
      from: 'franjas', var: 'franja', next: 'pide_nombre',
    },
    pide_nombre: { type: 'capture', text: '¿A nombre de quién agendo la cita?', var: 'nombre', validate: 'text', next: 'reservar' },
    reservar: {
      type: 'tool', tool: 'agendar_cita',
      args: { servicio_id: '{{servicio}}', recurso_id: '{{franja_recurso_id}}', inicio: '{{franja_inicio}}', nombre: '{{nombre}}' },
      on_success: 'confirmada', on_error: 'ocupada',
    },
    confirmada: { type: 'end', text: '¡Listo, {{nombre}}! Tu cita quedó para el {{franja_etiqueta}} con {{franja_recurso}}.' },
    ocupada: { type: 'end', text: 'Ese horario se acaba de ocupar. Escríbenos de nuevo y te muestro otros.' },
    cargar_citas: {
      type: 'tool', tool: 'consultar_mis_citas', args: {},
      save_list: 'citas', render: '{{etiqueta}} — {{servicio}} con {{recurso}}',
      on_success: 'mostrar_citas', on_empty: 'sin_citas', on_error: 'error',
    },
    mostrar_citas: { type: 'end', text: 'Tus próximas citas:\n{{citas}}' },
    sin_citas: { type: 'end', text: 'No tienes citas próximas.' },
    sin_servicios: { type: 'end', text: 'Por ahora no hay servicios para agendar.' },
    sin_franjas: { type: 'end', text: 'No encontré horarios libres en los próximos días. Escríbenos y te ayudamos.' },
    humano: { type: 'handoff', text: 'Te comunico con alguien del equipo.' },
    error: { type: 'end', text: 'Tuvimos un problema. Intenta de nuevo más tarde.' },
  },
};
```

- [ ] **Step 7: `persist` devuelve el contacto**

En `apps/api/src/queues/inbound.processor.ts`:
- el tipo de retorno de `persist` pasa a `Promise<{ conversationId: string; messageId: string; contactId: string; duplicate: boolean }>`;
- la consulta del duplicado temprano pasa a
```ts
    const [seen] = await m.query(
      `SELECT msg.id, msg.conversation_id, c.contact_id
         FROM messages msg JOIN conversations c ON c.id = msg.conversation_id
        WHERE msg.wamid = $1`, [message.wamid]);
    if (seen) return { conversationId: seen.conversation_id, messageId: seen.id, contactId: seen.contact_id, duplicate: true };
```
- los dos `return` restantes ganan `contactId: contact.id`.

- [ ] **Step 8: `FlowRunner` ejecuta las herramientas en la transacción del turno**

En `apps/api/src/flow-engine/flow-runner.service.ts`:
- imports:
```ts
import type { FlowStep } from '@citara/shared';
import { ToolRegistry } from '../scheduling/tools/registry';
import { CLOCK, type Clock } from '../clock';
import { interpolate } from './executor';
```
- constructor:
```ts
  constructor(
    private readonly ds: DataSource,
    private readonly inbound: InboundProcessor,
    @Inject(OutboundQueue) private readonly outboundQueue: OutboundEnqueuer,
    private readonly tools: ToolRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
```
- la llamada `this.advanceFlow(m, job, inbound.conversationId, inbound.messageId)` pasa a `this.advanceFlow(m, job, inbound)`, y la firma a
```ts
  private async advanceFlow(
    m: EntityManager, job: InboundJob,
    inbound: { conversationId: string; messageId: string; contactId: string },
  ): Promise<{ outbound: OutboundContent[]; enteredHandoff: boolean }> {
    const { conversationId, messageId: inboundId } = inbound;
```
- la línea `const result = advance(flow, state, input);` se reemplaza por:
```ts
    let result = advance(flow, state, input);
    // Las herramientas corren aquí, en la transacción del turno: si algo falla
    // después de agendar, el rollback se lleva también la cita.
    for (let hop = 0; result.pending; hop++) {
      if (hop >= MAX_TOOL_HOPS) throw new Error(`Cadena de herramientas demasiado larga en el flujo '${flow.key}'`);
      const { tool, args, stepKey } = result.pending;
      const step = flow.steps[stepKey] as Extract<FlowStep, { type: 'tool' }>;
      const out = await this.tools.run(tool, args, {
        m, tenantId: job.tenantId, contactId: inbound.contactId, conversationId, now: this.clock.now() });

      const vars = { ...result.state.vars };
      let next = out.ok ? step.on_success : step.on_error;
      if (!out.ok) vars.__tool_error = out.error ?? '';
      if (out.ok && step.save_list && Array.isArray(out.data)) {
        const items = out.data as Record<string, unknown>[];
        vars[`__${step.save_list}`] = JSON.stringify(items);
        vars[step.save_list] = items
          .map((it, i) => `${i + 1}. ${interpolate(step.render ?? '{{id}}',
            Object.fromEntries(Object.entries(it).map(([k, v]) => [k, String(v)])))}`)
          .join('\n');
        if (items.length === 0) next = step.on_empty ?? step.on_success;
      }
      const after = advance(flow, { ...result.state, vars, stepKey: next }, null);
      result = { ...after, outbound: [...result.outbound, ...after.outbound] };
    }
```
  y, junto a los demás imports del archivo, la constante `const MAX_TOOL_HOPS = 5;`.

En `apps/api/src/app.module.ts`, importar `CLOCK, systemClock` y añadir a `providers`:
```ts
    // Hora para las decisiones de agenda; los tests la fijan.
    { provide: CLOCK, useValue: systemClock },
```

- [ ] **Step 9: El arnés y los tests que construyen `FlowRunner` a mano**

En `apps/api/test/harness/conversation-harness.ts`, `create` acepta un `now` opcional y cablea las herramientas:
```ts
import { buildScheduling } from '../helpers';
import { systemClock, type Clock } from '../../src/clock';
```
```ts
  static async create(ctx: { tenantId: string; channelId: string; from: string; now?: Date }) {
    if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
    const clock: Clock = ctx.now ? { now: () => ctx.now! } : systemClock;
    const runner = new FlowRunner(ds, new InboundProcessor(ds), new FakeOutboundQueue(),
                                  buildScheduling().tools, clock);
    return new ConversationHarness(runner, ctx);
  }
```
En `apps/api/test/flow-engine/flow-runner.test.ts`, la construcción pasa a
`runner = new FlowRunner(ds, new InboundProcessor(ds), queue, buildScheduling().tools, systemClock);` (importando `buildScheduling` de `../helpers` y `systemClock` de `../../src/clock`).

- [ ] **Step 10: Correr los tests**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde, incluidos los e2e del motor de la Fase 1 y el pipeline.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/flow.ts apps/api/src/clock.ts apps/api/src/flow-engine apps/api/src/queues/inbound.processor.ts apps/api/src/app.module.ts apps/api/test/harness apps/api/test/flow-engine
git commit -m "feat(flow-engine): agendar por menús invocando las herramientas dentro del turno"
```

---

### Task 8: Plantillas en el contrato de salida

**Files:**
- Modify: `packages/shared/src/outbound-message.ts`, `apps/api/src/conversations/session-window.ts`, `apps/api/src/whatsapp/sender.ts`, `apps/api/src/flow-engine/flow-runner.service.ts`
- Create: `apps/api/src/conversations/message-type.ts`
- Test: `apps/api/test/whatsapp/sender.test.ts`, `apps/api/test/conversations/session-window.test.ts`

**Interfaces:**
- Produces: `OutboundContent` gana `{ kind: 'template'; name: string; language: string; params: string[] }`; `requiresOpenWindow(template) === false`; `messageTypeOf(content): 'text' | 'interactive' | 'template'`; `MetaSender` arma el cuerpo de plantilla.

- [ ] **Step 1: Escribir los tests que fallan**

En `apps/api/test/whatsapp/sender.test.ts`, dentro del `describe` principal:
```ts
  it('arma una plantilla con sus parámetros de cuerpo', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'template', name: 'recordatorio_cita_24h', language: 'es', params: ['Ana', 'jueves 10:00', 'Corte'] });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233',
      type: 'template',
      template: { name: 'recordatorio_cita_24h', language: { code: 'es' },
        components: [{ type: 'body', parameters: [
          { type: 'text', text: 'Ana' }, { type: 'text', text: 'jueves 10:00' }, { type: 'text', text: 'Corte' }] }] },
    });
  });
```
En `apps/api/test/conversations/session-window.test.ts`, dentro de `describe('requiresOpenWindow', ...)`:
```ts
  it('una plantilla puede salir fuera de la ventana: para eso existen', () => {
    expect(requiresOpenWindow({ kind: 'template', name: 'x', language: 'es', params: [] })).toBe(false);
  });
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm typecheck; pnpm test apps/api/test/whatsapp/sender.test.ts apps/api/test/conversations`
Expected: el typecheck falla en `requiresOpenWindow` (el `switch` exhaustivo no cubre `template`: es la trampa que se dejó a propósito) y los tests fallan.

- [ ] **Step 3: Implementar**

`packages/shared/src/outbound-message.ts`, añadir a la unión:
```ts
  | { kind: 'template'; name: string; language: string; params: string[] }
```
`apps/api/src/conversations/session-window.ts`, en el `switch`:
```ts
    case 'template':
      // Las plantillas aprobadas por Meta son justo lo que puede salir fuera de las 24 h.
      return false;
```
`apps/api/src/conversations/message-type.ts`:
```ts
import type { OutboundContent } from '@citara/shared';

/** `messages.type` con el vocabulario de Meta, igual que el entrante. */
export function messageTypeOf(content: OutboundContent): 'text' | 'interactive' | 'template' {
  if (content.kind === 'text') return 'text';
  if (content.kind === 'template') return 'template';
  return 'interactive';
}
```
`apps/api/src/whatsapp/sender.ts`, en `buildBody`, después del caso `text`:
```ts
    if (content.kind === 'template') {
      return {
        ...base,
        type: 'template',
        template: {
          name: content.name,
          language: { code: content.language },
          components: content.params.length
            ? [{ type: 'body', parameters: content.params.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      };
    }
```
`apps/api/src/flow-engine/flow-runner.service.ts`: importar `messageTypeOf` y, en el INSERT de salientes, reemplazar `const type = content.kind === 'text' ? 'text' : 'interactive';` por `const type = messageTypeOf(content);` y el parámetro `content.body` por `'body' in content ? content.body : null`.

- [ ] **Step 4: Correr los tests**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/outbound-message.ts apps/api/src/conversations apps/api/src/whatsapp/sender.ts apps/api/src/flow-engine/flow-runner.service.ts apps/api/test/whatsapp/sender.test.ts apps/api/test/conversations/session-window.test.ts
git commit -m "feat(whatsapp): enviar plantillas aprobadas, las únicas que pueden salir fuera de la ventana"
```

---

### Task 9: Recordatorios por el outbox

**Trabajo externo que arranca aquí:** enviar a aprobación de Meta las plantillas `recordatorio_cita_24h` y `recordatorio_cita_2h` (categoría UTILITY, idioma `es`), cada una con tres parámetros de cuerpo en este orden: nombre del cliente, fecha y hora, servicio. La aprobación tarda de horas a días: se radica al empezar la tarea.

**Files:**
- Create: migraciones `1725400600000-CreateReminders.ts`, `1725400700000-AddReminderOriginToMessages.ts`
- Create: `apps/api/src/scheduling/reminders.service.ts`, `apps/api/src/queues/reminders.queue.ts`
- Modify: `apps/api/src/queues/outbound.queue.ts` (`OutboundJob` por turno o por mensaje), `apps/api/src/queues/outbound.processor.ts`, `apps/api/src/scheduling/booking.service.ts`, `apps/api/src/queues/workers.ts`, `apps/api/src/app.module.ts`, `apps/api/test/helpers.ts`, `packages/db/test/rls-inventory.test.ts`
- Test: `apps/api/test/scheduling/reminders.test.ts`, `apps/api/test/queues/outbound.processor.test.ts`

**Interfaces:**
- Consumes: `BookingService` (Task 5), plantillas (Task 8), outbox (Fase 1).
- Produces:
```ts
// outbound.queue.ts
interface OutboundTarget { tenantId: string; channelId: string; conversationId: string; to: string }
export interface TurnOutboundJob extends OutboundTarget { turnId: string }
export interface MessageOutboundJob extends OutboundTarget { messageId: string }
export type OutboundJob = TurnOutboundJob | MessageOutboundJob;
OutboundQueue.add(job: OutboundJob, opts?: { delay?: number })
// reminders.service.ts
export const REMINDER_TEMPLATES: { '24h': 'recordatorio_cita_24h'; '2h': 'recordatorio_cita_2h' };
class RemindersService {
  constructor(ds: DataSource)
  scheduleFor(m, tenantId, appointmentId: string, startsAt: Date, now: Date): Promise<void>;
  cancelFor(m, appointmentId: string): Promise<void>;
  sweep(now: Date): Promise<{ job: MessageOutboundJob; delay: number }[]>;
}
// BookingService: constructor(availability, reminders: RemindersService)
// reminders.queue.ts
export const REMINDERS_QUEUE = 'reminders';
class RemindersQueue { schedule(): Promise<unknown> } // barrido cada 60 s
// startWorkers(ctx, { concurrency?, scheduleReminders? = true })
```
Estados de `reminders.status`: `pending` → `queued` (con `message_id`) o `cancelled`. El estado de entrega vive en el mensaje.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/scheduling/reminders.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { RemindersService } from '../../src/scheduling/reminders.service';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let s: ReturnType<typeof buildScheduling>;
let tenantId: string, channelId: string, serviceId: string, resourceId: string, contactId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const CITA = new Date('2026-09-10T15:00:00Z');
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const agendar = (startsAt = CITA) => inTenant((m) => s.booking.book(m, tenantId,
  { serviceId, resourceId, contactId, startsAt, customerName: 'Ana', now: AHORA }));
const reminders = (appointmentId?: string) => adminQuery(
  `SELECT kind, send_at, status, message_id FROM reminders
    ${appointmentId ? 'WHERE appointment_id = $1' : ''} ORDER BY send_at`, appointmentId ? [appointmentId] : []);

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  s = buildScheduling(app);
});

describe('programación', () => {
  it('agendar programa los recordatorios de 24 h y 2 h', async () => {
    const cita = await agendar();
    const rows = await reminders(cita.id);
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['24h', '2h']);
    expect(new Date(rows[0].send_at).toISOString()).toBe('2026-09-09T15:00:00.000Z');
    expect(new Date(rows[1].send_at).toISOString()).toBe('2026-09-10T13:00:00.000Z');
  });

  it('no programa un recordatorio cuyo momento ya pasó', async () => {
    const cita = await agendar(new Date('2026-09-08T15:00:00Z')); // en 3 horas
    expect((await reminders(cita.id)).map((r: { kind: string }) => r.kind)).toEqual(['2h']);
  });

  it('cancelar la cita cancela sus recordatorios', async () => {
    const cita = await agendar();
    await inTenant((m) => s.booking.cancel(m, cita.id, contactId));
    expect((await reminders(cita.id)).every((r: { status: string }) => r.status === 'cancelled')).toBe(true);
  });

  it('reprogramar cancela los de la hora vieja y programa los de la nueva', async () => {
    const cita = await agendar();
    const nueva = await inTenant((m) => s.booking.reschedule(
      m, tenantId, cita.id, contactId, new Date('2026-09-11T15:00:00Z'), AHORA));
    expect((await reminders(cita.id)).map((r: { status: string }) => r.status)).toEqual(['cancelled', 'cancelled']);
    expect((await reminders(nueva.id)).map((r: { status: string }) => r.status)).toEqual(['pending', 'pending']);
  });
});

describe('barrido', () => {
  it('deja un mensaje plantilla pendiente en la conversación y marca el recordatorio', async () => {
    const cita = await agendar();
    const jobs = await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));

    expect(jobs).toHaveLength(1);
    const [msg] = await adminQuery(`SELECT origin, type, status, payload, conversation_id FROM messages`);
    expect(msg).toMatchObject({ origin: 'reminder', type: 'template', status: 'pending' });
    expect(msg.payload).toMatchObject({ kind: 'template', name: 'recordatorio_cita_24h', language: 'es' });
    expect(msg.payload.params[0]).toBe('Ana');
    expect(jobs[0].job).toMatchObject({ tenantId, channelId, conversationId: msg.conversation_id, to: '573001112233' });
    const [r] = await reminders(cita.id);
    expect(r.status).toBe('queued');
  });

  it('un segundo barrido no duplica', async () => {
    await agendar();
    await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));
    expect(await s.reminders.sweep(new Date('2026-09-09T15:02:00Z'))).toEqual([]);
  });

  it('vuelve a encolar un recordatorio que quedó sin enviar', async () => {
    // El barrido guardó el mensaje pero el encolado posterior falló.
    await agendar();
    await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));
    await adminQuery(`UPDATE messages SET created_at = now() - interval '10 minutes'`);
    const again = await s.reminders.sweep(new Date('2026-09-09T15:02:00Z'));
    expect(again).toHaveLength(1);
  });

  it('reparte los envíos de un canal a no más de 10 por segundo', async () => {
    // 25 citas de 30 min: jueves 10, viernes 11 y lunes 14 (el 12 es sábado, sin horario).
    for (let i = 0; i < 25; i++) {
      const otro = await seedContact(tenantId, `5730000000${String(i).padStart(2, '0')}`);
      const day = [10, 11, 14][Math.floor(i / 9)], slot = i % 9;
      await inTenant((m) => s.booking.book(m, tenantId, { serviceId, resourceId, contactId: otro,
        startsAt: new Date(Date.UTC(2026, 8, day, 14 + slot)), customerName: `C${i}`, now: AHORA }));
    }
    const jobs = await s.reminders.sweep(new Date('2026-09-15T00:00:00Z')); // todo vencido
    const delays = jobs.map((j) => j.delay);
    expect(delays.filter((d) => d === 0)).toHaveLength(10);
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(4000); // 50 recordatorios → 5 segundos
  });
});
```
En `apps/api/test/queues/outbound.processor.test.ts`, antes del test del canal inexistente:
```ts
  it('un recordatorio sale fuera de la ventana y aunque el dueño esté atendiendo', async () => {
    const job = await seedTurn([HOLA], `now() - interval '3 days'`);
    const [row] = await adminQuery(`SELECT id FROM messages WHERE direction = 'out'`);
    await adminQuery(`UPDATE messages SET origin = 'reminder', type = 'template',
      payload = '{"kind":"template","name":"recordatorio_cita_24h","language":"es","params":[]}' WHERE id = $1`, [row.id]);
    await humanTookOver('phone');

    await processor.process({ tenantId: job.tenantId, channelId: job.channelId,
                              conversationId: job.conversationId, to: job.to, messageId: row.id });

    expect(sender.send.mock.calls[0][2]).toMatchObject({ kind: 'template' });
    expect((await outRows()).map((r) => r.status)).toEqual(['sent']);
  });
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/scheduling/reminders.test.ts apps/api/test/queues/outbound.processor.test.ts`
Expected: FAIL — no existe `RemindersService` ni la tabla; el processor no acepta `messageId`.

- [ ] **Step 3: Migraciones**

`packages/db/src/migrations/1725400600000-CreateReminders.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Recordatorios de cita. Al vencer, el barrido los convierte en un mensaje
 * plantilla `pending` (outbox) y guarda su `message_id`: el estado de entrega
 * vive en el mensaje, no aquí.
 */
export class CreateReminders1725400600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE reminders (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        kind           varchar(8) NOT NULL CHECK (kind IN ('24h', '2h')),
        send_at        timestamptz NOT NULL,
        status         varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'cancelled')),
        message_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (appointment_id, kind)
      )
    `);
    await q.query(`CREATE INDEX reminders_due ON reminders (send_at) WHERE status = 'pending'`);
    for (const sql of tenantRlsSql('reminders')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE reminders`);
  }
}
```

`packages/db/src/migrations/1725400700000-AddReminderOriginToMessages.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `origin='reminder'`: lo envía el sistema por agenda, no como respuesta de un
 * turno. Por eso no queda `superseded` cuando el dueño está atendiendo (spec §6.3).
 */
export class AddReminderOriginToMessages1725400700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE messages DROP CONSTRAINT messages_origin_check,
        ADD CONSTRAINT messages_origin_check
          CHECK (origin IN ('customer', 'bot', 'phone', 'operator', 'history', 'reminder'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE messages DROP CONSTRAINT messages_origin_check,
        ADD CONSTRAINT messages_origin_check
          CHECK (origin IN ('customer', 'bot', 'phone', 'operator', 'history'))
    `);
  }
}
```
En `PRESUPUESTO`: `reminders: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],`. En `resetDb`, añadir `reminders` al `TRUNCATE` (al principio de la lista). En `packages/db/src/entities/message.entity.ts`, el tipo de `origin` gana `| 'reminder'`.

- [ ] **Step 4: Jobs por turno o por mensaje**

En `apps/api/src/queues/outbound.queue.ts`, reemplazar la interfaz `OutboundJob` por:
```ts
interface OutboundTarget {
  tenantId: string;
  channelId: string;
  conversationId: string;
  to: string;
}

/** Las respuestas de un turno: las filas con reply_to_id = turnId, en orden de seq. */
export interface TurnOutboundJob extends OutboundTarget { turnId: string }

/** Un envío suelto (un recordatorio): la fila con id = messageId. */
export interface MessageOutboundJob extends OutboundTarget { messageId: string }

export type OutboundJob = TurnOutboundJob | MessageOutboundJob;

export const outboundJobId = (job: OutboundJob) => ('turnId' in job ? job.turnId : job.messageId);
```
y `add` pasa a:
```ts
  add(job: OutboundJob, opts: { delay?: number } = {}) {
    // jobId = el uuid del turno o del mensaje (BullMQ rechaza ids con `:`).
    return this.queue.add('send-turn', job, { jobId: outboundJobId(job), delay: opts.delay });
  }
```
En `apps/api/src/queues/outbound.processor.ts`:
- `const { tenantId, channelId, turnId, to } = job;` pasa a `const { tenantId, channelId, to } = job;` y, justo después,
```ts
    // Qué filas son de este job: las de un turno, o un mensaje suelto.
    const [column, key] = 'turnId' in job ? ['reply_to_id', job.turnId] : ['id', job.messageId];
```
- en la consulta de filas, `WHERE reply_to_id = $1 AND direction = 'out'` pasa a `` WHERE ${column} = $1 AND direction = 'out' `` y el parámetro `turnId` pasa a `key`;
- `failPending(tenantId, turnId)` y `closePending(tenantId, turnId, ...)` reciben `job` en lugar de `turnId`, y su SQL usa la misma selección:
```ts
  private closePending(job: OutboundJob, to: 'failed' | 'window_closed') {
    const [column, key] = 'turnId' in job ? ['reply_to_id', job.turnId] : ['id', job.messageId];
    return runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE messages SET status = $2 WHERE ${column} = $1 AND status = 'pending'`, [key, to]));
  }
```
  (`failPending(job)` llama a `closePending(job, 'failed')`; `failTurn(job)` llama a `failPending(job)`).

- [ ] **Step 5: El servicio de recordatorios**

`apps/api/src/scheduling/reminders.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { OutboundContent } from '@citara/shared';
import { runInTenant } from '../tenancy/tenant-context';
import type { MessageOutboundJob } from '../queues/outbound.queue';
import { labelFor } from './format';

/** Deben estar APROBADAS en Meta con tres parámetros: nombre, fecha y hora, servicio. */
export const REMINDER_TEMPLATES = { '24h': 'recordatorio_cita_24h', '2h': 'recordatorio_cita_2h' } as const;
const OFFSETS = [{ kind: '24h', minutes: 24 * 60 }, { kind: '2h', minutes: 2 * 60 }] as const;
/** Por debajo del tope de 20 mensajes por segundo de un número en coexistencia. */
const PER_CHANNEL_PER_SECOND = 10;
/** Un recordatorio pendiente más viejo que esto se considera huérfano del encolado. */
const ORPHAN_AFTER = `2 minutes`;

@Injectable()
export class RemindersService {
  constructor(private readonly ds: DataSource) {}

  async scheduleFor(m: EntityManager, tenantId: string, appointmentId: string, startsAt: Date, now: Date) {
    for (const o of OFFSETS) {
      const sendAt = new Date(startsAt.getTime() - o.minutes * 60_000);
      if (sendAt <= now) continue; // ya pasó: no se programa
      await m.query(
        `INSERT INTO reminders (tenant_id, appointment_id, kind, send_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (appointment_id, kind) DO NOTHING`, [tenantId, appointmentId, o.kind, sendAt]);
    }
  }

  async cancelFor(m: EntityManager, appointmentId: string) {
    await m.query(
      `UPDATE reminders SET status = 'cancelled' WHERE appointment_id = $1 AND status = 'pending'`, [appointmentId]);
  }

  /**
   * Convierte los recordatorios vencidos de todos los negocios en mensajes
   * plantilla `pending` (outbox) y devuelve los jobs a encolar, con su retraso.
   *
   * Itera negocios en vez de un SELECT global porque `reminders` tiene RLS: sin
   * `app.tenant_id` devuelve cero filas (D2). Un barrido global exigiría una
   * conexión privilegiada, que es justo como se filtran datos entre clientes.
   */
  async sweep(now: Date): Promise<{ job: MessageOutboundJob; delay: number }[]> {
    // `tenants` es la raíz y no lleva RLS: es la única lectura sin contexto.
    const tenants: { id: string; timezone: string }[] =
      await this.ds.query(`SELECT id, timezone FROM tenants WHERE status = 'active'`);

    const jobs: MessageOutboundJob[] = [];
    for (const t of tenants) {
      jobs.push(...await runInTenant(this.ds, t.id, (m) => this.sweepTenant(m, t.id, t.timezone, now)));
    }

    // Reparto por canal: un lote grande no puede salir de golpe.
    const perChannel = new Map<string, number>();
    return jobs.map((job) => {
      const i = perChannel.get(job.channelId) ?? 0;
      perChannel.set(job.channelId, i + 1);
      return { job, delay: Math.floor(i / PER_CHANNEL_PER_SECOND) * 1000 };
    });
  }

  private async sweepTenant(m: EntityManager, tenantId: string, timezone: string, now: Date) {
    const jobs: MessageOutboundJob[] = [];
    // SKIP LOCKED: dos workers barriendo a la vez no toman el mismo recordatorio.
    const due = await m.query(
      `SELECT r.id, r.kind, a.starts_at, a.status AS appointment_status, a.conversation_id,
              a.customer_name, a.contact_id, k.wa_id, k.name AS contact_name, s.name AS service_name
         FROM reminders r
         JOIN appointments a ON a.id = r.appointment_id
         JOIN contacts k ON k.id = a.contact_id
         JOIN services s ON s.id = a.service_id
        WHERE r.status = 'pending' AND r.send_at <= $1
        ORDER BY r.send_at
        LIMIT 500
        FOR UPDATE OF r SKIP LOCKED`, [now]);

    for (const row of due) {
      if (row.appointment_status !== 'confirmed') {
        await m.query(`UPDATE reminders SET status = 'cancelled' WHERE id = $1`, [row.id]);
        continue;
      }
      const conv = await this.conversationFor(m, tenantId, row.conversation_id, row.contact_id);
      if (!conv) continue; // sin canal activo: queda pendiente para el próximo barrido

      const content: OutboundContent = {
        kind: 'template',
        name: REMINDER_TEMPLATES[row.kind as '24h' | '2h'],
        language: 'es',
        params: [row.customer_name || row.contact_name || 'cliente', labelFor(row.starts_at, timezone), row.service_name],
      };
      const [msg] = await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, payload, status)
         VALUES ($1, $2, 'out', 'reminder', 'template', $3, 'pending') RETURNING id`,
        [tenantId, conv.id, JSON.stringify(content)]);
      await m.query(`UPDATE reminders SET status = 'queued', message_id = $2 WHERE id = $1`, [row.id, msg.id]);
      jobs.push({ tenantId, channelId: conv.channelId, conversationId: conv.id, to: row.wa_id, messageId: msg.id });
    }

    // Outbox: un recordatorio guardado cuyo encolado falló se vuelve a encolar.
    const orphans = await m.query(
      `SELECT msg.id, msg.conversation_id, c.channel_id, k.wa_id
         FROM messages msg
         JOIN conversations c ON c.id = msg.conversation_id
         JOIN contacts k ON k.id = c.contact_id
        WHERE msg.origin = 'reminder' AND msg.status = 'pending'
          AND msg.created_at < now() - interval '${ORPHAN_AFTER}'`);
    for (const o of orphans) {
      jobs.push({ tenantId, channelId: o.channel_id, conversationId: o.conversation_id, to: o.wa_id, messageId: o.id });
    }
    return jobs;
  }

  /** La conversación de la cita si sigue abierta; si no, la abierta del contacto; si no, una nueva. */
  private async conversationFor(m: EntityManager, tenantId: string, conversationId: string | null, contactId: string) {
    const [current] = await m.query(
      `SELECT id, channel_id FROM conversations
        WHERE status = 'open' AND (id = $1 OR contact_id = $2)
        ORDER BY (id = $1) DESC, updated_at DESC LIMIT 1`, [conversationId, contactId]);
    if (current) return { id: current.id as string, channelId: current.channel_id as string };

    // whatsapp_channels no lleva RLS: se filtra por tenant explícitamente.
    const [channel] = await m.query(
      `SELECT id FROM whatsapp_channels WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
      [tenantId]);
    if (!channel) return null;
    const [created] = await m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed' DO UPDATE SET updated_at = now()
       RETURNING id`, [tenantId, contactId, channel.id]);
    return { id: created.id as string, channelId: channel.id as string };
  }
}
```

- [ ] **Step 6: Las reservas programan y cancelan recordatorios**

En `apps/api/src/scheduling/booking.service.ts`:
- importar `import { RemindersService } from './reminders.service';` (valor) y el constructor pasa a
  `constructor(private readonly availability: AvailabilityService, private readonly reminders: RemindersService) {}`;
- en `book`, después de `RELEASE SAVEPOINT reservar_cita`:
```ts
      const cita = toAppointment(row);
      await this.reminders.scheduleFor(m, tenantId, cita.id, cita.startsAt, input.now);
      return cita;
```
  (en lugar de `return toAppointment(row);`);
- en `cancel`, antes del `return`: `await this.reminders.cancelFor(m, appointmentId);`.

En `apps/api/test/helpers.ts`, `buildScheduling` recibe la `DataSource` de la app:
```ts
import type { DataSource } from 'typeorm';
import { RemindersService } from '../src/scheduling/reminders.service';
```
```ts
export function buildScheduling(ds?: DataSource) {
  const availability = new AvailabilityService();
  // El barrido necesita la DataSource; programar y cancelar usan el EntityManager del llamador.
  const reminders = new RemindersService(ds as DataSource);
  const booking = new BookingService(availability, reminders);
  const tools = new ToolRegistry(availability, booking);
  return { availability, reminders, booking, tools };
}
```
En `app.module.ts`, importar y registrar `RemindersService` antes de `BookingService`.

- [ ] **Step 7: La cola de recordatorios y su worker**

`apps/api/src/queues/reminders.queue.ts`:
```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export const REMINDERS_QUEUE = 'reminders';

/** Un barrido por minuto. El scheduler vive en Redis y `upsert` es idempotente. */
@Injectable()
export class RemindersQueue implements OnModuleDestroy {
  private readonly queue = new Queue(REMINDERS_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 },
  });

  constructor() {
    this.queue.on('error', (err) => console.error(`[reminders] error de la cola: ${err.message}`));
  }

  schedule() {
    return this.queue.upsertJobScheduler('reminders-sweep', { every: 60_000 }, { name: 'sweep' });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
```
Registrar `RemindersQueue` en `app.module.ts`. En `apps/api/src/queues/workers.ts`:
- la firma pasa a `opts: { concurrency?: number; scheduleReminders?: boolean } = {}`;
- imports de `RemindersService`, `RemindersQueue`, `REMINDERS_QUEUE` y `OutboundQueue`;
- antes del `return`:
```ts
  const reminders = ctx.get(RemindersService);
  const outboundQueue = ctx.get(OutboundQueue);
  // Concurrencia 1: un barrido a la vez. Si el encolado falla, el siguiente
  // barrido re-encola los huérfanos (outbox).
  const remindersWorker = new Worker(REMINDERS_QUEUE, async () => {
    for (const { job, delay } of await reminders.sweep(new Date())) await outboundQueue.add(job, { delay });
  }, { connection, concurrency: 1 });
  remindersWorker.on('failed', (job, err) => console.error(`[reminders] job ${job?.id} falló: ${err.message}`));
  remindersWorker.on('error', (err) => console.error(`[reminders] error del worker: ${err.message}`));
  if (opts.scheduleReminders !== false) {
    void ctx.get(RemindersQueue).schedule()
      .catch((err: Error) => console.error(`[reminders] no se pudo programar el barrido: ${err.message}`));
  }
```
- `close` cierra también `remindersWorker`.

En `apps/api/test/pipeline/pipeline.e2e.test.ts`, `startWorkers(app, { concurrency: 10 })` pasa a `startWorkers(app, { concurrency: 10, scheduleReminders: false })`, y la lista de colas a limpiar gana `REMINDERS_QUEUE`.

- [ ] **Step 8: Correr los tests y el worker compilado**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

Run: `pnpm build && pnpm db:migrate && (node apps/worker/dist/src/main.js > /tmp/citara-worker.log 2>&1 & pid=$!; sleep 6; kill -TERM $pid; sleep 2; cat /tmp/citara-worker.log)`
Expected: `AppModule dependencies initialized`, sin `UnknownElementException` ni errores de `[reminders]`.

- [ ] **Step 9: Commit**

```bash
git add packages/db apps/api/src/scheduling apps/api/src/queues apps/api/src/app.module.ts apps/api/test/helpers.ts apps/api/test/scheduling/reminders.test.ts apps/api/test/queues/outbound.processor.test.ts apps/api/test/pipeline/pipeline.e2e.test.ts
git commit -m "feat(scheduling): enviar recordatorios de cita por el outbox con plantillas aprobadas"
```

---

### Task 10: `tenant:apply` — la configuración del negocio como archivo

**Files:**
- Create: `apps/api/src/cli/tenant-config.ts`, `apps/api/src/cli/tenant-apply.ts`, `docs/ejemplos/negocio.yaml`
- Modify: `apps/api/src/cli/provision.ts` (extraer `setDefaultFlow`), `package.json` (script)
- Test: `apps/api/test/cli/tenant-config.test.ts`

**Interfaces:**
- Consumes: tablas de las Tasks 1-3, `AGENDA_FLOW` (Task 7).
- Produces: `setDefaultFlow(m: EntityManager, tenantId: string, flow: FlowDefinition, version: string): Promise<string>` (en `provision.ts`); `tenantConfigSchema` (Zod); `applyTenantConfig(admin: DataSource, raw: unknown): Promise<{ tenantId: string; services: number; resources: number; hours: number; timeOff: number; flow: string | null }>`; script `pnpm tenant:apply <archivo.yaml>`.

Semántica: **declarativa e idempotente**. Servicios y recursos se identifican por `key`; los que ya no están en el archivo se **desactivan** (nunca se borran: las citas los referencian). Horarios, ausencias y la relación recurso-servicio se reemplazan por lo del archivo. Todo en una transacción: un archivo inválido no deja el negocio a medias.

- [ ] **Step 1: Instalar `yaml`**

```bash
pnpm --filter @citara/api add yaml@^2
```

- [ ] **Step 2: Escribir el test que falla**

`apps/api/test/cli/tenant-config.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { applyTenantConfig } from '../../src/cli/tenant-config';
import { resetDb, seedChannel, seedContact, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource;
let tenantId: string;

const config = (over: Record<string, unknown> = {}) => ({
  tenant: 'salon',
  timezone: 'America/Bogota',
  booking: { min_lead_minutes: 120, horizon_days: 30, slot_granularity_minutes: 30 },
  services: [
    { key: 'corte', name: 'Corte de cabello', duration_min: 30, buffer_min: 10, price_cents: 3500000 },
    { key: 'tinte', name: 'Tinte', duration_min: 90 },
  ],
  resources: [
    { key: 'maria', name: 'María', services: ['corte', 'tinte'] },
    { key: 'pedro', name: 'Pedro', services: ['corte'],
      hours: [{ days: ['sat'], start: '09:00', end: '13:00' }] },
  ],
  hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }],
  time_off: [{ from: '2026-12-24T00:00:00-05:00', to: '2026-12-26T00:00:00-05:00', reason: 'Navidad' }],
  flow: 'agenda',
  ...over,
});

beforeAll(async () => { admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize(); });
afterAll(async () => { await admin.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('applyTenantConfig', () => {
  it('carga catálogo, horarios, ausencias, reglas y flujo', async () => {
    const r = await applyTenantConfig(admin, config());
    expect(r).toMatchObject({ tenantId, services: 2, resources: 2, hours: 6, timeOff: 1, flow: 'agenda' });

    const [t] = await adminQuery(`SELECT min_lead_minutes, horizon_days, slot_granularity_minutes FROM tenants`);
    expect(t).toEqual({ min_lead_minutes: 120, horizon_days: 30, slot_granularity_minutes: 30 });
    const pedro = await adminQuery(
      `SELECT bh.weekday FROM business_hours bh JOIN resources r ON r.id = bh.resource_id WHERE r.key = 'pedro'`);
    expect(pedro).toEqual([{ weekday: 6 }]);
    const [f] = await adminQuery(`SELECT key FROM flows WHERE is_active AND is_default`);
    expect(f.key).toBe('agenda');
  });

  it('aplicarlo dos veces deja exactamente lo mismo', async () => {
    await applyTenantConfig(admin, config());
    const before = await adminQuery(`SELECT id, key FROM services ORDER BY key`);
    await applyTenantConfig(admin, config());
    expect(await adminQuery(`SELECT id, key FROM services ORDER BY key`)).toEqual(before);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM business_hours`);
    expect(n).toBe(6);
  });

  it('quitar un servicio con citas lo desactiva sin borrar las citas', async () => {
    await applyTenantConfig(admin, config());
    const [tinte] = await adminQuery(`SELECT id FROM services WHERE key = 'tinte'`);
    const [maria] = await adminQuery(`SELECT id FROM resources WHERE key = 'maria'`);
    const contactId = await seedContact(tenantId);
    await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, '2026-11-10T15:00:00Z', '2026-11-10T16:30:00Z')`,
      [tenantId, maria.id, tinte.id, contactId]);

    const cfg = config();
    await applyTenantConfig(admin, { ...cfg,
      services: (cfg.services as unknown[]).slice(0, 1),
      resources: [{ key: 'maria', name: 'María', services: ['corte'] }] });

    const [s] = await adminQuery(`SELECT active FROM services WHERE key = 'tinte'`);
    expect(s.active).toBe(false);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM appointments`);
    expect(n).toBe(1);
  });

  it('un recurso que presta un servicio que no existe falla nombrándolo, sin tocar nada', async () => {
    await expect(applyTenantConfig(admin, config({
      resources: [{ key: 'maria', name: 'María', services: ['masaje'] }] }))).rejects.toThrow(/masaje/);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM services`);
    expect(n).toBe(0);
  });

  it('rechaza un horario que termina antes de empezar y una zona horaria inválida', async () => {
    await expect(applyTenantConfig(admin, config({ hours: [{ days: ['mon'], start: '18:00', end: '09:00' }] })))
      .rejects.toThrow(/end/);
    await expect(applyTenantConfig(admin, config({ timezone: 'America/Bogata' }))).rejects.toThrow(/zona/);
  });

  it('falla si el negocio no existe', async () => {
    await expect(applyTenantConfig(admin, config({ tenant: 'no-existe' }))).rejects.toThrow(/no-existe/);
  });
});
```

- [ ] **Step 3: Correr y verlo fallar**

Run: `pnpm test apps/api/test/cli/tenant-config.test.ts`
Expected: FAIL — no existe `tenant-config`.

- [ ] **Step 4: Extraer `setDefaultFlow`**

En `apps/api/src/cli/provision.ts`, mover el bloque de flujo de `provisionDevTenant` a una función exportada y llamarla desde allí con `FLOW_VERSION`:
```ts
/**
 * Deja `flow` como el flujo activo por defecto del negocio. Un solo flujo por
 * defecto por tenant (índice flows_one_default): se apagan los demás antes.
 */
export async function setDefaultFlow(
  m: EntityManager, tenantId: string, flow: FlowDefinition, version: string,
): Promise<string> {
  await m.query(
    `UPDATE flows SET is_default = false WHERE tenant_id = $1 AND NOT (key = $2 AND version = $3)`,
    [tenantId, flow.key, version]);
  const [row] = await m.query(
    `INSERT INTO flows (tenant_id, key, version, definition, is_active, is_default)
     VALUES ($1, $2, $3, $4, true, true)
     ON CONFLICT (tenant_id, key, version) DO UPDATE
       SET definition = EXCLUDED.definition, is_active = true, is_default = true
     RETURNING id`, [tenantId, flow.key, version, JSON.stringify(flow)]);
  return row.id;
}
```
(`import type { DataSource, EntityManager } from 'typeorm';`). En `provisionDevTenant`, el bloque reemplazado queda como `const flowId = await setDefaultFlow(m, tenant.id, input.flow, FLOW_VERSION);` y el `return` usa `flowId`. Correr `pnpm test apps/api/test/cli/provision.test.ts`: debe seguir en verde.

- [ ] **Step 5: El esquema y la aplicación**

`apps/api/src/cli/tenant-config.ts`:
```ts
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { DataSource } from 'typeorm';
import type { FlowDefinition } from '@citara/shared';
import { AGENDA_FLOW } from '../flow-engine/flows/agenda';
import { setDefaultFlow } from './provision';

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;
const key = z.string().regex(/^[a-z0-9_-]{1,64}$/, 'clave: minúsculas, números, - y _');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora HH:MM');
const iso = z.string().refine((v) => DateTime.fromISO(v, { setZone: true }).isValid && /([+-]\d{2}:\d{2}|Z)$/.test(v),
  'fecha ISO-8601 con offset');
const hoursBlock = z.object({
  days: z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).min(1),
  start: hhmm,
  end: hhmm,
}).refine((b) => b.end > b.start, { message: 'end debe ser posterior a start' });
const flowSchema = z.object({ key: z.string(), entry: z.string(), steps: z.record(z.unknown()) })
  .refine((f) => f.entry in f.steps, { message: 'el paso de entrada del flujo no existe' });

export const tenantConfigSchema = z.object({
  tenant: z.string().min(1),
  name: z.string().min(1).optional(),
  timezone: z.string().refine((tz) => DateTime.local().setZone(tz).isValid, 'zona horaria IANA inválida').optional(),
  human_takeover_hours: z.number().int().min(1).max(168).optional(),
  booking: z.object({
    min_lead_minutes: z.number().int().min(0).optional(),
    horizon_days: z.number().int().min(1).max(365).optional(),
    slot_granularity_minutes: z.number().int()
      .refine((n) => [5, 10, 15, 20, 30, 60].includes(n), 'granularidad: 5, 10, 15, 20, 30 o 60').optional(),
  }).optional(),
  services: z.array(z.object({
    key, name: z.string().min(1),
    duration_min: z.number().int().positive(),
    buffer_min: z.number().int().min(0).default(0),
    price_cents: z.number().int().min(0).optional(),
  })).min(1),
  resources: z.array(z.object({
    key, name: z.string().min(1),
    services: z.array(key).min(1),
    hours: z.array(hoursBlock).optional(),
  })).min(1),
  hours: z.array(hoursBlock).min(1),
  time_off: z.array(z.object({ from: iso, to: iso, reason: z.string().optional(), resource: key.optional() }))
    .default([]),
  flow: z.union([z.literal('agenda'), flowSchema]).optional(),
}).superRefine((c, ctx) => {
  const services = new Set(c.services.map((s) => s.key));
  const resources = new Set(c.resources.map((r) => r.key));
  if (services.size !== c.services.length) ctx.addIssue({ code: 'custom', message: 'claves de servicio repetidas' });
  if (resources.size !== c.resources.length) ctx.addIssue({ code: 'custom', message: 'claves de recurso repetidas' });
  for (const r of c.resources) for (const s of r.services) {
    if (!services.has(s)) ctx.addIssue({ code: 'custom', message: `el recurso '${r.key}' presta '${s}', que no es un servicio` });
  }
  for (const t of c.time_off) {
    if (t.resource && !resources.has(t.resource)) ctx.addIssue({ code: 'custom', message: `ausencia de un recurso inexistente: '${t.resource}'` });
    if (new Date(t.to) <= new Date(t.from)) ctx.addIssue({ code: 'custom', message: 'una ausencia termina antes de empezar' });
  }
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

/** Aplica la configuración en UNA transacción, con la conexión admin. */
export async function applyTenantConfig(admin: DataSource, raw: unknown) {
  const parsed = tenantConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n'));
  }
  const c = parsed.data;

  return admin.transaction(async (m) => {
    const [tenant] = await m.query(`SELECT id FROM tenants WHERE slug = $1`, [c.tenant]);
    if (!tenant) throw new Error(`No existe el negocio '${c.tenant}'. Créalo primero (dev:provision o el alta).`);
    const tenantId: string = tenant.id;

    await m.query(
      `UPDATE tenants SET
         name = COALESCE($2, name), timezone = COALESCE($3, timezone),
         human_takeover_hours = COALESCE($4, human_takeover_hours),
         min_lead_minutes = COALESCE($5, min_lead_minutes), horizon_days = COALESCE($6, horizon_days),
         slot_granularity_minutes = COALESCE($7, slot_granularity_minutes)
       WHERE id = $1`,
      [tenantId, c.name ?? null, c.timezone ?? null, c.human_takeover_hours ?? null,
       c.booking?.min_lead_minutes ?? null, c.booking?.horizon_days ?? null, c.booking?.slot_granularity_minutes ?? null]);

    const serviceIds = new Map<string, string>();
    for (const s of c.services) {
      const [row] = await m.query(
        `INSERT INTO services (tenant_id, key, name, duration_min, buffer_min, price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET name = EXCLUDED.name, duration_min = EXCLUDED.duration_min, buffer_min = EXCLUDED.buffer_min,
               price_cents = EXCLUDED.price_cents, active = true
         RETURNING id`, [tenantId, s.key, s.name, s.duration_min, s.buffer_min, s.price_cents ?? null]);
      serviceIds.set(s.key, row.id);
    }
    // Lo que ya no está se desactiva, nunca se borra: las citas lo referencian.
    await m.query(`UPDATE services SET active = false WHERE tenant_id = $1 AND NOT (key = ANY($2))`,
                  [tenantId, [...serviceIds.keys()]]);

    const resourceIds = new Map<string, string>();
    for (const r of c.resources) {
      const [row] = await m.query(
        `INSERT INTO resources (tenant_id, key, name) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name, active = true
         RETURNING id`, [tenantId, r.key, r.name]);
      resourceIds.set(r.key, row.id);
    }
    await m.query(`UPDATE resources SET active = false WHERE tenant_id = $1 AND NOT (key = ANY($2))`,
                  [tenantId, [...resourceIds.keys()]]);

    await m.query(`DELETE FROM resource_services WHERE tenant_id = $1`, [tenantId]);
    for (const r of c.resources) for (const s of r.services) {
      await m.query(`INSERT INTO resource_services (tenant_id, resource_id, service_id) VALUES ($1, $2, $3)`,
                    [tenantId, resourceIds.get(r.key), serviceIds.get(s)]);
    }

    await m.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
    let hours = 0;
    const insertHours = async (blocks: z.infer<typeof hoursBlock>[], resourceId: string | null) => {
      for (const b of blocks) for (const d of b.days) {
        await m.query(
          `INSERT INTO business_hours (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, resourceId, DAYS[d], b.start, b.end]);
        hours++;
      }
    };
    await insertHours(c.hours, null);
    for (const r of c.resources) if (r.hours) await insertHours(r.hours, resourceIds.get(r.key)!);

    await m.query(`DELETE FROM time_off WHERE tenant_id = $1`, [tenantId]);
    for (const t of c.time_off) {
      await m.query(
        `INSERT INTO time_off (tenant_id, resource_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, t.resource ? resourceIds.get(t.resource) : null, t.from, t.to, t.reason ?? null]);
    }

    let flow: string | null = null;
    if (c.flow) {
      const definition = (c.flow === 'agenda' ? AGENDA_FLOW : c.flow) as FlowDefinition;
      await setDefaultFlow(m, tenantId, definition, 'current');
      flow = definition.key;
    }

    return { tenantId, services: c.services.length, resources: c.resources.length,
             hours, timeOff: c.time_off.length, flow };
  });
}
```

- [ ] **Step 6: La CLI, el script y el ejemplo**

`apps/api/src/cli/tenant-apply.ts`:
```ts
// Aplica un archivo YAML de configuración de negocio: `pnpm tenant:apply ruta.yaml`.
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { createDataSource } from '@citara/db';
import { applyTenantConfig } from './tenant-config';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Uso: pnpm tenant:apply <archivo.yaml>');
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL no está definida');

  const ds = createDataSource(url);
  await ds.initialize();
  try {
    const r = await applyTenantConfig(ds, parse(await readFile(file, 'utf8')));
    console.log(`Negocio ${r.tenantId}: ${r.services} servicios, ${r.resources} recursos, ` +
                `${r.hours} bloques de horario, ${r.timeOff} ausencias, flujo ${r.flow ?? 'sin cambios'}`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```
En `package.json`, después de `dev:provision`:
```json
    "tenant:apply": "node apps/api/dist/src/cli/tenant-apply.js",
```
`docs/ejemplos/negocio.yaml`:
```yaml
# Configuración de un negocio. Aplicar con: pnpm build && pnpm tenant:apply docs/ejemplos/negocio.yaml
# Es declarativa: lo que no está en el archivo se desactiva (servicios, recursos) o se
# reemplaza (horarios, ausencias). Se puede aplicar las veces que haga falta.
tenant: demo                  # slug del negocio (dev:provision crea 'demo')
name: Salón Demo
timezone: America/Bogota
human_takeover_hours: 12      # cuánto se calla el bot cuando el dueño contesta desde su celular
booking:
  min_lead_minutes: 60        # anticipación mínima
  horizon_days: 60            # hasta cuántos días adelante se agenda
  slot_granularity_minutes: 15
services:
  - { key: corte, name: Corte de cabello, duration_min: 30, buffer_min: 10, price_cents: 3500000 }
  - { key: tinte, name: Tinte, duration_min: 90, buffer_min: 15 }
resources:
  - { key: maria, name: María, services: [corte, tinte] }
  - key: pedro
    name: Pedro
    services: [corte]
    hours:                    # horario propio: reemplaza al del negocio para Pedro
      - { days: [tue, wed, thu, fri, sat], start: '10:00', end: '19:00' }
hours:
  - { days: [mon, tue, wed, thu, fri], start: '09:00', end: '18:00' }
  - { days: [sat], start: '09:00', end: '13:00' }
time_off:
  - { from: '2026-12-24T00:00:00-05:00', to: '2026-12-26T00:00:00-05:00', reason: Navidad }
flow: agenda                  # el flujo de menús incorporado
```

- [ ] **Step 7: Correr los tests y la CLI compilada**

Run: `pnpm typecheck && pnpm test apps/api/test/cli`
Expected: PASS.

Run: `pnpm build && META_WABA_ID=111 META_PHONE_NUMBER_ID=222 META_ACCESS_TOKEN=EAAG-falso pnpm -s dev:provision && pnpm -s tenant:apply docs/ejemplos/negocio.yaml`
Expected: `Negocio <uuid>: 2 servicios, 2 recursos, 11 bloques de horario, 1 ausencias, flujo agenda` (6 del negocio y 5 propios de Pedro).

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/cli package.json docs/ejemplos/negocio.yaml apps/api/test/cli/tenant-config.test.ts
git commit -m "feat(cli): aplicar la configuración de un negocio desde un archivo yaml idempotente"
```

---

### Task 11: Agendar de punta a punta y el runbook

**Files:**
- Modify: `apps/api/test/pipeline/pipeline.e2e.test.ts`
- Modify: `docs/desarrollo-local.md`

**Interfaces:**
- Consumes: todo lo anterior, a través del webhook real, Redis y `startWorkers`.

- [ ] **Step 1: Escribir el e2e**

En `apps/api/test/pipeline/pipeline.e2e.test.ts`:
- el `fakeSender` registra también las plantillas: `sent.push({ to, body: 'body' in content ? content.body : \`[plantilla ${content.name}]\` });`;
- el módulo de pruebas fija el reloj de agenda: `.overrideProvider(CLOCK).useValue({ now: () => AGENDA_NOW })`, con `const AGENDA_NOW = new Date('2026-09-08T03:00:00Z');` (lunes 22:00 en Bogotá) e imports de `CLOCK`, `AGENDA_FLOW`, `RemindersService`, `OutboundQueue`, `seedCatalog`, `seedHours`;
- añadir un `describe` al final:
```ts
describe('pipeline real de agenda', () => {
  it('un cliente agenda por WhatsApp y recibe el recordatorio por plantilla', async () => {
    const [t] = await adminQuery(`SELECT id FROM tenants`);
    await seedCatalog(t.id);
    await seedHours(t.id);
    await adminQuery(`UPDATE flows SET is_default = false`);
    await seedFlow(t.id, AGENDA_FLOW);

    let n = 0;
    for (const text of ['Hola', 'agendar', '1', '1', 'Ana']) {
      await post(webhook(`wamid.AG${n++}`, text));
      await quiesce();
    }
    expect(sent.at(-1)!.body).toMatch(/^¡Listo, Ana! Tu cita quedó para el martes/);
    const [cita] = await adminQuery(`SELECT starts_at FROM appointments`);
    expect(new Date(cita.starts_at).toISOString()).toBe('2026-09-08T14:00:00.000Z');

    // El recordatorio de 2 h (12:00Z). El de 24 h ya había pasado al agendar.
    const queue = app.get(OutboundQueue);
    for (const { job, delay } of await app.get(RemindersService).sweep(new Date('2026-09-08T12:01:00Z'))) {
      await queue.add(job, { delay });
    }
    await quiesce();
    expect(sent.at(-1)!.body).toBe('[plantilla recordatorio_cita_2h]');
  });
});
```

- [ ] **Step 2: Correrlo**

Run: `pnpm test apps/api/test/pipeline`
Expected: PASS. Si falla, el defecto está en el cableado (un provider sin registrar, el reloj, la cola) y se corrige ahí, no en el test.

- [ ] **Step 3: El runbook**

En `docs/desarrollo-local.md`, después de la sección "2. Compilar, migrar y dar de alta el negocio", añadir:
```markdown
### Cargar la agenda del negocio

Servicios, recursos, horarios, ausencias, reglas de reserva y flujo viven en un archivo YAML
por negocio (ver `docs/ejemplos/negocio.yaml`). Es declarativo e idempotente: se aplica las
veces que haga falta, y lo que se quita del archivo se desactiva o se reemplaza.

```bash
pnpm tenant:apply docs/ejemplos/negocio.yaml
```

Con `flow: agenda` el negocio queda con el flujo de menús: agendar, ver mis citas y hablar
con alguien.

### Recordatorios

El worker barre cada minuto los recordatorios vencidos (24 h y 2 h antes de cada cita) y los
envía como plantilla. Antes de operar hay que **enviar a aprobación de Meta** las plantillas
`recordatorio_cita_24h` y `recordatorio_cita_2h` (categoría UTILITY, idioma `es`), con tres
parámetros de cuerpo en este orden: nombre del cliente, fecha y hora, servicio. Sin plantilla
aprobada, Meta rechaza el envío y el mensaje queda `failed`.
```
En la tabla de "Estados de un mensaje saliente", añadir debajo: "Los recordatorios
(`origin='reminder'`) salen aunque el dueño esté atendiendo: no quedan `superseded`."

- [ ] **Step 4: Correr todo**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/pipeline/pipeline.e2e.test.ts docs/desarrollo-local.md
git commit -m "test(pipeline): agendar por whatsapp y recibir el recordatorio de punta a punta"
```

---

## Criterios de salida de la Fase 2

- [ ] `pnpm test` y `pnpm typecheck` en verde, incluido el test de concurrencia de la Task 3.
- [ ] Un cliente agenda una cita real por WhatsApp usando solo menús (con el número de prueba de Meta).
- [ ] Dos clientes piden la misma franja: uno la obtiene y el otro recibe "se acaba de ocupar". Nunca dos citas superpuestas.
- [ ] Las franjas ofrecidas respetan horario, ausencias, buffer, anticipación mínima y horizonte, y "cualquier recurso" no oculta huecos.
- [ ] `tenant:apply` carga un negocio completo desde YAML sin tocar SQL.
- [ ] Los recordatorios salen por plantilla, a su hora, y una cita cancelada o movida no deja recordatorios viejos.
- [ ] Las plantillas de recordatorio están **enviadas a aprobación** de Meta.
- [ ] Cero llamadas a un LLM y cero dependencias de Google en toda la fase.

**Punto de corte con valor:** con esta fase y el alta asistida (Fase 3), un negocio real agenda por WhatsApp sin IA.

## Lo que esta fase deliberadamente NO hace

- Cancelar o reprogramar desde los menús: las herramientas existen (con confirmación en dos tiempos) y las usará el agente; el flujo de menús ofrece agendar, ver citas y hablar con alguien.
- Google Calendar (fase 4) e IA (fase 5).
- Garantizar el buffer bajo una carrera: la restricción de exclusión cubre el solapamiento; el buffer se aplica al ofrecer y al validar.
