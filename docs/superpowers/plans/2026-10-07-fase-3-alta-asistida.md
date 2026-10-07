# Fase 3 — Alta asistida: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el operador dé de alta a un cliente real sin tocar SQL: crea el negocio, le manda un enlace, el cliente conecta su número de WhatsApp Business en coexistencia con el Embedded Signup de Meta, y el negocio queda operando en cuanto tiene canal, agenda y flujo.

**Architecture:** El negocio nace en `onboarding` y no responde hasta estar completo; suspenderlo lo saca de operación al instante. El operador trabaja con una CLI (`pnpm tenant ...`) sobre la conexión admin. El cliente solo abre un **enlace firmado de un solo uso** (`onboarding_links`, se guarda el hash) que sirve una página mínima con el Embedded Signup **v4**; la API canjea el código, suscribe la app a la cuenta, registra el canal y pide a Meta la sincronización de contactos e historial. La aplicación no gana privilegios de escritura sobre `whatsapp_channels` ni `tenants`: registrar un canal y activar un negocio pasan por dos funciones `SECURITY DEFINER` acotadas.

**Tech Stack:** lo de las fases anteriores. Sin dependencias nuevas. Facebook JS SDK en la página de conexión (cargado del CDN de Meta).

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md` (v2) — §8 alta asistida, §5.1 `account_update`, §11 riesgos.

**Verificado contra fuentes (2026-10-07):** Embedded Signup v2 se depreca el **15 de octubre de 2026**; se construye sobre v4 (configuración de Facebook Login for Business, `config_id`). Para coexistencia: `extras.featureType = 'whatsapp_business_app_onboarding'`, `sessionInfoVersion: '3'`; el evento de fin es `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` y trae `waba_id` (el `phone_number_id` se consulta a `/{waba_id}/phone_numbers`); la sincronización es `POST /{phone_number_id}/smb_app_data` con `sync_type` `smb_app_state_sync` y `history`, **una vez cada una, dentro de 24 h**; `account_update` trae `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED` y `ACCOUNT_RECONNECTED`. Fuentes: documentación de Meta "Onboard WhatsApp Business app users" (vía referencias de terceros: la página de Meta no responde desde el entorno de desarrollo) y la guía de migración a v4 de UnifyPort. **Se re-verifica en la consola de Meta al crear la configuración.**

## Global Constraints

- Todo lo de las fases 1, 1.5 y 2 sigue vigente (RLS, `TZ=UTC`, outbox, regla de control, servicios Nest con imports de valor, providers registrados en la tarea que los crea, `[filas, conteo]` de TypeORM, `PRESUPUESTO` cerrado, migraciones con `import type` y `'../rls.ts'`).
- **La aplicación (`citara_app`) no gana INSERT/UPDATE sobre `whatsapp_channels` ni `tenants`.** Lo que necesita escribir allí pasa por funciones `SECURITY DEFINER` con su validación adentro.
- **El token de Meta y el secreto de la app jamás aparecen en logs, errores ni respuestas HTTP.** El token se guarda cifrado con `EncryptionService`.
- **Los enlaces de conexión son de un solo uso, vencen (72 h por defecto) y solo se guarda su hash SHA-256.** Un negocio suspendido no puede usar sus enlaces.
- **Un negocio que no está `active` guarda lo que llega y no responde.** Pasa de `onboarding` a `active` solo cuando tiene canal activo, un servicio activo, horario y flujo por defecto. Suspender nunca se revierte solo.
- **La página de conexión no se cachea, no envía `Referer` (el token va en la URL) y escapa todo lo que inyecta.**
- Commits: Conventional Commits en español, un solo `-m`, sin cuerpo ni `Co-Authored-By`; `git add` con rutas explícitas.

## Review Focus

1. **Doble clic en "Conectar" o el mismo enlace abierto dos veces:** solo un alta gana; la otra recibe "enlace ya no válido" y no se registra un segundo canal. → Task 6.
2. **Cuenta de Meta con varios números y sin `phone_number_id` en la sesión:** error claro, y el enlace sigue sirviendo para reintentar. → Task 5.
3. **Meta falla al pedir la sincronización:** el alta no se pierde (canal guardado) y el operador puede reintentar con `pnpm tenant sync`. → Tasks 5 y 7.
4. **Enlace de un negocio suspendido:** no sirve. → Task 2.
5. **Nombre del negocio con HTML** (`<script>`): la página lo muestra escapado. → Task 6.

---

## File Structure

```
packages/db/src/migrations/
├─ 1725500000000-AddStatusCheckToTenants.ts
├─ 1725500100000-CreateOnboardingLinks.ts
└─ 1725500200000-CreateOnboardingFunctions.ts     register_channel(), refresh_tenant_status()
apps/api/src/onboarding/
├─ links.ts                         createLink / peekLink / consumeLink
├─ meta-onboarding.client.ts        canje del código, números, suscripción, sincronización
├─ onboarding.service.ts            completeWhatsapp(), requestSyncs()
├─ connect-page.ts                  HTML de la página de conexión (escapado)
└─ connect.controller.ts            GET /connect/whatsapp, POST /connect/whatsapp/complete
apps/api/src/cli/
├─ tenants.ts                       createTenant / newLink / setSuspended / listTenants / syncTenant
└─ tenant-cli.ts                    pnpm tenant <create|link|suspend|resume|list|sync>
apps/api/test/onboarding/*.test.ts
```

---

## Tareas

### Task 1: Un negocio que no está activo no responde

**Files:**
- Create: `packages/db/src/migrations/1725500000000-AddStatusCheckToTenants.ts`
- Modify: `apps/api/src/conversations/control.ts` (`readControl` devuelve `tenantStatus`)
- Modify: `apps/api/src/flow-engine/flow-runner.service.ts` (la puerta)
- Test: `apps/api/test/flow-engine/flow-runner.test.ts`, `apps/api/test/conversations/control.test.ts`

**Interfaces:**
- Produces: `tenants.status IN ('onboarding', 'active', 'suspended')`; `readControl(...)` → `ControlState & { channelStatus: string; tenantStatus: string }`.

- [ ] **Step 1: Escribir los tests que fallan**

Al final del `describe('FlowRunner', ...)` de `apps/api/test/flow-engine/flow-runner.test.ts`:
```ts
  it('un negocio en alta o suspendido guarda lo que llega pero no responde', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    for (const [i, status] of ['onboarding', 'suspended'].entries()) {
      await adminQuery(`UPDATE tenants SET status = $1`, [status]);
      expect(await say(`wamid.ST${i}`, 'Hola')).toEqual([]);
    }
    expect(jobs).toEqual([]);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    expect(n).toBe(2);
  });
```
En `apps/api/test/conversations/control.test.ts`, el test `'lee el estado del canal junto con el control'` pasa a:
```ts
  it('lee el estado del canal y del negocio junto con el control', async () => {
    const c = await control();
    expect([c.channelStatus, c.tenantStatus]).toEqual(['active', 'active']);
  });

  it('el estado de un negocio solo puede ser onboarding, active o suspended', async () => {
    await expect(adminQuery(`UPDATE tenants SET status = 'borrado'`)).rejects.toThrow(/check/i);
  });
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/flow-engine/flow-runner.test.ts apps/api/test/conversations/control.test.ts`
Expected: FAIL — el bot responde con el negocio en alta; `tenantStatus` es `undefined`; el UPDATE a `'borrado'` no falla.

- [ ] **Step 3: Implementar**

`packages/db/src/migrations/1725500000000-AddStatusCheckToTenants.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Ciclo de vida del negocio (spec §8): nace en alta, opera activo, se suspende. */
export class AddStatusCheckToTenants1725500000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
        CHECK (status IN ('onboarding', 'active', 'suspended'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tenants DROP CONSTRAINT tenants_status_check`);
  }
}
```
En `apps/api/src/conversations/control.ts`, `readControl`:
```ts
export async function readControl(
  m: EntityManager, conversationId: string,
): Promise<ControlState & { channelStatus: string; tenantStatus: string }> {
  const [row] = await m.query(
    `SELECT c.control, c.human_until, c.control_reason, ch.status AS channel_status, t.status AS tenant_status
       FROM conversations c
       JOIN whatsapp_channels ch ON ch.id = c.channel_id
       JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = $1`,
    [conversationId],
  );
  if (!row) throw new Error(`Conversación ${conversationId} no encontrada`);
  return {
    control: row.control,
    humanUntil: row.human_until ? new Date(row.human_until) : null,
    reason: row.control_reason,
    channelStatus: row.channel_status,
    tenantStatus: row.tenant_status,
  };
}
```
En `apps/api/src/flow-engine/flow-runner.service.ts`, la puerta pasa a:
```ts
      // En alta (sin agenda completa) o suspendido: se guarda lo que llega y
      // no se responde. Igual con el canal desconectado o un humano al mando.
      if (control.tenantStatus !== 'active' || control.channelStatus === 'disconnected'
          || humanInControl(control, now)) {
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm typecheck && pnpm test apps/api/test/flow-engine apps/api/test/conversations packages/db/test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/1725500000000-AddStatusCheckToTenants.ts apps/api/src/conversations/control.ts apps/api/src/flow-engine/flow-runner.service.ts apps/api/test/flow-engine/flow-runner.test.ts apps/api/test/conversations/control.test.ts
git commit -m "feat(tenancy): no responder mientras el negocio está en alta o suspendido"
```

---

### Task 2: Enlaces de conexión firmados y de un solo uso

**Files:**
- Create: `packages/db/src/migrations/1725500100000-CreateOnboardingLinks.ts`
- Create: `apps/api/src/onboarding/links.ts`
- Modify: `packages/db/test/rls-inventory.test.ts`, `apps/api/test/helpers.ts` (`resetDb`)
- Test: `apps/api/test/onboarding/links.test.ts`

**Interfaces:**
- Produces: tabla `onboarding_links` (`id, tenant_id, purpose ('whatsapp'|'google'), token_hash, expires_at, used_at, created_at`), sin RLS (se resuelve antes de conocer el negocio), la app con `SELECT` y `UPDATE (used_at)`.
```ts
export type LinkPurpose = 'whatsapp' | 'google';
export function hashToken(token: string): string;
export function createLink(admin: DataSource | EntityManager, tenantId: string, purpose: LinkPurpose, ttlHours?: number): Promise<string>;
export interface ValidLink { linkId: string; tenantId: string; tenantName: string }
export function peekLink(db: DataSource | EntityManager, token: string, purpose: LinkPurpose): Promise<ValidLink | null>;
export function consumeLink(db: DataSource | EntityManager, linkId: string): Promise<boolean>;
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/links.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { consumeLink, createLink, hashToken, peekLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource;
let tenantId: string;

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('enlaces de conexión', () => {
  it('un enlace recién creado es válido para su propósito y trae el nombre del negocio', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    expect(await peekLink(app, token, 'whatsapp')).toMatchObject({ tenantId, tenantName: 'Salón X' });
    expect(await peekLink(app, token, 'google')).toBeNull();
  });

  it('solo se guarda el hash del token', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    const [row] = await adminQuery(`SELECT token_hash FROM onboarding_links`);
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toContain(token);
  });

  it('se usa una sola vez: de dos usos, solo uno gana', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    const link = (await peekLink(app, token, 'whatsapp'))!;
    const results = await Promise.all([consumeLink(app, link.linkId), consumeLink(app, link.linkId)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
  });

  it('un enlace vencido no sirve', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    await adminQuery(`UPDATE onboarding_links SET expires_at = now() - interval '1 minute'`);
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
  });

  it('un negocio suspendido no puede usar sus enlaces', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    await adminQuery(`UPDATE tenants SET status = 'suspended'`);
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
  });

  it('la aplicación no puede crear enlaces', async () => {
    await expect(app.query(
      `INSERT INTO onboarding_links (tenant_id, purpose, token_hash, expires_at) VALUES ($1, 'whatsapp', 'x', now())`,
      [tenantId])).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/onboarding/links.test.ts`
Expected: FAIL — no existe `onboarding/links`.

- [ ] **Step 3: La migración y el guardia**

`packages/db/src/migrations/1725500100000-CreateOnboardingLinks.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enlaces de un solo uso que el operador le manda al cliente para conectar su
 * WhatsApp (y, en la Fase 4, Google Calendar). Sin RLS: se resuelven por el
 * token antes de saber de qué negocio son. Por eso la app solo puede leerlos y
 * marcarlos usados; crearlos es del operador (conexión admin).
 */
export class CreateOnboardingLinks1725500100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE onboarding_links (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        purpose    varchar(16) NOT NULL CHECK (purpose IN ('whatsapp', 'google')),
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at    timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON onboarding_links FROM citara_app`);
    await q.query(`GRANT SELECT ON onboarding_links TO citara_app`);
    await q.query(`GRANT UPDATE (used_at) ON onboarding_links TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE onboarding_links`);
  }
}
```
En `packages/db/test/rls-inventory.test.ts`:
- `EXENTAS_DE_RLS` gana:
```ts
  // Enlaces de conexión: se resuelven por el token antes de conocer el negocio.
  'onboarding_links',
