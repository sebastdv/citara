# Fase 4 — Google Calendar: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada recurso del negocio (la estilista, el médico) conecta su Google Calendar desde un enlace. Sus citas de Citara aparecen en un calendario "Citas" de su cuenta, lo que tenga ocupado en su calendario principal deja de ofrecerse por WhatsApp, y si el dueño borra o mueve una cita en Google, Citara se entera. Si Google falla, el sistema sigue agendando.

**Architecture:** Google es una **proyección** (D4): la cita se confirma en Postgres y después se refleja en Google.
- **Calendario aparte:** al conectar, Citara crea un calendario secundario "Citas · <recurso>" con el permiso `calendar.app.created` y escribe allí los eventos, con un id derivado del UUID de la cita (idempotente).
- **Disponibilidad:** sale del calendario **principal** con `freeBusy` (permiso `calendar.freebusy`), con caché corta y degradación a solo-Citara si Google no responde.
- **Sincronización inversa:** `events.watch` + `syncToken` sobre el calendario "Citas", con un sondeo cada 15 minutos de respaldo.
- **Mantenimiento:** un barrido por minuto en la cola nueva `calendar` encola las subidas pendientes, las bajadas, la renovación de canales y el chequeo diario de salud.

**Tech Stack:** lo de las fases anteriores. **Sin `googleapis`**: OAuth y los endpoints REST con `fetch`, igual que el cliente de Meta (Fase 3).

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md` (v2) — D4, §3.3 `GoogleCalendar`, §4.1 `google_accounts`, §4.3 cifrado, §7.3 reconciliación, §8 paso 4, §11 riesgo de `watch`.

**Decisiones del usuario (2026-10-08):**
1. Las citas van a un **calendario aparte creado por Citara** en la cuenta de cada recurso. Su calendario principal solo se consulta como ocupado.
2. Si el dueño borra o mueve una cita en Google, **solo se actualiza Citara** (y sus recordatorios). No se le escribe al cliente final. Queda en `audit_log`.

**Verificado contra la documentación de Google (2026-10-08):**
- `calendars.insert`, `calendars.get`, `events.insert/patch` y `events.watch` aceptan `calendar.app.created`. `freebusy.query` acepta `calendar.freebusy`.
- El `id` de evento es base32hex (`0-9a-v`), de 5 a 1024 caracteres, único por calendario.
- `syncToken` no se combina con `timeMin`, `timeMax`, `q`, `orderBy`, `updatedMin`, `iCalUID` ni `*ExtendedProperty`. Un `410` obliga a resincronizar desde cero, y lo borrado siempre viene en el incremental.
- Los canales de `watch` no se renuevan solos. El `ttl` por defecto es de 7 días; la notificación trae `X-Goog-Channel-ID`, `X-Goog-Channel-Token` y `X-Goog-Resource-State` (`sync` | `exists` | `not_exists`). La dirección exige HTTPS con un certificado válido.
- Los scopes de calendario son **sensibles**: requieren verificación de la app, sin auditoría de seguridad. En modo *testing*, el refresh token vence a los 7 días.

**VERIFICAR al conectar la primera cuenta real:** que `events.list` y `events.delete` acepten `calendar.app.created`, que `patch` sobre un evento borrado lo restaure, y el rango máximo de `freeBusy` (se trocea en ventanas de 60 días).

## Global Constraints

- Todo lo de las fases 1 a 3 sigue vigente: RLS, `TZ=UTC`, outbox, providers registrados en la tarea que los crea, imports de valor en constructores Nest, `[filas, conteo]` de TypeORM, `PRESUPUESTO` cerrado, migraciones con `import type` y `'../rls.ts'`, y jobIds de BullMQ sin `:`.
- **La cita es válida sin Google.** Ningún fallo de Google impide, revierte ni retrasa una reserva, una cancelación o una reprogramación en Citara.
- **Todo evento de cita usa `googleEventId(appointment.id)`** (el UUID en hexadecimal sin guiones). Un reintento devuelve `409` y se resuelve con `patch`, nunca con un evento duplicado.
- **El refresh token se guarda cifrado** con `EncryptionService`. Ni el refresh token, ni el access token, ni el client secret aparecen en logs, errores o respuestas HTTP.
- **Ante `invalid_grant`, la cuenta pasa a `needs_reauth`**, queda auditado y se ve en `pnpm tenant list`. El sistema sigue agendando y lo pendiente se sube al reconectar.
- **Lo que el sistema escribe en Google nunca rebota.** Un cambio local pendiente gana sobre lo que lea de Google. Un movimiento leído de Google que choque con otra cita no se aplica y se sube de vuelta lo local.
- **La aplicación no gana privilegios fuera de RLS.** `google_accounts` es tenant-scoped con RLS (sin DELETE). Consumir un enlace de Google pasa por una función `SECURITY DEFINER` endurecida (`search_path = pg_catalog, public, pg_temp`, nombres calificados, ligada a `app.tenant_id`).
- Commits: Conventional Commits en español, un solo `-m`, sin cuerpo ni `Co-Authored-By`, y `git add` con rutas explícitas.

## Review Focus

1. **El cliente desmarca un permiso en la pantalla de Google** (el consentimiento granular permite aceptar solo algunos): error claro y el enlace sigue sirviendo para reintentar. → Task 3.
2. **Google lento o caído mientras un cliente agenda:** se ofrecen franjas igual (solo-Citara), la reserva se confirma y el evento sube después. → Tasks 4 y 5.
3. **El cliente reprograma por WhatsApp mientras el dueño mueve el mismo evento en Google:** gana lo local pendiente; no hay ping-pong de cambios. → Task 6.
4. **El dueño borra el calendario "Citas":** se recrea y las citas futuras se vuelven a subir. → Task 7.
5. **El dueño revoca el acceso de Citara desde su cuenta de Google:** la cuenta queda `needs_reauth` y visible en `tenant list`, y se sigue agendando. → Tasks 2, 5 y 7.

## Trabajo externo (no bloquea el código; sí la prueba real)

- [ ] Proyecto en Google Cloud con la Calendar API habilitada.
- [ ] Pantalla de consentimiento OAuth con política de privacidad en el dominio propio; scopes `openid`, `email`, `calendar.app.created` y `calendar.freebusy`.
- [ ] Cliente OAuth "Aplicación web" con URI de redirección `${PUBLIC_BASE_URL}/connect/google/callback`; su ID y su secreto van en `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
- [ ] Solicitar la verificación (scopes sensibles: video de demostración). Mientras tanto, modo *testing* con usuarios de prueba: el refresh token vence a los 7 días.

---

## File Structure

```
packages/db/src/migrations/
├─ 1725600000000-CreateGoogleAccounts.ts
├─ 1725600100000-AddResourceToOnboardingLinks.ts    + consume_google_link()
└─ 1725600200000-AddGoogleSyncToAppointments.ts
apps/api/src/google/
├─ event-id.ts                 googleEventId / appointmentIdFromEventId
├─ google.client.ts            OAuth + Calendar REST (fetch)
├─ google-tokens.service.ts    access tokens en memoria, reintento ante 401
├─ accounts.ts                 loadAccount / markNeedsReauth
├─ google-connect.service.ts   cierre del OAuth: calendario, cuenta, citas pendientes
├─ connect-google.controller.ts  GET /connect/google, GET /connect/google/callback
├─ connect-google-page.ts      HTML de conexión y resultado
├─ google-busy.service.ts      ocupado del calendario principal (freeBusy + caché)
├─ calendar-push.processor.ts  Citara → Google
├─ calendar-pull.processor.ts  Google → Citara (syncToken)
├─ calendar-watch.service.ts   renovación de canales de watch
├─ calendar-health.processor.ts  chequeo diario: token y calendario
├─ calendar-sweep.service.ts   barrido por minuto: qué encolar
└─ google-webhook.controller.ts  POST /webhooks/google
apps/api/src/queues/calendar.queue.ts
apps/api/test/google/*.test.ts
```

---

## Tareas

### Task 1: Esquema de Google e id de evento

**Files:**
- Create: `packages/db/src/migrations/1725600000000-CreateGoogleAccounts.ts`, `packages/db/src/migrations/1725600100000-AddResourceToOnboardingLinks.ts`, `packages/db/src/migrations/1725600200000-AddGoogleSyncToAppointments.ts`
- Create: `apps/api/src/google/event-id.ts`
- Modify: `apps/api/src/onboarding/links.ts` (enlaces de Google por recurso), `packages/db/test/rls-inventory.test.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/google/schema.test.ts`

**Interfaces:**
- Produces:
  - Tabla `google_accounts` (una por `resource`) con RLS: `id, tenant_id, resource_id UNIQUE, email, calendar_id, refresh_token_encrypted, status ('active'|'needs_reauth'), sync_token, last_pulled_at, last_checked_at, watch_channel_id, watch_resource_id, watch_token_hash, watch_expires_at, watch_error, created_at, updated_at`. La app tiene SELECT, INSERT y UPDATE.
  - `onboarding_links.resource_id` (obligatorio si `purpose = 'google'`) y `consume_google_link(p_link uuid) RETURNS uuid` (el `resource_id`; `SQLSTATE CT410` si el enlace no sirve).
  - `appointments.google_sync_version integer` y `appointments.google_synced_at`; `google_sync_status IN ('pending','synced','failed')`.
```ts
export function googleEventId(appointmentId: string): string;               // 32 hex en minúscula
export function appointmentIdFromEventId(eventId: string): string | null;   // UUID o null si no es nuestro
export function createLink(admin: Db, tenantId: string, purpose: LinkPurpose, opts?: { ttlHours?: number; resourceId?: string }): Promise<string>;
export interface ValidLink { linkId: string; tenantId: string; tenantName: string; resourceId: string | null; resourceName: string | null }
// helpers de test:
export function seedGoogleAccount(tenantId: string, resourceId: string, over?: { status?: string; calendarId?: string | null }): Promise<string>;
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/google/schema.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { appointmentIdFromEventId, googleEventId } from '../../src/google/event-id';
import { createLink, peekLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource;
let tenantId: string, resourceId: string;

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
});

describe('id de evento', () => {
  it('es el uuid en hex sin guiones, válido para Google (base32hex, 5-1024)', () => {
    expect(googleEventId(UUID)).toBe('3f2504e04f8941d39a0c0305e82c3301');
    expect(googleEventId(UUID.toUpperCase())).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it('se puede volver del id de evento a la cita, y lo ajeno no es nuestro', () => {
    expect(appointmentIdFromEventId(googleEventId(UUID))).toBe(UUID);
    expect(appointmentIdFromEventId('7kvq2h0s1d2o9c3jtn4u0tqk1c')).toBeNull();
    expect(appointmentIdFromEventId('3f2504e04f8941d39a0c0305e82c3301_20261010T150000Z')).toBeNull();
  });

  it('rechaza algo que no sea un uuid', () => {
    expect(() => googleEventId('no-es-uuid')).toThrow(/uuid/i);
  });
});

describe('google_accounts', () => {
  it('un recurso tiene a lo sumo una cuenta de Google', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    await expect(seedGoogleAccount(tenantId, resourceId)).rejects.toThrow(/duplicate|unique/i);
  });

  it('la app puede leer y actualizar su cuenta, pero no borrarla', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const rows = await runInTenant(app, tenantId, (m) => m.query(`SELECT status FROM google_accounts`));
    expect(rows).toEqual([{ status: 'active' }]);
    await expect(runInTenant(app, tenantId, (m) => m.query(`DELETE FROM google_accounts`)))
      .rejects.toThrow(/permission denied/);
  });

  it('el estado de una cuenta solo puede ser active o needs_reauth', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    await expect(adminQuery(`UPDATE google_accounts SET status = 'rota'`)).rejects.toThrow(/check/i);
  });
});

describe('enlaces de Google', () => {
  it('un enlace de Google exige el recurso y trae su nombre', async () => {
    await expect(createLink(admin, tenantId, 'google')).rejects.toThrow(/check/i);
    const token = await createLink(admin, tenantId, 'google', { resourceId });
    expect(await peekLink(app, token, 'google')).toMatchObject({ tenantId, resourceId, resourceName: 'María' });
  });

  it('consume_google_link devuelve el recurso una sola vez', async () => {
    await createLink(admin, tenantId, 'google', { resourceId });
    const [link] = await adminQuery(`SELECT id FROM onboarding_links`);
    const consume = () => runInTenant(app, tenantId, (m) => m.query(`SELECT consume_google_link($1) AS r`, [link.id]));
    expect((await consume())[0].r).toBe(resourceId);
    await expect(consume()).rejects.toMatchObject({ driverError: { code: 'CT410' } });
  });

  it('consume_google_link no sirve desde el contexto de otro negocio', async () => {
    await createLink(admin, tenantId, 'google', { resourceId });
    const [link] = await adminQuery(`SELECT id FROM onboarding_links`);
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    await expect(runInTenant(app, otro.id, (m) => m.query(`SELECT consume_google_link($1)`, [link.id])))
      .rejects.toMatchObject({ driverError: { code: 'CT410' } });
  });

  it('consume_google_link busca pg_temp al final', async () => {
    const [row] = await adminQuery(`SELECT proconfig FROM pg_proc WHERE proname = 'consume_google_link'`);
    expect(row.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
  });
});

describe('sincronización de citas', () => {
  it('google_sync_status solo admite pending, synced o failed', async () => {
    const [{ def }] = await adminQuery(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'appointments_google_sync_status_check'`);
    expect(def).toMatch(/pending.*synced.*failed/);
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/google/schema.test.ts`
Expected: FAIL — no existen `google/event-id` ni `seedGoogleAccount`.

- [ ] **Step 3: Las migraciones**

`packages/db/src/migrations/1725600000000-CreateGoogleAccounts.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * La conexión de un recurso con su Google Calendar (spec §4.1). Una por
 * recurso. `calendar_id` es el calendario "Citas" que crea la app (permiso
 * calendar.app.created); el principal solo se consulta como ocupado.
 * Tenant-scoped con RLS; la app no borra cuentas (reconectar actualiza).
 */
export class CreateGoogleAccounts1725600000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE google_accounts (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id             uuid NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
        email                   varchar(320),
        calendar_id             varchar(1024),
        refresh_token_encrypted bytea NOT NULL,
        status                  varchar(16) NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'needs_reauth')),
        sync_token              text,
        last_pulled_at          timestamptz,
        last_checked_at         timestamptz,
        watch_channel_id        uuid,
        watch_resource_id       text,
        watch_token_hash        char(64),
        watch_expires_at        timestamptz,
        watch_error             text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const sql of tenantRlsSql('google_accounts')) await q.query(sql);
    await q.query(`REVOKE DELETE ON google_accounts FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE google_accounts`);
  }
}
```
`packages/db/src/migrations/1725600100000-AddResourceToOnboardingLinks.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los enlaces de Google son por recurso (spec §8 paso 4). Consumirlos pasa por
 * una función SECURITY DEFINER, como register_channel: la app no tiene UPDATE
 * sobre onboarding_links. Endurecida desde el inicio (pg_temp al final, nombres
 * calificados, ligada al negocio de la transacción).
 */
export class AddResourceToOnboardingLinks1725600100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE onboarding_links ADD COLUMN resource_id uuid REFERENCES resources(id) ON DELETE CASCADE`);
    await q.query(`
      ALTER TABLE onboarding_links ADD CONSTRAINT onboarding_links_google_resource_check
        CHECK (purpose <> 'google' OR resource_id IS NOT NULL)
    `);
    await q.query(`
      CREATE FUNCTION consume_google_link(p_link uuid)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_resource uuid;
      BEGIN
        UPDATE public.onboarding_links l SET used_at = now()
          FROM public.tenants t
         WHERE l.id = p_link AND t.id = l.tenant_id AND l.purpose = 'google'
           AND l.used_at IS NULL AND l.expires_at > now() AND t.status <> 'suspended'
           AND l.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        RETURNING l.resource_id INTO v_resource;
        IF v_resource IS NULL THEN
          RAISE EXCEPTION 'el enlace de conexión no es válido' USING ERRCODE = 'CT410';
        END IF;
        RETURN v_resource;
      END $$
    `);
    await q.query(`REVOKE ALL ON FUNCTION consume_google_link(uuid) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION consume_google_link(uuid) TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION consume_google_link(uuid)`);
    await q.query(`ALTER TABLE onboarding_links DROP CONSTRAINT onboarding_links_google_resource_check`);
    await q.query(`ALTER TABLE onboarding_links DROP COLUMN resource_id`);
  }
}
```
`packages/db/src/migrations/1725600200000-AddGoogleSyncToAppointments.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Proyección de la cita en Google (spec §7.3). `google_sync_version` sube con
 * cada cambio que hay que reflejar: la subida marca `synced` solo si la
 * versión no cambió mientras hablaba con Google (compare-and-set).
 */
export class AddGoogleSyncToAppointments1725600200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE appointments
        ADD COLUMN google_sync_version integer NOT NULL DEFAULT 0,
        ADD COLUMN google_synced_at timestamptz,
        ADD CONSTRAINT appointments_google_sync_status_check
          CHECK (google_sync_status IN ('pending', 'synced', 'failed'))
    `);
    await q.query(`
      CREATE INDEX appointments_google_pending ON appointments (tenant_id, resource_id)
        WHERE google_sync_status = 'pending'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX appointments_google_pending`);
    await q.query(`
      ALTER TABLE appointments
        DROP CONSTRAINT appointments_google_sync_status_check,
        DROP COLUMN google_synced_at,
        DROP COLUMN google_sync_version
    `);
  }
}
```

- [ ] **Step 4: El id de evento, los enlaces y los helpers**

`apps/api/src/google/event-id.ts`:
```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OURS = /^[0-9a-f]{32}$/;

/**
 * El id del evento de Google para una cita (spec §7.3): el UUID en hex sin
 * guiones. Google acepta base32hex (0-9, a-v), y hex es un subconjunto. Con un
 * id nuestro, reintentar la creación devuelve 409 en vez de duplicar.
 */
export function googleEventId(appointmentId: string): string {
  const id = appointmentId.toLowerCase();
  if (!UUID.test(id)) throw new Error(`No es un uuid: ${appointmentId}`);
  return id.replace(/-/g, '');
}

/** La cita detrás de un evento, o null si el evento no lo creó Citara. */
export function appointmentIdFromEventId(eventId: string): string | null {
  if (!OURS.test(eventId)) return null;
  return `${eventId.slice(0, 8)}-${eventId.slice(8, 12)}-${eventId.slice(12, 16)}-${eventId.slice(16, 20)}-${eventId.slice(20)}`;
}
```
En `apps/api/src/onboarding/links.ts`, los imports, `createLink`, `ValidLink` y `peekLink` pasan a:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';

// ...

/** Crea un enlace de un solo uso (conexión admin). Devuelve el token en claro: es lo que va en la URL. */
export async function createLink(
  admin: Db, tenantId: string, purpose: LinkPurpose,
  opts: { ttlHours?: number; resourceId?: string } = {},
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await admin.query(
    `INSERT INTO onboarding_links (tenant_id, purpose, token_hash, expires_at, resource_id)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5)`,
    [tenantId, purpose, hashToken(token), opts.ttlHours ?? DEFAULT_TTL_HOURS, opts.resourceId ?? null]);
  return token;
}

export interface ValidLink {
  linkId: string; tenantId: string; tenantName: string;
  /** Solo en los enlaces de Google: el recurso cuyo calendario se conecta. */
  resourceId: string | null; resourceName: string | null;
}

/**
 * Válido: del propósito pedido, sin usar, sin vencer y de un negocio no suspendido.
 * Solo consulta: lo consume register_channel o consume_google_link, en la
 * misma transacción que lo que registra.
 */
export async function peekLink(db: Db, token: string, purpose: LinkPurpose): Promise<ValidLink | null> {
  const [row] = await db.query(
    `SELECT l.id, l.tenant_id, t.name, l.resource_id
       FROM onboarding_links l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.token_hash = $1 AND l.purpose = $2 AND l.used_at IS NULL
        AND l.expires_at > now() AND t.status <> 'suspended'`,
    [hashToken(token), purpose]);
  if (!row) return null;
  let resourceName: string | null = null;
  if (row.resource_id) {
    // resources tiene RLS: sin el negocio fijado no se ve. Se lee dentro de él.
    const read = (m: EntityManager) => m.query(`SELECT name FROM resources WHERE id = $1`, [row.resource_id]);
    const [r] = db instanceof DataSource ? await runInTenant(db, row.tenant_id, read) : await read(db);
    resourceName = r?.name ?? null;
  }
  return { linkId: row.id, tenantId: row.tenant_id, tenantName: row.name,
           resourceId: row.resource_id, resourceName };
}
```


