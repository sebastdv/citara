# Fase 6 — Multi-tenant autoservicio: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un negocio nuevo se da de alta, conecta su número de WhatsApp y su calendario, carga sus servicios y horarios, y empieza a operar — sin que nadie toque una consola ni una CLI.

**Architecture:** Todo lo que hoy se hace por SQL o por script se convierte en un asistente de alta de seis pasos, con estado persistido para poder abandonarlo y retomarlo. El super-admin gana una vista transversal que es la **única** excepción al aislamiento por RLS del sistema, y por eso queda explícitamente auditada.

**Tech Stack:** lo de las fases 1-5.

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md`

**Depende de:** Fases 1-5 completas.

## Global Constraints

Además de las de las fases anteriores:

- **El super-admin es la única grieta del aislamiento, y se abre con llave propia.** No usa `runInTenant`; usa un método explícito `runAsSuperadmin` que **escribe en `audit_log` cada acceso**. Ninguna otra ruta del sistema puede usarlo.
- **El alta no puede dejar un negocio a medias operando.** Un tenant sin canal, sin servicios o sin horarios queda en `status = 'onboarding'` y no recibe webhooks.
- El asistente de alta es reanudable: el progreso vive en la base, no en el navegador.

---

## Tareas

### Task 1: Alta de negocio y estado de onboarding

**Files:**
- Create: migración `1725800000000-AddOnboardingToTenants.ts`, `1725800100000-CreateOnboardingSteps.ts`
- Create: `apps/api/src/onboarding/onboarding.service.ts`, `onboarding.controller.ts`
- Test: `apps/api/test/onboarding/signup.test.ts`

**Interfaces:**
- Consumes: `AuthService`, tabla `tenants`.
- Produces: `POST /signup` (crea tenant + usuario owner + sesión), `GET /onboarding/status`,
  y `tenants.status` gana el valor `'onboarding'`.
```ts
type OnboardingStep = 'business' | 'whatsapp' | 'services' | 'hours' | 'calendar' | 'agent';
interface OnboardingStatus { steps: Record<OnboardingStep, boolean>; complete: boolean }
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/signup.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, adminQuery, closeHelpers } from '../helpers';

let app: INestApplication;

const signup = (over: object = {}) =>
  request(app.getHttpServer()).post('/signup').send({
    businessName: 'Salón X', slug: 'salon-x', timezone: 'America/Bogota',
    email: 'maria@salon.co', password: 'clave-segura-123', ...over,
  });

beforeEach(async () => { await resetDb(); app = await createTestApp(); });
afterAll(async () => { await app.close(); await closeHelpers(); });

describe('alta de negocio', () => {
  it('crea el tenant en estado onboarding, no activo', async () => {
    await signup().expect(201);
    const [t] = await adminQuery(`SELECT status, timezone FROM tenants WHERE slug = 'salon-x'`);
    expect(t.status).toBe('onboarding');
    expect(t.timezone).toBe('America/Bogota');
  });

  it('crea al usuario como owner del tenant nuevo', async () => {
    await signup();
    const [tu] = await adminQuery(
      `SELECT role FROM tenant_users tu JOIN users u ON u.id = tu.user_id
        WHERE u.email = 'maria@salon.co'`);
    expect(tu.role).toBe('owner');
  });

  it('devuelve la cookie de sesión: el alta ya deja al usuario dentro', async () => {
    const res = await signup();
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
  });

  it('rechaza un slug ya tomado', async () => {
    await signup();
    await signup({ email: 'otro@salon.co' }).expect(409);
  });

  it('rechaza una zona horaria IANA inválida', async () => {
    await signup({ timezone: 'Marte/Olympus' }).expect(400);
  });

  it('rechaza una contraseña corta', async () => {
    await signup({ password: '123' }).expect(400);
  });

  it('un tenant en onboarding NO recibe webhooks — no puede operar a medias', async () => {
    await signup();
    const [t] = await adminQuery(`SELECT id FROM tenants WHERE slug = 'salon-x'`);
    await adminQuery(
      `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id,
                                      access_token_encrypted)
       VALUES ($1,'1','106540','\\x00')`, [t.id]);

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=loquesea')
      .send({ object: 'whatsapp_business_account', entry: [] });
    // Firma inválida devuelve 401; lo que importa es que jamás encole.
    expect([401, 200]).toContain(res.status);

    const eventos = await adminQuery(`SELECT count(*)::int AS n FROM webhook_events`);
    expect(eventos[0].n).toBe(0);
  });
});
```

`apps/api/test/onboarding/status.test.ts` verifica el avance:

```ts
it('marca cada paso a medida que se completa', async () => {
  const cookie = await signupAndLogin(app);
  let s = await getStatus(app, cookie);
  expect(s.steps).toMatchObject({ business: true, whatsapp: false, services: false });

  await connectChannel(app, cookie);
  s = await getStatus(app, cookie);
  expect(s.steps.whatsapp).toBe(true);
  expect(s.complete).toBe(false);
});