```
- `PRESUPUESTO` gana `onboarding_links: ['SELECT'],`
- y un test al final del `describe`:
```ts
  it('sobre onboarding_links la app solo puede marcar el enlace como usado', async () => {
    const cols: { column_name: string }[] = await ds.query(`
      SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'onboarding_links'
         AND grantee = 'citara_app' AND privilege_type = 'UPDATE'`);
    expect(cols.map((c) => c.column_name)).toEqual(['used_at']);
  });
```
En `apps/api/test/helpers.ts`, añadir `onboarding_links` al principio del `TRUNCATE` de `resetDb`.

- [ ] **Step 4: Los enlaces**

`apps/api/src/onboarding/links.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

export type LinkPurpose = 'whatsapp' | 'google';
type Db = DataSource | EntityManager;
const DEFAULT_TTL_HOURS = 72;

/** Solo se guarda el hash: con la tabla filtrada, nadie puede rearmar los enlaces. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Crea un enlace de un solo uso (conexión admin). Devuelve el token en claro: es lo que va en la URL. */
export async function createLink(
  admin: Db, tenantId: string, purpose: LinkPurpose, ttlHours = DEFAULT_TTL_HOURS,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await admin.query(
    `INSERT INTO onboarding_links (tenant_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [tenantId, purpose, hashToken(token), ttlHours]);
  return token;
}

export interface ValidLink { linkId: string; tenantId: string; tenantName: string }

/** Válido: del propósito pedido, sin usar, sin vencer y de un negocio no suspendido. */
export async function peekLink(db: Db, token: string, purpose: LinkPurpose): Promise<ValidLink | null> {
  const [row] = await db.query(
    `SELECT l.id, l.tenant_id, t.name
       FROM onboarding_links l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.token_hash = $1 AND l.purpose = $2 AND l.used_at IS NULL
        AND l.expires_at > now() AND t.status <> 'suspended'`,
    [hashToken(token), purpose]);
  return row ? { linkId: row.id, tenantId: row.tenant_id, tenantName: row.name } : null;
}

/** Lo marca usado de forma atómica: de dos usos simultáneos, solo uno gana. */
export async function consumeLink(db: Db, linkId: string): Promise<boolean> {
  // Con UPDATE, TypeORM devuelve [filas, conteo].
  const [, affected] = (await db.query(
    `UPDATE onboarding_links SET used_at = now()
      WHERE id = $1 AND used_at IS NULL AND expires_at > now()`, [linkId])) as [unknown[], number];
  return affected > 0;
}
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/onboarding/links.test.ts packages/db/test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/migrations/1725500100000-CreateOnboardingLinks.ts packages/db/test/rls-inventory.test.ts apps/api/src/onboarding/links.ts apps/api/test/helpers.ts apps/api/test/onboarding/links.test.ts
git commit -m "feat(onboarding): crear enlaces de conexión firmados de un solo uso"
```

---

### Task 3: Registrar un canal y activar un negocio sin dar privilegios a la app

**Files:**
- Create: `packages/db/src/migrations/1725500200000-CreateOnboardingFunctions.ts`
- Test: `apps/api/test/onboarding/functions.test.ts`

**Interfaces:**
- Produces (SQL, ejecutables por `citara_app`):
  - `register_channel(p_tenant uuid, p_waba text, p_phone text, p_display text, p_token bytea, p_mode text) RETURNS uuid` — crea o actualiza el canal del negocio; rechaza un número de otro negocio; en `coexistence` deja `history_sync = 'pending'`.
  - `refresh_tenant_status(p_tenant uuid) RETURNS text` — pasa `onboarding` → `active` si hay canal activo, servicio activo, horario y flujo por defecto; nunca toca un `suspended`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/functions.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { DEMO_FLOW } from '../../src/cli/provision';
import { resetDb, seedCatalog, seedHours, seedFlow, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string;

const register = (phone = '106999', tenant = tenantId, token = Buffer.from('cifrado')) =>
  runInTenant(app, tenant, (m) => m.query(
    `SELECT register_channel($1, '777', $2, '+57 300 000 0000', $3, 'coexistence') AS id`, [tenant, phone, token]));
const refresh = () => runInTenant(app, tenantId, (m) => m.query(`SELECT refresh_tenant_status($1) AS status`, [tenantId]));

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  const [t] = await adminQuery(
    `INSERT INTO tenants (slug, name, status) VALUES ('nuevo', 'Peluquería Nueva', 'onboarding') RETURNING id`);
  tenantId = t.id;
});

describe('register_channel', () => {
  it('la app registra un canal en coexistencia con el historial pendiente', async () => {
    const [{ id }] = await register();
    const [ch] = await adminQuery(`SELECT id, mode, history_sync, status, tenant_id FROM whatsapp_channels`);
    expect(ch).toMatchObject({ id, mode: 'coexistence', history_sync: 'pending', status: 'active', tenant_id: tenantId });
  });

  it('repetirlo para el mismo negocio rota el token sin duplicar', async () => {
    await register();
    await register('106999', tenantId, Buffer.from('otro'));
    const rows = await adminQuery(`SELECT access_token_encrypted FROM whatsapp_channels`);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].access_token_encrypted).toString()).toBe('otro');
  });

  it('se niega a pasarle a un negocio el número de otro', async () => {
    await register();
    const [otro] = await adminQuery(`INSERT INTO tenants (slug, name) VALUES ('otro', 'Otro') RETURNING id`);
    await expect(register('106999', otro.id)).rejects.toThrow(/otro negocio/);
  });
});