En `apps/api/test/helpers.ts`:
- `resetDb` añade `google_accounts` al principio del `TRUNCATE`.
- Al final:
```ts
/** Una cuenta de Google conectada para el recurso, con un refresh token de prueba cifrado. */
export async function seedGoogleAccount(
  tenantId: string, resourceId: string,
  over: { status?: string; calendarId?: string | null } = {},
): Promise<string> {
  const ds = await adminDs();
  const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
  await enc.ready();
  const [a] = await ds.query(
    `INSERT INTO google_accounts (tenant_id, resource_id, email, calendar_id, refresh_token_encrypted, status)
     VALUES ($1, $2, 'maria@gmail.com', $3, $4, $5) RETURNING id`,
    [tenantId, resourceId, over.calendarId === undefined ? 'citas123@group.calendar.google.com' : over.calendarId,
     enc.encrypt('1//refresh-de-prueba'), over.status ?? 'active']);
  return a.id;
}
```
En `packages/db/test/rls-inventory.test.ts`, `PRESUPUESTO` gana:
```ts
  // Google: la app guarda y renueva la conexión; reconectar actualiza, no borra.
  google_accounts: ['SELECT', 'INSERT', 'UPDATE'],
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/google apps/api/test/onboarding packages/db/test apps/api/test/scheduling`
Expected: PASS (los enlaces de WhatsApp siguen igual: `resourceId` y `resourceName` en null).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/migrations/1725600000000-CreateGoogleAccounts.ts packages/db/src/migrations/1725600100000-AddResourceToOnboardingLinks.ts packages/db/src/migrations/1725600200000-AddGoogleSyncToAppointments.ts apps/api/src/google/event-id.ts apps/api/src/onboarding/links.ts apps/api/test/helpers.ts packages/db/test/rls-inventory.test.ts apps/api/test/google/schema.test.ts
git commit -m "feat(google): modelar las cuentas de google por recurso y la proyección de las citas"
```

---
### Task 2: El cliente de Google y los access tokens

**Files:**
- Create: `apps/api/src/google/google.client.ts`, `apps/api/src/google/google-tokens.service.ts`, `apps/api/src/google/accounts.ts`
- Modify: `apps/api/src/app.module.ts` (providers), `.env.example`
- Test: `apps/api/test/google/google.client.test.ts`, `apps/api/test/google/google-tokens.test.ts`, `apps/api/test/google/accounts.test.ts`

**Interfaces:**
- Consumes: `EncryptionService`, `recordAudit`, `BusyInterval` (de `scheduling/availability`).
- Produces:
```ts
export const GOOGLE_SCOPES: readonly string[];            // openid, email, calendar.app.created, calendar.freebusy
export const REQUIRED_CALENDAR_SCOPES: readonly string[]; // los dos de calendario
export class GoogleApiError extends Error { readonly status: number | null; readonly reason: string | null }
export class GoogleAuthError extends GoogleApiError {}    // invalid_grant: hay que reconectar
export function isRetryable(err: unknown): boolean;
export interface GoogleEvent { id: string; status?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }
export interface EventBody { summary: string; description: string;
  start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string };
  extendedProperties?: { private: Record<string, string> } }
export class GoogleClient {
  constructor(clientId: string, clientSecret: string, redirectUri: string);
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<{ accessToken: string; expiresIn: number; refreshToken: string | null; scopes: string[]; email: string | null }>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>;
  createCalendar(token: string, summary: string, timeZone: string): Promise<string>;
  calendarExists(token: string, calendarId: string): Promise<boolean>;
  freeBusy(token: string, from: Date, to: Date, timeoutMs?: number): Promise<BusyInterval[]>;
  insertEvent(token: string, calendarId: string, eventId: string, body: EventBody): Promise<'created' | 'exists'>;
  patchEvent(token: string, calendarId: string, eventId: string, body: EventBody): Promise<void>;
  deleteEvent(token: string, calendarId: string, eventId: string): Promise<void>;
  listEvents(token: string, calendarId: string, q: { syncToken: string | null; pageToken: string | null }):
    Promise<{ items: GoogleEvent[]; nextPageToken: string | null; nextSyncToken: string | null }>;
  watchEvents(token: string, calendarId: string, ch: { id: string; token: string; address: string; ttlSeconds: number }):
    Promise<{ resourceId: string; expiration: Date }>;
  stopChannel(token: string, channelId: string, resourceId: string): Promise<void>;
}
export interface GoogleAccountRef { id: string; refreshTokenEncrypted: Buffer }
class GoogleTokens { accessToken(a: GoogleAccountRef): Promise<string>; invalidate(accountId: string): void;
  withToken<T>(a: GoogleAccountRef, fn: (token: string) => Promise<T>): Promise<T> }
export interface GoogleAccount extends GoogleAccountRef { tenantId: string; resourceId: string; resourceName: string;
  timezone: string; email: string | null; calendarId: string | null; status: string; syncToken: string | null;
  watchChannelId: string | null; watchResourceId: string | null; watchExpiresAt: Date | null }
export function loadAccount(m: EntityManager, accountId: string): Promise<GoogleAccount | null>;
export function markNeedsReauth(m: EntityManager, a: { id: string; tenantId: string; resourceId: string }, cause: string): Promise<boolean>;
export function markCalendarMissing(m: EntityManager, a: { id: string; tenantId: string; resourceId: string; calendarId: string | null }): Promise<void>;
```

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/google/google.client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleApiError, GoogleAuthError, GoogleClient, isRetryable } from '../../src/google/google.client';

let fetchMock: ReturnType<typeof vi.fn>;
const client = new GoogleClient('CLIENT_ID', 'SECRETO_DE_GOOGLE', 'https://citara.test/connect/google/callback');
const ok = (json: unknown, status = 200) => ({ ok: status < 300, status, json: async () => json });
const idToken = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const BODY = { summary: 'Corte — Ana', description: 'x',
  start: { dateTime: '2026-09-10T15:00:00.000Z', timeZone: 'America/Bogota' },
  end: { dateTime: '2026-09-10T15:30:00.000Z', timeZone: 'America/Bogota' } };

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });

describe('GoogleClient: OAuth', () => {
  it('la URL de autorización pide acceso permanente, consentimiento y los cuatro permisos', () => {
    const u = new URL(client.authUrl('ESTADO'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'CLIENT_ID', redirect_uri: 'https://citara.test/connect/google/callback', response_type: 'code',
      access_type: 'offline', prompt: 'consent', state: 'ESTADO' });
    expect(u.searchParams.get('scope')!.split(' ')).toEqual([
      'openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created',
      'https://www.googleapis.com/auth/calendar.freebusy']);
    expect(u.toString()).not.toContain('SECRETO_DE_GOOGLE');
  });

  it('canjea el código: el secreto va en el cuerpo, y lee permisos y correo', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'ya29.a', expires_in: 3599, refresh_token: '1//r',
      scope: 'openid https://www.googleapis.com/auth/calendar.freebusy', id_token: idToken({ email: 'maria@gmail.com' }) }));
    const r = await client.exchangeCode('CODIGO');
    expect(r).toEqual({ accessToken: 'ya29.a', expiresIn: 3599, refreshToken: '1//r',
      scopes: ['openid', 'https://www.googleapis.com/auth/calendar.freebusy'], email: 'maria@gmail.com' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(url).not.toContain('SECRETO');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toMatchObject({
      code: 'CODIGO', client_secret: 'SECRETO_DE_GOOGLE', grant_type: 'authorization_code' });
  });

  it('invalid_grant al renovar es un GoogleAuthError: hay que reconectar', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    await expect(client.refreshAccessToken('1//r')).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('un fallo de red no filtra el secreto', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed client_secret=SECRETO_DE_GOOGLE'));
    const err = await client.refreshAccessToken('1//r').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.message).not.toContain('SECRETO_DE_GOOGLE');
    expect(isRetryable(err)).toBe(true);
  });
});

describe('GoogleClient: calendario', () => {
  it('crea el calendario "Citas" en la zona del negocio', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'citas@group.calendar.google.com' }));
    expect(await client.createCalendar('ya29', 'Citas · María', 'America/Bogota')).toBe('citas@group.calendar.google.com');
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method, init.headers.Authorization]).toEqual(
      ['https://www.googleapis.com/calendar/v3/calendars', 'POST', 'Bearer ya29']);
    expect(JSON.parse(init.body)).toEqual({ summary: 'Citas · María', timeZone: 'America/Bogota' });
  });

  it('un calendario borrado no existe', async () => {
    fetchMock.mockResolvedValue(ok({ error: { code: 404, message: 'Not Found' } }, 404));
    expect(await client.calendarExists('ya29', 'c@group')).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe('https://www.googleapis.com/calendar/v3/calendars/c%40group');
  });

  it('crear un evento con un id que ya existe es "exists", no un error', async () => {
    fetchMock.mockResolvedValue(ok({ error: { code: 409, message: 'The requested identifier already exists.' } }, 409));
    expect(await client.insertEvent('ya29', 'c@group', 'abc12', BODY)).toBe('exists');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/c%40group/events?sendUpdates=none');
    expect(JSON.parse(init.body)).toMatchObject({ id: 'abc12', summary: 'Corte — Ana' });
  });

  it('actualizar un evento lo deja confirmado (restaura uno borrado)', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await client.patchEvent('ya29', 'c@group', 'abc12', BODY);
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method]).toEqual(
      ['https://www.googleapis.com/calendar/v3/calendars/c%40group/events/abc12?sendUpdates=none', 'PATCH']);
    expect(JSON.parse(init.body).status).toBe('confirmed');
  });

  it('borrar un evento que ya no está no es un error', async () => {
    fetchMock.mockResolvedValue(ok(null, 410));
    await expect(client.deleteEvent('ya29', 'c@group', 'abc12')).resolves.toBeUndefined();
  });

  it('lista con el syncToken y devuelve el siguiente', async () => {
    fetchMock.mockResolvedValue(ok({ items: [{ id: 'e1', status: 'cancelled' }], nextSyncToken: 'S2' }));
    const r = await client.listEvents('ya29', 'c@group', { syncToken: 'S1', pageToken: null });
    expect(r).toEqual({ items: [{ id: 'e1', status: 'cancelled' }], nextPageToken: null, nextSyncToken: 'S2' });
    const u = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(u.searchParams)).toEqual({ maxResults: '2500', syncToken: 'S1' });
  });

  it('un syncToken vencido es un error 410 que no se reintenta a ciegas', async () => {
    fetchMock.mockResolvedValue(ok({ error: { code: 410, message: 'Sync token is no longer valid' } }, 410));
    const err = await client.listEvents('ya29', 'c', { syncToken: 'S1', pageToken: null }).catch((e) => e);
    expect([err.status, isRetryable(err)]).toEqual([410, false]);
  });

  it('el ocupado se pide en ventanas de 60 días y se junta', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ calendars: { primary: { busy: [{ start: '2026-09-10T15:00:00Z', end: '2026-09-10T16:00:00Z' }] } } }))
      .mockResolvedValueOnce(ok({ calendars: { primary: { busy: [{ start: '2026-11-20T15:00:00Z', end: '2026-11-20T16:00:00Z' }] } } }));
    const busy = await client.freeBusy('ya29', new Date('2026-09-08T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(busy.map((b) => b.start.toISOString())).toEqual(['2026-09-10T15:00:00.000Z', '2026-11-20T15:00:00.000Z']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).items).toEqual([{ id: 'primary' }]);
  });

  it('un error de Google dentro de la respuesta de freeBusy es un error', async () => {
    fetchMock.mockResolvedValue(ok({ calendars: { primary: { errors: [{ domain: 'global', reason: 'internalError' }] } } }));
    await expect(client.freeBusy('ya29', new Date('2026-09-08T00:00:00Z'), new Date('2026-09-09T00:00:00Z')))
      .rejects.toBeInstanceOf(GoogleApiError);
  });

  it('abre un canal de watch y devuelve su expiración', async () => {
    fetchMock.mockResolvedValue(ok({ resourceId: 'RID', expiration: '1791000000000' }));
    const r = await client.watchEvents('ya29', 'c@group', { id: 'CH', token: 'T', address: 'https://citara.test/webhooks/google', ttlSeconds: 100 });
    expect(r).toEqual({ resourceId: 'RID', expiration: new Date(1791000000000) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      id: 'CH', type: 'web_hook', address: 'https://citara.test/webhooks/google', token: 'T', params: { ttl: '100' } });
  });

  it('los límites de tasa y los 5xx se reintentan; un 400 no', () => {
    expect(isRetryable(new GoogleApiError('x', 503))).toBe(true);
    expect(isRetryable(new GoogleApiError('x', 429))).toBe(true);
    expect(isRetryable(new GoogleApiError('x', 403, 'rateLimitExceeded'))).toBe(true);
    expect(isRetryable(new GoogleApiError('x', 403, 'forbidden'))).toBe(false);
    expect(isRetryable(new GoogleApiError('x', 400))).toBe(false);
  });
});
```
`apps/api/test/google/google-tokens.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { GoogleApiError, GoogleAuthError } from '../../src/google/google.client';
import { GoogleTokens } from '../../src/google/google-tokens.service';

let enc: EncryptionService;
beforeAll(async () => { enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready(); });

const setup = () => {
  const google = { refreshAccessToken: vi.fn().mockResolvedValue({ accessToken: 'ya29.uno', expiresIn: 3599 }) };
  const tokens = new GoogleTokens(enc, google as never);
  const account = { id: 'a1', refreshTokenEncrypted: enc.encrypt('1//refresh') };
  return { google, tokens, account };
};

describe('GoogleTokens', () => {
  it('renueva con el refresh token descifrado y reutiliza el access token mientras vive', async () => {
    const { google, tokens, account } = setup();
    expect(await tokens.accessToken(account)).toBe('ya29.uno');
    expect(await tokens.accessToken(account)).toBe('ya29.uno');
    expect(google.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(google.refreshAccessToken).toHaveBeenCalledWith('1//refresh');
  });

  it('un token a menos de un minuto de vencer se renueva', async () => {
    const { google, tokens, account } = setup();
    google.refreshAccessToken.mockResolvedValue({ accessToken: 'ya29.corto', expiresIn: 30 });
    await tokens.accessToken(account);
    await tokens.accessToken(account);
    expect(google.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('ante un 401 descarta el token y reintenta una vez', async () => {
    const { google, tokens, account } = setup();
    google.refreshAccessToken
      .mockResolvedValueOnce({ accessToken: 'ya29.viejo', expiresIn: 3599 })
      .mockResolvedValueOnce({ accessToken: 'ya29.nuevo', expiresIn: 3599 });
    const fn = vi.fn()
      .mockRejectedValueOnce(new GoogleApiError('x: Google respondió 401', 401))
      .mockResolvedValueOnce('ok');
    expect(await tokens.withToken(account, fn)).toBe('ok');
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['ya29.viejo', 'ya29.nuevo']);
  });

  it('un acceso revocado se propaga como GoogleAuthError', async () => {
    const { google, tokens, account } = setup();
    google.refreshAccessToken.mockRejectedValue(new GoogleAuthError('renovación del token: invalid_grant'));
    await expect(tokens.withToken(account, async () => 'nunca')).rejects.toBeInstanceOf(GoogleAuthError);
  });
});
```
`apps/api/test/google/accounts.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { loadAccount, markCalendarMissing, markNeedsReauth } from '../../src/google/accounts';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, resourceId: string, accountId: string;

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  accountId = await seedGoogleAccount(tenantId, resourceId);
});

describe('cuentas de Google', () => {
  it('carga la cuenta con el nombre del recurso y la zona del negocio', async () => {
    const a = await runInTenant(app, tenantId, (m) => loadAccount(m, accountId));
    expect(a).toMatchObject({ id: accountId, tenantId, resourceId, resourceName: 'María', timezone: 'America/Bogota',
                              calendarId: 'citas123@group.calendar.google.com', status: 'active' });
    expect(Buffer.isBuffer(a!.refreshTokenEncrypted)).toBe(true);
  });

  it('marcar que hay que reconectar se audita una sola vez', async () => {
    const ref = { id: accountId, tenantId, resourceId };
    expect(await runInTenant(app, tenantId, (m) => markNeedsReauth(m, ref, 'invalid_grant'))).toBe(true);
    expect(await runInTenant(app, tenantId, (m) => markNeedsReauth(m, ref, 'invalid_grant'))).toBe(false);
    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
    const audits = await adminQuery(`SELECT actor, action FROM audit_log`);
    expect(audits).toEqual([{ actor: 'google', action: 'calendar.needs_reauth' }]);
  });

  it('un calendario borrado deja la cuenta sin calendario y lo audita', async () => {
    await runInTenant(app, tenantId, (m) => markCalendarMissing(m,
      { id: accountId, tenantId, resourceId, calendarId: 'citas123@group.calendar.google.com' }));
    expect(await adminQuery(`SELECT calendar_id, sync_token FROM google_accounts`)).toEqual([{ calendar_id: null, sync_token: null }]);
    expect((await adminQuery(`SELECT action FROM audit_log`))[0].action).toBe('calendar.missing');
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/google/google.client.test.ts apps/api/test/google/google-tokens.test.ts apps/api/test/google/accounts.test.ts`
Expected: FAIL — no existen los módulos.

- [ ] **Step 3: El cliente**

