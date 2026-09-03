# Fase 3 — Google Calendar: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada recurso del negocio conecta su Google Calendar; las citas creadas en Citara aparecen ahí, lo que el negocio agende directo en Google bloquea franjas en Citara, y cuando la conexión se rompe el sistema sigue agendando y avisa al dueño antes de que lo note un cliente.

**Architecture:** Google es una **proyección**, nunca la fuente de verdad (decisión D4 del spec). La cita se confirma en Postgres primero; la creación del evento va a la cola `sync` con un id determinista que hace la operación idempotente frente a reintentos. La disponibilidad suma lo ocupado en Google a lo ocupado en Citara, pero degrada a solo-Citara si Google no responde.

**Tech Stack:** lo de las fases 1-2. **Sin la librería `googleapis`**: OAuth y tres endpoints REST se implementan con `fetch`, lo que evita ~50 MB de dependencia y deja el manejo de errores explícito.

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md`

**Depende de:** Fases 1 y 2 completas.

## Global Constraints

Además de las de las fases anteriores:

- **La cita es válida sin Google.** Ningún fallo de Google puede impedir, revertir o retrasar la confirmación de una cita en Citara.
- **Todo `events.insert` lleva un `id` provisto por nosotros**, derivado del `appointment.id`. Un reintento devuelve `409` en vez de duplicar.
- El `refresh_token` se guarda cifrado con el `EncryptionService` de la Fase 1. Jamás en logs, jamás en respuestas de API.
- Ante `invalid_grant`, la cuenta pasa a `needs_reauth` y **se avisa al dueño**. Fallar en silencio no es una opción.
- Los ids de evento de Google usan el alfabeto **base32hex** (`0-9`, `a-v`), entre 5 y 1024 caracteres. El UUID en hexadecimal sin guiones cumple; un ULID en Crockford base32 **no** (usa `w`, `x`, `y`, `z`).

---

## Trabajo externo — bloquea la salida de la fase

Debe estar radicado **antes** de empezar la Task 1, porque la verificación de Google
tarda semanas y corre en paralelo al desarrollo:

- [ ] Proyecto en Google Cloud con Calendar API habilitada.
- [ ] Pantalla de consentimiento OAuth configurada, con política de privacidad
      publicada en el dominio propio.
- [ ] Verificación solicitada para los scopes `calendar.events` y `calendar.readonly`
      (son scopes sensibles: exigen video de demostración).
- [ ] Mientras la verificación esté pendiente, la app funciona en modo *testing* con
      hasta 100 usuarios de prueba. **En ese modo el refresh token caduca a los 7
      días** — suficiente para desarrollar, inviable para producción.

---

## File Structure

```
apps/api/src/google/
├─ google-oauth.service.ts     URL de autorización, canje de código, refresco
├─ google-calendar.client.ts   freeBusy, events.insert/patch/delete, watch, list
├─ google-account.repository.ts  lectura/escritura de tokens cifrados
├─ event-id.ts                  derivación determinista del id de evento
├─ google.controller.ts         /google/connect, /google/callback, /google/notifications
└─ sync/
   ├─ push-event.processor.ts   Citara → Google
   ├─ pull-changes.processor.ts Google → Citara (syncToken)
   ├─ renew-watch.processor.ts  renovación de canales
   └─ health-check.processor.ts chequeo diario de tokens
```

---

## Tareas

### Task 1: `google_accounts` y derivación del id de evento

**Files:**
- Create: migración `1725500000000-CreateGoogleAccounts.ts`
- Create: `apps/api/src/google/event-id.ts`
- Test: `apps/api/test/google/event-id.test.ts`, `apps/api/test/google/accounts.test.ts`

**Interfaces:**
- Consumes: `tenantRlsSql`, `EncryptionService`, tabla `resources` (Fase 2).
- Produces: tabla `google_accounts` (uno por `resource`) y `googleEventId(appointmentId: string): string`.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/google/event-id.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { googleEventId } from '../../src/google/event-id';

const BASE32HEX = /^[0-9a-v]{5,1024}$/;

describe('googleEventId', () => {
  it('deriva un id determinista del uuid de la cita', () => {
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(googleEventId(uuid)).toBe(googleEventId(uuid));
  });

  it('produce un id válido para Google (base32hex, 5-1024 chars)', () => {
    expect(googleEventId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toMatch(BASE32HEX);
  });

  it('no contiene guiones ni mayúsculas', () => {
    const id = googleEventId('3F2504E0-4F89-41D3-9A0C-0305E82C3301');
    expect(id).not.toContain('-');
    expect(id).toBe(id.toLowerCase());
  });

  it('citas distintas producen ids distintos', () => {
    expect(googleEventId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'))
      .not.toBe(googleEventId('3f2504e0-4f89-41d3-9a0c-0305e82c3302'));
  });

  it('rechaza algo que no sea un uuid', () => {
    expect(() => googleEventId('no-es-uuid')).toThrow(/uuid/i);
  });

  it('un ULID en Crockford base32 NO sería válido — por eso usamos hex', () => {
    // Documenta la trampa: Crockford incluye w, x, y, z, fuera de base32hex.
    expect('01jw8xyz0000000000000000a').not.toMatch(BASE32HEX);
  });
});
```