describe('refresh_tenant_status', () => {
  it('un negocio en alta sin agenda completa sigue en alta', async () => {
    await register();
    expect((await refresh())[0].status).toBe('onboarding');
  });

  it('con canal, servicio, horario y flujo pasa a activo', async () => {
    await register();
    await seedCatalog(tenantId);
    await seedHours(tenantId);
    await seedFlow(tenantId, DEMO_FLOW);
    expect((await refresh())[0].status).toBe('active');
  });

  it('nunca reactiva un negocio suspendido', async () => {
    await register(); await seedCatalog(tenantId); await seedHours(tenantId); await seedFlow(tenantId, DEMO_FLOW);
    await adminQuery(`UPDATE tenants SET status = 'suspended'`);
    expect((await refresh())[0].status).toBe('suspended');
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/onboarding/functions.test.ts`
Expected: FAIL — `function register_channel(...) does not exist`.

- [ ] **Step 3: La migración**

`packages/db/src/migrations/1725500200000-CreateOnboardingFunctions.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dos escrituras que el alta necesita y que la app NO puede hacer por su
 * cuenta (no tiene INSERT en whatsapp_channels ni UPDATE en tenants, y así
 * debe seguir). SECURITY DEFINER las ejecuta con los privilegios del dueño,
 * pero solo hacen exactamente esto, con la validación adentro.
 */
export class CreateOnboardingFunctions1725500200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION register_channel(
        p_tenant uuid, p_waba text, p_phone text, p_display text, p_token bytea, p_mode text
      ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_id uuid;
      BEGIN
        IF p_mode NOT IN ('cloud_api', 'coexistence') THEN
          RAISE EXCEPTION 'modo de canal inválido: %', p_mode;
        END IF;
        -- El WHERE del DO UPDATE impide que un número cambie de dueño: si es de
        -- otro negocio no se actualiza nada, no vuelve id y se aborta.
        INSERT INTO whatsapp_channels
          (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted, mode, history_sync, status)
        VALUES (p_tenant, p_waba, p_phone, p_display, p_token, p_mode,
                CASE WHEN p_mode = 'coexistence' THEN 'pending' ELSE 'not_applicable' END, 'active')
        ON CONFLICT (phone_number_id) DO UPDATE
          SET waba_id = EXCLUDED.waba_id, display_phone_number = EXCLUDED.display_phone_number,
              access_token_encrypted = EXCLUDED.access_token_encrypted, mode = EXCLUDED.mode,
              history_sync = EXCLUDED.history_sync, status = 'active'
          WHERE whatsapp_channels.tenant_id = EXCLUDED.tenant_id
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN
          RAISE EXCEPTION 'el número % ya pertenece a otro negocio', p_phone;
        END IF;
        RETURN v_id;
      END $$
    `);
    await q.query(`
      CREATE FUNCTION refresh_tenant_status(p_tenant uuid)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_status text; v_ready boolean;
      BEGIN
        SELECT status INTO v_status FROM tenants WHERE id = p_tenant FOR UPDATE;
        IF v_status IS NULL THEN RAISE EXCEPTION 'no existe el negocio %', p_tenant; END IF;
        -- Solo el alta avanza sola. Un suspendido lo reactiva el operador.
        IF v_status <> 'onboarding' THEN RETURN v_status; END IF;
        SELECT EXISTS (SELECT 1 FROM whatsapp_channels WHERE tenant_id = p_tenant AND status = 'active')
           AND EXISTS (SELECT 1 FROM services WHERE tenant_id = p_tenant AND active)
           AND EXISTS (SELECT 1 FROM business_hours WHERE tenant_id = p_tenant)
           AND EXISTS (SELECT 1 FROM flows WHERE tenant_id = p_tenant AND is_active AND is_default)
          INTO v_ready;
        IF NOT v_ready THEN RETURN 'onboarding'; END IF;
        UPDATE tenants SET status = 'active' WHERE id = p_tenant;
        RETURN 'active';
      END $$
    `);
    for (const fn of ['register_channel(uuid, text, text, text, bytea, text)', 'refresh_tenant_status(uuid)']) {
      await q.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await q.query(`GRANT EXECUTE ON FUNCTION ${fn} TO citara_app`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION refresh_tenant_status(uuid)`);
    await q.query(`DROP FUNCTION register_channel(uuid, text, text, text, bytea, text)`);
  }
}
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test apps/api/test/onboarding packages/db/test`
Expected: PASS, incluido el guardia (la app sigue sin INSERT sobre `whatsapp_channels`).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/1725500200000-CreateOnboardingFunctions.ts apps/api/test/onboarding/functions.test.ts
git commit -m "feat(onboarding): registrar canales y activar negocios con funciones acotadas"
```

---

### Task 4: El cliente de Meta para el alta

**Files:**
- Create: `apps/api/src/onboarding/meta-onboarding.client.ts`
- Modify: `apps/api/src/app.module.ts` (provider), `.env.example`
- Test: `apps/api/test/onboarding/meta-onboarding.client.test.ts`

**Interfaces:**
- Produces:
```ts
export type SyncType = 'smb_app_state_sync' | 'history';
export class MetaOnboardingError extends Error { readonly status: number | null }
export class MetaOnboardingClient {
  constructor(graphVersion: string, appId: string, appSecret: string);
  exchangeCode(code: string): Promise<string>;                                  // token del negocio
  phoneNumbers(wabaId: string, token: string): Promise<{ id: string; displayPhoneNumber: string | null }[]>;
  subscribeApp(wabaId: string, token: string): Promise<void>;
  requestSync(phoneNumberId: string, token: string, syncType: SyncType): Promise<void>;
}
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/meta-onboarding.client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetaOnboardingClient, MetaOnboardingError } from '../../src/onboarding/meta-onboarding.client';

let fetchMock: ReturnType<typeof vi.fn>;
const client = new MetaOnboardingClient('v25.0', 'APP_ID', 'SECRETO_DE_LA_APP');
const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });

describe('MetaOnboardingClient', () => {
  it('canjea el código por el token del negocio', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'EAAG-negocio' }));
    expect(await client.exchangeCode('CODIGO')).toBe('EAAG-negocio');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v25.0/oauth/access_token');
    expect(Object.fromEntries(url.searchParams)).toEqual(
      { client_id: 'APP_ID', client_secret: 'SECRETO_DE_LA_APP', code: 'CODIGO' });
  });

  it('lista los números de la cuenta', async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ id: '106999', display_phone_number: '+57 300 000 0000' }] }));
    expect(await client.phoneNumbers('777', 'EAAG')).toEqual([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v25.0/777/phone_numbers');
    expect(init.headers.Authorization).toBe('Bearer EAAG');
  });

  it('suscribe la app a los webhooks de la cuenta', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await client.subscribeApp('777', 'EAAG');
    const [url, init] = fetchMock.mock.calls[0];
    expect([new URL(url).pathname, init.method]).toEqual(['/v25.0/777/subscribed_apps', 'POST']);
  });

  it('pide la sincronización con el cuerpo que espera Meta', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await client.requestSync('106999', 'EAAG', 'history');
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v25.0/106999/smb_app_data');
    expect(JSON.parse(init.body)).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' });
  });

  it('un rechazo de Meta es un error legible que nunca incluye el secreto', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid verification code' } }) });
    const err = await client.exchangeCode('MALO').catch((e) => e);
    expect(err).toBeInstanceOf(MetaOnboardingError);
    expect(err.message).toMatch(/Invalid verification code/);
    expect(err.message).not.toContain('SECRETO_DE_LA_APP');
  });

  it('un fallo de red tampoco filtra el secreto', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed https://graph.facebook.com/?client_secret=SECRETO_DE_LA_APP'));
    const err = await client.exchangeCode('X').catch((e) => e);
    expect(err.message).not.toContain('SECRETO_DE_LA_APP');
  });

  it('un 200 sin token es un error, no un token vacío', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await expect(client.exchangeCode('X')).rejects.toBeInstanceOf(MetaOnboardingError);
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/onboarding/meta-onboarding.client.test.ts`
Expected: FAIL — no existe el cliente.

- [ ] **Step 3: El cliente**

`apps/api/src/onboarding/meta-onboarding.client.ts`:
```ts
export type SyncType = 'smb_app_state_sync' | 'history';

/** Un paso del alta que Meta no completó. El mensaje es apto para logs: sin token ni secreto. */
export class MetaOnboardingError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'MetaOnboardingError';
  }
}

const TIMEOUT_MS = 15_000;

/**
 * Las llamadas a la Graph API que hace el alta (spec §8). Este es el único
 * lugar que conoce esos endpoints. VERIFICAR la versión vigente de la Graph API
 * en la consola de Meta (META_GRAPH_VERSION).
 */
export class MetaOnboardingClient {
  constructor(
    private readonly graphVersion: string,
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /** Canjea el `code` del Embedded Signup por el token del negocio. */
  async exchangeCode(code: string): Promise<string> {
    const json = await this.call<{ access_token?: string }>('canje del código',
      this.url('oauth/access_token', { client_id: this.appId, client_secret: this.appSecret, code }));
    if (!json?.access_token) throw new MetaOnboardingError('canje del código: Meta no devolvió token', 200);
    return json.access_token;
  }

  /** El evento de coexistencia solo trae la cuenta (WABA): el número se consulta aquí. */
  async phoneNumbers(wabaId: string, token: string) {
    const json = await this.call<{ data?: { id: string; display_phone_number?: string }[] }>(
      'números de la cuenta', this.url(`${wabaId}/phone_numbers`, { fields: 'id,display_phone_number' }),
      { headers: { Authorization: `Bearer ${token}` } });
    return (json?.data ?? []).map((p) => ({ id: String(p.id), displayPhoneNumber: p.display_phone_number ?? null }));
  }

  /** Sin esto, los webhooks de la cuenta del negocio no llegan a la app. */
  async subscribeApp(wabaId: string, token: string): Promise<void> {
    await this.call('suscripción a los webhooks', this.url(`${wabaId}/subscribed_apps`),
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  }

  /** Una vez por tipo, dentro de las 24 h siguientes al alta. */
  async requestSync(phoneNumberId: string, token: string, syncType: SyncType): Promise<void> {
    await this.call(`sincronización ${syncType}`, this.url(`${phoneNumberId}/smb_app_data`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
    });
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(`https://graph.facebook.com/${this.graphVersion}/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async call<T>(what: string, url: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      // Solo el nombre del error: el mensaje de un fallo de red puede traer la
      // URL, y la del canje lleva el secreto de la app.
      throw new MetaOnboardingError(`${what}: fallo de red (${(err as Error).name})`, null);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = typeof json?.error?.message === 'string' ? ` — ${json.error.message}` : '';
      throw new MetaOnboardingError(`${what}: Meta respondió ${res.status}${detail}`, res.status);
    }
    return json as T;
  }
}
```

- [ ] **Step 4: Registrar y documentar**

En `apps/api/src/app.module.ts`, importar `MetaOnboardingClient` y añadir a `providers`:
```ts
    {
      // Credenciales de la app de Meta (no del negocio). Los tests lo reemplazan.
      provide: MetaOnboardingClient,
      useFactory: () => new MetaOnboardingClient(
        process.env.META_GRAPH_VERSION ?? 'v25.0', process.env.META_APP_ID ?? '', process.env.META_APP_SECRET ?? ''),
    },