`apps/api/src/google/google.client.ts`:
```ts
import type { BusyInterval } from '../scheduling/availability';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  // Solo los calendarios que crea la app: ahí van las citas.
  'https://www.googleapis.com/auth/calendar.app.created',
  // Cuándo está ocupada la persona en su calendario principal, sin leer sus eventos.
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;
/** El consentimiento granular de Google permite desmarcarlos; sin ellos no hay integración. */
export const REQUIRED_CALENDAR_SCOPES: readonly string[] = GOOGLE_SCOPES.slice(2);

/** Una llamada a Google que no salió. El mensaje es apto para logs: sin tokens ni secreto. */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly reason: string | null = null) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** El refresh token ya no sirve (revocado, o vencido en modo testing): hay que reconectar. */
export class GoogleAuthError extends GoogleApiError {
  constructor(message: string) {
    super(message, 400, 'invalid_grant');
    this.name = 'GoogleAuthError';
  }
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

/** Red caída, límites de tasa y 5xx: el siguiente intento puede salir. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof GoogleApiError) || err instanceof GoogleAuthError) return false;
  if (err.status === null || err.status === 429 || err.status >= 500) return true;
  return err.status === 403 && RATE_LIMIT_REASONS.has(err.reason ?? '');
}

export interface GoogleEvent {
  id: string; status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export interface EventBody {
  summary: string; description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties?: { private: Record<string, string> };
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 10_000;
/** VERIFICAR: freeBusy rechaza rangos largos (~3 meses). Se pide por ventanas. */
const FREEBUSY_WINDOW_MS = 60 * 86_400_000;

type Json = Record<string, any> | null;

/**
 * OAuth y la Calendar API v3 con fetch (sin la librería googleapis). Es el
 * único lugar que conoce estos endpoints. Ninguna URL lleva secretos: el
 * client secret y los refresh tokens viajan en el cuerpo.
 */
export class GoogleClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  authUrl(state: string): string {
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      // offline + consent: sin ellos Google no entrega refresh token al reconectar.
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
    }).toString();
    return u.toString();
  }

  async exchangeCode(code: string) {
    const json = await this.token('canje del código',
      { code, grant_type: 'authorization_code', redirect_uri: this.redirectUri });
    return {
      accessToken: String(json.access_token), expiresIn: Number(json.expires_in ?? 3600),
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      scopes: typeof json.scope === 'string' ? json.scope.split(' ') : [],
      email: emailFromIdToken(json.id_token),
    };
  }

  async refreshAccessToken(refreshToken: string) {
    const json = await this.token('renovación del token', { refresh_token: refreshToken, grant_type: 'refresh_token' });
    return { accessToken: String(json.access_token), expiresIn: Number(json.expires_in ?? 3600) };
  }

  async createCalendar(token: string, summary: string, timeZone: string): Promise<string> {
    const { json } = await this.api('creación del calendario', token, 'POST', '/calendars', { body: { summary, timeZone } });
    if (typeof json?.id !== 'string') throw new GoogleApiError('creación del calendario: Google no devolvió id', 200);
    return json.id;
  }

  async calendarExists(token: string, calendarId: string): Promise<boolean> {
    const { status } = await this.api('consulta del calendario', token, 'GET', `/calendars/${enc(calendarId)}`,
      { accept: [404, 410] });
    return status < 300;
  }

  async freeBusy(token: string, from: Date, to: Date, timeoutMs = TIMEOUT_MS): Promise<BusyInterval[]> {
    const out: BusyInterval[] = [];
    for (let start = from.getTime(); start < to.getTime(); start += FREEBUSY_WINDOW_MS) {
      const end = Math.min(start + FREEBUSY_WINDOW_MS, to.getTime());
      const { json } = await this.api('consulta de ocupado', token, 'POST', '/freeBusy', {
        body: { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: [{ id: 'primary' }] },
        timeoutMs,
      });
      const cal = json?.calendars?.primary;
      if (cal?.errors?.length) {
        throw new GoogleApiError(`consulta de ocupado: ${cal.errors[0].reason ?? 'error'}`, 200, cal.errors[0].reason ?? null);
      }
      for (const b of cal?.busy ?? []) out.push({ start: new Date(b.start), end: new Date(b.end) });
    }
    return out;
  }

  async insertEvent(token: string, calendarId: string, eventId: string, body: EventBody): Promise<'created' | 'exists'> {
    const { status } = await this.api('creación del evento', token, 'POST',
      `/calendars/${enc(calendarId)}/events?sendUpdates=none`, { body: { id: eventId, ...body }, accept: [409] });
    return status === 409 ? 'exists' : 'created';
  }

  async patchEvent(token: string, calendarId: string, eventId: string, body: EventBody): Promise<void> {
    // status 'confirmed' devuelve a la vida un evento que el dueño había borrado (VERIFICAR).
    await this.api('actualización del evento', token, 'PATCH',
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`, { body: { ...body, status: 'confirmed' } });
  }

  async deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
    await this.api('borrado del evento', token, 'DELETE',
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`, { accept: [404, 410] });
  }

  async listEvents(token: string, calendarId: string, q: { syncToken: string | null; pageToken: string | null }) {
    const params = new URLSearchParams({ maxResults: '2500' });
    if (q.syncToken) params.set('syncToken', q.syncToken);
    if (q.pageToken) params.set('pageToken', q.pageToken);
    const { json } = await this.api('lectura de cambios', token, 'GET', `/calendars/${enc(calendarId)}/events?${params}`);
    return {
      items: (json?.items ?? []) as GoogleEvent[],
      nextPageToken: (json?.nextPageToken as string | undefined) ?? null,
      nextSyncToken: (json?.nextSyncToken as string | undefined) ?? null,
    };
  }

  async watchEvents(token: string, calendarId: string, ch: { id: string; token: string; address: string; ttlSeconds: number }) {
    const { json } = await this.api('apertura del canal de avisos', token, 'POST', `/calendars/${enc(calendarId)}/events/watch`, {
      body: { id: ch.id, type: 'web_hook', address: ch.address, token: ch.token, params: { ttl: String(ch.ttlSeconds) } },
    });
    return { resourceId: String(json?.resourceId), expiration: new Date(Number(json?.expiration)) };
  }

  async stopChannel(token: string, channelId: string, resourceId: string): Promise<void> {
    await this.api('cierre del canal de avisos', token, 'POST', '/channels/stop',
      { body: { id: channelId, resourceId }, accept: [404] });
  }

  private async token(what: string, params: Record<string, string>): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GoogleApiError(`${what}: fallo de red (${(err as Error).name})`, null);
    }
    const json: Json = await res.json().catch(() => null);
    if (!res.ok) {
      if (json?.error === 'invalid_grant') throw new GoogleAuthError(`${what}: Google respondió invalid_grant`);
      const detail = typeof json?.error === 'string' ? ` — ${json.error}` : '';
      throw new GoogleApiError(`${what}: Google respondió ${res.status}${detail}`, res.status,
        typeof json?.error === 'string' ? json.error : null);
    }
    if (typeof json?.access_token !== 'string') throw new GoogleApiError(`${what}: Google no devolvió token`, res.status);
    return json;
  }

  private async api(
    what: string, token: string, method: string, path: string,
    opts: { body?: unknown; accept?: number[]; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: Json }> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      throw new GoogleApiError(`${what}: fallo de red (${(err as Error).name})`, null);
    }
    const json: Json = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok || opts.accept?.includes(res.status)) return { status: res.status, json };
    const reason = json?.error?.errors?.[0]?.reason ?? null;
    const detail = typeof json?.error?.message === 'string' ? ` — ${json.error.message}` : '';
    throw new GoogleApiError(`${what}: Google respondió ${res.status}${detail}`, res.status, reason);
  }
}

const enc = (s: string) => encodeURIComponent(s);

/** El correo de la cuenta, del id_token que Google entrega en el canje (por TLS, directo de Google). */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Los tokens y las cuentas**

`apps/api/src/google/google-tokens.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { EncryptionService } from '../crypto/encryption.service';
import { GoogleApiError, GoogleClient } from './google.client';

export interface GoogleAccountRef { id: string; refreshTokenEncrypted: Buffer }

/** Un minuto de margen: un token a punto de vencer fallaría a mitad de la llamada. */
const MARGIN_SECONDS = 60;

/**
 * Access tokens en memoria, por cuenta. Viven ~1 h; el refresh token cifrado
 * es lo único que se guarda. Cada proceso (API, worker) tiene su caché.
 */
@Injectable()
export class GoogleTokens {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly enc: EncryptionService, private readonly google: GoogleClient) {}

  async accessToken(account: GoogleAccountRef): Promise<string> {
    const hit = this.cache.get(account.id);
    if (hit && hit.expiresAt > Date.now()) return hit.token;
    const r = await this.google.refreshAccessToken(this.enc.decrypt(account.refreshTokenEncrypted));
    this.cache.set(account.id, { token: r.accessToken, expiresAt: Date.now() + (r.expiresIn - MARGIN_SECONDS) * 1000 });
    return r.accessToken;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  /** Con un 401 (token revocado o vencido antes de tiempo), se renueva y se reintenta una vez. */
  async withToken<T>(account: GoogleAccountRef, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.accessToken(account));
    } catch (err) {
      if (!(err instanceof GoogleApiError) || err.status !== 401) throw err;
      this.invalidate(account.id);
      return fn(await this.accessToken(account));
    }
  }
}
```
`apps/api/src/google/accounts.ts`:
```ts
import type { EntityManager } from 'typeorm';
import { recordAudit } from '../audit/audit';
import type { GoogleAccountRef } from './google-tokens.service';

export interface GoogleAccount extends GoogleAccountRef {
  tenantId: string; resourceId: string; resourceName: string; timezone: string;
  email: string | null; calendarId: string | null; status: string; syncToken: string | null;
  watchChannelId: string | null; watchResourceId: string | null; watchExpiresAt: Date | null;
}

export async function loadAccount(m: EntityManager, accountId: string): Promise<GoogleAccount | null> {
  const [r] = await m.query(
    `SELECT g.*, r.name AS resource_name, t.timezone
       FROM google_accounts g
       JOIN resources r ON r.id = g.resource_id
       JOIN tenants t ON t.id = g.tenant_id
      WHERE g.id = $1`, [accountId]);
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenant_id, resourceId: r.resource_id, resourceName: r.resource_name,
    timezone: r.timezone, email: r.email, calendarId: r.calendar_id, status: r.status,
    refreshTokenEncrypted: r.refresh_token_encrypted, syncToken: r.sync_token,
    watchChannelId: r.watch_channel_id, watchResourceId: r.watch_resource_id,
    watchExpiresAt: r.watch_expires_at ? new Date(r.watch_expires_at) : null,
  };
}

/**
 * La cuenta deja de usarse hasta reconectar. Se audita la transición, no cada
 * intento: lo que queda pendiente se sube al reconectar.
 */
export async function markNeedsReauth(
  m: EntityManager, a: { id: string; tenantId: string; resourceId: string }, cause: string,
): Promise<boolean> {
  // Con UPDATE, TypeORM devuelve [filas, conteo].
  const [, affected] = (await m.query(
    `UPDATE google_accounts SET status = 'needs_reauth', updated_at = now()
      WHERE id = $1 AND status = 'active'`, [a.id])) as [unknown[], number];
  if (affected > 0) {
    await recordAudit(m, { tenantId: a.tenantId, actor: 'google', action: 'calendar.needs_reauth',
                           details: { resourceId: a.resourceId, cause } });
  }
  return affected > 0;
}

/** El dueño borró el calendario "Citas": el chequeo de salud lo recrea y vuelve a subir lo futuro. */
export async function markCalendarMissing(
  m: EntityManager, a: { id: string; tenantId: string; resourceId: string; calendarId: string | null },
): Promise<void> {
  const [, affected] = (await m.query(
    `UPDATE google_accounts SET calendar_id = NULL, sync_token = NULL, updated_at = now()
      WHERE id = $1 AND calendar_id IS NOT DISTINCT FROM $2`, [a.id, a.calendarId])) as [unknown[], number];
  if (affected > 0) {
    await recordAudit(m, { tenantId: a.tenantId, actor: 'google', action: 'calendar.missing',
                           details: { resourceId: a.resourceId } });
  }
}
```

- [ ] **Step 5: Registrar y documentar**

En `apps/api/src/app.module.ts`, importar `GoogleClient` y `GoogleTokens` y añadir a `providers`:
```ts
    {
      // Credenciales del cliente OAuth de Citara (no de cada negocio). Los tests lo reemplazan.
      provide: GoogleClient,
      useFactory: () => new GoogleClient(
        process.env.GOOGLE_CLIENT_ID ?? '', process.env.GOOGLE_CLIENT_SECRET ?? '',
        `${(process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/connect/google/callback`),
    },
    GoogleTokens,
```
En `.env.example`, después de `PUBLIC_BASE_URL`:
```
# Google Calendar (Fase 4): cliente OAuth "Aplicación web" del proyecto de Google Cloud.
# URI de redirección autorizada: ${PUBLIC_BASE_URL}/connect/google/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

- [ ] **Step 6: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/google`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/google/google.client.ts apps/api/src/google/google-tokens.service.ts apps/api/src/google/accounts.ts apps/api/src/app.module.ts .env.example apps/api/test/google/google.client.test.ts apps/api/test/google/google-tokens.test.ts apps/api/test/google/accounts.test.ts
git commit -m "feat(google): hablar con oauth y la calendar api sin filtrar tokens ni secretos"
```

---

### Task 3: Conectar el calendario de un recurso

**Files:**
- Create: `apps/api/src/google/google-connect.service.ts`, `apps/api/src/google/connect-google-page.ts`, `apps/api/src/google/connect-google.controller.ts`
- Modify: `apps/api/src/google/accounts.ts` (`attachNewCalendar`), `apps/api/src/onboarding/connect-page.ts` (exportar `escapeHtml`, `layout`), `apps/api/src/app.module.ts`, `apps/api/src/cli/tenants.ts`, `apps/api/src/cli/tenant-cli.ts`
- Test: `apps/api/test/google/connect-google.e2e.test.ts`, `apps/api/test/cli/tenants.test.ts`

**Interfaces:**
- Consumes: `peekLink`, `createLink` (Task 1), `consume_google_link`, `GoogleClient`, `GoogleTokens`, `REQUIRED_CALENDAR_SCOPES` (Task 2), `LinkInvalidError`, `OnboardingInputError` (Fase 3).
- Produces:
```ts
export function attachNewCalendar(ds: DataSource, google: GoogleClient, accessToken: string,
  a: { id: string; tenantId: string; resourceId: string; resourceName: string; timezone: string }): Promise<string>;
class GoogleConnectService { complete(input: { token: string; code: string }):
  Promise<{ resourceName: string; email: string | null; calendar: 'reused' | 'created' | 'pending' }> }
// GET /connect/google?t=  → página (200) o enlace inválido (410)
// GET /connect/google/callback?state&code|error → resultado: 200, 400, 410, 422, 502
export const googleConnectUrl: (token: string) => string;
export function newGoogleLink(admin: DataSource, slug: string, resourceKey: string): Promise<string>;
// pnpm tenant google <slug> <recurso>
```
Orden del cierre: validar el enlace → canjear el código → exigir los permisos de calendario y el refresh token → ver si el calendario anterior sigue vivo → **en una transacción**: consumir el enlace, guardar la cuenta (token cifrado), auditar → **fuera**: si no se reutiliza un calendario, crearlo (`attachNewCalendar`). Si crearlo falla, la cuenta queda sin calendario y el chequeo de salud (Task 7) lo crea.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/google/connect-google.e2e.test.ts`:
```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import { createDataSource } from '@citara/db';
import { AppModule } from '../../src/app.module';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { GoogleApiError, GoogleClient } from '../../src/google/google.client';
import { createLink, peekLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedContact, adminQuery, closeHelpers } from '../helpers';

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created',
                'https://www.googleapis.com/auth/calendar.freebusy'];

let app: INestApplication, admin: DataSource, enc: EncryptionService;
let tenantId: string, resourceId: string, token: string;
const google = {
  authUrl: vi.fn((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  exchangeCode: vi.fn(), calendarExists: vi.fn(), createCalendar: vi.fn(), refreshAccessToken: vi.fn(),
};
const http = () => request(app.getHttpServer());
const callback = (q: Record<string, string> = {}) =>
  http().get('/connect/google/callback').query({ state: token, code: 'CODIGO', ...q });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleClient).useValue(google).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();
});
afterAll(async () => { await app.close(); await admin.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  await adminQuery(`UPDATE resources SET name = 'María <b>'`);
  token = await createLink(admin, tenantId, 'google', { resourceId });
  google.exchangeCode.mockResolvedValue({ accessToken: 'ya29.a', expiresIn: 3599, refreshToken: '1//refresh',
                                          scopes: SCOPES, email: 'maria@gmail.com' });
  google.calendarExists.mockResolvedValue(false);
  google.createCalendar.mockResolvedValue('citas-nuevo@group.calendar.google.com');
});

