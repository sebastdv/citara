# Fase 2 — Agenda: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un negocio puede definir servicios, recursos y horarios, y un cliente puede agendar una cita real desde WhatsApp usando menús deterministas — sin una línea de IA y sin Google Calendar.

**Architecture:** `appointments` es la fuente de verdad, protegida por una restricción de exclusión de PostgreSQL que hace imposible la doble reserva a nivel de motor. El cálculo de disponibilidad es una función pura sobre horarios, ausencias y citas existentes, expresado siempre en la zona horaria del negocio. El motor de flujos gana un tipo de paso `tool` que invoca estas operaciones de forma determinista; en la Fase 4 las mismas operaciones se exponen al agente sin cambiar su implementación.

**Tech Stack:** lo de la Fase 1, más Luxon 3 para aritmética de zonas horarias.

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md`

**Depende de:** `docs/superpowers/plans/2026-09-03-fase-1-cimientos.md` completo.

## Global Constraints

Además de las de la Fase 1:

- **Toda aritmética de fechas usa la zona horaria del tenant** (`tenants.timezone`), nunca la del servidor ni la del contenedor. Los procesos corren con `TZ=UTC` precisamente para que un olvido se note en los tests.
- **Los instantes se almacenan en `timestamptz`** y se presentan convertidos. Jamás se guarda una hora local sin zona.
- **Las herramientas de agenda validan sus propios argumentos.** No se asume que el llamador (menú hoy, LLM en la Fase 4) respetó las reglas del negocio.
- Una cita confirmada **nunca** puede solaparse con otra del mismo recurso. Esto lo garantiza la base de datos, no la aplicación.

---

## File Structure

```
apps/api/src/scheduling/
├─ entities/                 (en packages/db) services, resources, business_hours, appointments
├─ availability.ts           cálculo de franjas — función PURA, sin BD
├─ availability.service.ts   carga datos y delega en availability.ts
├─ booking.service.ts        reserva, cancela, reprograma; traduce errores de Postgres
├─ scheduling.errors.ts      errores de dominio tipados
└─ tools/                    las operaciones invocables: contrato estable entre fases
   ├─ index.ts               registro de herramientas
   ├─ list-services.tool.ts
   ├─ list-slots.tool.ts
   ├─ book.tool.ts
   ├─ list-my-appointments.tool.ts
   ├─ cancel.tool.ts
   └─ reschedule.tool.ts
```

**Decisión de frontera:** `availability.ts` no toca la base de datos. Recibe horarios,
ausencias y citas ya cargadas y devuelve franjas. Así el algoritmo más delicado del
sistema —el que tiene que ser correcto con zonas horarias, buffers y bordes— se prueba
con tablas de casos, sin infraestructura.

---

## Tareas

### Task 1: Servicios y recursos

**Files:**
- Create: migraciones `1725400000000-CreateServices.ts`, `1725400100000-CreateResources.ts`, `1725400200000-CreateResourceServices.ts`
- Create: `packages/db/src/entities/service.entity.ts`, `resource.entity.ts`
- Test: `apps/api/test/scheduling/catalog.test.ts`

**Interfaces:**
- Consumes: `tenantRlsSql`, `runInTenant` (Fase 1).
- Produces: tablas `services` (`id, tenant_id, name, duration_min, buffer_min, price_cents, active`), `resources` (`id, tenant_id, name, active`), `resource_services` (`resource_id, service_id`). Helper de test `seedCatalog(tenantId)` que devuelve `{ serviceId, resourceId }`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/catalog.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { resetDb, seedChannel, seedCatalog, closeHelpers } from '../helpers';

let app: DataSource, tenantId: string;

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  if (!app) { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); }
});
afterAll(async () => { await app.destroy(); await closeHelpers(); });

describe('catálogo de agenda', () => {
  it('crea servicio y recurso enlazados', async () => {
    const { serviceId, resourceId } = await seedCatalog(tenantId);

    const rows = await runInTenant(app, tenantId, (m) =>
      m.query(
        `SELECT s.name AS servicio, s.duration_min, r.name AS recurso
           FROM resource_services rs
           JOIN services  s ON s.id = rs.service_id
           JOIN resources r ON r.id = rs.resource_id
          WHERE rs.service_id = $1 AND rs.resource_id = $2`,
        [serviceId, resourceId],
      ));

    expect(rows).toHaveLength(1);
    expect(rows[0].duration_min).toBe(30);
  });

  it('rechaza una duración de cero o negativa', async () => {
    await expect(
      runInTenant(app, tenantId, (m) =>
        m.query(`INSERT INTO services (tenant_id, name, duration_min) VALUES ($1,'X',0)`,
                [tenantId])),
    ).rejects.toThrow();
  });

  it('los servicios quedan aislados por tenant', async () => {
    await seedCatalog(tenantId);
    const [otro] = await (await import('../helpers')).adminQuery(
      `INSERT INTO tenants (slug, name) VALUES ('otro','Otro') RETURNING id`);

    const rows = await runInTenant(app, otro.id, (m) => m.query(`SELECT * FROM services`));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/scheduling/catalog`
Expected: FAIL — no existen las tablas ni `seedCatalog`.

- [ ] **Step 3: Implementar**

`packages/db/src/migrations/1725400000000-CreateServices.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateServices1725400000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE services (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name         varchar(255) NOT NULL,
        duration_min integer NOT NULL CHECK (duration_min > 0),
        buffer_min   integer NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
        price_cents  integer,
        active       boolean NOT NULL DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const sql of tenantRlsSql('services')) await q.query(sql);
  }
  public async down(q: QueryRunner): Promise<void> { await q.query(`DROP TABLE services`); }
}
```

`packages/db/src/migrations/1725400100000-CreateResources.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateResources1725400100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE resources (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name       varchar(255) NOT NULL,
        active     boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const sql of tenantRlsSql('resources')) await q.query(sql);
  }
  public async down(q: QueryRunner): Promise<void> { await q.query(`DROP TABLE resources`); }
}
```

`packages/db/src/migrations/1725400200000-CreateResourceServices.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateResourceServices1725400200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE resource_services (
        tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        service_id  uuid NOT NULL REFERENCES services(id)  ON DELETE CASCADE,
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

Añadir a `apps/api/test/helpers.ts`:
```ts
/** Ejecuta SQL como administrador. Solo para preparar y verificar en tests. */
export async function adminQuery(sql: string, params: unknown[] = []): Promise<any[]> {
  const ds = await adminDs();
  return ds.query(sql, params);
}