```
En `.env.example`, después de `META_GRAPH_VERSION`:
```
# Alta asistida (Embedded Signup v4). ID de la app de Meta y de la configuración de
# Facebook Login for Business creada con Embedded Signup y coexistencia.
META_APP_ID=
META_ES_CONFIG_ID=
# Base pública de la API: con ella se arman los enlaces de conexión que se mandan al cliente.
PUBLIC_BASE_URL=http://localhost:3000
```
y la línea `META_GRAPH_VERSION=v21.0` pasa a `META_GRAPH_VERSION=v25.0` (VERIFICAR la vigente: v21.0 sale de soporte).

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/onboarding && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/onboarding/meta-onboarding.client.ts apps/api/src/app.module.ts .env.example apps/api/test/onboarding/meta-onboarding.client.test.ts
git commit -m "feat(onboarding): hablar con la graph api para canjear el código, suscribir y sincronizar"
```

---

### Task 5: Completar el alta del WhatsApp

**Files:**
- Create: `apps/api/src/onboarding/onboarding.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/onboarding/onboarding.service.test.ts`

**Interfaces:**
- Consumes: `peekLink`, `consumeLink` (Task 2), `register_channel`, `refresh_tenant_status` (Task 3), `MetaOnboardingClient` (Task 4), `EncryptionService`, `recordAudit`.
- Produces:
```ts
export class LinkInvalidError extends Error {}
export class OnboardingInputError extends Error {}
class OnboardingService {
  constructor(ds: DataSource, enc: EncryptionService, meta: MetaOnboardingClient);
  completeWhatsapp(input: { token: string; code: string; wabaId: string; phoneNumberId?: string | null }):
    Promise<{ tenantId: string; channelId: string; phoneNumberId: string; displayPhoneNumber: string | null;
              syncs: Record<SyncType, 'requested' | 'failed'> }>;
  requestSyncs(tenantId: string, phoneNumberId: string, accessToken: string): Promise<Record<SyncType, 'requested' | 'failed'>>;
}
```
Orden: validar el enlace → canjear el código → elegir el número → suscribir la app → **en una transacción**: consumir el enlace, registrar el canal (token cifrado), auditar, refrescar el estado → **fuera de la transacción**: pedir las dos sincronizaciones (un fallo no deshace el alta).

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/onboarding.service.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { createLink, peekLink } from '../../src/onboarding/links';
import { MetaOnboardingError, type MetaOnboardingClient } from '../../src/onboarding/meta-onboarding.client';
import { LinkInvalidError, OnboardingInputError, OnboardingService } from '../../src/onboarding/onboarding.service';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource, enc: EncryptionService;
let tenantId: string, token: string;
let meta: { [K in keyof MetaOnboardingClient]: ReturnType<typeof vi.fn> };
let service: OnboardingService;

const complete = (over: Record<string, unknown> = {}) =>
  service.completeWhatsapp({ token, code: 'CODIGO', wabaId: '777', ...over });

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  const [t] = await adminQuery(
    `INSERT INTO tenants (slug, name, status) VALUES ('nuevo', 'Peluquería Nueva', 'onboarding') RETURNING id`);
  tenantId = t.id;
  token = await createLink(admin, tenantId, 'whatsapp');
  meta = {
    exchangeCode: vi.fn().mockResolvedValue('EAAG-del-negocio'),
    phoneNumbers: vi.fn().mockResolvedValue([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]),
    subscribeApp: vi.fn().mockResolvedValue(undefined),
    requestSync: vi.fn().mockResolvedValue(undefined),
  } as never;
  service = new OnboardingService(app, enc, meta as never);
});