describe('GET /connect/google', () => {
  it('sirve la página con el botón hacia Google, escapada y sin caché ni Referer', async () => {
    const res = await http().get('/connect/google').query({ t: token }).expect(200);
    expect(res.text).toContain('https://accounts.google.com/o/oauth2/v2/auth?state=');
    expect(res.text).toContain('María &lt;b&gt;');
    expect(res.text).not.toContain('María <b>');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('un enlace inválido responde 410', async () => {
    await http().get('/connect/google').query({ t: 'inventado' }).expect(410);
  });
});

describe('GET /connect/google/callback', () => {
  it('guarda la cuenta con el token cifrado, crea el calendario "Citas" y sube lo ya agendado', async () => {
    const contactId = await seedContact(tenantId);
    const [{ id: futura }] = await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
       SELECT $1, $2, s.id, $3, now() + interval '2 days', now() + interval '2 days 30 minutes'
         FROM services s RETURNING id`, [tenantId, resourceId, contactId]);

    const res = await callback().expect(200);

    expect(res.text).toContain('quedó conectado');
    const [acc] = await adminQuery(`SELECT email, calendar_id, status, refresh_token_encrypted FROM google_accounts`);
    expect(acc).toMatchObject({ email: 'maria@gmail.com', calendar_id: 'citas-nuevo@group.calendar.google.com', status: 'active' });
    expect(enc.decrypt(acc.refresh_token_encrypted)).toBe('1//refresh');
    expect(google.createCalendar).toHaveBeenCalledWith('ya29.a', 'Citas · María <b>', 'America/Bogota');
    const [cita] = await adminQuery(`SELECT google_sync_status, google_sync_version FROM appointments WHERE id = $1`, [futura]);
    expect(cita).toEqual({ google_sync_status: 'pending', google_sync_version: 1 });
    const actions = (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['calendar.connected', 'calendar.created']);
  });

  it('el enlace se usa una sola vez', async () => {
    await callback().expect(200);
    await callback().expect(410);
    expect(await adminQuery(`SELECT id FROM google_accounts`)).toHaveLength(1);
  });

  it('si desmarcó un permiso de calendario: error claro, nada guardado y el enlace sigue sirviendo', async () => {
    google.exchangeCode.mockResolvedValue({ accessToken: 'ya29.a', expiresIn: 3599, refreshToken: '1//r',
                                            scopes: ['openid', 'email'], email: null });
    const res = await callback().expect(422);
    expect(res.text).toContain('marca todas las casillas');
    expect(await adminQuery(`SELECT id FROM google_accounts`)).toEqual([]);
    expect(await peekLink(admin, token, 'google')).not.toBeNull();
  });

  it('si canceló en Google, la página lo dice y el enlace sigue sirviendo', async () => {
    const res = await http().get('/connect/google/callback').query({ state: token, error: 'access_denied' }).expect(200);
    expect(res.text).toContain('No se conectó');
    expect(await peekLink(admin, token, 'google')).not.toBeNull();
  });

  it('si Google falla, 502 sin el detalle de Google', async () => {
    google.exchangeCode.mockRejectedValue(new GoogleApiError('canje del código: Google respondió 400 — invalid_request', 400));
    const res = await callback().expect(502);
    expect(res.text).not.toContain('invalid_request');
  });

  it('al reconectar con la misma cuenta, reutiliza su calendario', async () => {
    await callback().expect(200);
    await adminQuery(`UPDATE google_accounts SET status = 'needs_reauth'`);
    token = await createLink(admin, tenantId, 'google', { resourceId });
    google.calendarExists.mockResolvedValue(true);
    google.createCalendar.mockClear();

    await callback().expect(200);

    expect(google.createCalendar).not.toHaveBeenCalled();
    expect(await adminQuery(`SELECT status, calendar_id FROM google_accounts`))
      .toEqual([{ status: 'active', calendar_id: 'citas-nuevo@group.calendar.google.com' }]);
  });

  it('si crear el calendario falla, la conexión queda y el calendario se crea después', async () => {
    google.createCalendar.mockRejectedValue(new GoogleApiError('creación del calendario: Google respondió 503', 503));
    await callback().expect(200);
    expect(await adminQuery(`SELECT status, calendar_id FROM google_accounts`)).toEqual([{ status: 'active', calendar_id: null }]);
  });
});
```
Al final del `describe('CLI del operador', ...)` de `apps/api/test/cli/tenants.test.ts` (importar `newGoogleLink` y `googleConnectUrl` de `../../src/cli/tenants`):
```ts
  it('un enlace de Google es por recurso y reemplaza solo al anterior de ese recurso', async () => {
    const { tenantId, token: whatsapp } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await applyTenantConfig(admin, agenda);
    const primero = await newGoogleLink(admin, 'nuevo', 'maria');
    const segundo = await newGoogleLink(admin, 'nuevo', 'maria');

    expect(await peekLink(admin, primero, 'google')).toBeNull();
    expect(await peekLink(admin, segundo, 'google')).toMatchObject({ tenantId, resourceName: 'María' });
    expect(await peekLink(app, whatsapp, 'whatsapp')).not.toBeNull();
    expect(googleConnectUrl(segundo)).toMatch(/\/connect\/google\?t=/);
    await expect(newGoogleLink(admin, 'nuevo', 'pedro')).rejects.toThrow(/pedro/);
  });

  it('un enlace nuevo de WhatsApp no anula los de Google', async () => {
    await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await applyTenantConfig(admin, agenda);
    const google = await newGoogleLink(admin, 'nuevo', 'maria');
    await newLink(admin, 'nuevo');
    expect(await peekLink(admin, google, 'google')).not.toBeNull();
  });
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/google/connect-google.e2e.test.ts apps/api/test/cli/tenants.test.ts`
Expected: FAIL — 404 en `/connect/google`; `newGoogleLink` no existe.

- [ ] **Step 3: Crear el calendario y el cierre del OAuth**

Al final de `apps/api/src/google/accounts.ts` (importar `DataSource` como tipo, `runInTenant` y `GoogleClient` como tipo):
```ts
/**
 * Crea el calendario "Citas · <recurso>" y deja todo lo futuro pendiente de
 * subir a él. Sirve al conectar y cuando el dueño borró el calendario.
 */
export async function attachNewCalendar(
  ds: DataSource, google: GoogleClient, accessToken: string,
  a: { id: string; tenantId: string; resourceId: string; resourceName: string; timezone: string },
): Promise<string> {
  const calendarId = await google.createCalendar(accessToken, `Citas · ${a.resourceName}`, a.timezone);
  await runInTenant(ds, a.tenantId, async (m) => {
    // Calendario nuevo: lo leído y los canales del anterior ya no aplican.
    await m.query(
      `UPDATE google_accounts SET calendar_id = $2, sync_token = NULL, watch_channel_id = NULL,
              watch_resource_id = NULL, watch_token_hash = NULL, watch_expires_at = NULL,
              watch_error = NULL, updated_at = now()
        WHERE id = $1`, [a.id, calendarId]);
    await m.query(
      `UPDATE appointments SET google_sync_status = 'pending', google_sync_version = google_sync_version + 1
        WHERE resource_id = $1 AND status = 'confirmed' AND ends_at > now()`, [a.resourceId]);
    await recordAudit(m, { tenantId: a.tenantId, actor: 'google', action: 'calendar.created',
                           details: { resourceId: a.resourceId } });
  });
  return calendarId;
}
```
`apps/api/src/google/google-connect.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { EncryptionService } from '../crypto/encryption.service';
import { GoogleClient, REQUIRED_CALENDAR_SCOPES } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { attachNewCalendar } from './accounts';
import { peekLink } from '../onboarding/links';
import { LinkInvalidError, OnboardingInputError } from '../onboarding/onboarding.service';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';

/** Lo que lanza consume_google_link cuando el enlace no está vigente. */
const LINK_INVALID_SQLSTATE = 'CT410';

@Injectable()
export class GoogleConnectService {
  private readonly log = new Logger(GoogleConnectService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly enc: EncryptionService,
    private readonly google: GoogleClient,
    private readonly tokens: GoogleTokens,
  ) {}

  async complete(input: { token: string; code: string }) {
    const link = await peekLink(this.ds, input.token, 'google');
    if (!link?.resourceId) throw new LinkInvalidError();

    const ex = await this.google.exchangeCode(input.code);
    // El consentimiento granular deja desmarcar permisos: sin los de calendario no hay integración.
    if (REQUIRED_CALENDAR_SCOPES.some((s) => !ex.scopes.includes(s))) {
      throw new OnboardingInputError(
        'Para conectar el calendario hay que aceptar todos los permisos que pide Google. ' +
        'Vuelve a abrir el enlace y marca todas las casillas.');
    }
    if (!ex.refreshToken) {
      throw new OnboardingInputError('Google no entregó un acceso permanente. Vuelve a abrir el enlace e inténtalo de nuevo.');
    }

    const { timezone, previous } = await runInTenant(this.ds, link.tenantId, async (m) => {
      const [t] = await m.query(`SELECT timezone FROM tenants WHERE id = $1`, [link.tenantId]);
      const [a] = await m.query(`SELECT calendar_id FROM google_accounts WHERE resource_id = $1`, [link.resourceId]);
      return { timezone: t.timezone as string, previous: (a?.calendar_id as string | null) ?? null };
    });
    // Misma cuenta y calendario intacto: se reutiliza. Otra cuenta, o lo borró: uno nuevo.
    const reuse = previous ? await this.google.calendarExists(ex.accessToken, previous) : false;

    let accountId: string;
    try {
      accountId = await runInTenant(this.ds, link.tenantId, async (m) => {
        const [{ r: resourceId }] = await m.query(`SELECT consume_google_link($1) AS r`, [link.linkId]);
        const [acc] = await m.query(
          `INSERT INTO google_accounts
             (tenant_id, resource_id, email, calendar_id, refresh_token_encrypted, status, last_checked_at)
           VALUES ($1, $2, $3, $4, $5, 'active', now())
           ON CONFLICT (resource_id) DO UPDATE
             SET email = EXCLUDED.email, refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                 status = 'active', calendar_id = EXCLUDED.calendar_id, last_checked_at = now(), updated_at = now()
           RETURNING id`,
          [link.tenantId, resourceId, ex.email, reuse ? previous : null, this.enc.encrypt(ex.refreshToken!)]);
        await recordAudit(m, { tenantId: link.tenantId, actor: 'onboarding', action: 'calendar.connected',
                               details: { resourceId, email: ex.email } });
        return acc.id as string;
      });
    } catch (err) {
      if ((err as { driverError?: { code?: string } }).driverError?.code === LINK_INVALID_SQLSTATE) {
        throw new LinkInvalidError();
      }
      throw err;
    }
    // La renovación del token se hace con el refresh token nuevo.
    this.tokens.invalidate(accountId);

    let calendar: 'reused' | 'created' | 'pending' = 'reused';
    if (!reuse) {
      try {
        await attachNewCalendar(this.ds, this.google, ex.accessToken, {
          id: accountId, tenantId: link.tenantId, resourceId: link.resourceId,
          resourceName: link.resourceName ?? 'recurso', timezone });
        calendar = 'created';
      } catch (err) {
        // La conexión ya quedó: el chequeo de salud crea el calendario después.
        this.log.warn(`no se pudo crear el calendario de ${link.resourceId}: ${(err as Error).message}`);
        calendar = 'pending';
      }
    }
    return { resourceName: link.resourceName ?? 'el recurso', email: ex.email, calendar };
  }
}
```

- [ ] **Step 4: Las páginas y el controlador**

En `apps/api/src/onboarding/connect-page.ts`, `escapeHtml` y `layout` pasan a `export const`.

`apps/api/src/google/connect-google-page.ts`:
```ts
import { escapeHtml, layout } from '../onboarding/connect-page';

export function connectGooglePage(p: { tenantName: string; resourceName: string; authUrl: string }): string {
  return layout('Conectar Google Calendar', `
<h1>Conecta el Google Calendar de ${escapeHtml(p.resourceName)}</h1>
<p>${escapeHtml(p.tenantName)} usa un asistente que agenda citas por WhatsApp.</p>
<p>Al conectar, el asistente crea en tu cuenta un calendario llamado
<strong>«Citas · ${escapeHtml(p.resourceName)}»</strong> donde aparecen tus citas, y consulta en tu
calendario principal cuándo estás ocupado para no ofrecer esas horas. No lee el contenido de tus eventos.</p>
<p>Si mueves o borras una cita en ese calendario, el asistente se entera.</p>
<p><a href="${escapeHtml(p.authUrl)}" rel="noreferrer"><button type="button">Conectar Google Calendar</button></a></p>`);
}

export function resultPage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
```
`apps/api/src/google/connect-google.controller.ts`:
```ts
import { Controller, Get, HttpStatus, Logger, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { GoogleClient, GoogleApiError } from './google.client';
import { GoogleConnectService } from './google-connect.service';
import { connectGooglePage, resultPage } from './connect-google-page';
import { invalidLinkPage } from '../onboarding/connect-page';
import { peekLink } from '../onboarding/links';
import { LinkInvalidError, OnboardingInputError } from '../onboarding/onboarding.service';

@Controller('connect/google')
export class ConnectGoogleController {
  private readonly log = new Logger(ConnectGoogleController.name);

  constructor(
    private readonly ds: DataSource,
    private readonly google: GoogleClient,
    private readonly connect: GoogleConnectService,
  ) {}

  @Get()
  async page(@Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    secure(res);
    const link = token ? await peekLink(this.ds, token, 'google') : null;
    if (!token || !link?.resourceName) {
      res.status(HttpStatus.GONE).type('html').send(invalidLinkPage());
      return;
    }
    // El token viaja como `state` y vuelve en el callback: así se sabe qué enlace se completa.
    res.status(HttpStatus.OK).type('html').send(connectGooglePage({
      tenantName: link.tenantName, resourceName: link.resourceName, authUrl: this.google.authUrl(token) }));
  }

  @Get('callback')
  async callback(
    @Query('state') state: string | undefined, @Query('code') code: string | undefined,
    @Query('error') error: string | undefined, @Res() res: Response,
  ): Promise<void> {
    secure(res);
    const send = (status: number, html: string) => { res.status(status).type('html').send(html); };
    if (error) {
      send(HttpStatus.OK, resultPage('Conexión cancelada',
        'No se conectó el calendario. Si fue un error, vuelve a abrir el enlace que te enviaron.'));
      return;
    }
    if (!state || !code) {
      send(HttpStatus.BAD_REQUEST, resultPage('Faltan datos', 'Vuelve a abrir el enlace que te enviaron.'));
      return;
    }
    try {
      const r = await this.connect.complete({ token: state, code });
      send(HttpStatus.OK, resultPage('¡Listo!',
        `El calendario de ${r.resourceName} quedó conectado. Tus citas aparecerán en «Citas · ${r.resourceName}». ` +
        'Ya puedes cerrar esta página.'));
    } catch (err) {
      if (err instanceof LinkInvalidError) { send(HttpStatus.GONE, invalidLinkPage()); return; }
      if (err instanceof OnboardingInputError) {
        send(HttpStatus.UNPROCESSABLE_ENTITY, resultPage('Falta un paso', err.message));
        return;
      }
      if (err instanceof GoogleApiError) {
        this.log.warn(`conexión de Google incompleta: ${err.message}`);
        send(HttpStatus.BAD_GATEWAY, resultPage('No se pudo conectar',
          'Google no completó la conexión. Intenta de nuevo en unos minutos.'));
        return;
      }
      throw err;
    }
  }
}

/** El token del enlace (y el code de Google) van en la URL: ni caché, ni Referer, ni marcos. */
function secure(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}
```
En `app.module.ts`: `controllers: [WhatsappController, ConnectController, ConnectGoogleController]` y `GoogleConnectService` en `providers`.

- [ ] **Step 5: La CLI**

En `apps/api/src/cli/tenants.ts`:
- `revokeLinks` pasa a anular solo los de un propósito (y, opcional, un recurso); `setSuspended(true)` sigue anulando todos:
```ts
/** Vence ya los enlaces sin usar: uno perdido pudo llegarle a otra persona. */
const revokeLinks = (m: EntityManager, tenantId: string, scope: { purpose?: LinkPurpose; resourceId?: string } = {}) =>
  m.query(
    `UPDATE onboarding_links SET expires_at = now()
      WHERE tenant_id = $1 AND used_at IS NULL AND expires_at > now()
        AND ($2::varchar IS NULL OR purpose = $2) AND ($3::uuid IS NULL OR resource_id = $3)`,
    [tenantId, scope.purpose ?? null, scope.resourceId ?? null]);
```
  y `newLink` llama `revokeLinks(m, tenantId, { purpose: 'whatsapp' })`.
- Nuevo:
```ts
const publicBase = () => (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export const googleConnectUrl = (token: string) => `${publicBase()}/connect/google?t=${token}`;

/** Enlace para que un recurso conecte su Google Calendar. Reemplaza al anterior de ese recurso. */
export async function newGoogleLink(admin: DataSource, slug: string, resourceKey: string): Promise<string> {
  const tenantId = await tenantBySlug(admin, slug);
  return admin.transaction(async (m) => {
    const [r] = await m.query(
      `SELECT id FROM resources WHERE tenant_id = $1 AND key = $2 AND active`, [tenantId, resourceKey]);
    if (!r) throw new Error(`'${slug}' no tiene el recurso activo '${resourceKey}'`);
    await revokeLinks(m, tenantId, { purpose: 'google', resourceId: r.id });
    return createLink(m, tenantId, 'google', { resourceId: r.id });
  });
}
```
  (`connectUrl` pasa a usar `publicBase()`; `LinkPurpose` se importa de `../onboarding/links`.)

En `apps/api/src/cli/tenant-cli.ts`, una línea más en `USAGE` y un caso:
```ts
  pnpm tenant google <slug> <recurso>             imprime el enlace para conectar el Google Calendar de un recurso
```
```ts
      case 'google':
        if (!args[0] || !args[1]) throw new Error(USAGE);
        console.log(`Enlace para el calendario de '${args[1]}' (vence en 72 h, un solo uso):\n` +
                    googleConnectUrl(await newGoogleLink(admin, args[0], args[1])));
        break;
```

- [ ] **Step 6: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/google apps/api/test/onboarding apps/api/test/cli`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/google/google-connect.service.ts apps/api/src/google/connect-google-page.ts apps/api/src/google/connect-google.controller.ts apps/api/src/google/accounts.ts apps/api/src/onboarding/connect-page.ts apps/api/src/app.module.ts apps/api/src/cli/tenants.ts apps/api/src/cli/tenant-cli.ts apps/api/test/google/connect-google.e2e.test.ts apps/api/test/cli/tenants.test.ts
git commit -m "feat(google): conectar el calendario de cada recurso con un enlace de un solo uso"
```

---

### Task 4: Lo ocupado en Google no se ofrece

**Files:**
- Create: `apps/api/src/google/google-busy.service.ts`
- Modify: `apps/api/src/scheduling/availability.service.ts`, `apps/api/src/app.module.ts`, `apps/api/test/helpers.ts` (`buildScheduling`)
- Test: `apps/api/test/google/google-busy.test.ts`, `apps/api/test/scheduling/availability-external.test.ts`

**Interfaces:**
- Consumes: `GoogleTokens`, `GoogleClient.freeBusy` (Task 2), tabla `google_accounts` (Task 1).
- Produces:
```ts
export const EXTERNAL_BUSY: unique symbol;   // token de inyección
export interface ExternalBusy { busyFor(m: EntityManager, resourceId: string, from: Date, to: Date): Promise<BusyInterval[]> }
class AvailabilityService { constructor(external?: ExternalBusy) }   // sin él, nada externo
class GoogleBusyService implements ExternalBusy {}                     // nunca lanza: degrada a []
export function buildScheduling(ds?: DataSource, external?: ExternalBusy): { availability, reminders, booking, tools };
```
**Por qué freeBusy dentro del turno:** la disponibilidad se calcula dentro de la transacción del turno. `freeBusy` con un timeout de 3 s y una caché de 60 s por cuenta acota lo que espera el cliente. Si Google falla, el resultado es solo-Citara (D4: mostrar franjas de más es preferible a no mostrar ninguna); la reserva no depende de Google.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/scheduling/availability-external.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { resetDb, seedChannel, seedCatalog, seedHours, closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const JUEVES = { from: new Date('2026-09-10T05:00:00Z'), to: new Date('2026-09-11T05:00:00Z') };  // jueves en Bogotá
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
// La persona tiene algo en su calendario de 10:00 a 11:00 (Bogotá).
const external = { busyFor: vi.fn().mockResolvedValue([
  { start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T16:00:00Z') }]) };

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  external.busyFor.mockClear();
});

describe('disponibilidad con lo ocupado fuera de Citara', () => {
  it('no ofrece las franjas que la persona tiene ocupadas en su calendario', async () => {
    const { availability } = buildScheduling(undefined, external);
    const slots = await inTenant((m) => availability.slotsFor(m, tenantId,
      { serviceId, resourceId: null, ...JUEVES, now: AHORA }));
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts).toContain('2026-09-10T14:30:00.000Z');       // 09:30
    expect(starts).not.toContain('2026-09-10T15:00:00.000Z');   // 10:00
    expect(starts).not.toContain('2026-09-10T15:30:00.000Z');   // 10:30
    expect(starts).toContain('2026-09-10T16:00:00.000Z');       // 11:00
    expect(external.busyFor).toHaveBeenCalledWith(expect.anything(), resourceId, expect.any(Date), expect.any(Date));
  });

  it('reservar sobre lo ocupado en Google se rechaza como "ocupado", no "fuera de horario"', async () => {
    const { availability } = buildScheduling(undefined, external);
    const verdict = await inTenant((m) => availability.check(m, tenantId,
      { serviceId, resourceId, start: new Date('2026-09-10T15:00:00Z'), now: AHORA }));
    expect(verdict).toBe('taken');
  });

  it('sin fuente externa, todo sigue como antes', async () => {
    const { availability } = buildScheduling();
    const slots = await inTenant((m) => availability.slotsFor(m, tenantId,
      { serviceId, resourceId: null, ...JUEVES, now: AHORA }));
    expect(slots.map((s) => s.start.toISOString())).toContain('2026-09-10T15:00:00.000Z');
  });
});
```
`apps/api/test/google/google-busy.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { GoogleApiError } from '../../src/google/google.client';
import { GoogleBusyService } from '../../src/google/google-busy.service';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, resourceId: string;
let google: { freeBusy: ReturnType<typeof vi.fn> };
let service: GoogleBusyService;

const FROM = new Date('2026-09-08T00:00:00Z'), TO = new Date('2026-09-20T00:00:00Z');
const BLOCK = { start: new Date('2026-09-10T15:00:00Z'), end: new Date('2026-09-10T16:00:00Z') };
const busy = (from = FROM, to = TO, now?: number) =>
  runInTenant(app, tenantId, (m: EntityManager) => service.busyFor(m, resourceId, from, to, now));

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  google = { freeBusy: vi.fn().mockResolvedValue([BLOCK]) };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  service = new GoogleBusyService(tokens as never, google as never);
});

describe('GoogleBusyService', () => {
  it('sin cuenta conectada no le pregunta a Google', async () => {
    expect(await busy()).toEqual([]);
    expect(google.freeBusy).not.toHaveBeenCalled();
  });

  it('una cuenta que hay que reconectar no se consulta', async () => {
    await seedGoogleAccount(tenantId, resourceId, { status: 'needs_reauth' });
    expect(await busy()).toEqual([]);
    expect(google.freeBusy).not.toHaveBeenCalled();
  });

  it('consulta el ocupado con un timeout corto', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    expect(await busy()).toEqual([BLOCK]);
    expect(google.freeBusy).toHaveBeenCalledWith('ya29.prueba', FROM, TO, 3000);
  });

  it('un rango dentro del ya consultado sale de la caché durante un minuto', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const t0 = Date.now();
    await busy(FROM, TO, t0);
    expect(await busy(new Date('2026-09-10T00:00:00Z'), new Date('2026-09-11T00:00:00Z'), t0 + 30_000)).toEqual([BLOCK]);
    expect(google.freeBusy).toHaveBeenCalledTimes(1);
    await busy(FROM, TO, t0 + 61_000);
    expect(google.freeBusy).toHaveBeenCalledTimes(2);
  });

  it('si Google falla, devuelve vacío en vez de lanzar', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    google.freeBusy.mockRejectedValue(new GoogleApiError('consulta de ocupado: fallo de red (TimeoutError)', null));
    expect(await busy()).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/scheduling/availability-external.test.ts apps/api/test/google/google-busy.test.ts`
Expected: FAIL — `buildScheduling` ignora la fuente externa (se ofrece 10:00); no existe `google-busy.service`.

- [ ] **Step 3: La fuente externa en la disponibilidad**

En `apps/api/src/scheduling/availability.service.ts`:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
// ...

/** Lo ocupado fuera de Citara (el calendario principal en Google). Nunca lanza. */
export interface ExternalBusy {
  busyFor(m: EntityManager, resourceId: string, from: Date, to: Date): Promise<BusyInterval[]>;
}
export const EXTERNAL_BUSY = Symbol('EXTERNAL_BUSY');
const NO_EXTERNAL_BUSY: ExternalBusy = { busyFor: async () => [] };
```
La clase gana constructor:
```ts
  constructor(@Optional() @Inject(EXTERNAL_BUSY) private readonly external: ExternalBusy = NO_EXTERNAL_BUSY) {}
```
y en `slotsFor`, después de leer `busy` de la base y antes de `computeSlots`:
```ts
      // Lo ocupado en Google se suma a lo de Citara. Con el mismo margen del buffer.
      const external = q.ignoreBusy ? [] : await this.external.busyFor(
        m, r.id, new Date(q.from.getTime() - margin), new Date(q.to.getTime() + margin));
```
y `computeSlots` recibe `busy: [...busy, ...external]`.

- [ ] **Step 4: GoogleBusyService**

`apps/api/src/google/google-busy.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { GoogleClient } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import type { BusyInterval } from '../scheduling/availability';
import type { ExternalBusy } from '../scheduling/availability.service';

const CACHE_MS = 60_000;
/** Se consulta dentro del turno: el cliente espera, así que se corta pronto. */
const TIMEOUT_MS = 3_000;

/**
 * Cuándo está ocupada la persona en su calendario PRINCIPAL. Las citas de
 * Citara viven en el calendario "Citas" y no aparecen aquí: no hay doble conteo.
 */
@Injectable()
export class GoogleBusyService implements ExternalBusy {
  private readonly log = new Logger(GoogleBusyService.name);
  private readonly cache = new Map<string, { at: number; from: number; to: number; busy: BusyInterval[] }>();

  constructor(private readonly tokens: GoogleTokens, private readonly google: GoogleClient) {}

  async busyFor(m: EntityManager, resourceId: string, from: Date, to: Date, now = Date.now()): Promise<BusyInterval[]> {
    const [acc] = await m.query(
      `SELECT id, refresh_token_encrypted FROM google_accounts WHERE resource_id = $1 AND status = 'active'`,
      [resourceId]);
    if (!acc) return [];
    const hit = this.cache.get(acc.id);
    const fresh = hit && now - hit.at < CACHE_MS && hit.from <= from.getTime() && hit.to >= to.getTime();
    const busy = fresh ? hit.busy : await this.fetch(acc, from, to, now);
    return busy.filter((b) => b.start < to && b.end > from);
  }

  private async fetch(acc: { id: string; refresh_token_encrypted: Buffer }, from: Date, to: Date, now: number) {
    try {
      const busy = await this.tokens.withToken({ id: acc.id, refreshTokenEncrypted: acc.refresh_token_encrypted },
        (token) => this.google.freeBusy(token, from, to, TIMEOUT_MS));
      this.cache.set(acc.id, { at: now, from: from.getTime(), to: to.getTime(), busy });
      return busy;
    } catch (err) {
      // D4: sin Google se agenda igual. Una cuenta revocada la detecta el chequeo de salud.
      this.log.warn(`sin ocupado de Google para la cuenta ${acc.id}: ${(err as Error).message}`);
      return [];
    }
  }
}
```
En `app.module.ts`, `providers` gana:
```ts
    GoogleBusyService,
    // AvailabilityService recibe lo ocupado en Google por este token.
    { provide: EXTERNAL_BUSY, useExisting: GoogleBusyService },
```
En `apps/api/test/helpers.ts`, `buildScheduling` pasa a:
```ts
/** Los servicios de agenda, cableados como en AppModule. `external` reemplaza a Google. */
export function buildScheduling(ds?: DataSource, external?: ExternalBusy) {
  const availability = new AvailabilityService(external);
  // ...el resto igual
```
(importando `type ExternalBusy` de `../src/scheduling/availability.service`).

- [ ] **Step 5: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/scheduling apps/api/test/google apps/api/test/pipeline`
Expected: PASS (el pipeline no tiene cuentas de Google: nada cambia).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/google/google-busy.service.ts apps/api/src/scheduling/availability.service.ts apps/api/src/app.module.ts apps/api/test/helpers.ts apps/api/test/google/google-busy.test.ts apps/api/test/scheduling/availability-external.test.ts
git commit -m "feat(google): no ofrecer las horas ocupadas en el calendario principal de cada recurso"
```

---

### Task 5: Las citas suben a Google

**Files:**
- Create: `apps/api/src/queues/calendar.queue.ts`, `apps/api/src/google/calendar-push.processor.ts`, `apps/api/src/google/calendar-sweep.service.ts`
- Modify: `apps/api/src/scheduling/booking.service.ts` (cancelar y reprogramar dejan pendiente), `apps/api/src/queues/workers.ts`, `apps/api/src/app.module.ts`, `apps/api/test/pipeline/pipeline.e2e.test.ts` y `apps/api/test/onboarding/alta.e2e.test.ts` (`scheduleCalendar: false`)
- Test: `apps/api/test/google/calendar-push.test.ts`, `apps/api/test/google/calendar-sweep.test.ts`

**Interfaces:**
- Consumes: `googleEventId` (Task 1), `GoogleClient`, `GoogleTokens`, `isRetryable`, `markNeedsReauth`, `markCalendarMissing` (Task 2).
- Produces:
```ts
export const CALENDAR_QUEUE = 'calendar';
export interface PushJob { tenantId: string; appointmentId: string; version: number }
export interface AccountJob { tenantId: string; accountId: string }
export type CalendarJob = { name: 'push'; data: PushJob; jobId: string }
  | { name: 'pull' | 'watch' | 'health'; data: AccountJob; jobId: string };
class CalendarQueue { add(job: CalendarJob): Promise<unknown>; schedule(): Promise<unknown> }
class CalendarPushProcessor { process(job: PushJob): Promise<{ result: 'created' | 'updated' | 'deleted' | 'skipped' | 'failed' }>;
                              markFailed(job: PushJob): Promise<void> }
class CalendarSweep { run(now: Date): Promise<CalendarJob[]> }
// startWorkers(ctx, { scheduleCalendar?: boolean })
```
Cada cambio de una cita que hay que reflejar sube `google_sync_version` y deja `google_sync_status = 'pending'`. La subida lee la versión, habla con Google y marca `synced` **solo si la versión sigue igual** (compare-and-set). El jobId `push-<cita>-<versión>` deduplica los barridos.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/google/calendar-push.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { googleEventId } from '../../src/google/event-id';
import { GoogleApiError, GoogleAuthError } from '../../src/google/google.client';
import { CalendarPushProcessor } from '../../src/google/calendar-push.processor';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, seedGoogleAccount, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;
let google: Record<'insertEvent' | 'patchEvent' | 'deleteEvent', ReturnType<typeof vi.fn>>;
let push: CalendarPushProcessor;

const AHORA = new Date('2026-09-08T12:00:00Z');
const JUEVES_10AM = new Date('2026-09-10T15:00:00Z');
const CAL = 'citas123@group.calendar.google.com';
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const book = () => inTenant((m) => buildScheduling().booking.book(m, tenantId,
  { serviceId, resourceId, contactId, startsAt: JUEVES_10AM, customerName: 'Ana', now: AHORA }));
const sync = async (id: string) => (await adminQuery(
  `SELECT google_sync_status AS s, google_sync_version AS v, google_event_id AS e FROM appointments WHERE id = $1`, [id]))[0];

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  google = { insertEvent: vi.fn().mockResolvedValue('created'), patchEvent: vi.fn().mockResolvedValue(undefined),
             deleteEvent: vi.fn().mockResolvedValue(undefined) };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  push = new CalendarPushProcessor(app, tokens as never, google as never);
});

describe('CalendarPushProcessor', () => {
  it('sube la cita al calendario "Citas" con su id y la marca sincronizada', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'created' });

    const [token, cal, eventId, body] = google.insertEvent.mock.calls[0];
    expect([token, cal, eventId]).toEqual(['ya29.prueba', CAL, googleEventId(cita.id)]);
    expect(body).toMatchObject({
      summary: 'Corte de cabello — Ana',
      start: { dateTime: '2026-09-10T15:00:00.000Z', timeZone: 'America/Bogota' },
      end: { dateTime: '2026-09-10T15:30:00.000Z', timeZone: 'America/Bogota' },
      extendedProperties: { private: { citaraAppointmentId: cita.id } } });
    expect(body.description).toContain('+573001112233');
    expect(await sync(cita.id)).toEqual({ s: 'synced', v: 0, e: googleEventId(cita.id) });
  });

  it('si el evento ya existía (un reintento), lo pone al día en vez de duplicarlo', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockResolvedValue('exists');

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'updated' });
    expect(google.patchEvent).toHaveBeenCalledWith('ya29.prueba', CAL, googleEventId(cita.id), expect.any(Object));
  });

  it('cancelar y reprogramar por WhatsApp dejan la cita pendiente con una versión nueva', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    const s = buildScheduling();
    await inTenant((m) => s.booking.reschedule(m, tenantId, cita.id, contactId, new Date('2026-09-10T16:00:00Z'), AHORA));
    expect(await sync(cita.id)).toMatchObject({ s: 'pending', v: 1 });
    await inTenant((m) => s.booking.cancel(m, cita.id, contactId));
    expect(await sync(cita.id)).toMatchObject({ s: 'pending', v: 2 });
  });

  it('una cita cancelada se borra de Google', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    await inTenant((m) => buildScheduling().booking.cancel(m, cita.id, contactId));

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 1 })).toEqual({ result: 'deleted' });
    expect(google.deleteEvent).toHaveBeenCalledWith('ya29.prueba', CAL, googleEventId(cita.id));
    expect((await sync(cita.id)).s).toBe('synced');
  });

  it('si la cita cambió mientras subía, queda pendiente para la versión nueva', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockImplementation(async () => {
      await adminQuery(`UPDATE appointments SET google_sync_version = google_sync_version + 1`);
      return 'created';
    });

    await push.process({ tenantId, appointmentId: cita.id, version: 0 });

    expect(await sync(cita.id)).toMatchObject({ s: 'pending', v: 1 });
  });

  it('un job de una versión vieja no hace nada', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 7 })).toEqual({ result: 'skipped' });
    expect(google.insertEvent).not.toHaveBeenCalled();
  });

  it('sin cuenta de Google, o con la cuenta caída, la cita queda pendiente sin llamar a Google', async () => {
    const cita = await book();
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'skipped' });
    await seedGoogleAccount(tenantId, resourceId, { status: 'needs_reauth' });
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'skipped' });
    expect(google.insertEvent).not.toHaveBeenCalled();
    expect((await sync(cita.id)).s).toBe('pending');
  });

  it('un acceso revocado deja la cuenta para reconectar y la cita pendiente', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockRejectedValue(new GoogleAuthError('renovación del token: Google respondió invalid_grant'));

    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'skipped' });

    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
    expect((await sync(cita.id)).s).toBe('pending');
  });

  it('si el dueño borró el calendario "Citas", la cuenta queda sin calendario para recrearlo', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockRejectedValue(new GoogleApiError('creación del evento: Google respondió 404', 404));

    await push.process({ tenantId, appointmentId: cita.id, version: 0 });

    expect(await adminQuery(`SELECT calendar_id FROM google_accounts`)).toEqual([{ calendar_id: null }]);
    expect((await sync(cita.id)).s).toBe('pending');
  });

  it('un rechazo permanente marca la cita como fallida; uno pasajero se reintenta', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const cita = await book();
    google.insertEvent.mockRejectedValueOnce(new GoogleApiError('creación del evento: Google respondió 503', 503));
    await expect(push.process({ tenantId, appointmentId: cita.id, version: 0 })).rejects.toThrow(/503/);
    expect((await sync(cita.id)).s).toBe('pending');

    google.insertEvent.mockRejectedValueOnce(new GoogleApiError('creación del evento: Google respondió 400', 400));
    expect(await push.process({ tenantId, appointmentId: cita.id, version: 0 })).toEqual({ result: 'failed' });
    expect((await sync(cita.id)).s).toBe('failed');
  });
});
```
`apps/api/test/google/calendar-sweep.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { CalendarSweep } from '../../src/google/calendar-sweep.service';
import { resetDb, seedChannel, seedCatalog, seedContact, seedGoogleAccount, addResource, adminQuery,
         closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string;
let sweep: CalendarSweep;

const AHORA = new Date('2026-09-08T12:00:00Z');
const appointment = async (resource: string, startsAt: string) => (await adminQuery(
  `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
   VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '30 minutes') RETURNING id`,
  [tenantId, resource, serviceId, contactId, startsAt]))[0].id as string;
const pushes = async () => (await sweep.run(AHORA)).filter((j) => j.name === 'push');

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  contactId = await seedContact(tenantId);
  sweep = new CalendarSweep(app);
});