`apps/api/test/google/accounts.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { resetDb, seedChannel, seedCatalog, adminQuery, closeHelpers } from '../helpers';

let tenantId: string, resourceId: string, enc: EncryptionService;

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
  await enc.ready();
});
afterAll(async () => { await closeHelpers(); });

describe('google_accounts', () => {
  it('guarda un refresh token cifrado por recurso', async () => {
    await adminQuery(
      `INSERT INTO google_accounts
         (tenant_id, resource_id, email, calendar_id, refresh_token_encrypted)
       VALUES ($1,$2,'maria@salon.co','primary',$3)`,
      [tenantId, resourceId, enc.encrypt('1//refresh-secreto')]);

    const [row] = await adminQuery(
      `SELECT refresh_token_encrypted, status FROM google_accounts WHERE resource_id = $1`,
      [resourceId]);

    expect(enc.decrypt(row.refresh_token_encrypted)).toBe('1//refresh-secreto');
    expect(row.status).toBe('active');
  });

  it('admite un solo calendario por recurso', async () => {
    const insert = () => adminQuery(
      `INSERT INTO google_accounts
         (tenant_id, resource_id, email, calendar_id, refresh_token_encrypted)
       VALUES ($1,$2,'a@b.co','primary',$3)`,
      [tenantId, resourceId, enc.encrypt('x')]);
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('solo acepta estados conocidos', async () => {
    await expect(adminQuery(
      `INSERT INTO google_accounts
         (tenant_id, resource_id, email, calendar_id, refresh_token_encrypted, status)
       VALUES ($1,$2,'a@b.co','primary',$3,'inventado')`,
      [tenantId, resourceId, enc.encrypt('x')])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm vitest run apps/api/test/google`
Expected: FAIL — no existe `googleEventId` ni la tabla.

- [ ] **Step 3: Implementar**

`apps/api/src/google/event-id.ts`:
```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Id de evento determinista, derivado del id de la cita.
 *
 * Es lo que hace idempotente a `events.insert`: si la respuesta se pierde por
 * timeout, el reintento manda el MISMO id y Google contesta 409 en vez de crear
 * un segundo evento en el calendario del cliente.
 *
 * El alfabeto de Google es base32hex (0-9, a-v). El hexadecimal es subconjunto,
 * así que el uuid sin guiones sirve tal cual. Un ULID no serviría: Crockford
 * base32 incluye w, x, y, z.
 */
export function googleEventId(appointmentId: string): string {
  if (!UUID.test(appointmentId)) {
    throw new Error(`Se esperaba un uuid de cita, llegó: ${appointmentId}`);
  }
  return appointmentId.toLowerCase().replace(/-/g, '');
}
```

`packages/db/src/migrations/1725500000000-CreateGoogleAccounts.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls';

export class CreateGoogleAccounts1725500000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE google_accounts (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Uno por recurso: cada médico o estilista tiene su propio calendario.
        resource_id             uuid NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
        email                   varchar(255) NOT NULL,
        calendar_id             varchar(255) NOT NULL DEFAULT 'primary',
        refresh_token_encrypted bytea NOT NULL,
        sync_token              text,
        watch_channel_id        varchar(64),
        watch_resource_id       varchar(255),
        watch_expires_at        timestamptz,
        status                  varchar(32) NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','needs_reauth','revoked')),
        last_checked_at         timestamptz,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE INDEX google_accounts_watch_expiry
        ON google_accounts (watch_expires_at) WHERE status = 'active'
    `);
    for (const sql of tenantRlsSql('google_accounts')) await q.query(sql);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE google_accounts`);
  }
}
```

Extender el `TRUNCATE` de `resetDb()` con `google_accounts`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm vitest run apps/api/test/google`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(google): modelar cuentas de calendario por recurso con token cifrado"
```

---

### Task 2: OAuth — autorización, canje y refresco

**Files:**
- Create: `apps/api/src/google/google-oauth.service.ts`, `google.controller.ts`
- Create: `apps/api/src/google/google.errors.ts`
- Test: `apps/api/test/google/oauth.test.ts`

**Interfaces:**
- Consumes: `EncryptionService`.
- Produces: los tres métodos de abajo. El cacheo del access token NO vive aquí — es
  responsabilidad de `GoogleAccountRepository.accessToken()` (Task 3), que descifra el
  refresh token, llama a `refresh()` y guarda el resultado en Redis.
```ts
class NeedsReauthError extends Error {}

class GoogleOAuthService {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string; email: string }>;
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>;
}
```

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/google/oauth.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleOAuthService } from '../../src/google/google-oauth.service';
import { NeedsReauthError } from '../../src/google/google.errors';

let fetchMock: ReturnType<typeof vi.fn>;
let oauth: GoogleOAuthService;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  oauth = new GoogleOAuthService({
    clientId: 'cid.apps.googleusercontent.com',
    clientSecret: 'secreto',
    redirectUri: 'https://citara.app/google/callback',
  });
});

describe('authorizationUrl', () => {
  it('pide acceso offline y consentimiento forzado', () => {
    const url = new URL(oauth.authorizationUrl('estado-123'));
    // Sin estos dos, Google NO entrega refresh_token en reconexiones.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('pide exactamente los scopes de calendario que necesitamos', () => {
    const url = new URL(oauth.authorizationUrl('e'));
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
  });

  it('propaga el state para atar la respuesta al tenant y recurso', () => {
    const url = new URL(oauth.authorizationUrl('tenant:abc|resource:def'));
    expect(url.searchParams.get('state')).toBe('tenant:abc|resource:def');
  });
});

describe('exchangeCode', () => {
  it('canjea el código por refresh y access token', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        refresh_token: '1//refresh', access_token: 'ya29.access', expires_in: 3599 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ email: 'maria@salon.co' }) });

    const res = await oauth.exchangeCode('4/codigo');
    expect(res).toMatchObject({ refreshToken: '1//refresh', email: 'maria@salon.co' });
  });

  it('falla con mensaje explícito si Google no devuelve refresh_token', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      access_token: 'ya29.access' }) }); // sin refresh_token
    await expect(oauth.exchangeCode('4/codigo'))
      .rejects.toThrow(/refresh_token/);
  });
});