describe('OnboardingService.completeWhatsapp', () => {
  it('registra el canal en coexistencia con el token cifrado, suscribe y pide las dos sincronizaciones', async () => {
    const r = await complete();

    expect(r).toMatchObject({ tenantId, phoneNumberId: '106999', syncs: { smb_app_state_sync: 'requested', history: 'requested' } });
    const resolved = await new ChannelResolver(app, enc).resolveByPhoneNumberId('106999');
    expect(resolved).toMatchObject({ tenantId, accessToken: 'EAAG-del-negocio' });
    expect(meta.subscribeApp).toHaveBeenCalledWith('777', 'EAAG-del-negocio');
    expect(meta.requestSync.mock.calls.map((c) => c[2]).sort()).toEqual(['history', 'smb_app_state_sync']);
    const actions = (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['channel.connected', 'channel.sync_requested', 'channel.sync_requested']);
  });

  it('el enlace queda usado: un segundo intento no registra otro canal', async () => {
    await complete();
    await expect(complete()).rejects.toBeInstanceOf(LinkInvalidError);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM whatsapp_channels`);
    expect(n).toBe(1);
  });

  it('con varios números y sin indicar cuál, falla claro y el enlace sigue sirviendo', async () => {
    meta.phoneNumbers.mockResolvedValue([{ id: '1', displayPhoneNumber: null }, { id: '2', displayPhoneNumber: null }]);
    await expect(complete()).rejects.toBeInstanceOf(OnboardingInputError);
    expect(await peekLink(app, token, 'whatsapp')).not.toBeNull();
    // Con el número indicado (la sesión lo trae), funciona.
    await expect(complete({ phoneNumberId: '2' })).resolves.toMatchObject({ phoneNumberId: '2' });
  });

  it('si Meta rechaza el código, no se registra nada y el enlace sigue sirviendo', async () => {
    meta.exchangeCode.mockRejectedValue(new MetaOnboardingError('canje del código: Meta respondió 400', 400));
    await expect(complete()).rejects.toBeInstanceOf(MetaOnboardingError);
    expect(await adminQuery(`SELECT id FROM whatsapp_channels`)).toEqual([]);
    expect(await peekLink(app, token, 'whatsapp')).not.toBeNull();
  });

  it('si falla la sincronización, el alta se conserva y queda registrado para reintentar', async () => {
    meta.requestSync.mockRejectedValue(new MetaOnboardingError('sincronización: Meta respondió 500', 500));
    const r = await complete();
    expect(r.syncs).toEqual({ smb_app_state_sync: 'failed', history: 'failed' });
    expect(await adminQuery(`SELECT id FROM whatsapp_channels`)).toHaveLength(1);
    const failed = await adminQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'channel.sync_failed'`);
    expect(failed[0].n).toBe(2);
  });

  it('un enlace inválido no llega a hablar con Meta', async () => {
    await expect(service.completeWhatsapp({ token: 'inventado', code: 'X', wabaId: '777' }))
      .rejects.toBeInstanceOf(LinkInvalidError);
    expect(meta.exchangeCode).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/onboarding/onboarding.service.test.ts`
Expected: FAIL — no existe `onboarding.service`.

- [ ] **Step 3: El servicio**

`apps/api/src/onboarding/onboarding.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
// Imports de VALOR: OnboardingService es @Injectable() y Nest los resuelve por tipo.
import { DataSource } from 'typeorm';
import { EncryptionService } from '../crypto/encryption.service';
import { MetaOnboardingClient, type SyncType } from './meta-onboarding.client';
import { consumeLink, peekLink } from './links';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';

/** El enlace no existe, venció, ya se usó o es de un negocio suspendido. */
export class LinkInvalidError extends Error {
  constructor() { super('Este enlace ya no es válido'); }
}

/** Lo que mandó la página no alcanza para completar el alta. */
export class OnboardingInputError extends Error {}

const SYNC_TYPES: SyncType[] = ['smb_app_state_sync', 'history'];

@Injectable()
export class OnboardingService {
  private readonly log = new Logger(OnboardingService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly enc: EncryptionService,
    private readonly meta: MetaOnboardingClient,
  ) {}

  async completeWhatsapp(input: { token: string; code: string; wabaId: string; phoneNumberId?: string | null }) {
    // Antes de hablar con Meta: un enlace inválido no gasta el código del cliente.
    const link = await peekLink(this.ds, input.token, 'whatsapp');
    if (!link) throw new LinkInvalidError();

    const accessToken = await this.meta.exchangeCode(input.code);
    const phones = await this.meta.phoneNumbers(input.wabaId, accessToken);
    const phone = input.phoneNumberId
      ? phones.find((p) => p.id === input.phoneNumberId)
      : phones.length === 1 ? phones[0] : undefined;
    if (!phone) {
      throw new OnboardingInputError(phones.length === 0
        ? 'La cuenta de WhatsApp no tiene números'
        : 'La cuenta tiene varios números y no se indicó cuál conectar');
    }
    await this.meta.subscribeApp(input.wabaId, accessToken);

    // Consumir el enlace y registrar el canal van juntos: si dos pestañas
    // completan a la vez, solo una gana y la otra no deja un canal a medias.
    const channelId = await runInTenant(this.ds, link.tenantId, async (m) => {
      if (!(await consumeLink(m, link.linkId))) throw new LinkInvalidError();
      const [row] = await m.query(
        `SELECT register_channel($1, $2, $3, $4, $5, 'coexistence') AS id`,
        [link.tenantId, input.wabaId, phone.id, phone.displayPhoneNumber, this.enc.encrypt(accessToken)]);
      await recordAudit(m, {
        tenantId: link.tenantId, actor: 'onboarding', action: 'channel.connected',
        details: { channelId: row.id, phoneNumberId: phone.id, mode: 'coexistence' },
      });
      await m.query(`SELECT refresh_tenant_status($1)`, [link.tenantId]);
      return row.id as string;
    });

    // Fuera de la transacción: son llamadas a Meta. Un fallo no deshace el alta;
    // el operador lo reintenta con `pnpm tenant sync` dentro de las 24 h.
    const syncs = await this.requestSyncs(link.tenantId, phone.id, accessToken);
    return { tenantId: link.tenantId, channelId, phoneNumberId: phone.id,
             displayPhoneNumber: phone.displayPhoneNumber, syncs };
  }

  /** Contactos e historial. Meta acepta cada uno una sola vez, dentro de 24 h del alta. */
  async requestSyncs(tenantId: string, phoneNumberId: string, accessToken: string) {
    const out = {} as Record<SyncType, 'requested' | 'failed'>;
    for (const syncType of SYNC_TYPES) {
      try {
        await this.meta.requestSync(phoneNumberId, accessToken, syncType);
        out[syncType] = 'requested';
      } catch (err) {
        out[syncType] = 'failed';
        this.log.warn(`no se pudo pedir ${syncType} para ${phoneNumberId}: ${(err as Error).message}`);
      }
      await runInTenant(this.ds, tenantId, (m) => recordAudit(m, {
        tenantId, actor: 'onboarding',
        action: out[syncType] === 'requested' ? 'channel.sync_requested' : 'channel.sync_failed',
        details: { syncType, phoneNumberId },
      }));
    }
    return out;
  }
}
```
Registrar `OnboardingService` en `providers` de `app.module.ts` (después de `MetaOnboardingClient`).

- [ ] **Step 4: Correr los tests**

Run: `pnpm test apps/api/test/onboarding && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/onboarding/onboarding.service.ts apps/api/src/app.module.ts apps/api/test/onboarding/onboarding.service.test.ts
git commit -m "feat(onboarding): completar el alta del número en coexistencia de forma atómica"
```

---

### Task 6: La página de conexión

**Files:**
- Create: `apps/api/src/onboarding/connect-page.ts`, `apps/api/src/onboarding/connect.controller.ts`
- Modify: `apps/api/src/app.module.ts` (`controllers`)
- Test: `apps/api/test/onboarding/connect.e2e.test.ts`

**Interfaces:**
- Consumes: `peekLink`, `OnboardingService`.
- Produces: `GET /connect/whatsapp?t=<token>` (200 con la página, 410 si el enlace no sirve) y `POST /connect/whatsapp/complete` con `{ t, code, waba_id, phone_number_id?, event? }` → 200 `{ ok: true, numero }`, 400 datos incompletos, 410 enlace inválido, 422 alta incompleta (cancelada o varios números), 502 Meta falló.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/onboarding/connect.e2e.test.ts`:
```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import { createDataSource } from '@citara/db';
import { AppModule } from '../../src/app.module';
import { MetaOnboardingClient, MetaOnboardingError } from '../../src/onboarding/meta-onboarding.client';
import { createLink } from '../../src/onboarding/links';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

let app: INestApplication;
let admin: DataSource;
let token: string;
const meta = {
  exchangeCode: vi.fn(), phoneNumbers: vi.fn(), subscribeApp: vi.fn(), requestSync: vi.fn(),
};
const http = () => request(app.getHttpServer());
const body = (over: Record<string, unknown> = {}) =>
  ({ t: token, code: 'CODIGO', waba_id: '777', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', ...over });

beforeAll(async () => {
  process.env.META_APP_ID = '1234567890';
  process.env.META_ES_CONFIG_ID = 'CONFIG-987';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaOnboardingClient).useValue(meta).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
});
afterAll(async () => { await app.close(); await admin.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  const [t] = await adminQuery(
    `INSERT INTO tenants (slug, name, status) VALUES ('nuevo', 'Peluquería <script>alert(1)</script>', 'onboarding') RETURNING id`);
  token = await createLink(admin, t.id, 'whatsapp');
  meta.exchangeCode.mockResolvedValue('EAAG');
  meta.phoneNumbers.mockResolvedValue([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]);
  meta.subscribeApp.mockResolvedValue(undefined);
  meta.requestSync.mockResolvedValue(undefined);
});

describe('GET /connect/whatsapp', () => {
  it('sirve la página con el Embedded Signup de coexistencia', async () => {
    const res = await http().get('/connect/whatsapp').query({ t: token }).expect(200);
    expect(res.text).toContain('CONFIG-987');
    expect(res.text).toContain('whatsapp_business_app_onboarding');
    expect(res.text).toContain('connect.facebook.net');
  });

  it('no se cachea ni envía el token a terceros', async () => {
    const res = await http().get('/connect/whatsapp').query({ t: token });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('escapa el nombre del negocio', async () => {
    const res = await http().get('/connect/whatsapp').query({ t: token });
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('un enlace inválido o ya usado responde 410', async () => {
    await http().get('/connect/whatsapp').query({ t: 'inventado' }).expect(410);
    await http().post('/connect/whatsapp/complete').send(body()).expect(200);
    await http().get('/connect/whatsapp').query({ t: token }).expect(410);
  });
});

describe('POST /connect/whatsapp/complete', () => {
  it('completa el alta y devuelve el número conectado', async () => {
    const res = await http().post('/connect/whatsapp/complete').send(body()).expect(200);
    expect(res.body).toEqual({ ok: true, numero: '+57 300 000 0000' });
    expect(await adminQuery(`SELECT mode FROM whatsapp_channels`)).toEqual([{ mode: 'coexistence' }]);
  });

  it('el doble clic registra un solo canal', async () => {
    const [a, b] = await Promise.all([
      http().post('/connect/whatsapp/complete').send(body()),
      http().post('/connect/whatsapp/complete').send(body()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect(await adminQuery(`SELECT id FROM whatsapp_channels`)).toHaveLength(1);
  });

  it('datos incompletos → 400; alta cancelada en Meta → 422', async () => {
    await http().post('/connect/whatsapp/complete').send({ t: token }).expect(400);
    await http().post('/connect/whatsapp/complete').send(body({ event: 'CANCEL' })).expect(422);
  });

  it('si Meta rechaza un paso → 502 con un mensaje para el cliente, sin el detalle de Meta', async () => {
    meta.exchangeCode.mockRejectedValueOnce(new MetaOnboardingError('canje del código: Meta respondió 400 — detalle', 400));
    const res = await http().post('/connect/whatsapp/complete').send(body()).expect(502);
    expect(res.body.message).toMatch(/Intenta de nuevo/);
    expect(JSON.stringify(res.body)).not.toContain('detalle');
  });

  it('un fallo inesperado → 500 sin filtrar su mensaje', async () => {
    meta.exchangeCode.mockRejectedValueOnce(new Error('detalle interno con EAAG'));
    const res = await http().post('/connect/whatsapp/complete').send(body()).expect(500);
    expect(JSON.stringify(res.body)).not.toContain('EAAG');
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/onboarding/connect.e2e.test.ts`
Expected: FAIL — 404 en `/connect/whatsapp`.

- [ ] **Step 3: La página**

`apps/api/src/onboarding/connect-page.ts`:
```ts
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** JSON seguro dentro de un <script>: un "</script>" en un valor no puede cerrar la etiqueta. */
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const layout = (title: string, body: string) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
button{font-size:1rem;padding:.75rem 1.25rem;border:0;border-radius:.5rem;background:#1877f2;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:default}#estado{margin-top:1rem}</style></head>
<body><main>${body}</main></body></html>`;

export function invalidLinkPage(): string {
  return layout('Enlace no válido',
    '<h1>Este enlace ya no es válido</h1><p>Puede que ya se haya usado o que haya vencido. Pide uno nuevo a quien te lo envió.</p>');
}

export function connectPage(p: { token: string; tenantName: string; appId: string; configId: string; graphVersion: string }): string {
  const cfg = jsonForScript({ token: p.token, appId: p.appId, configId: p.configId, graphVersion: p.graphVersion });
  return layout('Conectar WhatsApp', `
<h1>Conecta el WhatsApp de ${escapeHtml(p.tenantName)}</h1>
<p>Vas a vincular tu WhatsApp Business con el asistente de citas. Sigues usando tu app como siempre;
el asistente responde por ti cuando no estás en la conversación.</p>
<p>Ten a mano tu celular: Meta te pedirá escanear un código QR desde la app de WhatsApp Business.</p>
<button id="conectar" disabled>Conectar WhatsApp</button>
<p id="estado" role="status"></p>
<script>
const CFG = ${cfg};
const estado = (t) => { document.getElementById('estado').textContent = t; };
const boton = document.getElementById('conectar');
let sesion = null;
window.addEventListener('message', (e) => {
  try { if (!new URL(e.origin).hostname.endsWith('facebook.com')) return; } catch { return; }
  try {
    const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (d && d.type === 'WA_EMBEDDED_SIGNUP') sesion = d;
  } catch {}
});
window.fbAsyncInit = () => {
  FB.init({ appId: CFG.appId, autoLogAppEvents: true, xfbml: false, version: CFG.graphVersion });
  boton.disabled = false;
};
const completar = async (code) => {
  // El evento de la sesión puede llegar justo después del callback de login.
  for (let i = 0; i < 10 && !sesion; i++) await new Promise((r) => setTimeout(r, 300));
  const datos = (sesion && sesion.data) || {};
  const res = await fetch('/connect/whatsapp/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: CFG.token, code, waba_id: datos.waba_id, phone_number_id: datos.phone_number_id,
                           event: sesion && sesion.event }),
  });
  const r = await res.json().catch(() => ({}));
  if (res.ok) { estado('¡Listo! Tu WhatsApp ' + (r.numero || '') + ' quedó conectado. Ya puedes cerrar esta página.'); return; }
  estado(r.message || 'No se pudo completar la conexión. Intenta de nuevo.');
  boton.disabled = false;
};
boton.addEventListener('click', () => {
  boton.disabled = true;
  estado('Abriendo Meta…');
  FB.login((resp) => {
    const code = resp && resp.authResponse && resp.authResponse.code;
    if (!code) { estado('Se canceló la conexión.'); boton.disabled = false; return; }
    estado('Conectando…');
    completar(code).catch(() => { estado('No se pudo completar la conexión. Intenta de nuevo.'); boton.disabled = false; });
  }, {
    config_id: CFG.configId,
    response_type: 'code',
    override_default_response_type: true,
    // VERIFICAR en la consola de Meta: Embedded Signup v4 con coexistencia.
    extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
  });
});
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/es_LA/sdk.js"></script>`);
}
```

- [ ] **Step 4: El controlador**

`apps/api/src/onboarding/connect.controller.ts`:
```ts
import {
  BadGatewayException, BadRequestException, Body, Controller, Get, GoneException, HttpCode, HttpStatus,
  Logger, Post, Query, Res, UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { OnboardingService, LinkInvalidError, OnboardingInputError } from './onboarding.service';
import { MetaOnboardingError } from './meta-onboarding.client';
import { peekLink } from './links';
import { connectPage, invalidLinkPage } from './connect-page';

const FINISH_EVENTS = new Set(['FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', 'FINISH']);
const completeSchema = z.object({
  t: z.string().min(16),
  code: z.string().min(1),
  waba_id: z.string().regex(/^\d+$/),
  phone_number_id: z.string().regex(/^\d+$/).nullish(),
  event: z.string().nullish(),
});

@Controller('connect/whatsapp')
export class ConnectController {
  private readonly log = new Logger(ConnectController.name);

  constructor(private readonly ds: DataSource, private readonly onboarding: OnboardingService) {}

  @Get()
  async page(@Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    // El token va en la URL: ni caché ni Referer hacia el CDN de Meta.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const link = typeof token === 'string' && token.length > 0 ? await peekLink(this.ds, token, 'whatsapp') : null;
    if (!link) {
      res.status(HttpStatus.GONE).type('html').send(invalidLinkPage());
      return;
    }
    res.status(HttpStatus.OK).type('html').send(connectPage({
      token, tenantName: link.tenantName,
      appId: process.env.META_APP_ID ?? '', configId: process.env.META_ES_CONFIG_ID ?? '',
      graphVersion: process.env.META_GRAPH_VERSION ?? 'v25.0',
    }));
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Body() raw: unknown) {
    const parsed = completeSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Faltan datos para completar la conexión');
    const b = parsed.data;
    if (b.event && !FINISH_EVENTS.has(b.event)) {
      throw new UnprocessableEntityException('La conexión no se completó en Meta');
    }
    try {
      const r = await this.onboarding.completeWhatsapp(
        { token: b.t, code: b.code, wabaId: b.waba_id, phoneNumberId: b.phone_number_id ?? null });
      return { ok: true, numero: r.displayPhoneNumber };
    } catch (err) {
      if (err instanceof LinkInvalidError) throw new GoneException(err.message);
      if (err instanceof OnboardingInputError) throw new UnprocessableEntityException(err.message);
      if (err instanceof MetaOnboardingError) {
        this.log.warn(`alta incompleta: ${err.message}`);
        throw new BadGatewayException('Meta no completó la conexión. Intenta de nuevo en unos minutos.');
      }
      throw err;
    }
  }
}
```
En `app.module.ts`: `controllers: [WhatsappController, ConnectController],`.

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/onboarding && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/onboarding/connect-page.ts apps/api/src/onboarding/connect.controller.ts apps/api/src/app.module.ts apps/api/test/onboarding/connect.e2e.test.ts
git commit -m "feat(onboarding): servir la página de conexión con el embedded signup de coexistencia"
```

---

### Task 7: La CLI del operador

**Files:**
- Create: `apps/api/src/cli/tenants.ts`, `apps/api/src/cli/tenant-cli.ts`
- Modify: `apps/api/src/cli/tenant-config.ts` (refrescar el estado al aplicar), `package.json` (script `tenant`)
- Test: `apps/api/test/cli/tenants.test.ts`

**Interfaces:**
- Produces:
```ts
export function connectUrl(token: string): string;  // ${PUBLIC_BASE_URL}/connect/whatsapp?t=...
export function createTenant(admin: DataSource, input: { slug: string; name: string; timezone?: string }): Promise<{ tenantId: string; token: string }>;
export function newLink(admin: DataSource, slug: string): Promise<string>;
export function setSuspended(admin: DataSource, slug: string, suspended: boolean): Promise<string>; // estado final
export interface TenantSummary { slug: string; name: string; status: string; phone: string | null; mode: string | null;
  channelStatus: string | null; historySync: string | null; lastPhoneEcho: Date | null; lastCustomer: Date | null }
export function listTenants(admin: DataSource): Promise<TenantSummary[]>;
export function syncTenant(admin: DataSource, enc: EncryptionService, meta: MetaOnboardingClient, slug: string): Promise<Record<SyncType, 'requested' | 'failed'>>;
// applyTenantConfig devuelve además `status`.
```
Comandos: `pnpm tenant create <slug> "<nombre>" [zona]`, `pnpm tenant link <slug>`, `pnpm tenant suspend <slug>`, `pnpm tenant resume <slug>`, `pnpm tenant list`, `pnpm tenant sync <slug>`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/cli/tenants.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { peekLink } from '../../src/onboarding/links';
import { connectUrl, createTenant, listTenants, newLink, setSuspended, syncTenant } from '../../src/cli/tenants';
import { applyTenantConfig } from '../../src/cli/tenant-config';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource, enc: EncryptionService;

const agenda = {
  tenant: 'nuevo',
  services: [{ key: 'corte', name: 'Corte', duration_min: 30 }],
  resources: [{ key: 'maria', name: 'María', services: ['corte'] }],
  hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }],
  flow: 'agenda',
};
const connectChannel = async (tenantId: string) => adminQuery(
  `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, access_token_encrypted, mode, history_sync)
   VALUES ($1, '777', '106999', $2, 'coexistence', 'pending')`, [tenantId, enc.encrypt('EAAG-negocio')]);

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); });