describe('CalendarSweep: subidas', () => {
  it('encola lo pendiente de recursos conectados, con un jobId por versión', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    const id = await appointment(resourceId, '2026-09-10T15:00:00Z');
    expect(await pushes()).toEqual([{ name: 'push', data: { tenantId, appointmentId: id, version: 0 }, jobId: `push-${id}-0` }]);
  });

  it('no encola lo de recursos sin cuenta, con la cuenta caída o sin calendario', async () => {
    const pedro = await addResource(tenantId, 'pedro', 'Pedro', serviceId);
    await appointment(pedro, '2026-09-10T15:00:00Z');
    await seedGoogleAccount(tenantId, resourceId, { calendarId: null });
    await appointment(resourceId, '2026-09-10T15:00:00Z');
    expect(await pushes()).toEqual([]);
    await adminQuery(`UPDATE google_accounts SET calendar_id = 'c', status = 'needs_reauth'`);
    expect(await pushes()).toEqual([]);
  });

  it('no sube historia ni lo de un negocio suspendido', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    await appointment(resourceId, '2026-09-01T15:00:00Z');
    expect(await pushes()).toEqual([]);
    await appointment(resourceId, '2026-09-10T15:00:00Z');
    await adminQuery(`UPDATE tenants SET status = 'suspended'`);
    expect(await pushes()).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/google/calendar-push.test.ts apps/api/test/google/calendar-sweep.test.ts`
Expected: FAIL — no existen los módulos.

- [ ] **Step 3: Cancelar y reprogramar dejan pendiente**

En `apps/api/src/scheduling/booking.service.ts`, el `UPDATE` de `cancel` pasa a:
```ts
      `UPDATE appointments SET status = 'cancelled', updated_at = now(),
              google_sync_status = 'pending', google_sync_version = google_sync_version + 1
        WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'
        RETURNING ${COLUMNS}`
```
y el de `reschedule`:
```ts
        `UPDATE appointments SET starts_at = $3, ends_at = $4, updated_at = now(),
                google_sync_status = 'pending', google_sync_version = google_sync_version + 1
          WHERE id = $1 AND contact_id = $2 AND status = 'confirmed'
          RETURNING ${COLUMNS}`
```

- [ ] **Step 4: La cola, la subida y el barrido**

`apps/api/src/queues/calendar.queue.ts`:
```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export const CALENDAR_QUEUE = 'calendar';

export interface PushJob { tenantId: string; appointmentId: string; version: number }
export interface AccountJob { tenantId: string; accountId: string }
export type CalendarJob =
  | { name: 'push'; data: PushJob; jobId: string }
  | { name: 'pull' | 'watch' | 'health'; data: AccountJob; jobId: string };

/**
 * Cola propia (no `sync`): `sync` corre con concurrencia 1 para el historial de
 * coexistencia, y una importación grande no debe retrasar las citas en Google.
 * Los jobIds deduplican: el mismo trabajo no se encola dos veces.
 */
@Injectable()
export class CalendarQueue implements OnModuleDestroy {
  private readonly queue = new Queue(CALENDAR_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  });

  constructor() {
    this.queue.on('error', (err) => console.error(`[calendar] error de la cola: ${err.message}`));
  }

  add(job: CalendarJob) { return this.queue.add(job.name, job.data, { jobId: job.jobId }); }

  /** Un barrido por minuto. El scheduler vive en Redis y `upsert` es idempotente. */
  schedule() {
    return this.queue.upsertJobScheduler('calendar-sweep', { every: 60_000 }, { name: 'sweep' });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
```
`apps/api/src/google/calendar-push.processor.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { GoogleApiError, GoogleAuthError, GoogleClient, isRetryable, type EventBody } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { markCalendarMissing, markNeedsReauth } from './accounts';
import { googleEventId } from './event-id';
import { runInTenant } from '../tenancy/tenant-context';
import type { PushJob } from '../queues/calendar.queue';

type Row = Record<string, any>;

/** Citara → Google (spec §7.3). La cita ya está confirmada; esto es su proyección. */
@Injectable()
export class CalendarPushProcessor {
  private readonly log = new Logger(CalendarPushProcessor.name);

  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
  ) {}

  async process(job: PushJob): Promise<{ result: 'created' | 'updated' | 'deleted' | 'skipped' | 'failed' }> {
    const row: Row | undefined = await runInTenant(this.ds, job.tenantId, async (m) => (await m.query(
      `SELECT a.id, a.status, a.starts_at, a.ends_at, a.customer_name, a.notes,
              s.name AS service_name, c.wa_id, t.timezone,
              g.id AS account_id, g.resource_id, g.calendar_id, g.refresh_token_encrypted, g.status AS account_status
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         JOIN contacts c ON c.id = a.contact_id
         JOIN tenants t ON t.id = a.tenant_id
         LEFT JOIN google_accounts g ON g.resource_id = a.resource_id
        WHERE a.id = $1 AND a.google_sync_status = 'pending' AND a.google_sync_version = $2`,
      [job.appointmentId, job.version]))[0]);
    // Ya subida, o hay una versión más nueva con su propio job.
    if (!row) return { result: 'skipped' };
    // Sin cuenta sana o sin calendario: queda pendiente hasta reconectar o recrearlo.
    if (!row.account_id || row.account_status !== 'active' || !row.calendar_id) return { result: 'skipped' };

    const eventId = googleEventId(row.id);
    let result: 'created' | 'updated' | 'deleted';
    try {
      result = await this.tokens.withToken(
        { id: row.account_id, refreshTokenEncrypted: row.refresh_token_encrypted },
        async (token) => {
          if (row.status === 'cancelled') {
            await this.google.deleteEvent(token, row.calendar_id, eventId);
            return 'deleted';
          }
          const body = eventBody(row);
          if ((await this.google.insertEvent(token, row.calendar_id, eventId, body)) === 'created') return 'created';
          // 409: ya existía (un reintento, o la cita cambió). Se pone al día.
          await this.google.patchEvent(token, row.calendar_id, eventId, body);
          return 'updated';
        });
    } catch (err) {
      return this.onError(job, row, err);
    }

    // Compare-and-set: si la cita cambió mientras se hablaba con Google, su versión
    // subió y esta marca no aplica; el job de la versión nueva la sube.
    await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE appointments SET google_sync_status = 'synced', google_event_id = $3, google_synced_at = now()
        WHERE id = $1 AND google_sync_version = $2 AND google_sync_status = 'pending'`,
      [row.id, job.version, eventId]));
    return { result };
  }

  /** Reintentos agotados o rechazo permanente. El chequeo diario lo vuelve a intentar. */
  async markFailed(job: PushJob): Promise<void> {
    await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE appointments SET google_sync_status = 'failed'
        WHERE id = $1 AND google_sync_version = $2 AND google_sync_status = 'pending'`,
      [job.appointmentId, job.version]));
  }

  private async onError(job: PushJob, row: Row, err: unknown) {
    const account = { id: row.account_id, tenantId: job.tenantId, resourceId: row.resource_id, calendarId: row.calendar_id };
    if (err instanceof GoogleAuthError) {
      await runInTenant(this.ds, job.tenantId, (m) => markNeedsReauth(m, account, err.message));
      return { result: 'skipped' as const };
    }
    // 404 al crear o actualizar: el calendario "Citas" ya no existe.
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) {
      await runInTenant(this.ds, job.tenantId, (m) => markCalendarMissing(m, account));
      return { result: 'skipped' as const };
    }
    if (isRetryable(err)) throw err;
    this.log.warn(`la cita ${row.id} no se pudo reflejar en Google: ${(err as Error).message}`);
    await this.markFailed(job);
    return { result: 'failed' as const };
  }
}