export async function seedCatalog(
  tenantId: string,
  over: { durationMin?: number; bufferMin?: number } = {},
): Promise<{ serviceId: string; resourceId: string }> {
  const ds = await adminDs();
  const [s] = await ds.query(
    `INSERT INTO services (tenant_id, name, duration_min, buffer_min)
     VALUES ($1, 'Corte de cabello', $2, $3) RETURNING id`,
    [tenantId, over.durationMin ?? 30, over.bufferMin ?? 0],
  );
  const [r] = await ds.query(
    `INSERT INTO resources (tenant_id, name) VALUES ($1, 'María') RETURNING id`,
    [tenantId],
  );
  await ds.query(
    `INSERT INTO resource_services (tenant_id, resource_id, service_id) VALUES ($1,$2,$3)`,
    [tenantId, r.id, s.id],
  );
  return { serviceId: s.id, resourceId: r.id };
}
```

Extender el `TRUNCATE` de `resetDb()` con `services, resources, resource_services`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/scheduling/catalog`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scheduling): modelar servicios, recursos y su relación con aislamiento por tenant"
```

---

### Task 2: Horarios de atención y ausencias

**Files:**
- Create: migraciones `1725400300000-CreateBusinessHours.ts`, `1725400400000-CreateTimeOff.ts`
- Test: `apps/api/test/scheduling/business-hours.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `business_hours` (`tenant_id, resource_id NULL, weekday 0-6, start_time time, end_time time`) y `time_off` (`tenant_id, resource_id NULL, starts_at, ends_at, reason`). `resource_id NULL` significa "aplica a todo el negocio". Helper `seedHours(tenantId, resourceId?)`.

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
      `SELECT weekday, start_time, end_time FROM business_hours
        WHERE tenant_id = $1 ORDER BY weekday`, [tenantId]);
    expect(rows).toHaveLength(5);
    expect(rows[0].weekday).toBe(1);
    expect(rows[0].start_time).toBe('09:00:00');
  });

  it('rechaza un horario que termina antes de empezar', async () => {
    await expect(adminQuery(
      `INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 1, '18:00', '09:00')`, [tenantId])).rejects.toThrow();
  });

  it('rechaza un weekday fuera de 0..6', async () => {
    await expect(adminQuery(
      `INSERT INTO business_hours (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 7, '09:00', '18:00')`, [tenantId])).rejects.toThrow();
  });

  it('permite una ausencia acotada a un recurso concreto', async () => {
    await adminQuery(
      `INSERT INTO time_off (tenant_id, resource_id, starts_at, ends_at, reason)
       VALUES ($1, $2, '2026-09-10T13:00:00Z', '2026-09-10T18:00:00Z', 'Cita médica')`,
      [tenantId, resourceId]);
    const rows = await adminQuery(`SELECT * FROM time_off WHERE tenant_id = $1`, [tenantId]);
    expect(rows[0].resource_id).toBe(resourceId);
  });

  it('rechaza una ausencia que termina antes de empezar', async () => {
    await expect(adminQuery(
      `INSERT INTO time_off (tenant_id, starts_at, ends_at)
       VALUES ($1, '2026-09-10T18:00:00Z', '2026-09-10T13:00:00Z')`,
      [tenantId])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/scheduling/business-hours`
Expected: FAIL — no existen las tablas.

- [ ] **Step 3: Implementar**

```ts
// 1725400300000-CreateBusinessHours.ts
await q.query(`
  CREATE TABLE business_hours (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- NULL = aplica a todo el negocio; con valor = solo a ese recurso.
    resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
    weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = domingo
    start_time  time NOT NULL,
    end_time    time NOT NULL,
    CHECK (end_time > start_time)
  )
`);
await q.query(`CREATE INDEX business_hours_lookup ON business_hours (tenant_id, weekday)`);
for (const sql of tenantRlsSql('business_hours')) await q.query(sql);

// 1725400400000-CreateTimeOff.ts
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
```

Helper en `apps/api/test/helpers.ts`:
```ts
/** Lunes a viernes, 09:00–18:00 en hora local del negocio. */
export async function seedHours(tenantId: string, resourceId?: string): Promise<void> {
  const ds = await adminDs();
  for (const weekday of [1, 2, 3, 4, 5]) {
    await ds.query(
      `INSERT INTO business_hours (tenant_id, resource_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, '09:00', '18:00')`,
      [tenantId, resourceId ?? null, weekday],
    );
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/scheduling/business-hours`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scheduling): registrar horarios de atención y ausencias por negocio o recurso"
```

---

### Task 3: `appointments` y la restricción anti-doble-reserva

Esta es la tarea central de la fase. El test de concurrencia demuestra que la
prevención vive en el motor de base de datos, no en el código.

**Files:**
- Create: migración `1725400500000-CreateAppointments.ts`
- Create: `packages/db/src/entities/appointment.entity.ts`
- Test: `apps/api/test/scheduling/appointments-overlap.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: tabla `appointments` con la restricción `no_overlap` y el código de error `23P01` (`exclusion_violation`) como contrato para la capa de reservas.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/appointments-overlap.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { resetDb, seedChannel, seedCatalog, seedContact, adminQuery, closeHelpers } from '../helpers';

let tenantId: string, serviceId: string, resourceId: string, contactId: string;

const insert = (starts: string, ends: string, status = 'confirmed') =>
  adminQuery(
    `INSERT INTO appointments
       (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tenantId, resourceId, serviceId, contactId, starts, ends, status],
  );

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
    await expect(insert('2026-09-10T14:15:00Z', '2026-09-10T14:45:00Z'))
      .rejects.toMatchObject({ code: '23P01' });
  });

  it('rechaza una cita contenida dentro de otra', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T15:00:00Z');
    await expect(insert('2026-09-10T14:10:00Z', '2026-09-10T14:20:00Z'))
      .rejects.toMatchObject({ code: '23P01' });
  });

  it('permite el solapamiento si una está cancelada', async () => {
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z', 'cancelled');
    await expect(insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z')).resolves.toBeDefined();
  });

  it('permite el mismo horario en recursos distintos', async () => {
    const [otro] = await adminQuery(
      `INSERT INTO resources (tenant_id, name) VALUES ($1,'Pedro') RETURNING id`, [tenantId]);
    await insert('2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z');
    await expect(adminQuery(
      `INSERT INTO appointments
         (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, status)
       VALUES ($1,$2,$3,$4,'2026-09-10T14:00:00Z','2026-09-10T14:30:00Z','confirmed')
       RETURNING id`,
      [tenantId, otro.id, serviceId, contactId])).resolves.toBeDefined();
  });

  it('EL CASO REAL: dos transacciones concurrentes por la misma franja, solo una gana', async () => {
    const a = createDataSource(process.env.DATABASE_ADMIN_URL!);
    const b = createDataSource(process.env.DATABASE_ADMIN_URL!);
    await a.initialize(); await b.initialize();

    const ra = a.createQueryRunner(); const rb = b.createQueryRunner();
    await ra.connect(); await rb.connect();
    await ra.startTransaction(); await rb.startTransaction();

    const sql = `INSERT INTO appointments
      (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, status)
      VALUES ($1,$2,$3,$4,'2026-09-10T15:00:00Z','2026-09-10T15:30:00Z','confirmed')`;
    const args = [tenantId, resourceId, serviceId, contactId];

    // A inserta y NO confirma todavía: B queda bloqueada hasta que A decida.
    await ra.query(sql, args);
    const bInsert = rb.query(sql, args);

    await ra.commitTransaction();
    await expect(bInsert).rejects.toMatchObject({ code: '23P01' });
    await rb.rollbackTransaction();

    const rows = await adminQuery(
      `SELECT count(*)::int AS n FROM appointments WHERE starts_at = '2026-09-10T15:00:00Z'`);
    expect(rows[0].n).toBe(1);

    await ra.release(); await rb.release();
    await a.destroy(); await b.destroy();
  });
});
```

> El último test es el que justifica toda la decisión D5 del spec. Si alguna vez
> falla, significa que la restricción se cayó de una migración y el sistema volvió a
> ser capaz de poner a dos personas en la misma silla a la misma hora.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/scheduling/appointments-overlap`
Expected: FAIL — no existe la tabla `appointments`.

- [ ] **Step 3: Implementar**