describe('CLI del operador', () => {
  it('crear un negocio lo deja en alta con un enlace de conexión listo', async () => {
    const { tenantId, token } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    const [t] = await adminQuery(`SELECT status, timezone FROM tenants WHERE id = $1`, [tenantId]);
    expect(t).toEqual({ status: 'onboarding', timezone: 'America/Bogota' });
    expect(await peekLink(app, token, 'whatsapp')).toMatchObject({ tenantId });
    expect(connectUrl(token)).toMatch(/\/connect\/whatsapp\?t=/);
  });

  it('rechaza un slug repetido o inválido con un mensaje claro', async () => {
    await createTenant(admin, { slug: 'nuevo', name: 'X' });
    await expect(createTenant(admin, { slug: 'nuevo', name: 'Y' })).rejects.toThrow(/ya existe/);
    await expect(createTenant(admin, { slug: 'Con Espacios', name: 'Z' })).rejects.toThrow(/slug/);
  });

  it('con canal y agenda aplicada, el negocio pasa solo a activo', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    expect((await applyTenantConfig(admin, agenda)).status).toBe('onboarding'); // sin canal todavía
    await connectChannel(tenantId);
    expect((await applyTenantConfig(admin, agenda)).status).toBe('active');
  });

  it('suspender lo saca de operación y anula sus enlaces; reanudar lo devuelve', async () => {
    const { tenantId, token } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    await applyTenantConfig(admin, agenda);

    expect(await setSuspended(admin, 'nuevo', true)).toBe('suspended');
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
    expect(await setSuspended(admin, 'nuevo', false)).toBe('active');
    const actions = (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['tenant.suspended', 'tenant.resumed']);
  });

  it('un enlace nuevo reemplaza al perdido', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    expect(await peekLink(app, await newLink(admin, 'nuevo'), 'whatsapp')).toMatchObject({ tenantId });
    await expect(newLink(admin, 'no-existe')).rejects.toThrow(/no-existe/);
  });

  it('la lista muestra el estado de cada negocio y de su canal', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    expect(await listTenants(admin)).toEqual([expect.objectContaining({
      slug: 'nuevo', status: 'onboarding', mode: 'coexistence', channelStatus: 'active', historySync: 'pending' })]);
  });

  it('sync vuelve a pedir la sincronización con el token del canal', async () => {
    const { tenantId } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });
    await connectChannel(tenantId);
    const meta = { requestSync: vi.fn().mockResolvedValue(undefined) };
    const r = await syncTenant(admin, enc, meta as never, 'nuevo');
    expect(r).toEqual({ smb_app_state_sync: 'requested', history: 'requested' });
    expect(meta.requestSync).toHaveBeenCalledWith('106999', 'EAAG-negocio', 'history');
  });
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm test apps/api/test/cli/tenants.test.ts`
Expected: FAIL — no existe `cli/tenants`.

- [ ] **Step 3: Refrescar el estado al aplicar la configuración**

En `apps/api/src/cli/tenant-config.ts`, antes del `return` final de la transacción:
```ts
    // Si al negocio en alta solo le faltaba la agenda, aquí queda activo.
    const [{ status }] = await m.query(`SELECT refresh_tenant_status($1) AS status`, [tenantId]);
```
y el objeto devuelto gana `status`.

- [ ] **Step 4: Las operaciones**

`apps/api/src/cli/tenants.ts`:
```ts
import type { DataSource } from 'typeorm';
import { DateTime } from 'luxon';
import type { EncryptionService } from '../crypto/encryption.service';
import type { MetaOnboardingClient, SyncType } from '../onboarding/meta-onboarding.client';
import { OnboardingService } from '../onboarding/onboarding.service';
import { createLink } from '../onboarding/links';
import { recordAudit } from '../audit/audit';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const connectUrl = (token: string) =>
  `${(process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/connect/whatsapp?t=${token}`;