function eventBody(r: Row): EventBody {
  const customer = r.customer_name ?? 'Cliente';
  return {
    summary: `${r.service_name} — ${customer}`,
    description: [
      `Cliente: ${customer}`,
      `WhatsApp: +${r.wa_id}`,
      r.notes ? `Notas: ${r.notes}` : null,
      'Agendada por Citara. Si la mueves o la borras aquí, Citara se entera.',
    ].filter(Boolean).join('\n'),
    start: { dateTime: new Date(r.starts_at).toISOString(), timeZone: r.timezone },
    end: { dateTime: new Date(r.ends_at).toISOString(), timeZone: r.timezone },
    extendedProperties: { private: { citaraAppointmentId: r.id } },
  };
}
```
`apps/api/src/google/calendar-sweep.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Import de VALOR: parámetro del constructor de un servicio Nest.
import { DataSource, type EntityManager } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { CalendarJob } from '../queues/calendar.queue';

/**
 * Qué hay que hacer con Google, negocio por negocio (las tablas tienen RLS:
 * un SELECT global sin `app.tenant_id` no ve nada). Solo lee y devuelve jobs;
 * el worker los encola. Los jobIds evitan duplicados entre barridos.
 */
@Injectable()
export class CalendarSweep {
  constructor(private readonly ds: DataSource) {}

  async run(now: Date): Promise<CalendarJob[]> {
    const tenants: { id: string }[] = await this.ds.query(`SELECT id FROM tenants WHERE status <> 'suspended'`);
    const out: CalendarJob[] = [];
    for (const t of tenants) out.push(...await runInTenant(this.ds, t.id, (m) => this.forTenant(m, t.id, now)));
    return out;
  }

  private async forTenant(m: EntityManager, tenantId: string, now: Date): Promise<CalendarJob[]> {
    const out: CalendarJob[] = [];
    // Citara → Google: lo pendiente de recursos con cuenta sana y calendario. Sin historia.
    const pending: { id: string; version: number }[] = await m.query(
      `SELECT a.id, a.google_sync_version AS version
         FROM appointments a
         JOIN google_accounts g ON g.resource_id = a.resource_id
        WHERE a.google_sync_status = 'pending' AND g.status = 'active' AND g.calendar_id IS NOT NULL
          AND a.ends_at > $1::timestamptz - interval '1 day'`, [now]);
    for (const p of pending) {
      out.push({ name: 'push', data: { tenantId, appointmentId: p.id, version: p.version },
                 jobId: `push-${p.id}-${p.version}` });
    }
    return out;
  }
}
```

- [ ] **Step 5: El worker**

En `apps/api/src/queues/workers.ts`, `opts` gana `scheduleCalendar?: boolean` y, antes del `return`:
```ts
  const calendarQueue = ctx.get(CalendarQueue);
  const sweep = ctx.get(CalendarSweep);
  const push = ctx.get(CalendarPushProcessor);
  // Concurrencia 5: cada job es una o dos llamadas a Google; el barrido solo lee.
  const calendar = new Worker(CALENDAR_QUEUE, async (job) => {
    switch (job.name) {
      case 'sweep': for (const j of await sweep.run(new Date())) await calendarQueue.add(j); return;
      case 'push': return push.process(job.data as PushJob);
      default: throw new UnrecoverableError(`job de calendario desconocido: ${job.name}`);
    }
  }, { connection, concurrency: 5 });
  calendar.on('failed', (job, err) => {
    console.error(`[calendar] job ${job?.id} falló: ${err.message}`);
    // Reintentos agotados: la cita queda `failed` y el chequeo diario la retoma.
    if (job?.name === 'push' && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      push.markFailed(job.data as PushJob).catch((e: Error) =>
        console.error(`[calendar] no se pudo marcar la cita ${(job.data as PushJob).appointmentId}: ${e.message}`));
    }
  });
  calendar.on('error', (err) => console.error(`[calendar] error del worker: ${err.message}`));
  if (opts.scheduleCalendar !== false) {
    void calendarQueue.schedule()
      .catch((err: Error) => console.error(`[calendar] no se pudo programar el barrido: ${err.message}`));
  }
```
y `close` cierra también `calendar`. En `app.module.ts`, `providers` gana `CalendarQueue`, `CalendarPushProcessor` y `CalendarSweep`. En `apps/api/test/pipeline/pipeline.e2e.test.ts` y `apps/api/test/onboarding/alta.e2e.test.ts`, `startWorkers(...)` recibe además `scheduleCalendar: false`, y la lista de colas que vacían gana `CALENDAR_QUEUE`.

- [ ] **Step 6: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/google apps/api/test/scheduling apps/api/test/pipeline apps/api/test/onboarding`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/queues/calendar.queue.ts apps/api/src/google/calendar-push.processor.ts apps/api/src/google/calendar-sweep.service.ts apps/api/src/scheduling/booking.service.ts apps/api/src/queues/workers.ts apps/api/src/app.module.ts apps/api/test/pipeline/pipeline.e2e.test.ts apps/api/test/onboarding/alta.e2e.test.ts apps/api/test/google/calendar-push.test.ts apps/api/test/google/calendar-sweep.test.ts
git commit -m "feat(google): subir las citas al calendario citas de forma idempotente"
```

---

### Task 6: Lo que el dueño cambia en Google llega a Citara

**Files:**
- Create: `apps/api/src/google/calendar-pull.processor.ts`, `apps/api/src/google/calendar-watch.service.ts`, `apps/api/src/google/google-webhook.controller.ts`
- Modify: `apps/api/src/google/calendar-sweep.service.ts`, `apps/api/src/queues/workers.ts`, `apps/api/src/app.module.ts`
- Test: `apps/api/test/google/calendar-pull.test.ts`, `apps/api/test/google/calendar-watch.test.ts`, `apps/api/test/google/google-webhook.e2e.test.ts`, `apps/api/test/google/calendar-sweep.test.ts`

**Interfaces:**
- Consumes: `appointmentIdFromEventId` (Task 1), `GoogleClient.listEvents/watchEvents/stopChannel`, `loadAccount`, `markNeedsReauth`, `markCalendarMissing` (Task 2), `RemindersService.cancelFor/rescheduleFor` (Fase 2), `CalendarQueue` (Task 5), `hashToken` (Fase 3).
- Produces:
```ts
class CalendarPullProcessor { process(job: AccountJob, now?: Date): Promise<{ cancelled: number; moved: number; rejected: number }> }
class CalendarWatchService { renew(job: AccountJob, now?: Date): Promise<'renewed' | 'skipped'> }
export function watchEnabled(): boolean;   // PUBLIC_BASE_URL con https
// POST /webhooks/google → 200 siempre; encola un `pull` si el canal y su token son de una cuenta
// El token del canal es `<tenantId>.<secreto>`: el negocio se conoce sin saltarse RLS; se guarda el hash del secreto.
```
**Reglas de lo leído de Google:**
- Solo cuentan los eventos con id de cita (`appointmentIdFromEventId`) del recurso de la cuenta. El resto se ignora.
- Si la cita tiene un cambio local `pending`, gana lo local y la subida pisa a Google. Con `failed`, también se ignora.
- Si el evento viene `cancelled` y la cita está confirmada, se cancela la cita y sus recordatorios (auditoría `appointment.cancelled_in_google`). Al cliente no se le escribe (decisión 2).
- Si el evento trae otra hora, la cita se mueve y se reprograman sus recordatorios (`appointment.moved_in_google`), aunque quede fuera del horario: es decisión del dueño. Si choca con otra cita (la exclusión), no se aplica: se audita `appointment.move_rejected` y la cita vuelve a `pending` con versión nueva, así que la hora de Citara vuelve a Google.
- Un evento pasado a "todo el día" (sin `dateTime`) se ignora.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/google/calendar-pull.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { googleEventId } from '../../src/google/event-id';
import { GoogleApiError, GoogleAuthError } from '../../src/google/google.client';
import { CalendarPullProcessor } from '../../src/google/calendar-pull.processor';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, seedGoogleAccount, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string, accountId: string;
let google: { listEvents: ReturnType<typeof vi.fn> };
let pull: CalendarPullProcessor;

const AHORA = new Date('2026-09-08T12:00:00Z');
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const book = (startsAt = new Date('2026-09-10T15:00:00Z')) => inTenant((m) => buildScheduling().booking.book(m, tenantId,
  { serviceId, resourceId, contactId, startsAt, customerName: 'Ana', now: AHORA }));
const synced = (id: string) => adminQuery(`UPDATE appointments SET google_sync_status = 'synced' WHERE id = $1`, [id]);
const page = (items: object[], next: { nextPageToken?: string; nextSyncToken?: string } = { nextSyncToken: 'S2' }) =>
  ({ items, nextPageToken: next.nextPageToken ?? null, nextSyncToken: next.nextSyncToken ?? null });
const moved = (id: string, start: string, end: string) =>
  ({ id: googleEventId(id), status: 'confirmed', start: { dateTime: start }, end: { dateTime: end } });
const run = () => pull.process({ tenantId, accountId }, AHORA);
const cita = async (id: string) => (await adminQuery(
  `SELECT status, starts_at, google_sync_status AS s, google_sync_version AS v FROM appointments WHERE id = $1`, [id]))[0];

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  google = { listEvents: vi.fn() };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  pull = new CalendarPullProcessor(app, tokens as never, google as never, buildScheduling(app).reminders);
});

describe('CalendarPullProcessor', () => {
  it('borrar la cita en Google la cancela en Citara, con sus recordatorios, y guarda el syncToken', async () => {
    const a = await book(); await synced(a.id);
    google.listEvents.mockResolvedValue(page([{ id: googleEventId(a.id), status: 'cancelled' }]));

    expect(await run()).toEqual({ cancelled: 1, moved: 0, rejected: 0 });

    expect((await cita(a.id)).status).toBe('cancelled');
    expect(await adminQuery(`SELECT DISTINCT status FROM reminders`)).toEqual([{ status: 'cancelled' }]);
    expect((await adminQuery(`SELECT actor, action FROM audit_log`))).toEqual(
      [{ actor: 'google', action: 'appointment.cancelled_in_google' }]);
    expect(await adminQuery(`SELECT sync_token FROM google_accounts`)).toEqual([{ sync_token: 'S2' }]);
    expect(google.listEvents).toHaveBeenCalledWith('ya29.prueba', 'citas123@group.calendar.google.com',
                                                   { syncToken: null, pageToken: null });
  });

  it('moverla en Google la mueve en Citara y reprograma los recordatorios', async () => {
    const a = await book(); await synced(a.id);
    google.listEvents.mockResolvedValue(page([moved(a.id, '2026-09-11T16:00:00Z', '2026-09-11T16:30:00Z')]));

    expect(await run()).toMatchObject({ moved: 1 });

    expect(new Date((await cita(a.id)).starts_at).toISOString()).toBe('2026-09-11T16:00:00.000Z');
    expect((await cita(a.id)).s).toBe('synced');
    const [r] = await adminQuery(`SELECT send_at FROM reminders WHERE kind = '24h'`);
    expect(new Date(r.send_at).toISOString()).toBe('2026-09-10T16:00:00.000Z');
  });

  it('si la cita tiene un cambio local pendiente, gana lo local', async () => {
    const a = await book();   // queda pending: todavía no subió
    google.listEvents.mockResolvedValue(page([{ id: googleEventId(a.id), status: 'cancelled' }]));
    expect(await run()).toEqual({ cancelled: 0, moved: 0, rejected: 0 });
    expect((await cita(a.id)).status).toBe('confirmed');
  });

  it('lo que no es una cita de Citara se ignora', async () => {
    google.listEvents.mockResolvedValue(page([{ id: '7kvq2h0s1d2o9c3jtn4u0tqk1c', status: 'confirmed',
      start: { dateTime: '2026-09-10T15:00:00Z' }, end: { dateTime: '2026-09-10T16:00:00Z' } }]));
    expect(await run()).toEqual({ cancelled: 0, moved: 0, rejected: 0 });
  });

  it('un movimiento que choca con otra cita no se aplica y la hora de Citara vuelve a Google', async () => {
    const a = await book(); await synced(a.id);
    const b = await book(new Date('2026-09-10T17:00:00Z')); await synced(b.id);
    google.listEvents.mockResolvedValue(page([moved(a.id, '2026-09-10T17:00:00Z', '2026-09-10T17:30:00Z')]));

    expect(await run()).toMatchObject({ rejected: 1 });

    expect(await cita(a.id)).toMatchObject({ status: 'confirmed', s: 'pending', v: 1 });
    expect(new Date((await cita(a.id)).starts_at).toISOString()).toBe('2026-09-10T15:00:00.000Z');
    expect((await adminQuery(`SELECT action FROM audit_log`))[0].action).toBe('appointment.move_rejected');
  });

  it('usa el syncToken guardado y recorre todas las páginas', async () => {
    await adminQuery(`UPDATE google_accounts SET sync_token = 'S1'`);
    google.listEvents
      .mockResolvedValueOnce(page([], { nextPageToken: 'P2' }))
      .mockResolvedValueOnce(page([], { nextSyncToken: 'S3' }));
    await run();
    expect(google.listEvents.mock.calls.map((c) => c[2])).toEqual([
      { syncToken: 'S1', pageToken: null }, { syncToken: 'S1', pageToken: 'P2' }]);
    expect(await adminQuery(`SELECT sync_token FROM google_accounts`)).toEqual([{ sync_token: 'S3' }]);
  });

  it('con el syncToken vencido (410), rehace la lectura desde cero', async () => {
    await adminQuery(`UPDATE google_accounts SET sync_token = 'VIEJO'`);
    google.listEvents
      .mockRejectedValueOnce(new GoogleApiError('lectura de cambios: Google respondió 410', 410))
      .mockResolvedValueOnce(page([]));
    await run();
    expect(google.listEvents.mock.calls.map((c) => c[2].syncToken)).toEqual(['VIEJO', null]);
  });

  it('un acceso revocado deja la cuenta para reconectar', async () => {
    google.listEvents.mockRejectedValue(new GoogleAuthError('renovación del token: Google respondió invalid_grant'));
    await run();
    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
  });
});
```
`apps/api/test/google/calendar-watch.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { hashToken } from '../../src/onboarding/links';
import { GoogleApiError } from '../../src/google/google.client';
import { CalendarWatchService } from '../../src/google/calendar-watch.service';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, accountId: string;
let google: Record<'watchEvents' | 'stopChannel', ReturnType<typeof vi.fn>>;
let watch: CalendarWatchService;

const AHORA = new Date('2026-09-08T12:00:00Z');
const EXPIRA = new Date('2026-10-08T12:00:00Z');
const renew = () => watch.renew({ tenantId, accountId }, AHORA);

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  process.env.PUBLIC_BASE_URL = 'https://citara.test';
  await resetDb();
  ({ tenantId } = await seedChannel());
  const { resourceId } = await seedCatalog(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  google = { watchEvents: vi.fn().mockResolvedValue({ resourceId: 'RID', expiration: EXPIRA }),
             stopChannel: vi.fn().mockResolvedValue(undefined) };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  watch = new CalendarWatchService(app, tokens as never, google as never);
});
afterEach(() => { process.env.PUBLIC_BASE_URL = 'http://localhost:3000'; });

describe('CalendarWatchService', () => {
  it('abre un canal hacia /webhooks/google y guarda solo el hash del secreto', async () => {
    expect(await renew()).toBe('renewed');
    const [, cal, ch] = google.watchEvents.mock.calls[0];
    expect(cal).toBe('citas123@group.calendar.google.com');
    expect(ch.address).toBe('https://citara.test/webhooks/google');
    const [prefix, secret] = ch.token.split('.');
    expect(prefix).toBe(tenantId);
    const [acc] = await adminQuery(`SELECT watch_channel_id, watch_resource_id, watch_token_hash, watch_expires_at FROM google_accounts`);
    expect(acc).toMatchObject({ watch_channel_id: ch.id, watch_resource_id: 'RID', watch_token_hash: hashToken(secret) });
    expect(new Date(acc.watch_expires_at).toISOString()).toBe(EXPIRA.toISOString());
  });

  it('al renovar cierra el canal anterior', async () => {
    await renew();
    const [{ watch_channel_id: viejo }] = await adminQuery(`SELECT watch_channel_id FROM google_accounts`);
    await adminQuery(`UPDATE google_accounts SET watch_expires_at = $1`, [new Date('2026-09-09T00:00:00Z')]);
    await renew();
    expect(google.stopChannel).toHaveBeenCalledWith('ya29.prueba', viejo, 'RID');
  });

  it('no renueva un canal que todavía tiene más de dos días', async () => {
    await renew();
    expect(await renew()).toBe('skipped');
    expect(google.watchEvents).toHaveBeenCalledTimes(1);
  });

  it('sin HTTPS no hay canal: quedan los sondeos cada 15 minutos', async () => {
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    expect(await renew()).toBe('skipped');
    expect(google.watchEvents).not.toHaveBeenCalled();
  });

  it('si falla, lo deja visible y lo audita una vez, no en cada intento', async () => {
    google.watchEvents.mockRejectedValue(new GoogleApiError('apertura del canal de avisos: Google respondió 400', 400));
    await expect(renew()).rejects.toThrow(/400/);
    await expect(renew()).rejects.toThrow(/400/);
    expect((await adminQuery(`SELECT watch_error FROM google_accounts`))[0].watch_error).toMatch(/400/);
    expect(await adminQuery(`SELECT action FROM audit_log`)).toEqual([{ action: 'calendar.watch_failed' }]);
  });
});
```
`apps/api/test/google/google-webhook.e2e.test.ts`:
```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { CalendarQueue } from '../../src/queues/calendar.queue';
import { hashToken } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

const CANAL = '6f1c1d1e-0b7a-4f0e-9a51-1b2c3d4e5f60';
let app: INestApplication;
let tenantId: string, accountId: string;
const queue = { add: vi.fn(), schedule: vi.fn(), onModuleDestroy: vi.fn() };
const notify = (headers: Record<string, string>) =>
  request(app.getHttpServer()).post('/webhooks/google').set(headers).send().expect(200);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CalendarQueue).useValue(queue).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
});
afterAll(async () => { await app.close(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  const { resourceId } = await seedCatalog(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  await adminQuery(`UPDATE google_accounts SET watch_channel_id = $1, watch_token_hash = $2`, [CANAL, hashToken('SECRETO')]);
  queue.add.mockClear();
});

describe('POST /webhooks/google', () => {
  it('un aviso de cambios de un canal propio encola la lectura de esa cuenta', async () => {
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': `${tenantId}.SECRETO`, 'X-Goog-Resource-State': 'exists' });
    expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'pull', data: { tenantId, accountId } }));
  });

  it('el aviso inicial "sync" no tiene cambios que leer', async () => {
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': `${tenantId}.SECRETO`, 'X-Goog-Resource-State': 'sync' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('un token equivocado, un canal ajeno o basura responden 200 sin encolar nada', async () => {
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': `${tenantId}.OTRO`, 'X-Goog-Resource-State': 'exists' });
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': 'no-es-un-uuid.SECRETO', 'X-Goog-Resource-State': 'exists' });
    await notify({});
    expect(queue.add).not.toHaveBeenCalled();
  });
});
```
En `apps/api/test/google/calendar-sweep.test.ts`, un `describe` más:
```ts
describe('CalendarSweep: lecturas y canales', () => {
  const of = async (name: string) => (await sweep.run(AHORA)).filter((j) => j.name === name);

  it('lee cada 15 minutos aunque no lleguen avisos', async () => {
    const acc = await seedGoogleAccount(tenantId, resourceId);
    expect(await of('pull')).toEqual([expect.objectContaining({ data: { tenantId, accountId: acc } })]);
    await adminQuery(`UPDATE google_accounts SET last_pulled_at = $1`, [new Date(AHORA.getTime() - 5 * 60_000)]);
    expect(await of('pull')).toEqual([]);
  });

  it('renueva el canal que vence en menos de dos días, solo con HTTPS', async () => {
    await seedGoogleAccount(tenantId, resourceId);
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    expect(await of('watch')).toEqual([]);
    process.env.PUBLIC_BASE_URL = 'https://citara.test';
    expect(await of('watch')).toHaveLength(1);
    await adminQuery(`UPDATE google_accounts SET watch_expires_at = $1`, [new Date('2026-09-20T00:00:00Z')]);
    expect(await of('watch')).toEqual([]);
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/google/calendar-pull.test.ts apps/api/test/google/calendar-watch.test.ts apps/api/test/google/google-webhook.e2e.test.ts apps/api/test/google/calendar-sweep.test.ts`
Expected: FAIL — no existen los módulos; el barrido no emite `pull` ni `watch`.