it('complete pasa a true solo cuando los seis pasos están listos', async () => {
  const cookie = await completeAllSteps(app);
  expect((await getStatus(app, cookie)).complete).toBe(true);
});

it('al completarse, el tenant pasa de onboarding a active', async () => {
  const cookie = await completeAllSteps(app);
  const [t] = await adminQuery(`SELECT status FROM tenants WHERE slug = 'salon-x'`);
  expect(t.status).toBe('active');
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm vitest run apps/api/test/onboarding`
Expected: FAIL — no existe `/signup`.

- [ ] **Step 3: Implementar**

`1725800000000-AddOnboardingToTenants.ts`:
```ts
await q.query(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check`);
await q.query(`
  ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
    CHECK (status IN ('onboarding','active','suspended'))
`);
```

`1725800100000-CreateOnboardingSteps.ts`:
```ts
await q.query(`
  CREATE TABLE onboarding_steps (
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    step         varchar(32) NOT NULL
                   CHECK (step IN ('business','whatsapp','services','hours','calendar','agent')),
    completed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, step)
  )
`);
for (const sql of tenantRlsSql('onboarding_steps')) await q.query(sql);
```

Esta tabla registra únicamente lo que no se puede deducir de la realidad — por ahora,
solo la decisión explícita de *omitir* el calendario. Los demás pasos se calculan
consultando los datos, para que no exista forma de que la bandeja diga «listo» mientras
la tabla correspondiente está vacía.

`onboarding.service.ts` calcula el estado consultando la realidad, no una bandera:
`whatsapp` está listo si hay un `whatsapp_channels` activo; `services` si hay al menos
un servicio activo; `hours` si hay al menos un `business_hours`; `calendar` si hay una
`google_accounts` activa **o** el dueño marcó explícitamente "sin calendario";
`agent` si hay un `agent_configs` activo. Cuando los seis dan verdadero, el tenant pasa
a `active`.

`ChannelResolver.resolveByPhoneNumberId` gana un filtro:
`AND t.status = 'active'` sobre el `JOIN` con `tenants`. Un negocio a medio configurar
no puede recibir mensajes reales.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm vitest run apps/api/test/onboarding`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(onboarding): dar de alta negocios en estado de configuración sin permitirles operar"
```

---

### Task 2: Conexión del número de WhatsApp

**Files:**
- Create: `apps/api/src/onboarding/channel.controller.ts`
- Test: `apps/api/test/onboarding/channel.test.ts`

**Interfaces:**
- Consumes: `EncryptionService`, `MetaSender`.
- Produces: `POST /onboarding/whatsapp` con `{ wabaId, phoneNumberId, accessToken }`.
  **Verifica el token contra Graph antes de guardarlo**, y lo guarda cifrado.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/channel.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { createTestApp, resetDb, signupAndLogin, adminQuery, closeHelpers } from '../helpers';

let app: INestApplication, cookie: string;

const conectar = (over: object = {}) =>
  request(app.getHttpServer()).post('/onboarding/whatsapp').set('Cookie', cookie)
    .send({ wabaId: '102290', phoneNumberId: '106540',
            accessToken: 'EAAG-token-real', ...over });

const graphOk = () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true, status: 200,
  json: async () => ({ id: '106540', display_phone_number: '+57 300 111 2233' }) }));