async function tenantBySlug(admin: DataSource, slug: string): Promise<string> {
  const [t] = await admin.query(`SELECT id FROM tenants WHERE slug = $1`, [slug]);
  if (!t) throw new Error(`No existe el negocio '${slug}'`);
  return t.id;
}

/** Nace en alta: guarda lo que llega pero no responde hasta tener canal, agenda y flujo. */
export async function createTenant(admin: DataSource, input: { slug: string; name: string; timezone?: string }) {
  if (!SLUG.test(input.slug)) throw new Error('El slug debe ser minúsculas, números y guiones (2-63)');
  const timezone = input.timezone ?? 'America/Bogota';
  if (!DateTime.local().setZone(timezone).isValid) throw new Error(`Zona horaria inválida: ${timezone}`);
  return admin.transaction(async (m) => {
    const [exists] = await m.query(`SELECT 1 FROM tenants WHERE slug = $1`, [input.slug]);
    if (exists) throw new Error(`El negocio '${input.slug}' ya existe`);
    const [t] = await m.query(
      `INSERT INTO tenants (slug, name, timezone, status) VALUES ($1, $2, $3, 'onboarding') RETURNING id`,
      [input.slug, input.name, timezone]);
    const token = await createLink(m, t.id, 'whatsapp');
    return { tenantId: t.id as string, token };
  });
}

export async function newLink(admin: DataSource, slug: string): Promise<string> {
  return createLink(admin, await tenantBySlug(admin, slug), 'whatsapp');
}

/** Suspender saca al negocio de operación al instante; reanudar lo devuelve si está completo. */
export async function setSuspended(admin: DataSource, slug: string, suspended: boolean): Promise<string> {
  const tenantId = await tenantBySlug(admin, slug);
  return admin.transaction(async (m) => {
    if (suspended) {
      await m.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);
    } else {
      await m.query(`UPDATE tenants SET status = 'onboarding' WHERE id = $1 AND status = 'suspended'`, [tenantId]);
    }
    const [{ status }] = await m.query(`SELECT refresh_tenant_status($1) AS status`, [tenantId]);
    await recordAudit(m, { tenantId, actor: 'operator', action: suspended ? 'tenant.suspended' : 'tenant.resumed',
                           details: { status } });
    return status as string;
  });
}

export interface TenantSummary {
  slug: string; name: string; status: string; phone: string | null; mode: string | null;
  channelStatus: string | null; historySync: string | null; lastPhoneEcho: Date | null; lastCustomer: Date | null;
}

/** Lo que el operador necesita ver: quién opera, cómo está su canal, y si el dueño sigue abriendo la app. */
export async function listTenants(admin: DataSource): Promise<TenantSummary[]> {
  const rows = await admin.query(`
    SELECT t.slug, t.name, t.status,
           ch.display_phone_number AS phone, ch.mode, ch.status AS channel_status, ch.history_sync,
           (SELECT max(occurred_at) FROM messages m WHERE m.tenant_id = t.id AND m.origin = 'phone') AS last_phone_echo,
           (SELECT max(occurred_at) FROM messages m WHERE m.tenant_id = t.id AND m.origin = 'customer') AS last_customer
      FROM tenants t
      LEFT JOIN LATERAL (SELECT * FROM whatsapp_channels c WHERE c.tenant_id = t.id ORDER BY c.created_at DESC LIMIT 1) ch ON true
     ORDER BY t.slug`);
  return rows.map((r: Record<string, any>) => ({
    slug: r.slug, name: r.name, status: r.status, phone: r.phone, mode: r.mode,
    channelStatus: r.channel_status, historySync: r.history_sync,
    lastPhoneEcho: r.last_phone_echo, lastCustomer: r.last_customer,
  }));
}