`packages/db/src/migrations/1725400500000-CreateAppointments.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateAppointments1725400500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE appointments (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id     uuid NOT NULL REFERENCES resources(id),
        service_id      uuid NOT NULL REFERENCES services(id),
        contact_id      uuid NOT NULL REFERENCES contacts(id),
        conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
        starts_at       timestamptz NOT NULL,
        ends_at         timestamptz NOT NULL,
        status          varchar(32) NOT NULL DEFAULT 'confirmed'
                          CHECK (status IN ('confirmed','cancelled','completed','no_show')),
        customer_name   varchar(255),
        notes           text,
        -- Fase 3: proyección hacia Google Calendar.
        google_event_id   varchar(1024),
        google_sync_status varchar(32) NOT NULL DEFAULT 'pending',
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CHECK (ends_at > starts_at)
      )
    `);

    // btree_gist ya se creó en la migración del rol de aplicación (Fase 1).
    // Solo las confirmadas ocupan la franja: cancelar libera el espacio.
    await q.query(`
      ALTER TABLE appointments ADD CONSTRAINT no_overlap
        EXCLUDE USING gist (
          resource_id WITH =,
          tstzrange(starts_at, ends_at) WITH &&
        ) WHERE (status = 'confirmed')
    `);

    await q.query(`
      CREATE INDEX appointments_lookup
        ON appointments (tenant_id, resource_id, starts_at)
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

Helper en `apps/api/test/helpers.ts`:
```ts
export async function seedContact(tenantId: string, waId = '573001112233'): Promise<string> {
  const ds = await adminDs();
  const [c] = await ds.query(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1,$2,'Ana') RETURNING id`,
    [tenantId, waId],
  );
  return c.id;
}
```

Extender el `TRUNCATE` de `resetDb()` con `appointments, business_hours, time_off`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/scheduling/appointments-overlap`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scheduling): impedir doble reserva con restricción de exclusión sobre appointments"
```

---

### Task 4: Cálculo de disponibilidad — función pura

El algoritmo más delicado del sistema. Se prueba sin base de datos, con tablas de casos,
incluyendo un cambio de horario de verano para demostrar que la aritmética de zonas es
correcta y no una suma de milisegundos disfrazada.

**Files:**
- Create: `apps/api/src/scheduling/availability.ts`
- Test: `apps/api/test/scheduling/availability.test.ts`

**Interfaces:**
- Consumes: nada (función pura).
- Produces:
```ts
interface HoursBlock { weekday: number; start: string; end: string } // hora LOCAL 'HH:mm'
interface BusyInterval { start: Date; end: Date }                    // instantes UTC
interface Slot { start: Date; end: Date }

function computeSlots(input: {
  from: Date; to: Date; timezone: string;
  durationMin: number; bufferMin: number; granularityMin: number; minLeadMin: number;
  now: Date; hours: HoursBlock[]; busy: BusyInterval[];
}): Slot[];
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/availability.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeSlots } from '../../src/scheduling/availability';

const BOGOTA = 'America/Bogota';   // UTC-5 todo el año, sin horario de verano
const NY = 'America/New_York';     // con horario de verano: el caso interesante

// Jueves 10 de septiembre de 2026, 09:00–12:00 local.
const hours = [{ weekday: 4, start: '09:00', end: '12:00' }];

const base = {
  timezone: BOGOTA,
  durationMin: 30, bufferMin: 0, granularityMin: 30, minLeadMin: 0,
  now: new Date('2026-09-01T00:00:00Z'),
  hours, busy: [] as { start: Date; end: Date }[],
  from: new Date('2026-09-10T00:00:00Z'),
  to:   new Date('2026-09-11T00:00:00Z'),
};

const hhmm = (d: Date, tz = BOGOTA) =>
  new Intl.DateTimeFormat('es-CO', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);

describe('computeSlots', () => {
  it('genera franjas de 30 min entre 09:00 y 12:00 hora local', () => {
    const slots = computeSlots(base);
    expect(slots.map((s) => hhmm(s.start)))
      .toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('la última franja termina exactamente al cierre, nunca después', () => {
    const slots = computeSlots({ ...base, durationMin: 45, granularityMin: 45 });
    expect(slots.map((s) => hhmm(s.start))).toEqual(['09:00', '09:45', '10:30']);
    expect(hhmm(slots[slots.length - 1].end)).toBe('11:15');
  });

  it('excluye las franjas ocupadas por una cita existente', () => {
    const slots = computeSlots({
      ...base,
      busy: [{ start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z') }],
    }); // 15:00Z = 10:00 en Bogotá
    expect(slots.map((s) => hhmm(s.start)))
      .toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('el buffer del servicio bloquea también los bordes de lo ocupado', () => {
    const slots = computeSlots({
      ...base, bufferMin: 15,
      busy: [{ start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T15:30:00Z') }],
    });
    // 09:30 ya no cabe: terminaría a las 10:00, pegada al buffer previo.
    expect(slots.map((s) => hhmm(s.start))).toEqual(['09:00', '11:00', '11:30']);
  });

  it('respeta la anticipación mínima', () => {
    const slots = computeSlots({
      ...base,
      now: new Date('2026-09-10T14:40:00Z'), // 09:40 en Bogotá
      minLeadMin: 60,
    });
    // Nada antes de las 10:40 local → la primera válida es 11:00.
    expect(slots.map((s) => hhmm(s.start))).toEqual(['11:00', '11:30']);
  });

  it('devuelve vacío en un día sin horario definido', () => {
    const slots = computeSlots({
      ...base,
      from: new Date('2026-09-12T00:00:00Z'), // sábado
      to:   new Date('2026-09-13T00:00:00Z'),
    });
    expect(slots).toEqual([]);
  });

  it('cubre varios días del rango', () => {
    const slots = computeSlots({
      ...base,
      hours: [{ weekday: 4, start: '09:00', end: '10:00' },
              { weekday: 5, start: '09:00', end: '10:00' }],
      from: new Date('2026-09-10T00:00:00Z'),
      to:   new Date('2026-09-12T00:00:00Z'),
    });
    expect(slots).toHaveLength(4); // 2 días × 2 franjas
  });

  it('honra el horario LOCAL a través de un cambio de horario de verano', () => {
    // Nueva York vuelve a hora estándar el domingo 1 de noviembre de 2026.
    // El lunes 2 sigue siendo 09:00 local aunque el offset UTC haya cambiado.
    const slots = computeSlots({
      ...base,
      timezone: NY,
      hours: [{ weekday: 1, start: '09:00', end: '10:00' }],
      from: new Date('2026-10-25T00:00:00Z'),
      to:   new Date('2026-11-03T00:00:00Z'),
      now: new Date('2026-10-01T00:00:00Z'),
    });
    const locales = slots.map((s) => hhmm(s.start, NY));
    expect(locales).toEqual(['09:00', '09:30', '09:00', '09:30']);
    // Y en UTC los dos lunes NO coinciden: 13:00Z antes, 14:00Z después.
    expect(slots[0].start.toISOString()).toBe('2026-10-26T13:00:00.000Z');
    expect(slots[2].start.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('devuelve vacío si la duración no cabe en ningún bloque', () => {
    expect(computeSlots({ ...base, durationMin: 240 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/scheduling/availability`
Expected: FAIL — no existe `computeSlots`.

- [ ] **Step 3: Implementar**

```bash
pnpm --filter @citara/api add luxon
pnpm --filter @citara/api add -D @types/luxon
```

`apps/api/src/scheduling/availability.ts`:
```ts
import { DateTime, Interval } from 'luxon';

export interface HoursBlock { weekday: number; start: string; end: string }
export interface BusyInterval { start: Date; end: Date }
export interface Slot { start: Date; end: Date }

export interface SlotInput {
  from: Date;
  to: Date;
  /** IANA, de tenants.timezone. Toda la aritmética local depende de esto. */
  timezone: string;
  durationMin: number;
  bufferMin: number;
  granularityMin: number;
  minLeadMin: number;
  now: Date;
  hours: HoursBlock[];
  busy: BusyInterval[];
}

/**
 * Calcula las franjas libres. Función PURA: no consulta, no persiste.
 *
 * Trabaja en la zona del negocio y deja que Luxon resuelva los offsets: sumar
 * 24h en milisegundos se rompe en los cambios de horario de verano, avanzar un
 * día calendario no.
 */
export function computeSlots(input: SlotInput): Slot[] {
  const {
    from, to, timezone, durationMin, bufferMin,
    granularityMin, minLeadMin, now, hours, busy,
  } = input;

  const slots: Slot[] = [];

  // Lo ocupado se expande con el buffer a ambos lados: una cita no solo bloquea
  // su duración, también el margen de preparación antes y después.
  const blocked = busy.map((b) =>
    Interval.fromDateTimes(
      DateTime.fromJSDate(b.start).minus({ minutes: bufferMin }),
      DateTime.fromJSDate(b.end).plus({ minutes: bufferMin }),
    ),
  );

  const earliest = DateTime.fromJSDate(now).plus({ minutes: minLeadMin });

  let day = DateTime.fromJSDate(from).setZone(timezone).startOf('day');
  const lastDay = DateTime.fromJSDate(to).setZone(timezone).startOf('day');

  while (day < lastDay) {
    // Luxon: 1=lunes … 7=domingo. Nuestro esquema: 0=domingo … 6=sábado.
    const weekday = day.weekday === 7 ? 0 : day.weekday;

    for (const block of hours.filter((h) => h.weekday === weekday)) {
      const [sh, sm] = block.start.split(':').map(Number);
      const [eh, em] = block.end.split(':').map(Number);

      const blockStart = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
      const blockEnd = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

      let cursor = blockStart;
      while (true) {
        const slotEnd = cursor.plus({ minutes: durationMin });
        if (slotEnd > blockEnd) break;

        const fitsLead = cursor >= earliest;
        const candidate = Interval.fromDateTimes(cursor, slotEnd);
        const free = !blocked.some((b) => b.overlaps(candidate));

        if (fitsLead && free) {
          slots.push({ start: cursor.toJSDate(), end: slotEnd.toJSDate() });
        }
        cursor = cursor.plus({ minutes: granularityMin });
      }
    }

    // Avanzar un DÍA CALENDARIO, no 24 horas: es lo que sobrevive al DST.
    day = day.plus({ days: 1 }).startOf('day');
  }

  return slots;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/scheduling/availability`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scheduling): calcular franjas disponibles respetando zona horaria del negocio"
```

---

### Task 5: Reserva con traducción de errores de Postgres

**Files:**
- Create: `apps/api/src/scheduling/scheduling.errors.ts`, `booking.service.ts`, `availability.service.ts`
- Test: `apps/api/test/scheduling/booking.service.test.ts`

**Interfaces:**
- Consumes: `computeSlots`, `runInTenant`, tablas de Tasks 1-3.
- Produces:
```ts
class SlotTakenError extends Error {}
class OutsideHoursError extends Error {}
class TooSoonError extends Error {}
class NotFoundError extends Error {}

class AvailabilityService {
  slotsFor(tenantId, serviceId, resourceId | null, from: Date, to: Date, now?: Date): Promise<Slot[]>;
}
class BookingService {
  book(tenantId, input: BookInput): Promise<Appointment>;
  cancel(tenantId, appointmentId, contactId): Promise<Appointment>;
  reschedule(tenantId, appointmentId, contactId, newStart: Date): Promise<Appointment>;
  listForContact(tenantId, contactId, now: Date): Promise<Appointment[]>;
}
type BookInput = { serviceId: string; resourceId: string; contactId: string;
                   startsAt: Date; customerName: string; conversationId?: string; notes?: string };
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/booking.service.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { BookingService } from '../../src/scheduling/booking.service';
import { AvailabilityService } from '../../src/scheduling/availability.service';
import { SlotTakenError, OutsideHoursError, TooSoonError, NotFoundError }
  from '../../src/scheduling/scheduling.errors';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, closeHelpers } from '../helpers';

let ds: DataSource, booking: BookingService, availability: AvailabilityService;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;

// Jueves 10 de septiembre de 2026, 10:00 en Bogotá = 15:00 UTC.
const JUEVES_10AM = new Date('2026-09-10T15:00:00Z');
const AHORA = new Date('2026-09-08T12:00:00Z');

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
  availability = new AvailabilityService(ds);
  booking = new BookingService(ds, availability);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });

const input = (startsAt = JUEVES_10AM) => ({
  serviceId, resourceId, contactId, startsAt, customerName: 'Ana',
});