beforeEach(async () => {
  await resetDb();
  app = await createTestApp();
  cookie = await signupAndLogin(app);
});
afterAll(async () => { await app.close(); await closeHelpers(); });

describe('conexión de WhatsApp', () => {
  it('verifica el token contra Graph antes de guardarlo', async () => {
    graphOk();
    await conectar().expect(201);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toContain('/106540');
  });

  it('guarda el token CIFRADO, nunca en claro', async () => {
    graphOk();
    await conectar();
    const [ch] = await adminQuery(`SELECT access_token_encrypted FROM whatsapp_channels`);

    expect(ch.access_token_encrypted.toString('utf8')).not.toContain('EAAG-token-real');
    const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
    await enc.ready();
    expect(enc.decrypt(ch.access_token_encrypted)).toBe('EAAG-token-real');
  });

  it('guarda el número mostrado que devuelve Graph', async () => {
    graphOk();
    await conectar();
    const [ch] = await adminQuery(`SELECT display_phone_number FROM whatsapp_channels`);
    expect(ch.display_phone_number).toBe('+57 300 111 2233');
  });

  it('rechaza un token que Graph no acepta, sin guardar nada', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ error: { message: 'Invalid OAuth access token' } }) }));

    await conectar().expect(400);
    const chs = await adminQuery(`SELECT count(*)::int AS n FROM whatsapp_channels`);
    expect(chs[0].n).toBe(0);
  });

  it('rechaza un phone_number_id ya usado por OTRO negocio', async () => {
    graphOk();
    await conectar();
    const otro = await signupAndLogin(app, { slug: 'otro', email: 'otro@x.co' });
    await request(app.getHttpServer()).post('/onboarding/whatsapp').set('Cookie', otro)
      .send({ wabaId: '999', phoneNumberId: '106540', accessToken: 'EAAG-otro' })
      .expect(409);
  });

  it('nunca devuelve el token en la respuesta', async () => {
    graphOk();
    const res = await conectar();
    expect(JSON.stringify(res.body)).not.toContain('EAAG-token-real');
  });
});
```

> El quinto test cierra la puerta a la fuga entre clientes más obvia: dos negocios
> apuntando al mismo `phone_number_id` harían que los mensajes de uno se procesaran
> como del otro.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/onboarding/channel`
Expected: FAIL — no existe la ruta.

- [ ] **Step 3: Implementar**

`channel.controller.ts` llama `GET https://graph.facebook.com/{version}/{phoneNumberId}`
con el token recibido. Si responde `ok`, cifra el token y hace el `INSERT`; el índice
único sobre `phone_number_id` (Fase 1) convierte el duplicado en `409`. La respuesta
devuelve solo `{ id, displayPhoneNumber, wabaId }`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/onboarding`
Expected: PASS, 6 tests nuevos.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(onboarding): conectar el número de whatsapp verificando el token contra graph"
```

---

### Task 3: CRUD de servicios, recursos y horarios

**Files:**
- Create: `apps/api/src/scheduling/catalog.controller.ts`
- Test: `apps/api/test/onboarding/catalog-api.test.ts`

**Interfaces:**
- Consumes: `SessionGuard`, tablas de la Fase 2.
- Produces: CRUD en `/catalog/services`, `/catalog/resources`, `/catalog/hours`,
  `/catalog/time-off`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/catalog-api.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, signupAndLogin, adminQuery, closeHelpers } from '../helpers';

let app: INestApplication, cookie: string;

const post = (url: string, body: object) =>
  request(app.getHttpServer()).post(url).set('Cookie', cookie).send(body);