/** Reintenta la sincronización de un número en coexistencia (Meta la acepta dentro de 24 h del alta). */
export async function syncTenant(admin: DataSource, enc: EncryptionService, meta: MetaOnboardingClient, slug: string) {
  const tenantId = await tenantBySlug(admin, slug);
  const [ch] = await admin.query(
    `SELECT phone_number_id, access_token_encrypted FROM whatsapp_channels
      WHERE tenant_id = $1 AND mode = 'coexistence' AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [tenantId]);
  if (!ch) throw new Error(`'${slug}' no tiene un canal activo en coexistencia`);
  const service = new OnboardingService(admin, enc, meta);
  return service.requestSyncs(tenantId, ch.phone_number_id, enc.decrypt(ch.access_token_encrypted));
}
```

- [ ] **Step 5: El comando**

`apps/api/src/cli/tenant-cli.ts`:
```ts
// La CLI del operador: pnpm tenant <create|link|suspend|resume|list|sync> ...
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { createDataSource } from '@citara/db';
import { EncryptionService } from '../crypto/encryption.service';
import { MetaOnboardingClient } from '../onboarding/meta-onboarding.client';
import { connectUrl, createTenant, listTenants, newLink, setSuspended, syncTenant } from './tenants';

const USAGE = `Uso:
  pnpm tenant create <slug> "<nombre>" [zona]   crea el negocio en alta e imprime el enlace de conexión
  pnpm tenant link <slug>                         imprime un enlace de conexión nuevo
  pnpm tenant suspend <slug> | resume <slug>      saca o devuelve el negocio a operación
  pnpm tenant list                                estado de los negocios y sus canales
  pnpm tenant sync <slug>                         reintenta la sincronización de historial y contactos`;

const fmt = (d: Date | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL no está definida');
  const admin = createDataSource(url);
  await admin.initialize();
  try {
    switch (cmd) {
      case 'create': {
        const [slug, name, timezone] = args;
        if (!slug || !name) throw new Error(USAGE);
        const { token } = await createTenant(admin, { slug, name, timezone });
        console.log(`Negocio '${slug}' creado en alta. Envíale este enlace (vence en 72 h, un solo uso):\n${connectUrl(token)}`);
        break;
      }
      case 'link':
        if (!args[0]) throw new Error(USAGE);
        console.log(connectUrl(await newLink(admin, args[0])));
        break;
      case 'suspend':
      case 'resume':
        if (!args[0]) throw new Error(USAGE);
        console.log(`'${args[0]}' quedó ${await setSuspended(admin, args[0], cmd === 'suspend')}`);
        break;
      case 'list':
        for (const t of await listTenants(admin)) {
          console.log([t.slug, t.status, t.phone ?? 'sin número', t.mode ?? '—', t.channelStatus ?? '—',
                       `historial ${t.historySync ?? '—'}`, `último eco ${fmt(t.lastPhoneEcho)}`,
                       `último cliente ${fmt(t.lastCustomer)}`].join(' | '));
        }
        break;
      case 'sync': {
        if (!args[0]) throw new Error(USAGE);
        const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
        await enc.ready();
        const meta = new MetaOnboardingClient(process.env.META_GRAPH_VERSION ?? 'v25.0',
          process.env.META_APP_ID ?? '', process.env.META_APP_SECRET ?? '');
        console.log(await syncTenant(admin, enc, meta, args[0]));
        break;
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    await admin.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```
En `package.json`, después de `tenant:apply`: `"tenant": "node apps/api/dist/src/cli/tenant-cli.js",`.

- [ ] **Step 6: Correr los tests y la CLI compilada**

Run: `pnpm typecheck && pnpm test apps/api/test/cli`
Expected: PASS (incluidos los de `tenant-config`, que ahora devuelven `status`).

Run: `pnpm build && pnpm -s tenant create prueba-cli "Prueba CLI" && pnpm -s tenant list && pnpm -s tenant suspend prueba-cli`
Expected: un enlace `http://localhost:3000/connect/whatsapp?t=...`, la lista con `prueba-cli | onboarding | sin número ...`, y `'prueba-cli' quedó suspended`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/cli package.json apps/api/test/cli/tenants.test.ts
git commit -m "feat(cli): dar de alta, suspender, listar y resincronizar negocios desde la cli"
```

---

### Task 8: Reconexión, alta de punta a punta y runbook

**Files:**
- Modify: `apps/api/src/coexistence/account-update.processor.ts` (`ACCOUNT_RECONNECTED`)
- Test: `apps/api/test/coexistence/account-update.processor.test.ts`
- Create: `apps/api/test/onboarding/alta.e2e.test.ts`
- Modify: `docs/desarrollo-local.md`

**Interfaces:**
- Produces: `RECONNECT_EVENTS = new Set(['ACCOUNT_RECONNECTED'])`; el canal `disconnected` de esa cuenta vuelve a `active` y se audita `channel.reconnected`. `AccountUpdateProcessor.process` devuelve `{ disconnected: number; reconnected: number }`.

- [ ] **Step 1: Escribir los tests que fallan**

Al final del `describe` de `apps/api/test/coexistence/account-update.processor.test.ts`:
```ts
  it('una reconexión devuelve a operación el canal desconectado', async () => {
    await update('PARTNER_REMOVED');
    const r = await update('ACCOUNT_RECONNECTED');
    expect(r).toMatchObject({ reconnected: 1 });
    expect(await statuses()).toEqual(['active']);
    const actions = (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['channel.disconnected', 'channel.reconnected']);
  });

  it('una reconexión no reactiva un canal que el operador dejó inactivo', async () => {
    await adminQuery(`UPDATE whatsapp_channels SET status = 'inactive'`);
    expect(await update('ACCOUNT_RECONNECTED')).toMatchObject({ reconnected: 0 });
    expect(await statuses()).toEqual(['inactive']);
  });
```
`apps/api/test/onboarding/alta.e2e.test.ts`:
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
import { MetaOnboardingClient } from '../../src/onboarding/meta-onboarding.client';
import { startWorkers } from '../../src/queues/workers';
import { INBOUND_QUEUE } from '../../src/queues/inbound.queue';
import { OUTBOUND_QUEUE } from '../../src/queues/outbound.queue';
import { SYNC_QUEUE } from '../../src/queues/sync.queue';
import { REMINDERS_QUEUE } from '../../src/queues/reminders.queue';
import { createTenant } from '../../src/cli/tenants';
import { applyTenantConfig } from '../../src/cli/tenant-config';
import { resetDb, adminQuery, closeHelpers } from '../helpers';

/**
 * El alta completa, con todo real menos Meta: el operador crea el negocio, el
 * cliente conecta su número por la página, el negocio guarda pero no responde
 * hasta cargar la agenda, y después atiende.
 */
let app: INestApplication, admin: DataSource, workers: { close: () => Promise<void> }, queues: Queue[];
const sent: string[] = [];
const fakeSender = { async send(_c: unknown, _to: string, content: OutboundContent) {
  sent.push('body' in content ? content.body : `[plantilla ${content.name}]`); return { wamid: `wamid.o.${sent.length}` }; } };
const meta = {
  exchangeCode: vi.fn().mockResolvedValue('EAAG-negocio'),
  phoneNumbers: vi.fn().mockResolvedValue([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]),
  subscribeApp: vi.fn().mockResolvedValue(undefined),
  requestSync: vi.fn().mockResolvedValue(undefined),
};

const sign = (b: object) => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(JSON.stringify(b)).digest('hex');
const hola = (wamid: string) => ({ object: 'whatsapp_business_account', entry: [{ id: '777', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '573000000000', phone_number_id: '106999' },
  contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
  messages: [{ from: '573001112233', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hola' } }],
} }] }] });
const post = (b: object) => request(app.getHttpServer()).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(b)).send(b).expect(200);
async function quiesce() {
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 150; i++) {
    const counts = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
    if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('las colas no se vaciaron');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MetaSender).useValue(fakeSender)
    .overrideProvider(MetaOnboardingClient).useValue(meta).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  queues = [INBOUND_QUEUE, OUTBOUND_QUEUE, SYNC_QUEUE, REMINDERS_QUEUE]
    .map((n) => new Queue(n, { connection: { url: process.env.REDIS_URL } }));
  for (const q of queues) await q.obliterate({ force: true });
  await resetDb();
  workers = startWorkers(app, { concurrency: 5, scheduleReminders: false });
});
afterAll(async () => {
  await workers.close();
  for (const q of queues) { await q.obliterate({ force: true }); await q.close(); }
  await app.close(); await admin.destroy(); await closeHelpers();
});

describe('alta asistida de punta a punta', () => {
  it('crear → conectar → guardar sin responder → cargar agenda → atender', async () => {
    const { token } = await createTenant(admin, { slug: 'nuevo', name: 'Peluquería Nueva' });

    await request(app.getHttpServer()).get('/connect/whatsapp').query({ t: token }).expect(200);
    await request(app.getHttpServer()).post('/connect/whatsapp/complete')
      .send({ t: token, code: 'CODIGO', waba_id: '777', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' }).expect(200);

    // En alta: el mensaje se guarda y nadie le responde todavía.
    await post(hola('wamid.ALTA1'));
    await quiesce();
    expect(sent).toEqual([]);
    expect(await adminQuery(`SELECT origin FROM messages`)).toEqual([{ origin: 'customer' }]);

    const r = await applyTenantConfig(admin, {
      tenant: 'nuevo',
      services: [{ key: 'corte', name: 'Corte', duration_min: 30 }],
      resources: [{ key: 'maria', name: 'María', services: ['corte'] }],
      hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '06:00', end: '22:00' }],
      flow: 'agenda',
    });
    expect(r.status).toBe('active');

    await post(hola('wamid.ALTA2'));
    await quiesce();
    expect(sent[0]).toBe('¡Hola! Soy el asistente de citas 👋');
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/coexistence/account-update.processor.test.ts apps/api/test/onboarding/alta.e2e.test.ts`
Expected: FAIL en la reconexión (`reconnected` indefinido). El e2e debería pasar si las tareas 1-7 están bien: si falla, el defecto está en su cableado.

- [ ] **Step 3: La reconexión**

En `apps/api/src/coexistence/account-update.processor.ts`:
```ts
/** VERIFICAR contra la documentación: el número volvió a quedar conectado. */
export const RECONNECT_EVENTS = new Set(['ACCOUNT_RECONNECTED']);
```
y `process` pasa a:
```ts
  async process(job: AccountUpdateJob): Promise<{ disconnected: number; reconnected: number }> {
    const { wabaId, event } = job.update;
    const reconnect = RECONNECT_EVENTS.has(event);
    if (!reconnect && !DISCONNECT_EVENTS.has(event)) return { disconnected: 0, reconnected: 0 };

    // Sin RLS: whatsapp_channels se resuelve antes de conocer el tenant. La app
    // solo puede tocar `status` e `history_sync` (GRANT por columna). Una
    // reconexión solo devuelve lo que Meta desconectó, nunca un canal que el
    // operador dejó inactivo. Con UPDATE, TypeORM devuelve [filas, conteo].
    const [rows] = (await this.ds.query(
      reconnect
        ? `UPDATE whatsapp_channels SET status = 'active'
            WHERE waba_id = $1 AND status = 'disconnected' RETURNING id, tenant_id`
        : `UPDATE whatsapp_channels SET status = 'disconnected'
            WHERE waba_id = $1 AND status <> 'disconnected' RETURNING id, tenant_id`,
      [wabaId])) as [{ id: string; tenant_id: string }[], number];

    for (const ch of rows) {
      await runInTenant(this.ds, ch.tenant_id, (m) => recordAudit(m, {
        tenantId: ch.tenant_id, actor: 'meta', action: reconnect ? 'channel.reconnected' : 'channel.disconnected',
        details: { channelId: ch.id, event },
      }));
    }
    return reconnect ? { disconnected: 0, reconnected: rows.length } : { disconnected: rows.length, reconnected: 0 };
  }
```

- [ ] **Step 4: El runbook**

En `docs/desarrollo-local.md`, añadir antes de "## Coexistencia (Fase 1.5)":
```markdown
## Alta de un cliente (Fase 3)

### Antes del primer cliente (una sola vez)

1. **Tech Provider aprobado** en Meta, con acceso avanzado a `whatsapp_business_management`
   y `whatsapp_business_messaging`.
2. **Configuración de Embedded Signup v4** (Facebook Login for Business → Embedded Signup,
   producto Cloud API con la opción de coexistencia). La v2 deja de funcionar el 15 de
   octubre de 2026. Su ID va en `META_ES_CONFIG_ID`; el de la app, en `META_APP_ID`.
3. En la app de Meta, dominio de `PUBLIC_BASE_URL` permitido para el SDK de JavaScript y
   webhooks suscritos a `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`
   y `account_update`.
4. `META_GRAPH_VERSION` en la versión vigente (v25.0 al escribir esto; v21.0 sale de soporte).

### Cada cliente

```bash
pnpm tenant create peluqueria-ana "Peluquería Ana"
```

Imprime un enlace de un solo uso (vence en 72 h). Se lo mandas al cliente; él lo abre, toca
"Conectar WhatsApp" y escanea el QR desde su app de WhatsApp Business. Al terminar, el canal
queda registrado y se piden a Meta el historial y los contactos.

```bash
pnpm tenant:apply clientes/peluqueria-ana.yaml
```

Carga su agenda. Si ya tiene canal, el negocio pasa solo a `active` y empieza a responder.
Hasta entonces guarda todo lo que llega, sin responder.

```bash
pnpm tenant list
```

Estado de cada negocio: canal, historial y **último eco** (la última vez que el dueño escribió
desde su celular). Si el dueño no abre la app en unos 13 días, Meta corta la coexistencia:
vigila esa columna.

Otros comandos: `pnpm tenant link <slug>` (enlace nuevo si se perdió o venció),
`pnpm tenant sync <slug>` (reintentar la sincronización, dentro de las 24 h del alta),
`pnpm tenant suspend <slug>` / `pnpm tenant resume <slug>`.
```

- [ ] **Step 5: Correr todo**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/coexistence/account-update.processor.ts apps/api/test/coexistence/account-update.processor.test.ts apps/api/test/onboarding/alta.e2e.test.ts docs/desarrollo-local.md
git commit -m "feat(onboarding): reconectar canales y verificar el alta de punta a punta"
```

---

## Criterios de salida de la Fase 3

- [ ] `pnpm test` y `pnpm typecheck` en verde; el guardia de privilegios sigue sin INSERT de la app sobre `whatsapp_channels` ni `tenants`.
- [ ] Un negocio nuevo se da de alta y opera **sin que nadie toque SQL**: `tenant create` → enlace → página → `tenant:apply` → activo.
- [ ] Un negocio en alta o suspendido guarda lo que llega y no responde; suspender es inmediato.
- [ ] Dos negocios no pueden compartir el mismo `phone_number_id`.
- [ ] Un enlace se usa una sola vez, vence, y no sirve si el negocio está suspendido.
- [ ] **Con la aprobación de Tech Provider:** un número real se conecta en coexistencia, llegan el historial y los contactos, y el bot respeta al dueño (prueba manual con el runbook).

## Lo que esta fase deliberadamente NO hace

- Alta de números nuevos sin la app (`cloud_api` por Embedded Signup): la coexistencia es el camino del producto; un número dedicado se sigue cargando con `dev:provision`.
- Conectar Google Calendar: el enlace con `purpose = 'google'` ya existe en el modelo, el flujo llega en la Fase 4.
- Avisar al operador por canal propio (correo, WhatsApp) cuando un canal se desconecta o el dueño deja de abrir la app: `pnpm tenant list` lo muestra; el aviso activo queda para el panel (Fase 6).
- Validar la firma del `code` del Embedded Signup más allá de lo que hace Meta al canjearlo.