describe('BookingService.book', () => {
  it('reserva una franja libre y calcula ends_at desde la duración del servicio', async () => {
    const cita = await booking.book(tenantId, { ...input(), now: AHORA });
    expect(cita.startsAt.toISOString()).toBe(JUEVES_10AM.toISOString());
    expect(cita.endsAt.toISOString()).toBe('2026-09-10T15:30:00.000Z');
    expect(cita.status).toBe('confirmed');
    expect(cita.googleSyncStatus).toBe('pending');
  });

  it('lanza SlotTakenError si la franja se ocupó entre consulta y reserva', async () => {
    await booking.book(tenantId, { ...input(), now: AHORA });
    await expect(booking.book(tenantId, { ...input(), now: AHORA }))
      .rejects.toBeInstanceOf(SlotTakenError);
  });

  it('lanza OutsideHoursError fuera del horario de atención', async () => {
    // Domingo: no hay horario definido.
    await expect(booking.book(tenantId, {
      ...input(new Date('2026-09-13T15:00:00Z')), now: AHORA,
    })).rejects.toBeInstanceOf(OutsideHoursError);
  });

  it('lanza OutsideHoursError si la cita se sale del cierre', async () => {
    // 17:45 local + 30 min = 18:15, pasado el cierre de las 18:00.
    await expect(booking.book(tenantId, {
      ...input(new Date('2026-09-10T22:45:00Z')), now: AHORA,
    })).rejects.toBeInstanceOf(OutsideHoursError);
  });

  it('lanza TooSoonError si no respeta la anticipación mínima', async () => {
    await expect(booking.book(tenantId, {
      ...input(), now: new Date('2026-09-10T14:50:00Z'), // 10 min antes
    })).rejects.toBeInstanceOf(TooSoonError);
  });

  it('NO confía en el llamador: valida aunque le pasen una hora arbitraria', async () => {
    // Las 3 de la madrugada nunca es válida, la pida quien la pida.
    await expect(booking.book(tenantId, {
      ...input(new Date('2026-09-10T08:00:00Z')), now: AHORA,
    })).rejects.toBeInstanceOf(OutsideHoursError);
  });
});