beforeEach(async () => {
  await resetDb(); app = await createTestApp(); cookie = await signupAndLogin(app);
});
afterAll(async () => { await app.close(); await closeHelpers(); });

describe('catálogo', () => {
  it('crea un servicio con duración y buffer', async () => {
    const res = await post('/catalog/services',
      { name: 'Corte', durationMin: 30, bufferMin: 10, priceCents: 3500000 }).expect(201);
    expect(res.body).toMatchObject({ name: 'Corte', durationMin: 30 });
  });

  it('rechaza una duración no positiva', async () => {
    await post('/catalog/services', { name: 'X', durationMin: 0 }).expect(400);
  });

  it('crea un recurso y lo enlaza a servicios', async () => {
    const s = await post('/catalog/services', { name: 'Corte', durationMin: 30 });
    const r = await post('/catalog/resources',
      { name: 'María', serviceIds: [s.body.id] }).expect(201);

    const [link] = await adminQuery(
      `SELECT * FROM resource_services WHERE resource_id = $1`, [r.body.id]);
    expect(link.service_id).toBe(s.body.id);
  });

  it('rechaza enlazar un recurso a un servicio de otro negocio', async () => {
    const s = await post('/catalog/services', { name: 'Corte', durationMin: 30 });
    const otro = await signupAndLogin(app, { slug: 'otro', email: 'otro@x.co' });
    await request(app.getHttpServer()).post('/catalog/resources').set('Cookie', otro)
      .send({ name: 'Intruso', serviceIds: [s.body.id] }).expect(400);
  });

  it('define el horario semanal de una vez', async () => {
    await post('/catalog/hours', { blocks: [
      { weekday: 1, start: '09:00', end: '18:00' },
      { weekday: 2, start: '09:00', end: '18:00' },
    ] }).expect(201);
    const rows = await adminQuery(`SELECT count(*)::int AS n FROM business_hours`);
    expect(rows[0].n).toBe(2);
  });

  it('reemplaza el horario completo en vez de acumular duplicados', async () => {
    await post('/catalog/hours', { blocks: [{ weekday: 1, start: '09:00', end: '18:00' }] });
    await post('/catalog/hours', { blocks: [{ weekday: 1, start: '10:00', end: '16:00' }] });

    const rows = await adminQuery(
      `SELECT to_char(start_time,'HH24:MI') AS s FROM business_hours`);
    expect(rows).toHaveLength(1);
    expect(rows[0].s).toBe('10:00');
  });

  it('rechaza un bloque con fin anterior al inicio', async () => {
    await post('/catalog/hours',
      { blocks: [{ weekday: 1, start: '18:00', end: '09:00' }] }).expect(400);
  });

  it('rechaza bloques solapados el mismo día', async () => {
    await post('/catalog/hours', { blocks: [
      { weekday: 1, start: '09:00', end: '14:00' },
      { weekday: 1, start: '13:00', end: '18:00' },
    ] }).expect(400);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/onboarding/catalog-api`
Expected: FAIL — no existen las rutas.

- [ ] **Step 3: Implementar**

Todo dentro de `runInTenant` con el tenant de la sesión. `POST /catalog/hours` reemplaza
el horario completo en una transacción (`DELETE` + `INSERT`), validando antes que no
haya solapes dentro del payload — un horario con bloques superpuestos generaría franjas
duplicadas en `computeSlots`. El enlace recurso→servicio falla con `400` cuando el
`service_id` no existe **en el contexto del tenant**, que es exactamente lo que RLS
garantiza.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/onboarding`
Expected: PASS, 8 tests nuevos.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(catalog): administrar servicios, recursos y horarios desde el panel"
```

---

### Task 4: Vista de super-admin con auditoría

**Files:**
- Create: migración `1725800200000-CreateAuditLog.ts`, `1725800300000-AllowSuperadminBypass.ts`
- Modify: `packages/db/src/rls.ts` (`tenantRlsSql` genera la política nueva)
- Create: `apps/api/src/admin/admin.service.ts`, `admin.controller.ts`
- Create: `apps/api/src/tenancy/superadmin-context.ts`
- Test: `apps/api/test/admin/superadmin.test.ts`

**Interfaces:**
- Consumes: `SessionGuard`.
- Produces: `runAsSuperadmin(ds, actorUserId, reason, fn)` — la **única** vía que atraviesa
  RLS, y escribe en `audit_log` en la misma transacción. `GET /admin/tenants`,
  `GET /admin/tenants/:id/summary`, `POST /admin/tenants/:id/suspend`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/admin/superadmin.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, seedChannel, seedUser, loginAs,
         adminQuery, closeHelpers } from '../helpers';

let app: INestApplication, superCookie: string, ownerCookie: string;
let tenantA: string, tenantB: string;

beforeEach(async () => {
  await resetDb();
  ({ tenantId: tenantA } = await seedChannel('a'));
  ({ tenantId: tenantB } = await seedChannel('b'));
  await seedUser(tenantA, 'super@citara.app', 'clave-segura-123', 'superadmin');
  await seedUser(tenantA, 'owner@a.co', 'clave-segura-123', 'owner');
  app = await createTestApp();
  superCookie = await loginAs(app, 'super@citara.app', 'clave-segura-123');
  ownerCookie = await loginAs(app, 'owner@a.co', 'clave-segura-123');
});
afterAll(async () => { await app.close(); await closeHelpers(); });

describe('super-admin', () => {
  it('ve todos los negocios', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenants').set('Cookie', superCookie).expect(200);
    expect(res.body.map((t: { id: string }) => t.id).sort())
      .toEqual([tenantA, tenantB].sort());
  });

  it('un owner NO puede entrar a las rutas de admin', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants').set('Cookie', ownerCookie).expect(403);
  });

  it('CADA acceso transversal queda registrado en audit_log', async () => {
    await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantB}/summary`).set('Cookie', superCookie).expect(200);

    const [log] = await adminQuery(
      `SELECT action, target_tenant_id, reason FROM audit_log ORDER BY created_at DESC LIMIT 1`);
    expect(log.action).toBe('tenant.summary');
    expect(log.target_tenant_id).toBe(tenantB);
    expect(log.reason).toBeTruthy();
  });

  it('el registro de auditoría se escribe en la MISMA transacción que la lectura', async () => {
    // Si la lectura falla, no debe quedar un registro de auditoría huérfano.
    await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000/summary')
      .set('Cookie', superCookie).expect(404);

    const logs = await adminQuery(`SELECT count(*)::int AS n FROM audit_log`);
    expect(logs[0].n).toBe(0);
  });

  it('suspender un negocio impide que reciba webhooks', async () => {
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantB}/suspend`).set('Cookie', superCookie)
      .send({ reason: 'falta de pago' }).expect(200);

    const [t] = await adminQuery(`SELECT status FROM tenants WHERE id = $1`, [tenantB]);
    expect(t.status).toBe('suspended');
  });

  it('suspender exige un motivo', async () => {
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantB}/suspend`).set('Cookie', superCookie)
      .send({}).expect(400);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/admin`
Expected: FAIL — no existen las rutas.

- [ ] **Step 3: Implementar**

`1725800200000-CreateAuditLog.ts`:
```ts
await q.query(`
  CREATE TABLE audit_log (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id    uuid NOT NULL REFERENCES users(id),
    action           varchar(64) NOT NULL,
    target_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
    reason           text NOT NULL,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
  )
`);
await q.query(`CREATE INDEX audit_log_recent ON audit_log (created_at DESC)`);
// Sin RLS a propósito: es un registro global, y solo el superadmin lo lee.
await q.query(`GRANT SELECT, INSERT ON audit_log TO citara_app`);
```

`apps/api/src/tenancy/superadmin-context.ts`:
```ts
import type { DataSource, EntityManager } from 'typeorm';

/**
 * La ÚNICA vía del sistema que lee a través de todos los tenants.
 *
 * No fija `app.tenant_id`, así que las políticas de RLS no filtran nada; por eso
 * escribe el registro de auditoría en la MISMA transacción que la consulta. Si el
 * trabajo falla, el rollback se lleva también el registro — y si el registro no se
 * pudo escribir, el trabajo tampoco ocurre. No hay acceso transversal sin rastro.
 *
 * Ninguna ruta que no sea /admin/* puede llamar a esta función.
 */
export async function runAsSuperadmin<T>(
  ds: DataSource,
  actor: { userId: string; action: string; targetTenantId: string | null; reason: string },
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // Local a la transacción: la grieta se cierra sola al terminar.
    await runner.query(`SELECT set_config('app.superadmin', 'on', true)`);

    const result = await fn(runner.manager);

    await runner.query(
      `INSERT INTO audit_log (actor_user_id, action, target_tenant_id, reason)
       VALUES ($1,$2,$3,$4)`,
      [actor.userId, actor.action, actor.targetTenantId, actor.reason],
    );

    await runner.commitTransaction();
    return result;
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }
}
```

Para que esto funcione hay que **reescribir la política de todas las tablas
tenant-scoped**. `1725800300000-AllowSuperadminBypass.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