describe('refresh', () => {
  it('obtiene un access token nuevo a partir del refresh token', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      access_token: 'ya29.nuevo', expires_in: 3599 }) });

    const token = await oauth.refresh('1//refresh');
    expect(token.accessToken).toBe('ya29.nuevo');

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('1//refresh');
  });

  it('traduce invalid_grant a NeedsReauthError', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({
      error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) });

    await expect(oauth.refresh('1//muerto')).rejects.toBeInstanceOf(NeedsReauthError);
  });

  it('un 503 de Google NO es NeedsReauthError — es transitorio y se reintenta', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({
      error: 'backendError' }) });

    const err = await oauth.refresh('1//vivo').catch((e) => e);
    expect(err).not.toBeInstanceOf(NeedsReauthError);
  });

  it('nunca incluye el refresh token en el mensaje de error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({
      error: 'invalid_grant' }) });
    const err = await oauth.refresh('1//super-secreto').catch((e) => e);
    expect(String(err.message)).not.toContain('super-secreto');
  });
});
```

> La distinción del quinto test es la que evita el peor fallo operativo de esta
> fase: marcar `needs_reauth` por una caída pasajera de Google desconectaría a
> todos los clientes a la vez y exigiría que cada uno reconecte a mano.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/google/oauth`
Expected: FAIL — no existe `GoogleOAuthService`.

- [ ] **Step 3: Implementar**

`apps/api/src/google/google.errors.ts`:
```ts
export class GoogleError extends Error {}

/** El refresh token murió: revocado, expirado o consentimiento retirado. */
export class NeedsReauthError extends GoogleError {
  constructor() { super('La conexión con Google Calendar requiere volver a autorizarse'); }
}

/** Fallo transitorio: reintentar con retroceso. */
export class GoogleTransientError extends GoogleError {
  constructor(status: number) { super(`Google respondió ${status}, reintentable`); }
}
```

`apps/api/src/google/google-oauth.service.ts`:
```ts
import { NeedsReauthError, GoogleTransientError, GoogleError } from './google.errors';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleOAuthService {
  constructor(private readonly cfg: OAuthConfig) {}

  authorizationUrl(state: string): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES.join(' '));
    // access_type=offline + prompt=consent: sin AMBOS, Google omite el
    // refresh_token cuando el usuario ya había autorizado antes.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{
    refreshToken: string; accessToken: string; email: string;
  }> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        redirect_uri: this.cfg.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const json = await res.json();
    if (!res.ok) throw new GoogleError(`Canje de código falló: ${json?.error ?? res.status}`);

    if (!json.refresh_token) {
      throw new GoogleError(
        'Google no devolvió refresh_token. Revisa access_type=offline y prompt=consent, ' +
        'o revoca el acceso previo de la cuenta en myaccount.google.com/permissions',
      );
    }

    const info = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${json.access_token}` },
    });
    const { email } = await info.json();

    return { refreshToken: json.refresh_token, accessToken: json.access_token, email };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      // invalid_grant es lo ÚNICO que significa "el token murió".
      // Cualquier otro fallo es transitorio: marcar needs_reauth por un 503
      // desconectaría a todos los clientes a la vez.
      if (json?.error === 'invalid_grant') throw new NeedsReauthError();
      throw new GoogleTransientError(res.status);
    }

    return { accessToken: json.access_token, expiresIn: json.expires_in };
  }
}
```

`google.controller.ts` expone `GET /google/connect?resource_id=` (redirige a
`authorizationUrl` con `state` firmado que lleva tenant y recurso) y
`GET /google/callback` (valida el `state`, canjea el código, cifra y guarda el
refresh token, y dispara el primer `watch`).

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/google/oauth`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(google): conectar calendarios por oauth distinguiendo token muerto de fallo transitorio"
```

---

### Task 3: Cliente de Calendar y creación idempotente de eventos

**Files:**
- Create: `apps/api/src/google/google-calendar.client.ts`, `google-account.repository.ts`
- Create: `apps/api/src/google/sync/push-event.processor.ts`
- Test: `apps/api/test/google/calendar-client.test.ts`, `apps/api/test/google/push-event.test.ts`

**Interfaces:**
- Consumes: `GoogleOAuthService`, `googleEventId`, `EncryptionService`, tabla `appointments`.
- Produces:
```ts
class GoogleCalendarClient {
  freeBusy(token: string, calendarId: string, from: Date, to: Date): Promise<BusyInterval[]>;
  insertEvent(token: string, calendarId: string, event: EventInput): Promise<{ id: string; created: boolean }>;
  deleteEvent(token: string, calendarId: string, eventId: string): Promise<void>;
  listChanges(token: string, calendarId: string, syncToken?: string): Promise<{ items: GEvent[]; nextSyncToken?: string; expired: boolean }>;
  watch(token: string, calendarId: string, address: string, channelId: string): Promise<{ resourceId: string; expiration: Date }>;
}
type EventInput = { id: string; summary: string; description?: string;
                    start: Date; end: Date; timezone: string };