- [ ] **Step 3: La lectura de cambios**

`apps/api/src/google/calendar-pull.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource, type EntityManager } from 'typeorm';
import { GoogleApiError, GoogleAuthError, GoogleClient, type GoogleEvent } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { loadAccount, markCalendarMissing, markNeedsReauth, type GoogleAccount } from './accounts';
import { appointmentIdFromEventId } from './event-id';
import { RemindersService } from '../scheduling/reminders.service';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';
import type { AccountJob } from '../queues/calendar.queue';

const PG_EXCLUSION_VIOLATION = '23P01';
type Stats = { cancelled: number; moved: number; rejected: number };

/** Google → Citara (spec §7.3): lo que el dueño mueve o borra en el calendario "Citas". */
@Injectable()
export class CalendarPullProcessor {
  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
    private readonly reminders: RemindersService,
  ) {}

  async process(job: AccountJob, now = new Date()): Promise<Stats> {
    const stats: Stats = { cancelled: 0, moved: 0, rejected: 0 };
    const acc = await runInTenant(this.ds, job.tenantId, (m) => loadAccount(m, job.accountId));
    if (!acc || acc.status !== 'active' || !acc.calendarId) return stats;
    try {
      await this.readAll(acc, acc.calendarId, now, stats);
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await runInTenant(this.ds, acc.tenantId, (m) => markNeedsReauth(m, acc, err.message));
        return stats;
      }
      if (err instanceof GoogleApiError && err.status === 404) {
        await runInTenant(this.ds, acc.tenantId, (m) => markCalendarMissing(m, acc));
        return stats;
      }
      throw err;
    }
    return stats;
  }

  private async readAll(acc: GoogleAccount, calendarId: string, now: Date, stats: Stats): Promise<void> {
    let syncToken = acc.syncToken;
    let pageToken: string | null = null;
    let restarted = false;
    for (;;) {
      let page;
      try {
        page = await this.tokens.withToken(acc, (t) => this.google.listEvents(t, calendarId, { syncToken, pageToken }));
      } catch (err) {
        // 410: el syncToken venció. Se lee todo desde cero, una vez (aplicar es idempotente).
        if (err instanceof GoogleApiError && err.status === 410 && !restarted) {
          restarted = true; syncToken = null; pageToken = null;
          continue;
        }
        throw err;
      }
      await runInTenant(this.ds, acc.tenantId, async (m) => {
        for (const ev of page.items) await this.apply(m, acc, ev, now, stats);
      });
      if (page.nextPageToken) { pageToken = page.nextPageToken; continue; }
      await runInTenant(this.ds, acc.tenantId, (m) => m.query(
        `UPDATE google_accounts SET sync_token = $2, last_pulled_at = $3, updated_at = now() WHERE id = $1`,
        [acc.id, page.nextSyncToken, now]));
      return;
    }
  }

  private async apply(m: EntityManager, acc: GoogleAccount, ev: GoogleEvent, now: Date, stats: Stats): Promise<void> {
    const appointmentId = appointmentIdFromEventId(ev.id);
    if (!appointmentId) return;   // algo creado a mano en "Citas": no es una cita
    const [a] = await m.query(
      `SELECT id, status, starts_at, ends_at, google_sync_status FROM appointments
        WHERE id = $1 AND resource_id = $2 FOR UPDATE`, [appointmentId, acc.resourceId]);
    // Con un cambio local pendiente gana lo local: la subida pisa lo que haya en Google.
    if (!a || a.google_sync_status !== 'synced' || a.status !== 'confirmed') return;
    const audit = (action: string, details: Record<string, unknown>) =>
      recordAudit(m, { tenantId: acc.tenantId, actor: 'google', action, details: { appointmentId, ...details } });

    if (ev.status === 'cancelled') {
      await m.query(`UPDATE appointments SET status = 'cancelled', updated_at = now() WHERE id = $1`, [a.id]);
      await this.reminders.cancelFor(m, a.id);
      await audit('appointment.cancelled_in_google', {});
      stats.cancelled++;
      return;
    }

    // Pasada a "todo el día" no es una hora: se ignora.
    if (!ev.start?.dateTime || !ev.end?.dateTime) return;
    const start = new Date(ev.start.dateTime), end = new Date(ev.end.dateTime);
    if (!(end > start)) return;
    if (start.getTime() === new Date(a.starts_at).getTime() && end.getTime() === new Date(a.ends_at).getTime()) return;

    await m.query(`SAVEPOINT mover_desde_google`);
    try {
      await m.query(`UPDATE appointments SET starts_at = $2, ends_at = $3, updated_at = now() WHERE id = $1`,
                    [a.id, start, end]);
      await m.query(`RELEASE SAVEPOINT mover_desde_google`);
    } catch (err) {
      await m.query(`ROLLBACK TO SAVEPOINT mover_desde_google`);
      if ((err as { code?: string }).code !== PG_EXCLUSION_VIOLATION) throw err;
      // Choca con otra cita: no se aplica, y la hora de Citara vuelve a Google.
      await m.query(
        `UPDATE appointments SET google_sync_status = 'pending', google_sync_version = google_sync_version + 1
          WHERE id = $1`, [a.id]);
      await audit('appointment.move_rejected', { start: start.toISOString(), end: end.toISOString() });
      stats.rejected++;
      return;
    }
    await this.reminders.rescheduleFor(m, acc.tenantId, a.id, start, now);
    await audit('appointment.moved_in_google', { from: new Date(a.starts_at).toISOString(), to: start.toISOString() });
    stats.moved++;
  }
}
```

- [ ] **Step 4: Los canales de watch y el webhook**

`apps/api/src/google/calendar-watch.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { GoogleAuthError, GoogleClient } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { loadAccount, markNeedsReauth } from './accounts';
import { hashToken } from '../onboarding/links';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';
import type { AccountJob } from '../queues/calendar.queue';

/** Se renueva con dos días de margen: el job de renovación puede fallar un día entero. */
export const RENEW_BEFORE_MS = 2 * 86_400_000;
/** Lo que se pide; Google puede dar menos y se guarda la expiración que devuelve. */
const TTL_SECONDS = 30 * 86_400;

const publicBase = () => (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
/** Google solo avisa a direcciones HTTPS con certificado válido. En desarrollo, sondeo. */
export const watchEnabled = () => publicBase().startsWith('https://');

@Injectable()
export class CalendarWatchService {
  private readonly log = new Logger(CalendarWatchService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
  ) {}

  async renew(job: AccountJob, now = new Date()): Promise<'renewed' | 'skipped'> {
    if (!watchEnabled()) return 'skipped';
    const acc = await runInTenant(this.ds, job.tenantId, (m) => loadAccount(m, job.accountId));
    if (!acc || acc.status !== 'active' || !acc.calendarId) return 'skipped';
    if (acc.watchExpiresAt && acc.watchExpiresAt.getTime() - now.getTime() > RENEW_BEFORE_MS) return 'skipped';

    const channelId = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    let channel: { resourceId: string; expiration: Date };
    try {
      channel = await this.tokens.withToken(acc, (t) => this.google.watchEvents(t, acc.calendarId!, {
        // El negocio va en el token: el webhook lo resuelve sin saltarse RLS.
        id: channelId, token: `${acc.tenantId}.${secret}`,
        address: `${publicBase()}/webhooks/google`, ttlSeconds: TTL_SECONDS }));
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await runInTenant(this.ds, acc.tenantId, (m) => markNeedsReauth(m, acc, err.message));
        return 'skipped';
      }
      const message = (err as Error).message;
      await runInTenant(this.ds, acc.tenantId, async (m) => {
        // Se audita la primera falla; las siguientes solo actualizan el detalle.
        const [, first] = (await m.query(
          `UPDATE google_accounts SET watch_error = $2, updated_at = now() WHERE id = $1 AND watch_error IS NULL`,
          [acc.id, message])) as [unknown[], number];
        if (first) {
          await recordAudit(m, { tenantId: acc.tenantId, actor: 'google', action: 'calendar.watch_failed',
                                 details: { resourceId: acc.resourceId, error: message } });
        } else {
          await m.query(`UPDATE google_accounts SET watch_error = $2 WHERE id = $1`, [acc.id, message]);
        }
      });
      throw err;
    }

    await runInTenant(this.ds, acc.tenantId, (m) => m.query(
      `UPDATE google_accounts SET watch_channel_id = $2, watch_resource_id = $3, watch_token_hash = $4,
              watch_expires_at = $5, watch_error = NULL, updated_at = now()
        WHERE id = $1`, [acc.id, channelId, channel.resourceId, hashToken(secret), channel.expiration]));
    // El canal viejo se cierra después del nuevo: si esto falla, solo llegan avisos de más hasta que venza.
    if (acc.watchChannelId && acc.watchResourceId) {
      await this.tokens.withToken(acc, (t) => this.google.stopChannel(t, acc.watchChannelId!, acc.watchResourceId!))
        .catch((err: Error) => this.log.warn(`no se pudo cerrar el canal ${acc.watchChannelId}: ${err.message}`));
    }
    return 'renewed';
  }
}
```
`apps/api/src/google/google-webhook.controller.ts`:
```ts
import { Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { CalendarQueue } from '../queues/calendar.queue';
import { hashToken } from '../onboarding/links';
import { runInTenant } from '../tenancy/tenant-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ráfagas de avisos de la misma cuenta se juntan en una lectura cada 10 s. */
const PULL_BUCKET_MS = 10_000;

/**
 * Avisos de Google (`events.watch`). No traen el cambio: solo dicen "algo
 * cambió"; la lectura con syncToken trae qué. Siempre 200: un aviso que no es
 * nuestro no se arregla con reintentos de Google.
 */
@Controller('webhooks/google')
export class GoogleWebhookController {
  constructor(private readonly ds: DataSource, private readonly queue: CalendarQueue) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async notify(
    @Headers('x-goog-channel-id') channelId: string | undefined,
    @Headers('x-goog-channel-token') token: string | undefined,
    @Headers('x-goog-resource-state') state: string | undefined,
  ): Promise<void> {
    // 'sync' solo anuncia que el canal empezó a funcionar.
    if (state === 'sync' || !channelId || !token || !UUID.test(channelId)) return;
    const [tenantId, secret] = token.split('.');
    if (!tenantId || !secret || !UUID.test(tenantId)) return;
    const [acc] = await runInTenant(this.ds, tenantId, (m) => m.query(
      `SELECT id FROM google_accounts
        WHERE watch_channel_id = $1 AND watch_token_hash = $2 AND status = 'active'`,
      [channelId, hashToken(secret)]));
    if (!acc) return;
    await this.queue.add({ name: 'pull', data: { tenantId, accountId: acc.id },
                           jobId: `pull-${acc.id}-w${Math.floor(Date.now() / PULL_BUCKET_MS)}` });
  }
}
```

- [ ] **Step 5: Barrido y worker**

En `apps/api/src/google/calendar-sweep.service.ts`, al final de `forTenant` (antes del `return`), importando `RENEW_BEFORE_MS` y `watchEnabled`:
```ts
    // Google → Citara: además de los avisos, una lectura cada 15 minutos. Si el
    // canal de watch muere en silencio, los cambios igual llegan (spec §11).
    const accounts: { id: string; last_pulled_at: Date | null; watch_expires_at: Date | null }[] = await m.query(
      `SELECT id, last_pulled_at, watch_expires_at FROM google_accounts
        WHERE status = 'active' AND calendar_id IS NOT NULL`);
    const pullBucket = Math.floor(now.getTime() / PULL_EVERY_MS);
    const hourBucket = Math.floor(now.getTime() / 3_600_000);
    for (const a of accounts) {
      if (!a.last_pulled_at || now.getTime() - new Date(a.last_pulled_at).getTime() >= PULL_EVERY_MS) {
        out.push({ name: 'pull', data: { tenantId, accountId: a.id }, jobId: `pull-${a.id}-p${pullBucket}` });
      }
      if (watchEnabled() && (!a.watch_expires_at
          || new Date(a.watch_expires_at).getTime() - now.getTime() < RENEW_BEFORE_MS)) {
        out.push({ name: 'watch', data: { tenantId, accountId: a.id }, jobId: `watch-${a.id}-${hourBucket}` });
      }
    }
```
con `const PULL_EVERY_MS = 15 * 60_000;` arriba del archivo.

En `workers.ts`, el `switch` del worker de calendario gana:
```ts
      case 'pull': return pull.process(job.data as AccountJob);
      case 'watch': return watch.renew(job.data as AccountJob);
```
con `const pull = ctx.get(CalendarPullProcessor);` y `const watch = ctx.get(CalendarWatchService);`. En `app.module.ts`: `CalendarPullProcessor` y `CalendarWatchService` en `providers`, y `GoogleWebhookController` en `controllers`.

- [ ] **Step 6: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/google`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/google/calendar-pull.processor.ts apps/api/src/google/calendar-watch.service.ts apps/api/src/google/google-webhook.controller.ts apps/api/src/google/calendar-sweep.service.ts apps/api/src/queues/workers.ts apps/api/src/app.module.ts apps/api/test/google/calendar-pull.test.ts apps/api/test/google/calendar-watch.test.ts apps/api/test/google/google-webhook.e2e.test.ts apps/api/test/google/calendar-sweep.test.ts
git commit -m "feat(google): reflejar en citara las citas que el dueño mueve o borra en google"
```

---

### Task 7: La salud de cada conexión, a la vista del operador

**Files:**
- Create: `apps/api/src/google/calendar-health.processor.ts`
- Modify: `apps/api/src/google/calendar-sweep.service.ts`, `apps/api/src/queues/workers.ts`, `apps/api/src/app.module.ts`, `apps/api/src/cli/tenants.ts` (`listTenants`), `apps/api/src/cli/tenant-cli.ts`
- Test: `apps/api/test/google/calendar-health.test.ts`, `apps/api/test/google/calendar-sweep.test.ts`, `apps/api/test/cli/tenants.test.ts`