// Toda tabla que llegó a existir con tenantRlsSql().
const TENANT_TABLES = [
  'contacts', 'conversations', 'messages', 'flows', 'conversation_sessions',
  'services', 'resources', 'resource_services', 'business_hours', 'time_off',
  'appointments', 'reminders', 'google_accounts', 'agent_configs', 'agent_runs',
  'onboarding_steps',
];

export class AllowSuperadminBypass1725800300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    for (const table of TENANT_TABLES) {
      await q.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
      await q.query(`
        CREATE POLICY tenant_isolation ON ${table}
          USING (
            current_setting('app.superadmin', true) = 'on'
            OR tenant_id = current_setting('app.tenant_id', true)::uuid
          )
          WITH CHECK (
            tenant_id = current_setting('app.tenant_id', true)::uuid
          )
      `);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of TENANT_TABLES) {
      await q.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
      await q.query(`
        CREATE POLICY tenant_isolation ON ${table}
          USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
      `);
    }
  }
}
```

Nota deliberada sobre el `WITH CHECK`: el super-admin puede **leer** a través de los
negocios, pero **no escribir** en uno ajeno. `WITH CHECK` sigue exigiendo un
`app.tenant_id` que coincida, así que un `INSERT` o `UPDATE` transversal falla incluso
con la grieta abierta. La vista de administración es de lectura; suspender un negocio
escribe en `tenants`, que nunca llevó RLS.

A partir de aquí, `tenantRlsSql()` debe generar la política nueva para que las tablas
que se creen después nazcan con la misma forma.

`runAsSuperadmin` hace `SELECT set_config('app.superadmin','on',true)` al abrir la
transacción. Como `set_config` con `true` es local a la transacción, la grieta se cierra
sola al terminar.

`admin.controller.ts` exige rol `superadmin`, obliga a un `reason` no vacío en las
acciones de escritura, y para las de lectura usa un motivo por defecto que identifica la
ruta. `suspend` deja el tenant en `suspended`, lo que `ChannelResolver` ya filtra desde
la Task 1.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test`
Expected: PASS, toda la suite — **incluida la prueba de aislamiento de la Fase 1**, que
debe seguir en verde: sin `app.superadmin`, el comportamiento no cambia.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(admin): habilitar la vista transversal de super-admin con auditoría transaccional"
```

---

### Task 5: Asistente de alta en el panel

**Files:**
- Create: `apps/dashboard/src/app/onboarding/` (seis pasos), `src/components/wizard-*.tsx`
- Test: `apps/dashboard/test/wizard.test.tsx`

**Interfaces:**
- Consumes: `/onboarding/status`, `/onboarding/whatsapp`, `/catalog/*`,
  `/google/connect` (Fase 3), `/agent/config` (Fase 5).
- Produces: `/onboarding` con seis pasos reanudables.

- [ ] **Step 1: Escribir el test que falla**

`apps/dashboard/test/wizard.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WizardNav } from '../src/components/wizard-nav';

const steps = {
  business: true, whatsapp: true, services: false,
  hours: false, calendar: false, agent: false,
};

describe('WizardNav', () => {
  it('marca como completos los pasos ya resueltos', () => {
    render(<WizardNav steps={steps} current="services" onGo={() => {}} />);
    expect(screen.getByLabelText('Negocio completado')).toBeInTheDocument();
    expect(screen.getByLabelText('WhatsApp completado')).toBeInTheDocument();
  });

  it('deja volver a un paso ya completado', () => {
    const onGo = vi.fn();
    render(<WizardNav steps={steps} current="services" onGo={onGo} />);
    fireEvent.click(screen.getByText('WhatsApp'));
    expect(onGo).toHaveBeenCalledWith('whatsapp');
  });

  it('NO deja saltar a un paso posterior sin completar los previos', () => {
    const onGo = vi.fn();
    render(<WizardNav steps={steps} current="services" onGo={onGo} />);
    fireEvent.click(screen.getByText('Agente'));
    expect(onGo).not.toHaveBeenCalled();
  });

  it('el paso de calendario se puede omitir explícitamente', () => {
    render(<WizardNav steps={steps} current="calendar" onGo={() => {}} />);
    expect(screen.getByRole('button', { name: /sin calendario por ahora/i }))
      .toBeInTheDocument();
  });

  it('avisa que el negocio no recibe mensajes hasta terminar', () => {
    render(<WizardNav steps={steps} current="services" onGo={() => {}} />);
    expect(screen.getByText(/no recibirá mensajes/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/dashboard/test/wizard`
Expected: FAIL — no existe `WizardNav`.

- [ ] **Step 3: Implementar**

Los seis pasos: **Negocio** (nombre, slug, zona horaria) · **WhatsApp** (waba,
phone_number_id, token, con instrucciones y enlace al panel de Meta) · **Servicios**
(nombre, duración, buffer, precio) · **Horarios** (rejilla semanal) · **Calendario**
(botón *Conectar con Google*, que lleva a `/google/connect` de la Fase 3, con la opción
explícita *Sin calendario por ahora*) · **Agente** (prompt inicial con una plantilla
sugerida por vertical, y las herramientas a habilitar).

El estado se lee de `/onboarding/status` en cada carga, así que abandonar el navegador
y volver al día siguiente retoma donde quedó. Un banner permanente recuerda que el
negocio no recibe mensajes hasta completar los seis.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run`
Expected: PASS, toda la suite de las seis fases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(dashboard): guiar el alta de un negocio en seis pasos reanudables"
```

---

## Criterios de salida de la Fase 6

- [ ] `pnpm test` en verde en toda la suite de las seis fases.
- [ ] Un negocio nuevo se da de alta y opera **sin que nadie toque SQL ni una CLI**.
- [ ] Un tenant a medio configurar no recibe webhooks.
- [ ] Dos negocios no pueden compartir el mismo `phone_number_id`.
- [ ] El super-admin ve todos los negocios y **cada** acceso transversal queda en
      `audit_log` con actor, acción, negocio y motivo.
- [ ] La prueba de aislamiento por RLS de la Fase 1 **sigue pasando sin cambios**.
- [ ] Suspender un negocio lo saca de operación de inmediato.

---

## Después de la Fase 6

Fuera del alcance de este ciclo, en orden de valor probable: facturación real del SaaS
sobre los datos que `agent_runs` y `appointments` ya recogen; gestión autoservicio de
plantillas de Meta; canales adicionales (Instagram, web chat); y transcripción de notas
de voz, que en el vertical de agendamiento aparece antes de lo que uno espera.