describe('BookingService.cancel', () => {
  it('cancela una cita propia y libera la franja', async () => {
    const cita = await booking.book(tenantId, { ...input(), now: AHORA });
    const cancelada = await booking.cancel(tenantId, cita.id, contactId);
    expect(cancelada.status).toBe('cancelled');

    // La franja vuelve a estar disponible.
    await expect(booking.book(tenantId, { ...input(), now: AHORA })).resolves.toBeDefined();
  });

  it('no deja cancelar la cita de otro contacto', async () => {
    const cita = await booking.book(tenantId, { ...input(), now: AHORA });
    const otro = await seedContact(tenantId, '573009998877');
    await expect(booking.cancel(tenantId, cita.id, otro))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('BookingService.listForContact', () => {
  it('lista solo las citas futuras confirmadas del contacto', async () => {
    const futura = await booking.book(tenantId, { ...input(), now: AHORA });
    const otra = await booking.book(tenantId, {
      ...input(new Date('2026-09-11T15:00:00Z')), now: AHORA });
    await booking.cancel(tenantId, otra.id, contactId);

    const citas = await booking.listForContact(tenantId, contactId, AHORA);
    expect(citas.map((c) => c.id)).toEqual([futura.id]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/scheduling/booking`
Expected: FAIL — no existe `BookingService`.

- [ ] **Step 3: Implementar**

`apps/api/src/scheduling/scheduling.errors.ts`:
```ts
export class SchedulingError extends Error {}

/** La franja se ocupó entre la consulta y la reserva. Ofrecer alternativas. */
export class SlotTakenError extends SchedulingError {
  constructor() { super('La franja ya está ocupada'); }
}
export class OutsideHoursError extends SchedulingError {
  constructor() { super('El horario solicitado está fuera de la atención del negocio'); }
}
export class TooSoonError extends SchedulingError {
  constructor(minLeadMin: number) {
    super(`Se requiere al menos ${minLeadMin} minutos de anticipación`);
  }
}
export class NotFoundError extends SchedulingError {
  constructor(what = 'recurso') { super(`No se encontró el ${what}`); }
}
```

`apps/api/src/scheduling/availability.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { computeSlots, type Slot } from './availability';
import { runInTenant } from '../tenancy/tenant-context';
import { NotFoundError } from './scheduling.errors';

export const DEFAULT_GRANULARITY_MIN = 15;
export const DEFAULT_MIN_LEAD_MIN = 60;

@Injectable()
export class AvailabilityService {
  constructor(private readonly ds: DataSource) {}

  async slotsFor(
    tenantId: string,
    serviceId: string,
    resourceId: string | null,
    from: Date,
    to: Date,
    now: Date = new Date(),
  ): Promise<Slot[]> {
    return runInTenant(this.ds, tenantId, async (m) => {
      const [tenant] = await m.query(`SELECT timezone FROM tenants WHERE id = $1`, [tenantId]);
      if (!tenant) throw new NotFoundError('negocio');

      const [service] = await m.query(
        `SELECT duration_min, buffer_min FROM services WHERE id = $1 AND active`, [serviceId]);
      if (!service) throw new NotFoundError('servicio');

      const hours = await m.query(
        `SELECT weekday, to_char(start_time,'HH24:MI') AS start,
                to_char(end_time,'HH24:MI') AS end
           FROM business_hours
          WHERE resource_id IS NOT DISTINCT FROM $1 OR resource_id IS NULL`,
        [resourceId],
      );

      const busy = await m.query(
        `SELECT starts_at AS start, ends_at AS end FROM appointments
          WHERE status = 'confirmed' AND starts_at < $2 AND ends_at > $1
            AND ($3::uuid IS NULL OR resource_id = $3)
         UNION ALL
         SELECT starts_at, ends_at FROM time_off
          WHERE starts_at < $2 AND ends_at > $1
            AND ($3::uuid IS NULL OR resource_id = $3 OR resource_id IS NULL)`,
        [from, to, resourceId],
      );

      return computeSlots({
        from, to, now,
        timezone: tenant.timezone,
        durationMin: service.duration_min,
        bufferMin: service.buffer_min,
        granularityMin: DEFAULT_GRANULARITY_MIN,
        minLeadMin: DEFAULT_MIN_LEAD_MIN,
        hours,
        busy: busy.map((b: { start: Date; end: Date }) => ({ start: b.start, end: b.end })),
      });
    });
  }
}
```

`apps/api/src/scheduling/booking.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { AvailabilityService, DEFAULT_MIN_LEAD_MIN } from './availability.service';
import { SlotTakenError, OutsideHoursError, TooSoonError, NotFoundError } from './scheduling.errors';

const PG_EXCLUSION_VIOLATION = '23P01';

export interface BookInput {
  serviceId: string;
  resourceId: string;
  contactId: string;
  startsAt: Date;
  customerName: string;
  conversationId?: string;
  notes?: string;
  now?: Date;
}

export interface Appointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  googleSyncStatus: string;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly ds: DataSource,
    private readonly availability: AvailabilityService,
  ) {}

  async book(tenantId: string, input: BookInput): Promise<Appointment> {
    const now = input.now ?? new Date();

    if (input.startsAt.getTime() - now.getTime() < DEFAULT_MIN_LEAD_MIN * 60_000) {
      throw new TooSoonError(DEFAULT_MIN_LEAD_MIN);
    }

    // REGLA R1 del spec: la herramienta valida por su cuenta. No se asume que
    // el llamador (menú hoy, LLM en la Fase 4) haya elegido una franja legítima.
    const dayStart = new Date(input.startsAt); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const slots = await this.availability.slotsFor(
      tenantId, input.serviceId, input.resourceId, dayStart, dayEnd, now,
    );
    const legit = slots.some((s) => s.start.getTime() === input.startsAt.getTime());
    if (!legit) throw new OutsideHoursError();

    return runInTenant(this.ds, tenantId, async (m) => {
      const [service] = await m.query(
        `SELECT duration_min FROM services WHERE id = $1`, [input.serviceId]);
      if (!service) throw new NotFoundError('servicio');

      const endsAt = new Date(input.startsAt.getTime() + service.duration_min * 60_000);

      try {
        const [row] = await m.query(
          `INSERT INTO appointments
             (tenant_id, resource_id, service_id, contact_id, conversation_id,
              starts_at, ends_at, customer_name, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, starts_at, ends_at, status, google_sync_status`,
          [tenantId, input.resourceId, input.serviceId, input.contactId,
           input.conversationId ?? null, input.startsAt, endsAt,
           input.customerName, input.notes ?? null],
        );
        return this.toAppointment(row);
      } catch (err: unknown) {
        // La carrera consultar→reservar la resuelve el motor, no un if previo.
        if ((err as { code?: string }).code === PG_EXCLUSION_VIOLATION) {
          throw new SlotTakenError();
        }
        throw err;
      }
    });
  }

  async cancel(tenantId: string, appointmentId: string, contactId: string): Promise<Appointment> {
    return runInTenant(this.ds, tenantId, async (m) => {
      // La propiedad se verifica en SQL: el llamador no puede saltársela.
      const [row] = await m.query(
        `UPDATE appointments
            SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'
          RETURNING id, starts_at, ends_at, status, google_sync_status`,
        [appointmentId, contactId],
      );
      if (!row) throw new NotFoundError('cita');
      return this.toAppointment(row);
    });
  }

  async reschedule(
    tenantId: string, appointmentId: string, contactId: string, newStart: Date, now = new Date(),
  ): Promise<Appointment> {
    const [existing] = await runInTenant(this.ds, tenantId, (m) =>
      m.query(`SELECT service_id, resource_id FROM appointments
                WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'`,
              [appointmentId, contactId]));
    if (!existing) throw new NotFoundError('cita');

    // Cancelar libera la franja vieja ANTES de reservar la nueva; si la nueva
    // falla, la cancelación se revierte con el throw.
    await this.cancel(tenantId, appointmentId, contactId);
    try {
      return await this.book(tenantId, {
        serviceId: existing.service_id, resourceId: existing.resource_id,
        contactId, startsAt: newStart, customerName: '', now,
      });
    } catch (err) {
      await runInTenant(this.ds, tenantId, (m) =>
        m.query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [appointmentId]));
      throw err;
    }
  }

  async listForContact(tenantId: string, contactId: string, now: Date): Promise<Appointment[]> {
    const rows = await runInTenant(this.ds, tenantId, (m) =>
      m.query(
        `SELECT id, starts_at, ends_at, status, google_sync_status
           FROM appointments
          WHERE contact_id = $1 AND status = 'confirmed' AND starts_at >= $2
          ORDER BY starts_at`,
        [contactId, now]));
    return rows.map((r: Record<string, unknown>) => this.toAppointment(r));
  }

  private toAppointment(row: Record<string, any>): Appointment {
    return {
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      googleSyncStatus: row.google_sync_status,
    };
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/scheduling/booking`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scheduling): reservar y cancelar citas traduciendo la violación de exclusión a error de dominio"
```

---

### Task 6: Registro de herramientas de agenda

El contrato que la Fase 4 entregará al modelo **sin modificarlo**. Hoy lo invoca un
menú determinista; mañana lo invoca el agente. Esa es la razón de construirlo ahora:
para cuando llegue el LLM, estas operaciones ya llevan semanas probadas.

**Files:**
- Create: `apps/api/src/scheduling/tools/index.ts` y los seis archivos de herramienta
- Test: `apps/api/test/scheduling/tools.test.ts`

**Interfaces:**
- Consumes: `AvailabilityService`, `BookingService`.
- Produces:
```ts
interface ToolContext { tenantId: string; contactId: string; conversationId: string; now: Date }
interface ToolResult { ok: boolean; data?: unknown; error?: string; confirmationToken?: string }
interface ToolDefinition {
  name: string;
  description: string;             // se le entrega al modelo en la Fase 4
  schema: z.ZodTypeAny;            // valida ANTES de ejecutar
  destructive: boolean;            // exige confirmación en dos tiempos
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
const TOOLS: Record<string, ToolDefinition>;
async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/tools.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { runTool, TOOLS } from '../../src/scheduling/tools';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact,
         seedConversation, closeHelpers, buildToolRegistry } from '../helpers';

let ctx: { tenantId: string; contactId: string; conversationId: string; now: Date };
let serviceId: string, resourceId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');

beforeEach(async () => {
  await resetDb();
  const { tenantId } = await seedChannel();
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  const contactId = await seedContact(tenantId);
  const conversationId = await seedConversation(tenantId, contactId);
  ctx = { tenantId, contactId, conversationId, now: AHORA };
  await buildToolRegistry();
});
afterAll(async () => { await closeHelpers(); });

describe('registro de herramientas', () => {
  it('marca como destructivas solo cancelar y reprogramar', () => {
    const destructivas = Object.values(TOOLS).filter((t) => t.destructive).map((t) => t.name);
    expect(destructivas.sort()).toEqual(['cancelar_cita', 'reprogramar_cita']);
  });

  it('ninguna herramienta acepta tenant_id ni contact_id como argumento', () => {
    // REGLA R3: la identidad la inyecta el runtime, no el modelo.
    for (const tool of Object.values(TOOLS)) {
      const shape = (tool.schema as any)._def?.shape?.() ?? {};
      expect(Object.keys(shape)).not.toContain('tenant_id');
      expect(Object.keys(shape)).not.toContain('contact_id');
    }
  });
});

describe('consultar_servicios', () => {
  it('lista los servicios activos con duración y precio', async () => {
    const res = await runTool('consultar_servicios', {}, ctx);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject([{ id: serviceId, nombre: 'Corte de cabello', duracion_min: 30 }]);
  });
});

describe('consultar_disponibilidad', () => {
  it('devuelve franjas en ISO con offset del negocio', async () => {
    const res = await runTool('consultar_disponibilidad', {
      servicio_id: serviceId, desde: '2026-09-10', hasta: '2026-09-11',
    }, ctx);
    expect(res.ok).toBe(true);
    const franjas = res.data as { inicio: string }[];
    expect(franjas[0].inicio).toMatch(/^2026-09-10T09:00:00-05:00$/);
  });

  it('rechaza un rango invertido con un error legible', async () => {
    const res = await runTool('consultar_disponibilidad', {
      servicio_id: serviceId, desde: '2026-09-11', hasta: '2026-09-10',
    }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rango/i);
  });

  it('rechaza un servicio inexistente sin lanzar', async () => {
    const res = await runTool('consultar_disponibilidad', {
      servicio_id: '00000000-0000-0000-0000-000000000000',
      desde: '2026-09-10', hasta: '2026-09-11',
    }, ctx);
    expect(res.ok).toBe(false);
  });
});

describe('agendar_cita', () => {
  it('agenda y devuelve el identificador de la cita', async () => {
    const res = await runTool('agendar_cita', {
      servicio_id: serviceId, recurso_id: resourceId,
      inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana',
    }, ctx);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ estado: 'confirmed' });
  });

  it('devuelve ok:false con mensaje útil si la franja se ocupó', async () => {
    const args = { servicio_id: serviceId, recurso_id: resourceId,
                   inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana' };
    await runTool('agendar_cita', args, ctx);
    const res = await runTool('agendar_cita', args, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ocupada/i);
  });

  it('rechaza una fecha sin offset de zona — nunca adivina la zona', async () => {
    const res = await runTool('agendar_cita', {
      servicio_id: serviceId, recurso_id: resourceId,
      inicio: '2026-09-10T10:00:00', nombre: 'Ana',
    }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/zona|offset/i);
  });

  it('rechaza una fecha en el pasado', async () => {
    const res = await runTool('agendar_cita', {
      servicio_id: serviceId, recurso_id: resourceId,
      inicio: '2020-01-01T10:00:00-05:00', nombre: 'Ana',
    }, ctx);
    expect(res.ok).toBe(false);
  });
});

describe('cancelar_cita — confirmación en dos tiempos', () => {
  it('la primera llamada NO cancela: devuelve detalles y un token', async () => {
    const creada = await runTool('agendar_cita', {
      servicio_id: serviceId, recurso_id: resourceId,
      inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana',
    }, ctx);
    const citaId = (creada.data as { id: string }).id;

    const primera = await runTool('cancelar_cita', { cita_id: citaId }, ctx);
    expect(primera.ok).toBe(true);
    expect(primera.confirmationToken).toBeTruthy();
    expect((primera.data as { requiere_confirmacion: boolean }).requiere_confirmacion).toBe(true);

    const vigentes = await runTool('consultar_mis_citas', {}, ctx);
    expect(vigentes.data).toHaveLength(1); // sigue viva
  });

  it('la segunda llamada con el token sí cancela', async () => {
    const creada = await runTool('agendar_cita', {
      servicio_id: serviceId, recurso_id: resourceId,
      inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana',
    }, ctx);
    const citaId = (creada.data as { id: string }).id;

    const primera = await runTool('cancelar_cita', { cita_id: citaId }, ctx);
    const segunda = await runTool('cancelar_cita',
      { cita_id: citaId, confirmation_token: primera.confirmationToken }, ctx);

    expect(segunda.ok).toBe(true);
    const vigentes = await runTool('consultar_mis_citas', {}, ctx);
    expect(vigentes.data).toHaveLength(0);
  });

  it('rechaza un token inventado', async () => {
    const creada = await runTool('agendar_cita', {
      servicio_id: serviceId, recurso_id: resourceId,
      inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana',
    }, ctx);
    const citaId = (creada.data as { id: string }).id;
    const res = await runTool('cancelar_cita',
      { cita_id: citaId, confirmation_token: 'inventado' }, ctx);
    expect(res.ok).toBe(false);
  });

  it('no cancela la cita de otro contacto ni siquiera con token válido', async () => {
    const creada = await runTool('agendar_cita', {
      servicio_id: serviceId, recurso_id: resourceId,
      inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana',
    }, ctx);
    const citaId = (creada.data as { id: string }).id;
    const primera = await runTool('cancelar_cita', { cita_id: citaId }, ctx);

    const intruso = { ...ctx, contactId: await seedContact(ctx.tenantId, '573009990000') };
    const res = await runTool('cancelar_cita',
      { cita_id: citaId, confirmation_token: primera.confirmationToken }, intruso);
    expect(res.ok).toBe(false);
  });
});
```

> El último test es la prueba de la regla R3 y vale por sí solo: aunque un atacante
> —o un modelo confundido— consiga un token válido, la propiedad se verifica contra
> el `contactId` que inyecta el runtime.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/scheduling/tools`
Expected: FAIL — no existe el registro.

- [ ] **Step 3: Implementar**

```bash
pnpm --filter @citara/api add zod
```

`apps/api/src/scheduling/tools/index.ts`:
```ts
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { DateTime } from 'luxon';
import type { AvailabilityService } from '../availability.service';
import type { BookingService } from '../booking.service';
import { SlotTakenError, SchedulingError } from '../scheduling.errors';

export interface ToolContext {
  tenantId: string;
  contactId: string;
  conversationId: string;
  now: Date;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  confirmationToken?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  destructive: boolean;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** ISO-8601 que EXIGE offset: nunca se adivina la zona de una fecha suelta. */
const isoConOffset = z.string().refine(
  (v) => /[+-]\d{2}:\d{2}$|Z$/.test(v) && DateTime.fromISO(v, { setZone: true }).isValid,
  'La fecha debe incluir offset de zona (p. ej. 2026-09-10T10:00:00-05:00)',
);

/** Token derivado de la cita y el contacto: no se guarda estado para validarlo. */
function confirmationToken(citaId: string, contactId: string): string {
  return createHmac('sha256', process.env.DB_ENCRYPTION_KEY!)
    .update(`${citaId}:${contactId}`).digest('hex').slice(0, 32);
}

let availability: AvailabilityService;
let booking: BookingService;

/** Se llama una vez al arrancar la app (y en los tests). */
export function configureTools(a: AvailabilityService, b: BookingService): void {
  availability = a; booking = b;
}

export const TOOLS: Record<string, ToolDefinition> = {
  consultar_servicios: {
    name: 'consultar_servicios',
    description: 'Lista los servicios que ofrece el negocio, con duración y precio.',
    schema: z.object({}),
    destructive: false,
    async run(_args, ctx) {
      const rows = await availability.listServices(ctx.tenantId);
      return { ok: true, data: rows };
    },
  },

  consultar_disponibilidad: {
    name: 'consultar_disponibilidad',
    description: 'Devuelve las franjas libres para un servicio en un rango de fechas.',
    schema: z.object({
      servicio_id: z.string().uuid(),
      recurso_id: z.string().uuid().optional(),
      desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    destructive: false,
    async run(args, ctx) {
      const a = args as { servicio_id: string; recurso_id?: string; desde: string; hasta: string };
      if (a.hasta < a.desde) return { ok: false, error: 'El rango de fechas está invertido' };

      const tz = await availability.timezoneOf(ctx.tenantId);
      const from = DateTime.fromISO(a.desde, { zone: tz }).startOf('day').toJSDate();
      const to = DateTime.fromISO(a.hasta, { zone: tz }).endOf('day').toJSDate();

      const slots = await availability.slotsFor(
        ctx.tenantId, a.servicio_id, a.recurso_id ?? null, from, to, ctx.now);

      return {
        ok: true,
        data: slots.map((s) => ({
          inicio: DateTime.fromJSDate(s.start).setZone(tz).toISO({ suppressMilliseconds: true }),
          fin: DateTime.fromJSDate(s.end).setZone(tz).toISO({ suppressMilliseconds: true }),
        })),
      };
    },
  },

  consultar_mis_citas: {
    name: 'consultar_mis_citas',
    description: 'Lista las próximas citas confirmadas de quien escribe.',
    schema: z.object({}),
    destructive: false,
    async run(_args, ctx) {
      const citas = await booking.listForContact(ctx.tenantId, ctx.contactId, ctx.now);
      return { ok: true, data: citas.map((c) => ({ id: c.id, inicio: c.startsAt.toISOString() })) };
    },
  },

  agendar_cita: {
    name: 'agendar_cita',
    description: 'Reserva una cita en una franja disponible.',
    schema: z.object({
      servicio_id: z.string().uuid(),
      recurso_id: z.string().uuid(),
      inicio: isoConOffset,
      nombre: z.string().min(1).max(255),
      notas: z.string().max(1000).optional(),
    }),
    destructive: false,
    async run(args, ctx) {
      const a = args as { servicio_id: string; recurso_id: string;
                          inicio: string; nombre: string; notas?: string };
      const cita = await booking.book(ctx.tenantId, {
        serviceId: a.servicio_id, resourceId: a.recurso_id,
        contactId: ctx.contactId, conversationId: ctx.conversationId,
        startsAt: new Date(a.inicio), customerName: a.nombre, notes: a.notas, now: ctx.now,
      });
      return { ok: true, data: { id: cita.id, inicio: cita.startsAt.toISOString(),
                                 estado: cita.status } };
    },
  },

  cancelar_cita: {
    name: 'cancelar_cita',
    description: 'Cancela una cita. Requiere confirmación explícita del usuario.',
    schema: z.object({
      cita_id: z.string().uuid(),
      confirmation_token: z.string().optional(),
      motivo: z.string().max(500).optional(),
    }),
    destructive: true,
    async run(args, ctx) {
      const a = args as { cita_id: string; confirmation_token?: string };
      const esperado = confirmationToken(a.cita_id, ctx.contactId);

      if (!a.confirmation_token) {
        // REGLA R4: la primera llamada NO ejecuta.
        const citas = await booking.listForContact(ctx.tenantId, ctx.contactId, ctx.now);
        const cita = citas.find((c) => c.id === a.cita_id);
        if (!cita) return { ok: false, error: 'No encontré esa cita a tu nombre' };
        return {
          ok: true,
          confirmationToken: esperado,
          data: { requiere_confirmacion: true, inicio: cita.startsAt.toISOString() },
        };
      }

      if (a.confirmation_token !== esperado) {
        return { ok: false, error: 'Token de confirmación inválido' };
      }
      await booking.cancel(ctx.tenantId, a.cita_id, ctx.contactId);
      return { ok: true, data: { cancelada: true } };
    },
  },

  reprogramar_cita: {
    name: 'reprogramar_cita',
    description: 'Mueve una cita a otro horario. Requiere confirmación explícita.',
    schema: z.object({
      cita_id: z.string().uuid(),
      nuevo_inicio: isoConOffset,
      confirmation_token: z.string().optional(),
    }),
    destructive: true,
    async run(args, ctx) {
      const a = args as { cita_id: string; nuevo_inicio: string; confirmation_token?: string };
      const esperado = confirmationToken(a.cita_id, ctx.contactId);

      if (!a.confirmation_token) {
        return { ok: true, confirmationToken: esperado,
                 data: { requiere_confirmacion: true, nuevo_inicio: a.nuevo_inicio } };
      }
      if (a.confirmation_token !== esperado) {
        return { ok: false, error: 'Token de confirmación inválido' };
      }
      const cita = await booking.reschedule(
        ctx.tenantId, a.cita_id, ctx.contactId, new Date(a.nuevo_inicio), ctx.now);
      return { ok: true, data: { id: cita.id, inicio: cita.startsAt.toISOString() } };
    },
  },
};

/**
 * Ejecuta una herramienta: valida argumentos, corre y normaliza errores.
 * NUNCA lanza: un error de dominio vuelve como { ok: false, error } para que el
 * llamador (menú o modelo) pueda explicarlo al usuario.
 */
export async function runTool(
  name: string, args: unknown, ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `Herramienta desconocida: ${name}` };

  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }

  try {
    return await tool.run(parsed.data, ctx);
  } catch (err) {
    if (err instanceof SlotTakenError) {
      return { ok: false, error: 'Esa franja ya está ocupada. Ofrece otro horario.' };
    }
    if (err instanceof SchedulingError) return { ok: false, error: err.message };
    throw err;
  }
}
```

Añadir a `AvailabilityService` los métodos `listServices(tenantId)` y `timezoneOf(tenantId)`:
```ts
async listServices(tenantId: string) {
  return runInTenant(this.ds, tenantId, (m) =>
    m.query(`SELECT id, name AS nombre, duration_min AS duracion_min,
                    price_cents AS precio_centavos
               FROM services WHERE active ORDER BY name`));
}

async timezoneOf(tenantId: string): Promise<string> {
  const [t] = await runInTenant(this.ds, tenantId, (m) =>
    m.query(`SELECT timezone FROM tenants WHERE id = $1`, [tenantId]));
  if (!t) throw new NotFoundError('negocio');
  return t.timezone;
}
```

Helpers de test:
```ts
export async function seedConversation(tenantId: string, contactId: string): Promise<string> {
  const ds = await adminDs();
  const [ch] = await ds.query(`SELECT id FROM whatsapp_channels WHERE tenant_id = $1`, [tenantId]);
  const [c] = await ds.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
     VALUES ($1,$2,$3, now()) RETURNING id`, [tenantId, contactId, ch.id]);
  return c.id;
}

/** Cablea el registro de herramientas contra la BD de pruebas. */
export async function buildToolRegistry(): Promise<void> {
  const ds = createDataSource(process.env.DATABASE_URL!);
  if (!ds.isInitialized) await ds.initialize();
  const availability = new AvailabilityService(ds);
  configureTools(availability, new BookingService(ds, availability));
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/scheduling/tools`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scheduling): exponer las operaciones de agenda como herramientas validadas con zod"
```

---

### Task 7: Paso `tool` en el motor y agendamiento por menús

**Files:**
- Modify: `apps/api/src/flow-engine/executor.ts`, `flow-runner.service.ts`
- Test: `apps/api/test/harness/agendar-por-menus.e2e.test.ts`

**Interfaces:**
- Consumes: `runTool`, `advance` (Fase 1), `ConversationHarness`.
- Produces: tipo de paso
```ts
{ type: 'tool'; tool: string; args: Record<string, string>;
  save_list?: string;        // guarda el resultado como lista elegible
  render?: string;           // plantilla por elemento, con {{campos}}
  on_success: string; on_error: string }
```
y `{ type: 'pick'; text: string; from: string; var: string; next: string }` para elegir de una lista guardada por número.

**Por qué `advance` deja de ser pura aquí:** una herramienta consulta la base. La
solución es que `advance` siga siendo pura y **devuelva una intención** —
`{ pending: { tool, args } }` — que `FlowRunner` ejecuta y vuelve a alimentar. El
motor no adquiere dependencias; el runner las tiene desde la Fase 1.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/harness/agendar-por-menus.e2e.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { ConversationHarness } from './conversation-harness';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow,
         adminQuery, closeHelpers } from '../helpers';

const flow = {
  key: 'agenda', entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Agendemos tu cita.', next: 'cargar_servicios' },
    cargar_servicios: {
      type: 'tool', tool: 'consultar_servicios', args: {},
      save_list: 'servicios', render: '{{nombre}} ({{duracion_min}} min)',
      on_success: 'elegir_servicio', on_error: 'error',
    },
    elegir_servicio: {
      type: 'pick', text: '¿Qué servicio necesitas?\n{{servicios}}',
      from: 'servicios', var: 'servicio_id', next: 'cargar_franjas',
    },
    cargar_franjas: {
      type: 'tool', tool: 'consultar_disponibilidad',
      args: { servicio_id: '{{servicio_id}}', desde: '2026-09-10', hasta: '2026-09-10' },
      save_list: 'franjas', render: '{{inicio}}',
      on_success: 'elegir_franja', on_error: 'error',
    },
    elegir_franja: {
      type: 'pick', text: 'Horarios disponibles:\n{{franjas}}',
      from: 'franjas', var: 'inicio', next: 'pide_nombre',
    },
    pide_nombre: { type: 'capture', text: '¿A nombre de quién?', var: 'nombre',
                   validate: 'text', next: 'reservar' },
    reservar: {
      type: 'tool', tool: 'agendar_cita',
      args: { servicio_id: '{{servicio_id}}', recurso_id: '{{recurso_id}}',
              inicio: '{{inicio}}', nombre: '{{nombre}}' },
      on_success: 'listo', on_error: 'ocupado',
    },
    listo: { type: 'end', text: '¡Listo, {{nombre}}! Te esperamos.' },
    ocupado: { type: 'end', text: 'Ese horario se acaba de ocupar. Escríbenos de nuevo.' },
    error: { type: 'end', text: 'Tuvimos un problema. Intenta más tarde.' },
  },
};

let h: ConversationHarness, tenantId: string, resourceId: string;

beforeEach(async () => {
  await resetDb();
  let channelId: string;
  ({ tenantId, channelId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  await seedFlow(tenantId, flow);
  h = await ConversationHarness.create({
    tenantId, channelId, from: '573001112233',
    now: new Date('2026-09-08T12:00:00Z'),
    vars: { recurso_id: resourceId },
  });
});
afterAll(async () => { await ConversationHarness.teardown(); await closeHelpers(); });

describe('agendar una cita solo con menús', () => {
  it('recorre servicios → franjas → nombre → cita creada', async () => {
    const uno = await h.say('Hola');
    expect(uno[1].body).toContain('Corte de cabello (30 min)');

    const dos = await h.say('1');
    expect(dos[0].body).toContain('2026-09-10T09:00:00-05:00');

    await h.say('1');                       // primera franja
    const fin = await h.say('Ana');
    expect(fin[0]).toEqual({ kind: 'text', body: '¡Listo, Ana! Te esperamos.' });

    const citas = await adminQuery(
      `SELECT starts_at, customer_name, status FROM appointments WHERE tenant_id = $1`,
      [tenantId]);
    expect(citas).toHaveLength(1);
    expect(citas[0].customer_name).toBe('Ana');
    expect(citas[0].status).toBe('confirmed');
    expect(new Date(citas[0].starts_at).toISOString()).toBe('2026-09-10T14:00:00.000Z');
  });

  it('si la franja se ocupa entre la elección y la reserva, sale por on_error', async () => {
    await h.say('Hola'); await h.say('1'); await h.say('1');

    // Alguien más reserva justo esa franja antes de que el usuario dé su nombre.
    const contacto = await adminQuery(
      `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1,'573000000000','Otro') RETURNING id`,
      [tenantId]);
    const servicio = await adminQuery(`SELECT id FROM services WHERE tenant_id = $1`, [tenantId]);
    await adminQuery(
      `INSERT INTO appointments
         (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,'2026-09-10T14:00:00Z','2026-09-10T14:30:00Z')`,
      [tenantId, resourceId, servicio[0].id, contacto[0].id]);

    const fin = await h.say('Ana');
    expect(fin[0].body).toContain('se acaba de ocupar');
  });

  it('elegir un número fuera de la lista repite la pregunta', async () => {
    await h.say('Hola');
    const res = await h.say('99');
    expect(res[0].body).toContain('¿Qué servicio necesitas?');
  });
});
```

> El segundo test es la carrera del spec vista desde el usuario: la restricción de
> la base de datos se convierte en un mensaje comprensible, no en un error 500.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/harness/agendar-por-menus`
Expected: FAIL — el motor no conoce `tool` ni `pick`.

- [ ] **Step 3: Implementar**

En `apps/api/src/flow-engine/executor.ts`, ampliar el resultado:
```ts
export interface ExecResult {
  state: SessionState;
  outbound: OutboundContent[];
  /** Intención de invocar una herramienta. El motor NO la ejecuta. */
  pending?: { tool: string; args: Record<string, string>; stepKey: string };
}
```

Y dentro del bucle de `advance`:
```ts
if (step.type === 'tool') {
  // El motor sigue siendo puro: solo declara qué hay que ejecutar.
  const args = Object.fromEntries(
    Object.entries(step.args).map(([k, v]) => [k, interpolate(v, current.vars)]),
  );
  return { state: current, outbound, pending: { tool: step.tool, args, stepKey: current.stepKey } };
}

if (step.type === 'pick') {
  const raw = current.vars[`__${step.from}`];
  const options: Record<string, string>[] = raw ? JSON.parse(raw) : [];

  if (input === null) {
    outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
    return { state: current, outbound };
  }

  const index = /^\d+$/.test(input.trim()) ? Number(input.trim()) - 1 : -1;
  if (index < 0 || index >= options.length) {
    outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
    return { state: current, outbound };
  }

  // Guarda el campo canónico del elegido: 'id' si existe, si no 'inicio'.
  const chosen = options[index];
  current = {
    ...current,
    vars: { ...current.vars, [step.var]: chosen.id ?? chosen.inicio ?? '' },
    stepKey: step.next,
  };
  input = null;
  continue;
}
```

En `FlowRunner.handle`, envolver la ejecución en un bucle que resuelva las
herramientas pendientes:
```ts
const MAX_TOOL_HOPS = 5;

let result = advance(flow, state, input);

for (let hop = 0; result.pending && hop < MAX_TOOL_HOPS; hop++) {
  const { tool, args, stepKey } = result.pending;
  const step = flow.steps[stepKey] as { on_success: string; on_error: string;
                                        save_list?: string; render?: string };

  const toolResult = await runTool(tool, args, {
    tenantId: job.tenantId, contactId, conversationId, now: new Date(),
  });

  const vars = { ...result.state.vars };
  if (toolResult.ok && step.save_list && Array.isArray(toolResult.data)) {
    const items = toolResult.data as Record<string, string>[];
    // La lista cruda va en __clave (para 'pick'); la versión legible en clave.
    vars[`__${step.save_list}`] = JSON.stringify(items);
    vars[step.save_list] = items
      .map((it, i) => `${i + 1}. ${interpolate(step.render ?? '{{id}}', it)}`)
      .join('\n');
  }
  if (!toolResult.ok && toolResult.error) vars.__tool_error = toolResult.error;

  const nextKey = toolResult.ok ? step.on_success : step.on_error;
  const nextState = { ...result.state, vars, stepKey: nextKey };
  const nextResult = advance(flow, nextState, null);

  result = { ...nextResult, outbound: [...result.outbound, ...nextResult.outbound] };
}

if (result.pending) {
  throw new Error(`Cadena de herramientas demasiado larga en el flujo '${flow.key}'`);
}
```

`ConversationHarness.create` acepta ahora `now` y `vars` iniciales, que se
inyectan en la sesión al crearla.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test`
Expected: PASS, toda la suite de las fases 1 y 2.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(flow-engine): invocar herramientas de agenda desde pasos deterministas del flujo"
```

---

### Task 8: Recordatorios programados

**Files:**
- Create: migración `1725400600000-CreateReminders.ts`
- Create: `apps/api/src/scheduling/reminders.service.ts`, `apps/api/src/queues/reminders.processor.ts`
- Test: `apps/api/test/scheduling/reminders.test.ts`

**Interfaces:**
- Consumes: `BookingService`, `OutboundQueue`, `canSendFreeform` (Fase 1).
- Produces: `RemindersService.scheduleFor(appointment)`, `RemindersService.due(now): Promise<Reminder[]>`, y el contenido de salida `{ kind: 'template'; name: string; language: string; params: string[] }`.

**Trabajo externo que arranca aquí:** enviar a aprobación de Meta las plantillas
`recordatorio_cita_24h` y `recordatorio_cita_2h`. La aprobación tarda de horas a días,
así que se radica al empezar la tarea, no al terminarla.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/scheduling/reminders.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { RemindersService } from '../../src/scheduling/reminders.service';
import { BookingService } from '../../src/scheduling/booking.service';
import { AvailabilityService } from '../../src/scheduling/availability.service';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact,
         adminQuery, closeHelpers } from '../helpers';

let ds: DataSource, reminders: RemindersService, booking: BookingService;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const CITA = new Date('2026-09-10T15:00:00Z');

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
  const availability = new AvailabilityService(ds);
  booking = new BookingService(ds, availability);
  reminders = new RemindersService(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });

const agendar = () => booking.book(tenantId, {
  serviceId, resourceId, contactId, startsAt: CITA, customerName: 'Ana', now: AHORA });

describe('RemindersService', () => {
  it('programa dos recordatorios al crear una cita', async () => {
    const cita = await agendar();
    await reminders.scheduleFor(tenantId, cita.id);

    const rows = await adminQuery(
      `SELECT kind, send_at FROM reminders WHERE appointment_id = $1 ORDER BY send_at`,
      [cita.id]);
    expect(rows.map((r) => r.kind)).toEqual(['24h', '2h']);
    expect(new Date(rows[0].send_at).toISOString()).toBe('2026-09-09T15:00:00.000Z');
    expect(new Date(rows[1].send_at).toISOString()).toBe('2026-09-10T13:00:00.000Z');
  });

  it('no programa un recordatorio cuyo momento ya pasó', async () => {
    const cita = await booking.book(tenantId, {
      serviceId, resourceId, contactId, customerName: 'Ana',
      startsAt: new Date('2026-09-08T15:00:00Z'), // en 3 horas
      now: AHORA });
    await reminders.scheduleFor(tenantId, cita.id);

    const rows = await adminQuery(
      `SELECT kind FROM reminders WHERE appointment_id = $1`, [cita.id]);
    expect(rows.map((r) => r.kind)).toEqual(['2h']); // el de 24h ya no aplica
  });

  it('due() devuelve solo los vencidos y pendientes', async () => {
    const cita = await agendar();
    await reminders.scheduleFor(tenantId, cita.id);

    expect(await reminders.due(new Date('2026-09-09T14:00:00Z'))).toHaveLength(0);
    expect(await reminders.due(new Date('2026-09-09T15:30:00Z'))).toHaveLength(1);
  });

  it('cancelar la cita cancela sus recordatorios pendientes', async () => {
    const cita = await agendar();
    await reminders.scheduleFor(tenantId, cita.id);
    await booking.cancel(tenantId, cita.id, contactId);
    await reminders.syncWithAppointment(tenantId, cita.id);

    const rows = await adminQuery(
      `SELECT status FROM reminders WHERE appointment_id = $1`, [cita.id]);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('marca el recordatorio como enviado y no lo repite', async () => {
    const cita = await agendar();
    await reminders.scheduleFor(tenantId, cita.id);
    const [pendiente] = await reminders.due(new Date('2026-09-09T15:30:00Z'));

    await reminders.markSent(tenantId, pendiente.id);
    expect(await reminders.due(new Date('2026-09-09T15:30:00Z'))).toHaveLength(0);
  });

  it('el recordatorio se envía SIEMPRE como plantilla, nunca como texto libre', async () => {
    const cita = await agendar();
    await reminders.scheduleFor(tenantId, cita.id);
    const [pendiente] = await reminders.due(new Date('2026-09-09T15:30:00Z'));

    const content = reminders.buildContent(pendiente);
    expect(content.kind).toBe('template');
    expect(content.name).toBe('recordatorio_cita_24h');
  });
});
```

> El último test protege la regla de la ventana de 24 h: un recordatorio, por
> definición, se envía cuando la conversación lleva horas o días inactiva. Enviarlo
> como texto libre siempre falla en Meta.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/scheduling/reminders`
Expected: FAIL — no existe `RemindersService`.

- [ ] **Step 3: Implementar**

Migración `1725400600000-CreateReminders.ts`:
```ts
await q.query(`
  CREATE TABLE reminders (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    kind           varchar(16) NOT NULL CHECK (kind IN ('24h','2h')),
    send_at        timestamptz NOT NULL,
    status         varchar(16) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sent','cancelled','failed')),
    sent_at        timestamptz,
    UNIQUE (appointment_id, kind)
  )
`);
await q.query(`
  CREATE INDEX reminders_due ON reminders (send_at) WHERE status = 'pending'
`);
for (const sql of tenantRlsSql('reminders')) await q.query(sql);
```

`apps/api/src/scheduling/reminders.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';

const OFFSETS: { kind: '24h' | '2h'; minutesBefore: number; template: string }[] = [
  { kind: '24h', minutesBefore: 24 * 60, template: 'recordatorio_cita_24h' },
  { kind: '2h',  minutesBefore: 2 * 60,  template: 'recordatorio_cita_2h' },
];

export interface Reminder {
  id: string; tenantId: string; appointmentId: string;
  kind: '24h' | '2h'; sendAt: Date; waId: string; customerName: string; startsAt: Date;
}

export interface TemplateContent {
  kind: 'template'; name: string; language: string; params: string[];
}

@Injectable()
export class RemindersService {
  constructor(private readonly ds: DataSource) {}

  async scheduleFor(tenantId: string, appointmentId: string, now = new Date()): Promise<void> {
    await runInTenant(this.ds, tenantId, async (m) => {
      const [cita] = await m.query(
        `SELECT starts_at FROM appointments WHERE id = $1`, [appointmentId]);
      if (!cita) return;

      for (const o of OFFSETS) {
        const sendAt = new Date(new Date(cita.starts_at).getTime() - o.minutesBefore * 60_000);
        // Un recordatorio cuyo momento ya pasó no se programa: se descarta.
        if (sendAt <= now) continue;

        await m.query(
          `INSERT INTO reminders (tenant_id, appointment_id, kind, send_at)
           VALUES ($1,$2,$3,$4) ON CONFLICT (appointment_id, kind) DO NOTHING`,
          [tenantId, appointmentId, o.kind, sendAt],
        );
      }
    });
  }

  /**
   * Recordatorios vencidos y pendientes de todos los negocios.
   *
   * OJO — la razón de que esto itere tenants en vez de hacer un solo SELECT:
   * `reminders` tiene RLS, así que una consulta sin `app.tenant_id` devuelve
   * CERO filas (falla cerrado, decisión D2 del spec). Un barrido global exigiría
   * una conexión privilegiada, y abrir esa puerta para una tarea de fondo es
   * exactamente cómo se filtran datos entre clientes. A este volumen, una
   * consulta por negocio cada minuto no cuesta nada.
   */
  async due(now: Date): Promise<Reminder[]> {
    // La lista de negocios activos es la única lectura sin contexto: `tenants`
    // es la tabla raíz y no lleva RLS.
    const tenants = await this.ds.query(
      `SELECT id FROM tenants WHERE status = 'active'`);

    const out: Reminder[] = [];
    for (const t of tenants) {
      const rows = await runInTenant(this.ds, t.id, (m) =>
        m.query(
          `SELECT r.id, r.tenant_id, r.appointment_id, r.kind, r.send_at,
                  c.wa_id, a.customer_name, a.starts_at
             FROM reminders r
             JOIN appointments a ON a.id = r.appointment_id
             JOIN contacts c ON c.id = a.contact_id
            WHERE r.status = 'pending' AND r.send_at <= $1 AND a.status = 'confirmed'
            ORDER BY r.send_at
            LIMIT 500`,
          [now]));

      for (const r of rows) {
        out.push({
          id: r.id, tenantId: r.tenant_id, appointmentId: r.appointment_id,
          kind: r.kind, sendAt: r.send_at, waId: r.wa_id,
          customerName: r.customer_name, startsAt: r.starts_at,
        });
      }
    }
    return out.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
  }

  /** Los recordatorios SIEMPRE son plantilla: van fuera de la ventana de 24 h. */
  buildContent(reminder: Reminder): TemplateContent {
    const template = OFFSETS.find((o) => o.kind === reminder.kind)!.template;
    return {
      kind: 'template', name: template, language: 'es',
      params: [reminder.customerName, reminder.startsAt.toISOString()],
    };
  }

  /** Recibe el tenant porque la escritura también pasa por el contexto de RLS. */
  async markSent(tenantId: string, reminderId: string): Promise<void> {
    await runInTenant(this.ds, tenantId, (m) =>
      m.query(`UPDATE reminders SET status = 'sent', sent_at = now() WHERE id = $1`,
              [reminderId]));
  }

  async syncWithAppointment(tenantId: string, appointmentId: string): Promise<void> {
    await runInTenant(this.ds, tenantId, (m) =>
      m.query(
        `UPDATE reminders r SET status = 'cancelled'
           FROM appointments a
          WHERE r.appointment_id = a.id AND a.id = $1
            AND a.status <> 'confirmed' AND r.status = 'pending'`,
        [appointmentId]));
  }
}
```

`apps/api/src/queues/reminders.processor.ts`: un job repetible cada minuto que
llama `due(new Date())`, encola cada envío en `OutboundQueue` con
`buildContent(reminder)` y llama `markSent(reminder.tenantId, reminder.id)` al
confirmarse el envío. `MetaSender` gana el
caso `kind === 'template'` en `buildBody`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/scheduling/reminders`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scheduling): programar recordatorios de cita y enviarlos siempre por plantilla"
```

---

## Criterios de salida de la Fase 2

- [ ] `pnpm test` en verde, incluido el test de concurrencia de la Task 3.
- [ ] Un usuario agenda una cita real por WhatsApp usando solo menús.
- [ ] Dos usuarios pidiendo la misma franja: uno la obtiene, el otro recibe un mensaje
      claro con alternativas. Nunca dos citas superpuestas.
- [ ] Las franjas ofrecidas respetan horario, ausencias, buffer y anticipación mínima.
- [ ] Las plantillas de recordatorio están **enviadas a aprobación** de Meta.
- [ ] Cero llamadas a un LLM y cero dependencias de Google en toda la fase.

**Punto de corte con valor:** al terminar esta fase el producto ya es útil para un
negocio real. Todo lo que sigue lo hace mejor, no lo hace posible.