**Interfaces:**
- Consumes: `loadAccount`, `markNeedsReauth`, `attachNewCalendar` (Tasks 2-3), `GoogleTokens`, `GoogleClient.calendarExists`.
- Produces:
```ts
class CalendarHealthProcessor { process(job: AccountJob, now?: Date): Promise<'ok' | 'recreated' | 'needs_reauth' | 'skipped'> }
// TenantSummary.google: { resource: string; status: string; calendar: boolean;
//   watchExpiresAt: string | null; watchError: boolean; unsynced: number }[]
```
El chequeo diario (spec §7.3, "token muerto") fuerza una renovación del access token, que es la llamada barata que detecta un acceso revocado. Además:
- confirma que el calendario "Citas" existe y, si no, lo recrea y deja todo lo futuro pendiente de volver a subir;
- devuelve a `pending` lo que falló de forma permanente, una vez al día.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/google/calendar-health.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { GoogleAuthError } from '../../src/google/google.client';
import { CalendarHealthProcessor } from '../../src/google/calendar-health.processor';
import { resetDb, seedChannel, seedCatalog, seedContact, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, serviceId: string, resourceId: string, contactId: string, accountId: string;
let google: Record<'calendarExists' | 'createCalendar', ReturnType<typeof vi.fn>>;
let tokens: { withToken: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> };
let health: CalendarHealthProcessor;

const AHORA = new Date('2026-09-08T12:00:00Z');
const run = () => health.process({ tenantId, accountId }, AHORA);
const appointment = async (status: string, startsAt: string) => (await adminQuery(
  `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, google_sync_status)
   VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '30 minutes', $6) RETURNING id`,
  [tenantId, resourceId, serviceId, contactId, startsAt, status]))[0].id as string;
const status = async (id: string) =>
  (await adminQuery(`SELECT google_sync_status AS s FROM appointments WHERE id = $1`, [id]))[0].s;

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  contactId = await seedContact(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  google = { calendarExists: vi.fn().mockResolvedValue(true), createCalendar: vi.fn().mockResolvedValue('citas-nuevo@group') };
  tokens = { withToken: vi.fn((_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba')), invalidate: vi.fn() };
  health = new CalendarHealthProcessor(app, tokens as never, google as never);
});

describe('CalendarHealthProcessor', () => {
  it('una cuenta sana: renueva el token, deja constancia y reintenta lo fallido futuro', async () => {
    const futura = await appointment('failed', '2026-09-20T15:00:00Z');
    const vieja = await appointment('failed', '2026-09-01T15:00:00Z');

    expect(await run()).toBe('ok');

    expect(tokens.invalidate).toHaveBeenCalledWith(accountId);
    expect([await status(futura), await status(vieja)]).toEqual(['pending', 'failed']);
    const [acc] = await adminQuery(`SELECT last_checked_at FROM google_accounts`);
    expect(new Date(acc.last_checked_at).toISOString()).toBe(AHORA.toISOString());
  });

  it('un acceso revocado deja la cuenta para reconectar', async () => {
    tokens.withToken.mockRejectedValue(new GoogleAuthError('renovación del token: Google respondió invalid_grant'));
    expect(await run()).toBe('needs_reauth');
    expect(await adminQuery(`SELECT status FROM google_accounts`)).toEqual([{ status: 'needs_reauth' }]);
  });

  it('si el dueño borró el calendario "Citas", se recrea y lo futuro vuelve a subir', async () => {
    google.calendarExists.mockResolvedValue(false);
    const futura = await appointment('synced', '2026-09-20T15:00:00Z');

    expect(await run()).toBe('recreated');

    expect(google.createCalendar).toHaveBeenCalledWith('ya29.prueba', 'Citas · María', 'America/Bogota');
    expect(await adminQuery(`SELECT calendar_id FROM google_accounts`)).toEqual([{ calendar_id: 'citas-nuevo@group' }]);
    expect(await status(futura)).toBe('pending');
    expect((await adminQuery(`SELECT action FROM audit_log`)).map((a: { action: string }) => a.action))
      .toContain('calendar.created');
  });

  it('una cuenta sin calendario (lo detectó una subida) también lo recrea', async () => {
    await adminQuery(`UPDATE google_accounts SET calendar_id = NULL`);
    expect(await run()).toBe('recreated');
    expect(google.calendarExists).not.toHaveBeenCalled();
  });
});
```
En `apps/api/test/google/calendar-sweep.test.ts`, un `describe` más:
```ts
describe('CalendarSweep: chequeo de salud', () => {
  const health = async () => (await sweep.run(AHORA)).filter((j) => j.name === 'health');

  it('una vez al día por cuenta, y cada hora si le falta el calendario', async () => {
    const acc = await seedGoogleAccount(tenantId, resourceId);
    expect(await health()).toEqual([expect.objectContaining({ data: { tenantId, accountId: acc } })]);
    await adminQuery(`UPDATE google_accounts SET last_checked_at = $1`, [new Date(AHORA.getTime() - 3_600_000)]);
    expect(await health()).toEqual([]);
    await adminQuery(`UPDATE google_accounts SET calendar_id = NULL`);
    expect((await health())[0].jobId).toMatch(/-h\d+$/);
  });

  it('una cuenta que hay que reconectar no se chequea', async () => {
    await seedGoogleAccount(tenantId, resourceId, { status: 'needs_reauth' });
    expect(await health()).toEqual([]);
  });
});
```
En `apps/api/test/cli/tenants.test.ts`, importar `seedGoogleAccount` de `../helpers` y añadir:
```ts
  it('la lista muestra la conexión de Google de cada recurso', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await applyTenantConfig(admin, agenda);
    const [r] = await adminQuery(`SELECT id FROM resources WHERE key = 'maria'`);
    await seedGoogleAccount(tenantId, r.id, { status: 'needs_reauth' });

    const [t] = await listTenants(admin);
    expect(t.google).toEqual([{ resource: 'maria', status: 'needs_reauth', calendar: true,
                                watchExpiresAt: null, watchError: false, unsynced: 0 }]);
  });
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/google/calendar-health.test.ts apps/api/test/google/calendar-sweep.test.ts apps/api/test/cli/tenants.test.ts`
Expected: FAIL — no existe el procesador; el barrido no emite `health`; `t.google` es `undefined`.

- [ ] **Step 3: El chequeo**

`apps/api/src/google/calendar-health.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { GoogleAuthError, GoogleClient } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { attachNewCalendar, loadAccount, markNeedsReauth } from './accounts';
import { runInTenant } from '../tenancy/tenant-context';
import type { AccountJob } from '../queues/calendar.queue';

/** Chequeo diario de cada conexión (spec §7.3, "token muerto"). */
@Injectable()
export class CalendarHealthProcessor {
  constructor(
    private readonly ds: DataSource,
    private readonly tokens: GoogleTokens,
    private readonly google: GoogleClient,
  ) {}

  async process(job: AccountJob, now = new Date()): Promise<'ok' | 'recreated' | 'needs_reauth' | 'skipped'> {
    const acc = await runInTenant(this.ds, job.tenantId, (m) => loadAccount(m, job.accountId));
    if (!acc || acc.status !== 'active') return 'skipped';
    // Sin el access token en caché, la llamada fuerza una renovación: si el
    // dueño revocó el acceso, aparece aquí y no al agendar.
    this.tokens.invalidate(acc.id);
    let result: 'ok' | 'recreated' = 'ok';
    try {
      const exists = acc.calendarId
        ? await this.tokens.withToken(acc, (t) => this.google.calendarExists(t, acc.calendarId!))
        : false;
      if (!exists) {
        await this.tokens.withToken(acc, (t) => attachNewCalendar(this.ds, this.google, t, acc));
        result = 'recreated';
      }
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await runInTenant(this.ds, acc.tenantId, (m) => markNeedsReauth(m, acc, err.message));
        return 'needs_reauth';
      }
      throw err;
    }
    await runInTenant(this.ds, acc.tenantId, async (m) => {
      // Lo que Google rechazó de forma permanente se reintenta una vez al día.
      await m.query(
        `UPDATE appointments SET google_sync_status = 'pending', google_sync_version = google_sync_version + 1
          WHERE resource_id = $1 AND google_sync_status = 'failed' AND ends_at > $2`, [acc.resourceId, now]);
      await m.query(`UPDATE google_accounts SET last_checked_at = $2 WHERE id = $1`, [acc.id, now]);
    });
    return result;
  }
}
```

- [ ] **Step 4: Barrido, worker y lista**

En `calendar-sweep.service.ts`, al final de `forTenant` (antes del `return`; `hourBucket` es el de la Task 6):
```ts
    // Salud: una vez al día; cada hora si a la cuenta le falta el calendario.
    const checks: { id: string; last_checked_at: Date | null; calendar_id: string | null }[] = await m.query(
      `SELECT id, last_checked_at, calendar_id FROM google_accounts WHERE status = 'active'`);
    const dayBucket = now.toISOString().slice(0, 10).replace(/-/g, '');
    for (const c of checks) {
      if (!c.calendar_id) {
        out.push({ name: 'health', data: { tenantId, accountId: c.id }, jobId: `health-${c.id}-h${hourBucket}` });
      } else if (!c.last_checked_at || now.getTime() - new Date(c.last_checked_at).getTime() >= 86_400_000) {
        out.push({ name: 'health', data: { tenantId, accountId: c.id }, jobId: `health-${c.id}-${dayBucket}` });
      }
    }
```
En `workers.ts`: `case 'health': return health.process(job.data as AccountJob);` con `const health = ctx.get(CalendarHealthProcessor);`. En `app.module.ts`: `CalendarHealthProcessor` en `providers`.

En `apps/api/src/cli/tenants.ts`, `TenantSummary` gana:
```ts
  /** Por recurso conectado: estado, si tiene calendario, el canal de avisos y lo que no ha subido. */
  google: { resource: string; status: string; calendar: boolean; watchExpiresAt: string | null;
            watchError: boolean; unsynced: number }[];
```
el `SELECT` de `listTenants` gana la columna:
```sql
           (SELECT jsonb_agg(jsonb_build_object(
                     'resource', r.key, 'status', g.status, 'calendar', g.calendar_id IS NOT NULL,
                     'watchExpiresAt', g.watch_expires_at, 'watchError', g.watch_error IS NOT NULL,
                     'unsynced', (SELECT count(*) FROM appointments a
                                   WHERE a.resource_id = g.resource_id AND a.status = 'confirmed'
                                     AND a.google_sync_status <> 'synced' AND a.ends_at > now()))
                   ORDER BY r.key)
              FROM google_accounts g JOIN resources r ON r.id = g.resource_id
             WHERE g.tenant_id = t.id) AS google
```
y el `map` gana `google: r.google ?? []`.

En `apps/api/src/cli/tenant-cli.ts`:
```ts
/** "google maria ok · pedro RECONECTAR (3 sin subir)": lo que el operador tiene que mirar. */
const fmtGoogle = (google: TenantSummary['google']) => {
  if (!google.length) return 'google —';
  return 'google ' + google.map((g) => {
    const state = g.status === 'needs_reauth' ? 'RECONECTAR' : !g.calendar ? 'SIN CALENDARIO' : 'ok';
    const watch = g.watchError ? ' avisos FALLAN'
      : g.watchExpiresAt && new Date(g.watchExpiresAt) < new Date() ? ' avisos VENCIDOS' : '';
    const unsynced = g.unsynced ? ` (${g.unsynced} sin subir)` : '';
    return `${g.resource} ${state}${watch}${unsynced}`;
  }).join(' · ');
};
```
y la línea de `list` incluye `fmtGoogle(t.google)` después de `fmtSyncs(t.syncs)`.

- [ ] **Step 5: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/google apps/api/test/cli`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/google/calendar-health.processor.ts apps/api/src/google/calendar-sweep.service.ts apps/api/src/queues/workers.ts apps/api/src/app.module.ts apps/api/src/cli/tenants.ts apps/api/src/cli/tenant-cli.ts apps/api/test/google/calendar-health.test.ts apps/api/test/google/calendar-sweep.test.ts apps/api/test/cli/tenants.test.ts
git commit -m "feat(google): vigilar cada conexión a diario y mostrarla en la lista de negocios"
```

---

### Task 8: De punta a punta, runbook y spec

**Files:**
- Create: `apps/api/test/google/google.e2e.test.ts`
- Modify: `docs/desarrollo-local.md`, `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md`

**Interfaces:**
- Consumes: todo lo anterior, con `MetaSender` y `GoogleClient` de mentira, `startWorkers` y Redis reales.

- [ ] **Step 1: Escribir el test de punta a punta**

`apps/api/test/google/google.e2e.test.ts`:
```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import type { OutboundContent } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { AppModule } from '../../src/app.module';
import { MetaSender } from '../../src/whatsapp/sender';
import { GoogleClient } from '../../src/google/google.client';
import { googleEventId } from '../../src/google/event-id';
import { CalendarSweep } from '../../src/google/calendar-sweep.service';
import { CALENDAR_QUEUE, CalendarQueue } from '../../src/queues/calendar.queue';
import { startWorkers } from '../../src/queues/workers';
import { INBOUND_QUEUE } from '../../src/queues/inbound.queue';
import { OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';
import { SYNC_QUEUE } from '../../src/queues/sync.queue';
import { REMINDERS_QUEUE } from '../../src/queues/reminders.queue';
import { CLOCK } from '../../src/clock';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { createLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow, adminQuery, closeHelpers } from '../helpers';

/**
 * Google Calendar de punta a punta, con todo real menos Meta y Google: el
 * recurso conecta su calendario, un cliente agenda por WhatsApp sin que se le
 * ofrezca lo ocupado en Google, la cita sube al calendario "Citas", y cuando
 * el dueño la borra allí, Citara la cancela.
 */
/** Lunes 7 de septiembre, 22:00 en Bogotá: la primera franja del martes es 09:00. */
const AGENDA_NOW = new Date('2026-09-08T03:00:00Z');
const CAL = 'citas-e2e@group.calendar.google.com';

let app: INestApplication, admin: DataSource, workers: { close: () => Promise<void> }, queues: Queue[];
const sent: string[] = [];
let changes: object[] = [];
const fakeSender = { async send(_c: unknown, _to: string, content: OutboundContent) {
  sent.push('body' in content ? content.body : `[plantilla ${content.name}]`); return { wamid: `wamid.g.${sent.length}` }; } };
const google = {
  authUrl: vi.fn((s: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${s}`),
  exchangeCode: vi.fn().mockResolvedValue({ accessToken: 'ya29.e2e', expiresIn: 3599, refreshToken: '1//e2e',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created',
             'https://www.googleapis.com/auth/calendar.freebusy'], email: 'maria@gmail.com' }),
  refreshAccessToken: vi.fn().mockResolvedValue({ accessToken: 'ya29.e2e', expiresIn: 3599 }),
  calendarExists: vi.fn().mockResolvedValue(true),
  createCalendar: vi.fn().mockResolvedValue(CAL),
  // María tiene algo personal el martes de 09:00 a 10:00 (Bogotá) en su calendario principal.
  freeBusy: vi.fn().mockResolvedValue([{ start: new Date('2026-09-08T14:00:00Z'), end: new Date('2026-09-08T15:00:00Z') }]),
  insertEvent: vi.fn().mockResolvedValue('created'),
  patchEvent: vi.fn(), deleteEvent: vi.fn(),
  listEvents: vi.fn(async () => ({ items: changes, nextPageToken: null, nextSyncToken: 'S1' })),
  watchEvents: vi.fn().mockResolvedValue({ resourceId: 'RID', expiration: new Date('2026-10-08T00:00:00Z') }),
  stopChannel: vi.fn(),
};

const sign = (b: object) => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(JSON.stringify(b)).digest('hex');
const say = (wamid: string, text: string) => {
  const b = { object: 'whatsapp_business_account', entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
  } }] }] };
  return request(app.getHttpServer()).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(b)).send(b).expect(200);
};
async function quiesce() {
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 150; i++) {
    const counts = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
    if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('las colas no se vaciaron');
}
const sweep = async () => {
  for (const j of await app.get(CalendarSweep).run(AGENDA_NOW)) await app.get(CalendarQueue).add(j);
  await quiesce();
};

beforeAll(async () => {
  process.env.PUBLIC_BASE_URL = 'https://citara.test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaSender).useValue(fakeSender)
    .overrideProvider(GoogleClient).useValue(google)
    .overrideProvider(CLOCK).useValue({ now: () => AGENDA_NOW })
    .compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  queues = [INBOUND_QUEUE, OUTBOUND_QUEUE, SYNC_QUEUE, REMINDERS_QUEUE, CALENDAR_QUEUE]
    .map((n) => new Queue(n, { connection: { url: process.env.REDIS_URL } }));
  for (const q of queues) await q.obliterate({ force: true });
  await resetDb();
  workers = startWorkers(app, { concurrency: 5, scheduleReminders: false, scheduleCalendar: false });
});
afterAll(async () => {
  await workers.close();
  for (const q of queues) { await q.obliterate({ force: true }); await q.close(); }
  await app.close(); await admin.destroy(); await closeHelpers();
  process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
});

describe('Google Calendar de punta a punta', () => {
  it('conectar → no ofrecer lo ocupado → subir la cita → borrarla en Google la cancela', async () => {
    const { tenantId } = await seedChannel();
    const { resourceId } = await seedCatalog(tenantId);
    await seedHours(tenantId);
    await seedFlow(tenantId, AGENDA_FLOW);

    // El recurso conecta su calendario desde el enlace.
    const token = await createLink(admin, tenantId, 'google', { resourceId });
    await request(app.getHttpServer()).get('/connect/google/callback').query({ state: token, code: 'CODIGO' }).expect(200);

    // Un cliente agenda por WhatsApp: el martes a las 09:00 está ocupado en Google.
    let n = 0;
    for (const text of ['Hola', 'agendar', '1', '1', '1', 'Ana']) { await say(`wamid.G${n++}`, text); await quiesce(); }
    const [cita] = await adminQuery(`SELECT id, starts_at FROM appointments`);
    expect(new Date(cita.starts_at).toISOString()).toBe('2026-09-08T15:00:00.000Z');   // 10:00

    // El barrido sube la cita y abre el canal de avisos.
    await sweep();
    expect(google.insertEvent).toHaveBeenCalledWith('ya29.e2e', CAL, googleEventId(cita.id), expect.any(Object));
    expect(await adminQuery(`SELECT google_sync_status FROM appointments`)).toEqual([{ google_sync_status: 'synced' }]);
    const [{ id: channelId, token: channelToken }] = google.watchEvents.mock.calls.at(-1)!.slice(2) as
      [{ id: string; token: string }];

    // El dueño la borra en Google y Google avisa.
    changes = [{ id: googleEventId(cita.id), status: 'cancelled' }];
    await request(app.getHttpServer()).post('/webhooks/google')
      .set({ 'X-Goog-Channel-ID': channelId, 'X-Goog-Channel-Token': channelToken, 'X-Goog-Resource-State': 'exists' })
      .send().expect(200);
    await quiesce();

    expect(await adminQuery(`SELECT status FROM appointments`)).toEqual([{ status: 'cancelled' }]);
    expect(await adminQuery(`SELECT DISTINCT status FROM reminders`)).toEqual([{ status: 'cancelled' }]);
  });
});
```

- [ ] **Step 2: Correrlo**

Run: `pnpm test apps/api/test/google/google.e2e.test.ts`
Expected: PASS si las tareas 1-7 están bien cableadas (providers, worker, controladores). Si falla, el defecto está en el cableado: depurarlo, no ajustar el test.

- [ ] **Step 3: El runbook**

En `docs/desarrollo-local.md`, antes de `## Coexistencia (Fase 1.5)`:
````markdown
## Google Calendar (Fase 4)

Cada recurso (la estilista, el médico) conecta su propia cuenta de Google. Citara crea en
ella un calendario **«Citas · <recurso>»** donde pone las citas, y consulta su calendario
principal solo para saber cuándo está ocupado (sin leer el contenido de sus eventos).

### Antes del primer cliente (una sola vez)

1. Proyecto en Google Cloud con la **Calendar API** habilitada.
2. Pantalla de consentimiento OAuth con política de privacidad en el dominio propio, y los
   scopes `openid`, `email`, `calendar.app.created` y `calendar.freebusy`. Son sensibles:
   hay que solicitar la verificación (con video). Mientras tanto, en modo *testing* y con
   usuarios de prueba, **el acceso vence a los 7 días** y hay que reconectar.
3. Cliente OAuth de tipo "Aplicación web" con la URI de redirección
   `${PUBLIC_BASE_URL}/connect/google/callback`. Su ID y su secreto van en `GOOGLE_CLIENT_ID`
   y `GOOGLE_CLIENT_SECRET`.

### Cada recurso

```bash
pnpm tenant google peluqueria-ana maria
```

Imprime un enlace de un solo uso para ese recurso (vence en 72 h; uno nuevo anula el
anterior). La persona lo abre, entra con su cuenta de Google y acepta **todos** los permisos.
Lo que ya estaba agendado sube a su calendario en el siguiente minuto.

### Qué pasa después

- Lo ocupado en su calendario principal deja de ofrecerse por WhatsApp. Si Google no
  responde, se ofrecen las franjas según Citara: el sistema sigue agendando.
- Cada cita nueva, movida o cancelada se refleja en «Citas» en menos de un minuto.
- Si el dueño **borra o mueve** una cita en «Citas», Citara la cancela o la mueve (y sus
  recordatorios). Al cliente no se le escribe. Si la mueve encima de otra cita, no se aplica y
  vuelve a su hora en Google. Todo queda en `audit_log` con `actor = 'google'`.
- Los avisos de Google (`events.watch`) exigen `PUBLIC_BASE_URL` con HTTPS. Sin HTTPS (en
  desarrollo), los cambios se leen cada 15 minutos.

`pnpm tenant list` muestra, por recurso, `ok`, `RECONECTAR` (revocó el acceso o venció el
modo *testing*: mándale `pnpm tenant google ...` de nuevo), `SIN CALENDARIO` (lo borró; se
recrea solo en menos de una hora), `avisos FALLAN` o `avisos VENCIDOS`, y cuántas citas
faltan por subir.
````

- [ ] **Step 4: El spec**

En `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md`:
- Cabecera: `**Versión:** 2.1 (2026-10-08) · v2: 2026-10-06 · v1: 2026-09-03`.
- `## Registro de cambios` gana, arriba de **v2**:
```markdown
**v2.1 (2026-10-08)** — al planear la Fase 4
- **Google Calendar en un calendario aparte.** Citara crea un calendario «Citas · <recurso>»
  en la cuenta de cada recurso (`calendar.app.created`) y consulta el principal solo como
  ocupado (`calendar.freebusy`). Permisos mínimos y sin mezclar eventos (§4.1, §7.3).
- **Cambios del dueño en Google:** se reflejan en Citara (cita y recordatorios) sin
  escribirle al cliente final (§7.3).
- **Cola `calendar`** propia, separada de `sync` (§3.4).
```
- §3.4: la fila de `sync` pasa a `| \`sync\` | Historial y contactos de coexistencia |` y se añade `| \`calendar\` | Google Calendar: subir citas, leer cambios, renovar canales de \`watch\`, salud de las conexiones |`.
- §4.1, la línea de `google_accounts` pasa a:
```markdown
- `google_accounts`: **una por `resource`**, con refresh token cifrado, `calendar_id` (el
  calendario «Citas» que crea la app), `sync_token`, canal de `watch` y estado
  (`active` | `needs_reauth`)
```
- §7.3, antes de **Orden.**:
```markdown
**Calendario aparte.** Las citas viven en un calendario secundario «Citas · <recurso>» que
crea la app; el calendario principal de la persona solo se consulta con `freeBusy` para no
ofrecer lo que tiene ocupado (con timeout corto y degradación a solo-Citara). Así las citas
propias nunca cuentan dos veces como ocupado y la sincronización inversa solo ve eventos
de citas.

**Cambios del dueño.** Si borra o mueve una cita en «Citas», se cancela o se mueve en
Citara con sus recordatorios, sin escribirle al cliente. Un cambio local pendiente gana
sobre lo leído de Google, y un movimiento que choca con otra cita no se aplica: la hora de
Citara vuelve a Google.
```
- §10, la fila de la Fase 4: estado `Plan escrito (2026-10-08)`.

- [ ] **Step 5: Correr todo**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/google/google.e2e.test.ts docs/desarrollo-local.md docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md
git commit -m "feat(google): verificar google calendar de punta a punta y documentar la operación"
```

---

## Criterios de salida de la Fase 4

- [ ] `pnpm test` y `pnpm typecheck` en verde. El guardia de privilegios sigue cerrado: `google_accounts` con RLS y sin DELETE para la app.
- [ ] Un recurso conecta su Google Calendar desde un enlace; el refresh token queda cifrado y se crea «Citas · <recurso>».
- [ ] Una cita agendada por WhatsApp aparece en «Citas» con el id derivado de la cita; reintentar no duplica el evento.
- [ ] Lo ocupado en el calendario principal no se ofrece; con Google caído se sigue agendando.
- [ ] Borrar o mover la cita en Google la cancela o la mueve en Citara, con sus recordatorios.
- [ ] Revocar el acceso deja la cuenta en `needs_reauth` en menos de 24 h, visible en `pnpm tenant list`, sin impedir agendar.
- [ ] **Con el proyecto de Google Cloud:** una cuenta real se conecta y se verifica lo marcado VERIFICAR (scopes de `events.list`/`delete`, `patch` sobre un evento borrado, rango de `freeBusy`).

## Lo que esta fase deliberadamente NO hace

- **Escribirle al cliente cuando el dueño cancela o mueve en Google** (decisión 2). Si se quiere después, necesita plantillas aprobadas para fuera de la ventana de 24 h.
- **Bloquear horarios con eventos creados a mano dentro de «Citas»:** solo el calendario principal cuenta como ocupado.
- **Cambiar de cuenta de Google sin reconectar,** ni desconectar un recurso desde la CLI (basta con revocar el acceso desde la cuenta de Google; la cuenta queda `needs_reauth`).
- **Avisar al operador por un canal propio:** `pnpm tenant list` y `audit_log` lo muestran; el aviso activo es del panel (Fase 6).
- **Varios calendarios principales por persona** (trabajo y personal): `freeBusy` consulta solo el principal.