```
- `insertEvent` devuelve `{ created: false }` cuando Google responde `409` — el evento ya existía y eso es éxito, no error.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/google/calendar-client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleCalendarClient } from '../../src/google/google-calendar.client';
import { NeedsReauthError, GoogleTransientError } from '../../src/google/google.errors';

let fetchMock: ReturnType<typeof vi.fn>;
let client: GoogleCalendarClient;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  client = new GoogleCalendarClient();
});

const evento = {
  id: '3f2504e04f8941d39a0c0305e82c3301',
  summary: 'Corte de cabello — Ana',
  start: new Date('2026-09-10T15:00:00Z'),
  end: new Date('2026-09-10T15:30:00Z'),
  timezone: 'America/Bogota',
};

describe('insertEvent', () => {
  it('envía el id que nosotros derivamos, no uno de Google', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ id: evento.id }) });

    const res = await client.insertEvent('ya29.token', 'primary', evento);
    expect(res).toEqual({ id: evento.id, created: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.id).toBe(evento.id);
    expect(body.start).toEqual({
      dateTime: '2026-09-10T15:00:00.000Z', timeZone: 'America/Bogota' });
  });

  it('un 409 significa "ya existía": éxito, no error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409,
      json: async () => ({ error: { message: 'The requested identifier already exists' } }) });

    const res = await client.insertEvent('ya29.token', 'primary', evento);
    expect(res).toEqual({ id: evento.id, created: false });
  });

  it('un 401 se traduce a NeedsReauthError', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(client.insertEvent('ya29.malo', 'primary', evento))
      .rejects.toBeInstanceOf(NeedsReauthError);
  });

  it('un 429 y un 5xx son transitorios', async () => {
    for (const status of [429, 500, 503]) {
      fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({}) });
      await expect(client.insertEvent('ya29.token', 'primary', evento))
        .rejects.toBeInstanceOf(GoogleTransientError);
    }
  });
});

describe('freeBusy', () => {
  it('devuelve los intervalos ocupados como fechas', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      calendars: { primary: { busy: [
        { start: '2026-09-10T16:00:00Z', end: '2026-09-10T17:00:00Z' },
      ] } } }) });

    const busy = await client.freeBusy('ya29.token', 'primary',
      new Date('2026-09-10T00:00:00Z'), new Date('2026-09-11T00:00:00Z'));

    expect(busy).toEqual([{
      start: new Date('2026-09-10T16:00:00Z'),
      end: new Date('2026-09-10T17:00:00Z'),
    }]);
  });

  it('devuelve vacío si el calendario no reporta ocupación', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ calendars: { primary: {} } }) });
    expect(await client.freeBusy('t', 'primary', new Date(), new Date())).toEqual([]);
  });
});

describe('listChanges', () => {
  it('marca expired cuando Google responde 410 GONE', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 410, json: async () => ({}) });
    const res = await client.listChanges('t', 'primary', 'token-viejo');
    // 410 = el syncToken caducó: toca resincronizar completo, no es un error.
    expect(res.expired).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('devuelve los cambios y el siguiente syncToken', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      items: [{ id: 'abc', status: 'cancelled' }], nextSyncToken: 'tok-2' }) });
    const res = await client.listChanges('t', 'primary', 'tok-1');
    expect(res.nextSyncToken).toBe('tok-2');
    expect(res.items).toHaveLength(1);
    expect(res.expired).toBe(false);
  });
});
```

`apps/api/test/google/push-event.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { PushEventProcessor } from '../../src/google/sync/push-event.processor';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact,
         seedGoogleAccount, adminQuery, closeHelpers, bookOne } from '../helpers';

let ds: DataSource, processor: PushEventProcessor, fetchMock: ReturnType<typeof vi.fn>;
let tenantId: string, resourceId: string, appointmentId: string;

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  await seedContact(tenantId);
  await seedGoogleAccount(tenantId, resourceId);
  appointmentId = await bookOne(tenantId);

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200,
    json: async () => ({ access_token: 'ya29.t', expires_in: 3599, id: 'x' }) });
  vi.stubGlobal('fetch', fetchMock);

  if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
  processor = new PushEventProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });

describe('PushEventProcessor', () => {
  it('crea el evento y marca la cita como sincronizada', async () => {
    await processor.process({ tenantId, appointmentId });

    const [cita] = await adminQuery(
      `SELECT google_event_id, google_sync_status FROM appointments WHERE id = $1`,
      [appointmentId]);
    expect(cita.google_sync_status).toBe('synced');
    expect(cita.google_event_id).toBe(appointmentId.replace(/-/g, ''));
  });

  it('un reintento tras 409 deja la cita como sincronizada igual', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ access_token: 'ya29.t', expires_in: 3599 }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) });

    await processor.process({ tenantId, appointmentId });
    const [cita] = await adminQuery(
      `SELECT google_sync_status FROM appointments WHERE id = $1`, [appointmentId]);
    expect(cita.google_sync_status).toBe('synced');
  });

  it('si el token murió, marca la cuenta needs_reauth y NO toca la cita', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant' }) });

    await processor.process({ tenantId, appointmentId });

    const [cuenta] = await adminQuery(
      `SELECT status FROM google_accounts WHERE resource_id = $1`, [resourceId]);
    expect(cuenta.status).toBe('needs_reauth');

    // LA CITA SIGUE CONFIRMADA: Google es proyección, no fuente de verdad.
    const [cita] = await adminQuery(
      `SELECT status, google_sync_status FROM appointments WHERE id = $1`, [appointmentId]);
    expect(cita.status).toBe('confirmed');
    expect(cita.google_sync_status).toBe('failed');
  });

  it('sin cuenta de Google conectada, la cita queda skipped y confirmada', async () => {
    await adminQuery(`DELETE FROM google_accounts WHERE resource_id = $1`, [resourceId]);
    await processor.process({ tenantId, appointmentId });

    const [cita] = await adminQuery(
      `SELECT status, google_sync_status FROM appointments WHERE id = $1`, [appointmentId]);
    expect(cita.status).toBe('confirmed');
    expect(cita.google_sync_status).toBe('skipped');
  });
});
```

> Los dos últimos tests son la decisión D4 del spec puesta a prueba: pase lo que
> pase con Google, la cita del cliente sigue en pie.

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm vitest run apps/api/test/google/calendar-client apps/api/test/google/push-event`
Expected: FAIL — no existen el cliente ni el procesador.

- [ ] **Step 3: Implementar**

`apps/api/src/google/google-calendar.client.ts`:
```ts
import { NeedsReauthError, GoogleTransientError, GoogleError } from './google.errors';

const BASE = 'https://www.googleapis.com/calendar/v3';

export interface EventInput {
  id: string; summary: string; description?: string;
  start: Date; end: Date; timezone: string;
}
export interface BusyInterval { start: Date; end: Date }
export interface GEvent { id: string; status?: string;
                          start?: { dateTime?: string }; end?: { dateTime?: string } }

export class GoogleCalendarClient {
  async insertEvent(
    token: string, calendarId: string, event: EventInput,
  ): Promise<{ id: string; created: boolean }> {
    const res = await fetch(
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // El id lo ponemos NOSOTROS: es lo que hace idempotente el reintento.
          id: event.id,
          summary: event.summary,
          description: event.description,
          start: { dateTime: event.start.toISOString(), timeZone: event.timezone },
          end: { dateTime: event.end.toISOString(), timeZone: event.timezone },
        }),
      },
    );

    // 409 = ya existe un evento con ese id. Es exactamente lo que queríamos:
    // el reintento no duplicó nada. Éxito, no error.
    if (res.status === 409) return { id: event.id, created: false };

    this.assertOk(res);
    return { id: event.id, created: true };
  }

  async freeBusy(
    token: string, calendarId: string, from: Date, to: Date,
  ): Promise<BusyInterval[]> {
    const res = await fetch(`${BASE}/freeBusy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: from.toISOString(), timeMax: to.toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    this.assertOk(res);

    const json = await res.json();
    const busy = json?.calendars?.[calendarId]?.busy ?? [];
    return busy.map((b: { start: string; end: string }) => ({
      start: new Date(b.start), end: new Date(b.end),
    }));
  }

  async deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
    const res = await fetch(
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    // 404/410 = ya no está. El objetivo se cumplió igual.
    if (res.status === 404 || res.status === 410) return;
    this.assertOk(res);
  }

  async listChanges(
    token: string, calendarId: string, syncToken?: string,
  ): Promise<{ items: GEvent[]; nextSyncToken?: string; expired: boolean }> {
    const url = new URL(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
    if (syncToken) url.searchParams.set('syncToken', syncToken);
    else url.searchParams.set('timeMin', new Date().toISOString());
    url.searchParams.set('showDeleted', 'true');

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    // 410 GONE = el syncToken caducó. No es un fallo: toca resincronizar completo.
    if (res.status === 410) return { items: [], expired: true };
    this.assertOk(res);

    const json = await res.json();
    return { items: json.items ?? [], nextSyncToken: json.nextSyncToken, expired: false };
  }

  async watch(
    token: string, calendarId: string, address: string, channelId: string,
  ): Promise<{ resourceId: string; expiration: Date }> {
    const res = await fetch(
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: channelId, type: 'web_hook', address }),
      },
    );
    this.assertOk(res);

    const json = await res.json();
    return { resourceId: json.resourceId, expiration: new Date(Number(json.expiration)) };
  }

  private assertOk(res: Response): void {
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new NeedsReauthError();
    if (res.status === 429 || res.status >= 500) throw new GoogleTransientError(res.status);
    throw new GoogleError(`Google Calendar respondió ${res.status}`);
  }
}
```

`apps/api/src/google/sync/push-event.processor.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { runInTenant } from '../../tenancy/tenant-context';
import { GoogleCalendarClient } from '../google-calendar.client';
import { GoogleAccountRepository } from '../google-account.repository';
import { googleEventId } from '../event-id';
import { NeedsReauthError, GoogleTransientError } from '../google.errors';

export interface PushEventJob { tenantId: string; appointmentId: string }

@Injectable()
export class PushEventProcessor {
  private readonly log = new Logger(PushEventProcessor.name);

  constructor(
    private readonly ds: DataSource,
    private readonly accounts = new GoogleAccountRepository(ds),
    private readonly calendar = new GoogleCalendarClient(),
  ) {}

  async process(job: PushEventJob): Promise<void> {
    const { tenantId, appointmentId } = job;

    const cita = await runInTenant(this.ds, tenantId, async (m) => {
      const [row] = await m.query(
        `SELECT a.id, a.resource_id, a.starts_at, a.ends_at, a.customer_name,
                s.name AS servicio, t.timezone
           FROM appointments a
           JOIN services s ON s.id = a.service_id
           JOIN tenants  t ON t.id = a.tenant_id
          WHERE a.id = $1 AND a.status = 'confirmed'`,
        [appointmentId]);
      return row;
    });
    if (!cita) return;

    const account = await this.accounts.activeForResource(tenantId, cita.resource_id);
    if (!account) {
      // Sin calendario conectado: no es un fallo. La cita vive en Citara.
      await this.mark(tenantId, appointmentId, 'skipped', null);
      return;
    }

    try {
      const token = await this.accounts.accessToken(tenantId, account);
      const eventId = googleEventId(appointmentId);

      await this.calendar.insertEvent(token, account.calendarId, {
        id: eventId,
        summary: `${cita.servicio} — ${cita.customer_name}`,
        start: cita.starts_at,
        end: cita.ends_at,
        timezone: cita.timezone,
      });

      await this.mark(tenantId, appointmentId, 'synced', eventId);
    } catch (err) {
      if (err instanceof NeedsReauthError) {
        await this.accounts.markNeedsReauth(tenantId, account.id);
        await this.mark(tenantId, appointmentId, 'failed', null);
        this.log.error(`Cuenta de Google ${account.id} requiere reautorización`);
        return; // sin relanzar: reintentar no arregla un token muerto
      }
      if (err instanceof GoogleTransientError) throw err; // que BullMQ reintente
      await this.mark(tenantId, appointmentId, 'failed', null);
      throw err;
    }
  }

  private mark(tenantId: string, id: string, status: string, eventId: string | null) {
    return runInTenant(this.ds, tenantId, (m) =>
      m.query(
        `UPDATE appointments
            SET google_sync_status = $2, google_event_id = COALESCE($3, google_event_id),
                updated_at = now()
          WHERE id = $1`,
        [id, status, eventId]));
  }
}
```

`GoogleAccountRepository` expone `activeForResource(tenantId, resourceId)`,
`accessToken(tenantId, account)` (descifra el refresh token, llama
`GoogleOAuthService.refresh` y cachea el access token en Redis por su `expiresIn`
menos un minuto) y `markNeedsReauth(tenantId, accountId)`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm vitest run apps/api/test/google`
Expected: PASS, 8 del cliente + 4 del push.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(google): crear eventos de forma idempotente sin que un fallo afecte la cita"
```

---

### Task 4: Disponibilidad que suma lo ocupado en Google

**Files:**
- Modify: `apps/api/src/scheduling/availability.service.ts`
- Test: `apps/api/test/google/availability-with-google.test.ts`

**Interfaces:**
- Consumes: `GoogleCalendarClient.freeBusy`, `GoogleAccountRepository`.
- Produces: `AvailabilityService.slotsFor` incorpora los intervalos de Google. **Degrada a solo-Citara** si Google falla: mostrar franjas de más es preferible a no mostrar ninguna.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/google/availability-with-google.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { AvailabilityService } from '../../src/scheduling/availability.service';
import { resetDb, seedChannel, seedCatalog, seedHours,
         seedGoogleAccount, closeHelpers } from '../helpers';

let ds: DataSource, availability: AvailabilityService, fetchMock: ReturnType<typeof vi.fn>;
let tenantId: string, serviceId: string, resourceId: string;

const DIA_DESDE = new Date('2026-09-10T00:00:00Z');
const DIA_HASTA = new Date('2026-09-11T00:00:00Z');
const AHORA = new Date('2026-09-08T12:00:00Z');

const hhmm = (d: Date) => new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

const mockGoogle = (busy: { start: string; end: string }[]) => {
  fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ access_token: 'ya29.t', expires_in: 3599 }) })
    .mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ calendars: { primary: { busy } } }) });
  vi.stubGlobal('fetch', fetchMock);
};

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  await seedGoogleAccount(tenantId, resourceId);
  if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
  availability = new AvailabilityService(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });

describe('disponibilidad con Google', () => {
  it('descuenta lo que el negocio agendó directo en su calendario', async () => {
    // 15:00–16:00Z = 10:00–11:00 en Bogotá.
    mockGoogle([{ start: '2026-09-10T15:00:00Z', end: '2026-09-10T16:00:00Z' }]);

    const slots = await availability.slotsFor(
      tenantId, serviceId, resourceId, DIA_DESDE, DIA_HASTA, AHORA);

    const horas = slots.map((s) => hhmm(s.start));
    expect(horas).not.toContain('10:00');
    expect(horas).not.toContain('10:30');
    expect(horas).toContain('09:00');
    expect(horas).toContain('11:00');
  });

  it('DEGRADA a solo-Citara si Google falla — nunca se queda sin franjas', async () => {
    fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const slots = await availability.slotsFor(
      tenantId, serviceId, resourceId, DIA_DESDE, DIA_HASTA, AHORA);

    expect(slots.length).toBeGreaterThan(0);
  });

  it('no llama a Google si el recurso no tiene calendario conectado', async () => {
    await (await import('../helpers')).adminQuery(
      `DELETE FROM google_accounts WHERE resource_id = $1`, [resourceId]);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const slots = await availability.slotsFor(
      tenantId, serviceId, resourceId, DIA_DESDE, DIA_HASTA, AHORA);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(slots.length).toBeGreaterThan(0);
  });

  it('no llama a Google si la cuenta está en needs_reauth', async () => {
    await (await import('../helpers')).adminQuery(
      `UPDATE google_accounts SET status = 'needs_reauth' WHERE resource_id = $1`,
      [resourceId]);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await availability.slotsFor(tenantId, serviceId, resourceId, DIA_DESDE, DIA_HASTA, AHORA);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/google/availability-with-google`
Expected: FAIL — `slotsFor` ignora Google.

- [ ] **Step 3: Implementar**

En `AvailabilityService.slotsFor`, tras cargar `busy` de la base y antes de llamar
`computeSlots`:

```ts
const externalBusy = await this.googleBusy(tenantId, resourceId, from, to);

return computeSlots({
  /* … */
  busy: [...localBusy, ...externalBusy],
});
```

Y el método nuevo:
```ts
/**
 * Ocupación reportada por Google Calendar.
 *
 * DEGRADA a lista vacía ante cualquier fallo: ofrecer una franja que luego
 * resulte ocupada es molesto; no ofrecer ninguna porque Google tuvo un 503
 * deja al negocio sin agendar. Lo primero se recupera con un mensaje, lo
 * segundo se pierde como venta.
 */
private async googleBusy(
  tenantId: string, resourceId: string | null, from: Date, to: Date,
): Promise<BusyInterval[]> {
  if (!resourceId) return [];

  const account = await this.accounts.activeForResource(tenantId, resourceId);
  if (!account) return [];

  try {
    const token = await this.accounts.accessToken(tenantId, account);
    return await this.calendar.freeBusy(token, account.calendarId, from, to);
  } catch (err) {
    if (err instanceof NeedsReauthError) {
      await this.accounts.markNeedsReauth(tenantId, account.id);
    }
    this.log.warn(`freeBusy falló para el recurso ${resourceId}; sigo sin Google`);
    return [];
  }
}
```

`activeForResource` filtra por `status = 'active'`, así que los dos últimos tests
pasan sin código adicional.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test`
Expected: PASS, toda la suite de las fases 1-3.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(google): descontar la ocupación del calendario degradando si google falla"
```

---

### Task 5: Sincronización inversa y renovación de canales

**Files:**
- Create: `apps/api/src/google/sync/pull-changes.processor.ts`, `renew-watch.processor.ts`
- Modify: `apps/api/src/google/google.controller.ts` (endpoint de notificaciones)
- Test: `apps/api/test/google/pull-changes.test.ts`, `renew-watch.test.ts`

**Interfaces:**
- Consumes: `GoogleCalendarClient.listChanges` y `.watch`.
- Produces: `PullChangesProcessor.process({ tenantId, accountId })` y `RenewWatchProcessor.process()`. `POST /google/notifications` recibe el push de Google y encola un pull.

**El fallo silencioso que hay que vigilar:** los canales de `watch` caducan (un mes
como máximo). Si el job de renovación falla, se dejan de recibir cambios **sin ningún
error visible** — el sistema simplemente deja de enterarse. Por eso la Task incluye
una métrica de canales vencidos, no solo el job.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/google/pull-changes.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { PullChangesProcessor } from '../../src/google/sync/pull-changes.processor';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact,
         seedGoogleAccount, bookOne, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource, processor: PullChangesProcessor;
let tenantId: string, resourceId: string, accountId: string, appointmentId: string;

const mockList = (payload: object, status = 200) => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ access_token: 'ya29.t', expires_in: 3599 }) })
    .mockResolvedValueOnce({ ok: status === 200, status, json: async () => payload }));
};

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  await seedContact(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  appointmentId = await bookOne(tenantId);
  await adminQuery(
    `UPDATE appointments SET google_event_id = $2, google_sync_status = 'synced' WHERE id = $1`,
    [appointmentId, appointmentId.replace(/-/g, '')]);
  if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
  processor = new PullChangesProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });

describe('PullChangesProcessor', () => {
  it('cancela en Citara la cita que el negocio borró en Google', async () => {
    mockList({ items: [{ id: appointmentId.replace(/-/g, ''), status: 'cancelled' }],
               nextSyncToken: 'tok-2' });

    await processor.process({ tenantId, accountId });

    const [cita] = await adminQuery(
      `SELECT status FROM appointments WHERE id = $1`, [appointmentId]);
    expect(cita.status).toBe('cancelled');
  });

  it('guarda el nuevo syncToken para el siguiente barrido', async () => {
    mockList({ items: [], nextSyncToken: 'tok-2' });
    await processor.process({ tenantId, accountId });

    const [cuenta] = await adminQuery(
      `SELECT sync_token FROM google_accounts WHERE id = $1`, [accountId]);
    expect(cuenta.sync_token).toBe('tok-2');
  });

  it('ante un 410 limpia el syncToken para forzar resincronización completa', async () => {
    await adminQuery(`UPDATE google_accounts SET sync_token = 'viejo' WHERE id = $1`, [accountId]);
    mockList({}, 410);

    await processor.process({ tenantId, accountId });

    const [cuenta] = await adminQuery(
      `SELECT sync_token FROM google_accounts WHERE id = $1`, [accountId]);
    expect(cuenta.sync_token).toBeNull();
  });

  it('ignora eventos de Google que no corresponden a citas nuestras', async () => {
    mockList({ items: [{ id: 'evento-ajeno-del-dueno', status: 'cancelled' }],
               nextSyncToken: 'tok-2' });

    await processor.process({ tenantId, accountId });

    const [cita] = await adminQuery(
      `SELECT status FROM appointments WHERE id = $1`, [appointmentId]);
    expect(cita.status).toBe('confirmed');
  });
});
```

`apps/api/test/google/renew-watch.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { RenewWatchProcessor } from '../../src/google/sync/renew-watch.processor';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount,
         adminQuery, closeHelpers } from '../helpers';

let ds: DataSource, processor: RenewWatchProcessor;
let tenantId: string, resourceId: string, accountId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  accountId = await seedGoogleAccount(tenantId, resourceId);
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ access_token: 'ya29.t', expires_in: 3599 }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      resourceId: 'res-1', expiration: String(new Date('2026-10-08T12:00:00Z').getTime()) }) }));
  if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
  processor = new RenewWatchProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });

describe('RenewWatchProcessor', () => {
  it('renueva los canales que vencen dentro de las próximas 48 horas', async () => {
    await adminQuery(
      `UPDATE google_accounts SET watch_expires_at = $2 WHERE id = $1`,
      [accountId, new Date('2026-09-09T12:00:00Z')]);

    const renovados = await processor.process(AHORA);
    expect(renovados).toBe(1);

    const [cuenta] = await adminQuery(
      `SELECT watch_resource_id, watch_expires_at FROM google_accounts WHERE id = $1`,
      [accountId]);
    expect(cuenta.watch_resource_id).toBe('res-1');
    expect(new Date(cuenta.watch_expires_at).toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('no toca los canales que aún tienen semanas de vida', async () => {
    await adminQuery(
      `UPDATE google_accounts SET watch_expires_at = $2 WHERE id = $1`,
      [accountId, new Date('2026-10-01T12:00:00Z')]);
    expect(await processor.process(AHORA)).toBe(0);
  });

  it('crea el canal por primera vez si nunca hubo uno', async () => {
    await adminQuery(
      `UPDATE google_accounts SET watch_expires_at = NULL WHERE id = $1`, [accountId]);
    expect(await processor.process(AHORA)).toBe(1);
  });

  it('cuenta como vencidos los canales ya caducados — métrica de alerta', async () => {
    await adminQuery(
      `UPDATE google_accounts SET watch_expires_at = $2 WHERE id = $1`,
      [accountId, new Date('2026-09-01T12:00:00Z')]);
    expect(await processor.expiredCount(AHORA)).toBe(1);
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm vitest run apps/api/test/google/pull-changes apps/api/test/google/renew-watch`
Expected: FAIL — no existen los procesadores.

- [ ] **Step 3: Implementar**

`pull-changes.processor.ts`: pide `listChanges(token, calendarId, syncToken)`. Si
`expired`, limpia `sync_token` y termina (el siguiente barrido resincroniza). Si no,
por cada `item` con `status === 'cancelled'` busca `appointments` por
`google_event_id = item.id` y, si existe y sigue confirmada, la cancela y cancela sus
recordatorios (`RemindersService.syncWithAppointment`). Los eventos que no
correspondan a ninguna cita se ignoran: son reuniones propias del dueño. Al final
guarda `nextSyncToken`.

`renew-watch.processor.ts`:
```ts
const RENEW_WINDOW_HOURS = 48;

async process(now = new Date()): Promise<number> {
  const limite = new Date(now.getTime() + RENEW_WINDOW_HOURS * 3600_000);

  // `tenants` no lleva RLS; el resto se lee dentro del contexto de cada uno.
  const tenants = await this.ds.query(`SELECT id FROM tenants WHERE status = 'active'`);
  let renovados = 0;

  for (const t of tenants) {
    const cuentas = await runInTenant(this.ds, t.id, (m) =>
      m.query(
        `SELECT id, resource_id, calendar_id FROM google_accounts
          WHERE status = 'active' AND (watch_expires_at IS NULL OR watch_expires_at <= $1)`,
        [limite]));

    for (const cuenta of cuentas) {
      try {
        const token = await this.accounts.accessToken(t.id, cuenta);
        const channelId = randomUUID();
        const { resourceId, expiration } = await this.calendar.watch(
          token, cuenta.calendar_id,
          `${process.env.PUBLIC_URL}/google/notifications`, channelId,
        );
        await runInTenant(this.ds, t.id, (m) =>
          m.query(
            `UPDATE google_accounts
                SET watch_channel_id = $2, watch_resource_id = $3,
                    watch_expires_at = $4, updated_at = now()
              WHERE id = $1`,
            [cuenta.id, channelId, resourceId, expiration]));
        renovados++;
      } catch (err) {
        // Un canal que no se renueva deja de avisar EN SILENCIO.
        // Se registra fuerte y expiredCount() lo hará visible en métricas.
        this.log.error(`No pude renovar el watch de la cuenta ${cuenta.id}: ${err}`);
      }
    }
  }
  return renovados;
}

/** Canales ya vencidos: si esto sube de cero, hay ceguera ante cambios. */
async expiredCount(now = new Date()): Promise<number> {
  const tenants = await this.ds.query(`SELECT id FROM tenants WHERE status = 'active'`);
  let total = 0;
  for (const t of tenants) {
    const [row] = await runInTenant(this.ds, t.id, (m) =>
      m.query(
        `SELECT count(*)::int AS n FROM google_accounts
          WHERE status = 'active' AND watch_expires_at IS NOT NULL AND watch_expires_at <= $1`,
        [now]));
    total += row.n;
  }
  return total;
}
```

`POST /google/notifications` lee las cabeceras `x-goog-channel-id` y
`x-goog-resource-state`, responde `200` de inmediato y encola un
`PullChangesProcessor` para la cuenta dueña de ese canal.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm vitest run apps/api/test/google`
Expected: PASS, 8 tests nuevos.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(google): reflejar los cambios del calendario del negocio y renovar los canales de aviso"
```

---

### Task 6: Chequeo diario de salud de las conexiones

**Files:**
- Create: `apps/api/src/google/sync/health-check.processor.ts`
- Test: `apps/api/test/google/health-check.test.ts`

**Interfaces:**
- Consumes: `GoogleAccountRepository`.
- Produces: `HealthCheckProcessor.process(now): Promise<{ checked: number; broken: string[] }>`. Marca `needs_reauth` y deja el aviso pendiente para el dueño.

- [ ] **Step 1: Escribir el test que falla**

`apps/api/test/google/health-check.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { HealthCheckProcessor } from '../../src/google/sync/health-check.processor';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount,
         adminQuery, closeHelpers } from '../helpers';

let ds: DataSource, processor: HealthCheckProcessor;
let tenantId: string, resourceId: string, accountId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');

beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  ({ resourceId } = await seedCatalog(tenantId));
  accountId = await seedGoogleAccount(tenantId, resourceId);
  if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
  processor = new HealthCheckProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });

describe('HealthCheckProcessor', () => {
  it('deja intacta una cuenta cuyo token sigue vivo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ access_token: 'ya29.t', expires_in: 3599 }) }));

    const res = await processor.process(AHORA);
    expect(res).toMatchObject({ checked: 1, broken: [] });

    const [c] = await adminQuery(`SELECT status, last_checked_at FROM google_accounts WHERE id = $1`,
                                 [accountId]);
    expect(c.status).toBe('active');
    expect(c.last_checked_at).not.toBeNull();
  });

  it('marca needs_reauth ante invalid_grant y lo reporta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant' }) }));

    const res = await processor.process(AHORA);
    expect(res.broken).toEqual([accountId]);

    const [c] = await adminQuery(`SELECT status FROM google_accounts WHERE id = $1`, [accountId]);
    expect(c.status).toBe('needs_reauth');
  });

  it('un 503 NO rompe la cuenta: se reintenta mañana', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503,
      json: async () => ({}) }));

    const res = await processor.process(AHORA);
    expect(res.broken).toEqual([]);

    const [c] = await adminQuery(`SELECT status FROM google_accounts WHERE id = $1`, [accountId]);
    expect(c.status).toBe('active');
  });

  it('no revisa cuentas ya marcadas como rotas', async () => {
    await adminQuery(`UPDATE google_accounts SET status = 'needs_reauth' WHERE id = $1`,
                     [accountId]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await processor.process(AHORA);
    expect(res.checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run apps/api/test/google/health-check`
Expected: FAIL — no existe `HealthCheckProcessor`.

- [ ] **Step 3: Implementar**

`health-check.processor.ts`: recorre los tenants activos, y por cada
`google_accounts` con `status = 'active'` intenta un refresco de token. Ante
`NeedsReauthError` marca `needs_reauth` y agrega el id a `broken`; ante
`GoogleTransientError` no cambia nada (mañana se reintenta). Siempre actualiza
`last_checked_at`. Al terminar, por cada cuenta rota encola una notificación al
dueño (correo y aviso en el panel; el envío real se implementa en la Fase 5,
aquí basta con dejar la fila en una tabla `notifications`).

Se registra como job repetible diario:
```ts
await queue.add('health-check', {}, {
  repeat: { pattern: '0 6 * * *', tz: 'America/Bogota' },
  jobId: 'google-health-check', // evita duplicar el repetible al reiniciar
});
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run apps/api/test/google`
Expected: PASS, toda la carpeta.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(google): detectar conexiones rotas a diario y avisar antes de que falle una cita"
```

---

## Criterios de salida de la Fase 3

- [ ] `pnpm test` en verde en toda la suite de las fases 1-3.
- [ ] Un negocio conecta su Google Calendar desde un enlace y el token queda cifrado.
- [ ] Una cita agendada por WhatsApp aparece en el calendario del recurso correcto.
- [ ] Reintentar la sincronización de la misma cita **no** crea un segundo evento.
- [ ] Un evento creado a mano en Google bloquea esa franja en Citara.
- [ ] Borrar el evento en Google cancela la cita en Citara.
- [ ] Con Google caído, se sigue pudiendo agendar; las citas quedan `pending` y se
      sincronizan al volver.
- [ ] Revocar el acceso desde la cuenta de Google marca `needs_reauth` en menos de 24 h
      y **no** impide seguir agendando.
- [ ] La verificación de scopes de Google está aprobada, o se conoce la fecha estimada.
