# Fase 1.5 — Coexistencia (núcleo): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un número en coexistencia con la app de WhatsApp Business funcione sin que el bot le hable encima al dueño: los mensajes que el dueño envía desde su celular, el historial, los contactos, los estados de entrega y las desconexiones entran al sistema, y una única regla de control decide en cada mensaje si responde el bot o se calla.

**Architecture:** El control vive en `conversations` (`control`, `human_until`, `control_reason`) y lo alimentan cuatro fuentes: el eco del celular, el paso `handoff` del flujo, el operador (fase 6) y el historial. `FlowRunner` lo consulta dentro de la transacción del turno, antes de avanzar; `OutboundProcessor` lo vuelve a consultar justo antes de enviar y marca `superseded` lo que el bot ya no debe decir. El normalizador enruta por `changes[].field`: los ecos, los estados y las desconexiones van a la cola `inbound` (comparten el bloqueo de la conversación con los mensajes del cliente) y el historial y los contactos van a una cola nueva, `sync`, con concurrencia 1.

**Tech Stack:** lo de la Fase 1 (Node 24, pnpm 10, TypeScript 5.9, NestJS 11, TypeORM 0.3, PostgreSQL 16, Redis 7, BullMQ 5, Vitest 2). Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-09-03-plataforma-whatsapp-citas-design.md` (v2) — §4 modelo de datos, §5 entrada de WhatsApp, §6 control, §7.1 estados de salida.

## Global Constraints

- Todas las restricciones de la Fase 1 siguen vigentes: RLS con `ENABLE` y `FORCE` en toda tabla con `tenant_id`, la app como `citara_app` sin bypass, `TZ=UTC`, secretos cifrados y nunca en logs, webhook con `200` en menos de 100 ms.
- **Toda tabla nueva se declara en `PRESUPUESTO`** de `packages/db/test/rls-inventory.test.ts`. Si el guardia se pone en rojo por una tabla nueva, se añade su entrada; **jamás se debilita el guardia**.
- **Migraciones:** `import type { MigrationInterface, QueryRunner } from 'typeorm'` (con `type`) y `import { tenantRlsSql } from '../rls.ts'` (con extensión). Una migración por tabla.
- **Servicios Nest:** los parámetros del constructor se importan como valor (`import { DataSource } from 'typeorm'`), **nunca** con `import type`: `emitDecoratorMetadata` necesita la referencia en runtime.
- **Todo procesador nuevo se registra en `providers` de `apps/api/src/app.module.ts`** en la misma tarea que lo crea. Un test que construye la clase a mano no prueba el cableado; el worker real hace `ctx.get(...)`.
- **TypeORM con `UPDATE` o `DELETE` devuelve `[filas, conteo]`**, no las filas. Para saber si una actualización ganó: `const [, affected] = (await m.query(...)) as [unknown[], number]`.
- **Las transiciones de `messages.status` son compare-and-set** sobre el estado previo (`WHERE id = $1 AND status = $2`).
- **Los payloads de coexistencia de este plan son ejemplos según la documentación de Meta, no grabaciones.** Las constantes marcadas `VERIFICAR` se contrastan con la documentación oficial al grabar el primer payload real.
- **Tests:** `pnpm test` usa la base `citara_test` y la db 1 de Redis; nunca los datos de desarrollo. Un archivo: `pnpm test <ruta>`. Helpers en `apps/api/test/helpers.ts`: `resetDb`, `seedChannel` (tenant `salon`, canal `106540`, WABA `102290`), `seedFlow`, `adminQuery`, `closeHelpers`.
- **Commits:** Conventional Commits en español, `tipo(scope): descripción`, **un solo `-m`, sin cuerpo y sin trailer `Co-Authored-By`**.

## Review Focus

Entradas que el spec implica y que ningún test cubriría por sí solo; cada una lleva su test en la tarea que es dueña del código:

1. **Un eco cuyo destinatario llega con `+`** (`"+573001112233"`) debe caer en el mismo contacto que el cliente que escribe sin `+`. → Task 5.
2. **Un eco de un tipo que no entendemos** (sticker, reacción) sigue siendo actividad del dueño y debe darle el control. → Task 6.
3. **Un mensaje que ya llegó por eco y vuelve a aparecer en el historial** no se duplica. → Task 8.
4. **Un chunk de historial que llega después del chunk final** (reentregas) también aplica la regla del dueño activo. → Task 8.
5. **Una desconexión de una WABA con varios números** desconecta todos sus canales. → Task 9.

---

## File Structure

```
packages/db/src/migrations/
├─ 1725301300000-AddTakeoverHoursToTenants.ts
├─ 1725301400000-AddCoexistenceToWhatsappChannels.ts
├─ 1725301500000-AddControlToConversations.ts
├─ 1725301600000-AddOriginToMessages.ts
├─ 1725301700000-AddSavedNameToContacts.ts
└─ 1725301800000-CreateAuditLog.ts
packages/shared/src/inbound-message.ts     eventos tipados de entrada (PhoneEcho, HistoryChunk, ...)
apps/api/src/
├─ audit/audit.ts                          recordAudit: única forma de escribir en audit_log
├─ conversations/control.ts                regla de control (puras + operaciones SQL)
├─ coexistence/
│  ├─ echo.processor.ts                    eco del celular → saliente 'phone' + control humano
│  ├─ history.processor.ts                 importa historial + regla del dueño activo
│  ├─ contacts-sync.processor.ts           saved_name
│  └─ account-update.processor.ts          desconexión del canal
├─ queues/status.processor.ts              estados de entrega, solo hacia adelante
├─ queues/sync.queue.ts                    cola `sync`
├─ whatsapp/normalizer.ts                  enruta por changes[].field
├─ whatsapp/ingest.service.ts              encola cada evento en su cola
└─ queues/workers.ts                       despacha por job.name
apps/api/test/
├─ conversations/control.test.ts
├─ coexistence/*.test.ts
├─ queues/status.processor.test.ts
└─ whatsapp/fixtures/coexistence.ts        payloads de ejemplo de coexistencia
```

---

## Tareas

### Task 1: Modelo de datos de coexistencia

**Files:**
- Create: las seis migraciones de la File Structure
- Create: `packages/db/test/coexistence-schema.test.ts`
- Modify: `packages/db/test/rls-inventory.test.ts`
- Modify: `packages/db/src/entities/{tenant,whatsapp-channel,conversation,message,contact}.entity.ts`
- Modify: `apps/api/src/queues/inbound.processor.ts` (INSERT del entrante)
- Modify: `apps/api/src/flow-engine/flow-runner.service.ts` (INSERT de los salientes)
- Modify: `apps/api/test/helpers.ts` (`resetDb`)
- Modify: `apps/api/test/queues/outbound.processor.test.ts` (`seedTurn`)
- Modify: `apps/api/test/queues/inbound.processor.test.ts`

**Interfaces:**
- Produces: columnas `tenants.human_takeover_hours`; `whatsapp_channels.mode`, `history_sync` (más `GRANT UPDATE (status, history_sync)` a `citara_app`); `conversations.status` (`open`|`closed`), `control`, `human_until`, `control_reason` (sin `assigned_to`); `messages.origin` (NOT NULL, sin default), `occurred_at`; `contacts.saved_name`; tabla `audit_log` (`tenant_id`, `actor`, `action`, `conversation_id`, `details`, `created_at`), de solo inserción para la app.

- [ ] **Step 1: Escribir el test de esquema que falla**

`packages/db/test/coexistence-schema.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/data-source';

let ds: DataSource;

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await ds.initialize();
  await ds.runMigrations();
});
afterAll(async () => { await ds.destroy(); });

const columns = async (table: string) => {
  const rows: { column_name: string; column_default: string | null; is_nullable: string }[] =
    await ds.query(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return Object.fromEntries(rows.map((r) => [r.column_name, r]));
};

describe('esquema de coexistencia', () => {
  it('una conversación nace abierta y en manos del bot, sin assigned_to', async () => {
    const c = await columns('conversations');
    expect(c.status.column_default).toContain("'open'");
    expect(c.control.column_default).toContain("'bot'");
    expect(c.human_until).toBeDefined();
    expect(c.control_reason).toBeDefined();
    expect(c.assigned_to).toBeUndefined();
  });

  it('todo mensaje declara quién lo escribió y cuándo ocurrió', async () => {
    const c = await columns('messages');
    // Sin default a propósito: un INSERT que olvide el origen debe fallar.
    expect(c.origin.is_nullable).toBe('NO');
    expect(c.origin.column_default).toBeNull();
    expect(c.occurred_at.is_nullable).toBe('NO');
    expect(c.occurred_at.column_default).toContain('clock_timestamp');
  });

  it('un canal nace como cloud_api sin historial que sincronizar', async () => {
    const c = await columns('whatsapp_channels');
    expect(c.mode.column_default).toContain("'cloud_api'");
    expect(c.history_sync.column_default).toContain("'not_applicable'");
  });

  it('un negocio trae 12 horas de plazo humano por defecto', async () => {
    const c = await columns('tenants');
    expect(c.human_takeover_hours.column_default).toBe('12');
  });

  it('los contactos pueden guardar el nombre del celular del negocio', async () => {
    const c = await columns('contacts');
    expect(c.saved_name.is_nullable).toBe('YES');
  });

  it('rechaza un origin desconocido', async () => {
    const [con] = await ds.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'messages_origin_check'`);
    for (const o of ['customer', 'bot', 'phone', 'operator', 'history']) expect(con.def).toContain(`'${o}'`);
  });
});
```

- [ ] **Step 2: Añadir al guardia de privilegios lo que esta tarea exige**

En `packages/db/test/rls-inventory.test.ts`, dentro de `PRESUPUESTO`, añadir después de `conversation_sessions`:
```ts
  // Bitácora: la aplicación agrega, nunca corrige ni borra lo que pasó.
  audit_log: ['SELECT', 'INSERT'],
```
Y añadir este test al final del `describe`:
```ts
  it('sobre whatsapp_channels la app solo puede actualizar status e history_sync', async () => {
    // Los ecos de desconexión y el historial cambian el estado del canal desde
    // la aplicación. El GRANT es por columna: el token cifrado, el
    // phone_number_id y la WABA siguen siendo intocables para la app.
    const cols: { column_name: string }[] = await ds.query(`
      SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'whatsapp_channels'
         AND grantee = 'citara_app' AND privilege_type = 'UPDATE'
       ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(['history_sync', 'status']);
  });
```

- [ ] **Step 3: Correr y verlos fallar**

Run: `pnpm test packages/db/test`
Expected: FAIL — `c.control` indefinido, `messages_origin_check` inexistente, y la columna `UPDATE` vacía.

- [ ] **Step 4: Escribir las seis migraciones**

`packages/db/src/migrations/1725301300000-AddTakeoverHoursToTenants.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** La N de la regla de control (spec §6.1): horas que manda el humano tras intervenir. */
export class AddTakeoverHoursToTenants1725301300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants ADD COLUMN human_takeover_hours smallint NOT NULL DEFAULT 12
        CHECK (human_takeover_hours BETWEEN 1 AND 168)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tenants DROP COLUMN human_takeover_hours`);
  }
}
```

`packages/db/src/migrations/1725301400000-AddCoexistenceToWhatsappChannels.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Modalidad del canal (D6) y estado de la importación del historial.
 *
 * El GRANT es por COLUMNA: la app necesita marcar un canal como desconectado
 * (`account_update`) y registrar el avance del historial, pero esta es la única
 * tabla sin RLS que guarda el token de todos los clientes. Un UPDATE de tabla
 * completa le permitiría reescribir el token o el phone_number_id de otro.
 */
export class AddCoexistenceToWhatsappChannels1725301400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE whatsapp_channels
        ADD COLUMN mode varchar(16) NOT NULL DEFAULT 'cloud_api'
          CHECK (mode IN ('cloud_api', 'coexistence')),
        ADD COLUMN history_sync varchar(16) NOT NULL DEFAULT 'not_applicable'
          CHECK (history_sync IN ('not_applicable', 'pending', 'done', 'declined'))
    `);
    await q.query(`GRANT UPDATE (status, history_sync) ON whatsapp_channels TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE UPDATE (status, history_sync) ON whatsapp_channels FROM citara_app`);
    await q.query(`ALTER TABLE whatsapp_channels DROP COLUMN history_sync, DROP COLUMN mode`);
  }
}
```

`packages/db/src/migrations/1725301500000-AddControlToConversations.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quién habla en la conversación (spec §6). De paso separa dos ideas que
 * `status` mezclaba: valía 'bot' por defecto y además servía para
 * abierta/cerrada. Ahora `status` es solo el ciclo de vida y `control` dice
 * quién responde. `assigned_to` (pensado para varios agentes) se elimina: el
 * panel es de un único operador.
 */
export class AddControlToConversations1725301500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE conversations SET status = 'open' WHERE status <> 'closed'`);
    await q.query(`ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'open'`);
    await q.query(`
      ALTER TABLE conversations
        ADD CONSTRAINT conversations_status_check CHECK (status IN ('open', 'closed')),
        DROP COLUMN assigned_to,
        ADD COLUMN control varchar(8) NOT NULL DEFAULT 'bot' CHECK (control IN ('bot', 'human')),
        ADD COLUMN human_until timestamptz,
        ADD COLUMN control_reason varchar(16)
          CHECK (control_reason IN ('phone', 'flow_handoff', 'operator', 'history'))
    `);
    // Una sesión que ya estaba en traspaso conserva el silencio bajo el modelo nuevo.
    await q.query(`
      UPDATE conversations c
         SET control = 'human', human_until = now() + interval '12 hours',
             control_reason = 'flow_handoff'
       WHERE EXISTS (SELECT 1 FROM conversation_sessions s
                      WHERE s.conversation_id = c.id AND s.status = 'handoff')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE conversations
        DROP COLUMN control_reason, DROP COLUMN human_until, DROP COLUMN control,
        ADD COLUMN assigned_to uuid,
        DROP CONSTRAINT conversations_status_check
    `);
    await q.query(`ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'bot'`);
    await q.query(`UPDATE conversations SET status = 'bot' WHERE status = 'open'`);
  }
}
```

`packages/db/src/migrations/1725301600000-AddOriginToMessages.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `origin` dice QUIÉN escribió (`direction` solo dice hacia dónde fue), y
 * `occurred_at` CUÁNDO pasó según Meta. Con el historial se insertan hoy
 * mensajes de hace meses: ordenar por `created_at` dejaría la conversación al
 * revés. `origin` no lleva default a propósito: un INSERT que lo olvide falla.
 */
export class AddOriginToMessages1725301600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE messages ADD COLUMN origin varchar(16), ADD COLUMN occurred_at timestamptz`);
    await q.query(`
      UPDATE messages
         SET origin = CASE WHEN direction = 'in' THEN 'customer' ELSE 'bot' END,
             occurred_at = created_at
    `);
    await q.query(`
      ALTER TABLE messages
        ALTER COLUMN origin SET NOT NULL,
        ADD CONSTRAINT messages_origin_check
          CHECK (origin IN ('customer', 'bot', 'phone', 'operator', 'history')),
        ALTER COLUMN occurred_at SET NOT NULL,
        ALTER COLUMN occurred_at SET DEFAULT clock_timestamp(),
        ADD CONSTRAINT messages_status_check CHECK (status IS NULL OR status IN (
          'pending', 'sending', 'sent', 'delivered', 'read',
          'window_closed', 'failed', 'unconfirmed', 'superseded'))
    `);
    await q.query(`CREATE INDEX messages_conversation_occurred_idx ON messages (conversation_id, occurred_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX messages_conversation_occurred_idx`);
    await q.query(`
      ALTER TABLE messages
        DROP CONSTRAINT messages_status_check, DROP CONSTRAINT messages_origin_check,
        DROP COLUMN occurred_at, DROP COLUMN origin
    `);
  }
}
```

`packages/db/src/migrations/1725301700000-AddSavedNameToContacts.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** El nombre con que el negocio tiene guardado al cliente en su celular (smb_app_state_sync). */
export class AddSavedNameToContacts1725301700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE contacts ADD COLUMN saved_name varchar(255)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE contacts DROP COLUMN saved_name`);
  }
}
```

`packages/db/src/migrations/1725301800000-CreateAuditLog.ts`:
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * Bitácora de lo que cambia quién habla y de las acciones del operador. Nace
 * aquí y no en el panel porque los cambios de control empiezan en esta fase.
 * Solo inserción para la app: una bitácora que se puede corregir no prueba nada.
 */
export class CreateAuditLog1725301800000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE audit_log (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor           varchar(64) NOT NULL,
        action          varchar(64) NOT NULL,
        conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
        details         jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await q.query(`CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC)`);
    for (const sql of tenantRlsSql('audit_log')) await q.query(sql);
    // tenantRlsSql otorga los cuatro privilegios; la bitácora se queda en dos.
    await q.query(`REVOKE UPDATE, DELETE ON audit_log FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE audit_log`);
  }
}
```

- [ ] **Step 5: Correr el esquema y el guardia**

Run: `pnpm test packages/db/test`
Expected: PASS (los tests del Step 1 y del Step 2, más los que ya existían).

- [ ] **Step 6: Escribir el test del entrante que falla**

Añadir al final del `describe` de `apps/api/test/queues/inbound.processor.test.ts`:
```ts
  it('guarda el entrante como escrito por el cliente, a la hora que dice Meta', async () => {
    const at = new Date('2026-09-03T15:00:00Z');
    await processor.process({ tenantId, channelId, message: msg({ wamid: 'wamid.ORIG1', timestamp: at }) });

    const [row] = await runInTenant(app, tenantId, (m) =>
      m.query(`SELECT origin, occurred_at FROM messages WHERE wamid = 'wamid.ORIG1'`));
    expect(row.origin).toBe('customer');
    expect(new Date(row.occurred_at).toISOString()).toBe(at.toISOString());
  });
```

- [ ] **Step 7: Correr la suite y ver los fallos esperados**

Run: `pnpm test`
Expected: FAIL. El test nuevo falla con `null value in column "origin"`, y fallan también todos los tests que pasan por `InboundProcessor`, `FlowRunner` o `seedTurn`: esos INSERT todavía no declaran `origin`. Es la columna sin default haciendo su trabajo.

- [ ] **Step 8: Declarar `origin` y `occurred_at` en todos los INSERT**

En `apps/api/src/queues/inbound.processor.ts`, el INSERT del entrante pasa a:
```ts
      `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type, body,
                             payload, occurred_at)
       VALUES ($1, $2, $3, 'in', 'customer', $4, $5, $6, $7)
       ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
       RETURNING id`,
      [tenantId, conversation.id, message.wamid, message.type,
       message.text, JSON.stringify(message.raw), message.timestamp],
```

En `apps/api/src/flow-engine/flow-runner.service.ts`, el INSERT de cada saliente pasa a:
```ts
        `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload,
                               status, reply_to_id, seq)
         VALUES ($1, $2, 'out', 'bot', $3, $4, $5, 'pending', $6, $7)`,
```
(los parámetros no cambian: `occurred_at` toma su default, la hora real de inserción).

En `apps/api/test/queues/outbound.processor.test.ts`, dentro de `seedTurn`, el INSERT del entrante pasa a:
```ts
      `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type, body)
       VALUES ($1, $2, 'wamid.IN1', 'in', 'customer', 'text', 'Hola') RETURNING id`,
```
y el de cada saliente a:
```ts
        `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload,
                               status, reply_to_id, seq)
         VALUES ($1, $2, 'out', 'bot', 'text', $3, $4, 'pending', $5, $6)`,
```

En `apps/api/test/helpers.ts`, el `TRUNCATE` de `resetDb` gana `audit_log`:
```ts
    TRUNCATE webhook_events, audit_log, messages, conversation_sessions, conversations,
             flows, contacts, whatsapp_channels, tenants
    RESTART IDENTITY CASCADE
```

- [ ] **Step 9: Alinear las entidades**

Las consultas son SQL directo, pero las entidades no deben mentir sobre el esquema.

`packages/db/src/entities/conversation.entity.ts`: reemplazar el bloque de `status` y `assignedTo` por:
```ts
  @Column({ default: 'open' })
  status!: 'open' | 'closed';

  @Column({ type: 'varchar', default: 'bot' })
  control!: 'bot' | 'human';

  @Column({ name: 'human_until', type: 'timestamptz', nullable: true })
  humanUntil!: Date | null;

  @Column({ name: 'control_reason', type: 'varchar', nullable: true })
  controlReason!: 'phone' | 'flow_handoff' | 'operator' | 'history' | null;
```

`packages/db/src/entities/message.entity.ts`: después de `direction`:
```ts
  @Column({ type: 'varchar' })
  origin!: 'customer' | 'bot' | 'phone' | 'operator' | 'history';

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
```

`packages/db/src/entities/whatsapp-channel.entity.ts`: después de `status`:
```ts
  @Column({ type: 'varchar', default: 'cloud_api' })
  mode!: 'cloud_api' | 'coexistence';

  @Column({ name: 'history_sync', type: 'varchar', default: 'not_applicable' })
  historySync!: 'not_applicable' | 'pending' | 'done' | 'declined';
```

`packages/db/src/entities/contact.entity.ts`: después de `name`:
```ts
  @Column({ name: 'saved_name', type: 'varchar', nullable: true })
  savedName!: string | null;
```

`packages/db/src/entities/tenant.entity.ts`: después de `status`:
```ts
  @Column({ name: 'human_takeover_hours', type: 'smallint', default: 12 })
  humanTakeoverHours!: number;
```

- [ ] **Step 10: Correr todo**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck sin errores; la suite completa en verde.

- [ ] **Step 11: Commit**

```bash
git add packages/db apps/api/src/queues/inbound.processor.ts apps/api/src/flow-engine/flow-runner.service.ts apps/api/test/helpers.ts apps/api/test/queues
git commit -m "feat(db): crear el modelo de datos de coexistencia y control de la conversación"
```

---

### Task 2: Regla de control y bitácora

**Files:**
- Create: `apps/api/src/audit/audit.ts`
- Create: `apps/api/src/conversations/control.ts`
- Test: `apps/api/test/conversations/control.test.ts`

**Interfaces:**
- Consumes: columnas de la Task 1.
- Produces:
  - `recordAudit(m: EntityManager, e: AuditEntry): Promise<void>` con `AuditEntry = { tenantId: string; actor: string; action: string; conversationId?: string | null; details?: Record<string, unknown> }`.
  - `type ControlReason = 'phone' | 'flow_handoff' | 'operator' | 'history'`
  - `interface ControlState { control: 'bot' | 'human'; humanUntil: Date | null; reason: ControlReason | null }`
  - `humanInControl(s, now): boolean`, `humanControlExpired(s, now): boolean`, `botRepliesSuperseded(s, now): boolean`
  - `readControl(m, conversationId): Promise<ControlState & { channelStatus: string }>`
  - `giveControlToHuman(m, a: { tenantId; conversationId; from: Date; reason: ControlReason; actor: string }): Promise<void>`
  - `returnControlToBot(m, a: { tenantId; conversationId; cause: 'expired' | 'operator'; actor: string }): Promise<void>`

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/conversations/control.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import {
  botRepliesSuperseded, giveControlToHuman, humanControlExpired, humanInControl,
  readControl, returnControlToBot, type ControlState,
} from '../../src/conversations/control';
import { DEMO_FLOW } from '../../src/cli/provision';
import { resetDb, seedChannel, seedFlow, adminQuery, closeHelpers } from '../helpers';

const now = new Date('2026-10-06T15:00:00Z');
const state = (over: Partial<ControlState>): ControlState =>
  ({ control: 'bot', humanUntil: null, reason: null, ...over });
const hoursFromNow = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('regla de control (puras)', () => {
  it('manda el humano solo mientras su plazo no ha vencido', () => {
    expect(humanInControl(state({ control: 'human', humanUntil: hoursFromNow(1) }), now)).toBe(true);
    expect(humanInControl(state({ control: 'human', humanUntil: hoursFromNow(-1) }), now)).toBe(false);
    expect(humanInControl(state({ control: 'bot' }), now)).toBe(false);
  });

  it('un control humano sin plazo cuenta como vencido, no como eterno', () => {
    expect(humanInControl(state({ control: 'human', humanUntil: null }), now)).toBe(false);
    expect(humanControlExpired(state({ control: 'human', humanUntil: null }), now)).toBe(true);
  });

  it('lo pendiente del bot sobra solo si un humano intervino', () => {
    const phone = state({ control: 'human', humanUntil: hoursFromNow(1), reason: 'phone' });
    const flow = state({ control: 'human', humanUntil: hoursFromNow(1), reason: 'flow_handoff' });
    expect(botRepliesSuperseded(phone, now)).toBe(true);
    // El mensaje de traspaso se produjo en el mismo turno que pidió el traspaso.
    expect(botRepliesSuperseded(flow, now)).toBe(false);
  });
});

let ds: DataSource;
let tenantId: string, channelId: string, conversationId: string;

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  const [contact] = await adminQuery(
    `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, '573001112233') RETURNING id`, [tenantId]);
  const [conv] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, contact.id, channelId]);
  conversationId = conv.id;
});

const control = () => runInTenant(ds, tenantId, (m) => readControl(m, conversationId));
const audit = () => adminQuery(`SELECT actor, action, details FROM audit_log ORDER BY created_at`);

describe('regla de control (base de datos)', () => {
  it('dar el control al humano fija el plazo con las horas del negocio y lo audita', async () => {
    await adminQuery(`UPDATE tenants SET human_takeover_hours = 2 WHERE id = $1`, [tenantId]);
    const from = new Date();

    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from, reason: 'phone', actor: 'phone' }));

    const c = await control();
    expect(c.control).toBe('human');
    expect(c.reason).toBe('phone');
    expect(c.humanUntil!.getTime()).toBe(from.getTime() + 2 * 3_600_000);
    expect(await audit()).toEqual([
      { actor: 'phone', action: 'control.to_human', details: { reason: 'phone' } }]);
  });

  it('una segunda intervención alarga el plazo pero nunca lo acorta', async () => {
    const later = new Date();
    const earlier = new Date(later.getTime() - 3_600_000);
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: later, reason: 'phone', actor: 'phone' }));
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: earlier, reason: 'phone', actor: 'phone' }));

    expect((await control()).humanUntil!.getTime()).toBe(later.getTime() + 12 * 3_600_000);
  });

  it('alargar el plazo no repite la auditoría', async () => {
    for (let i = 0; i < 3; i++) {
      await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
        tenantId, conversationId, from: new Date(), reason: 'phone', actor: 'phone' }));
    }
    expect(await audit()).toHaveLength(1);
  });

  it('devolver el control al bot cierra las sesiones a medias y lo audita', async () => {
    const flowId = await seedFlow(tenantId, DEMO_FLOW);
    await adminQuery(
      `INSERT INTO conversation_sessions (tenant_id, conversation_id, flow_id, step_key, status)
       VALUES ($1, $2, $3, 'pide_nombre', 'active')`, [tenantId, conversationId, flowId]);
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: new Date(), reason: 'phone', actor: 'phone' }));

    await runInTenant(ds, tenantId, (m) => returnControlToBot(m, {
      tenantId, conversationId, cause: 'expired', actor: 'system' }));

    const c = await control();
    expect([c.control, c.humanUntil, c.reason]).toEqual(['bot', null, null]);
    const sessions = await adminQuery(`SELECT status FROM conversation_sessions`);
    expect(sessions).toEqual([{ status: 'ended' }]);
    expect((await audit()).at(-1)).toEqual(
      { actor: 'system', action: 'control.to_bot', details: { cause: 'expired' } });
  });

  it('lee el estado del canal junto con el control', async () => {
    expect((await control()).channelStatus).toBe('active');
  });

  it('la aplicación no puede corregir ni borrar la bitácora', async () => {
    await runInTenant(ds, tenantId, (m) => giveControlToHuman(m, {
      tenantId, conversationId, from: new Date(), reason: 'phone', actor: 'phone' }));
    await expect(runInTenant(ds, tenantId, (m) => m.query(`DELETE FROM audit_log`)))
      .rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/conversations/control.test.ts`
Expected: FAIL con `Failed to load url ../../src/conversations/control`.

- [ ] **Step 3: Escribir la bitácora**

`apps/api/src/audit/audit.ts`:
```ts
import type { EntityManager } from 'typeorm';

export interface AuditEntry {
  tenantId: string;
  /** Quién: 'phone', 'flow', 'history', 'system', 'meta', 'operator:<id>'. */
  actor: string;
  /** Qué, con punto como separador: 'control.to_human', 'channel.disconnected'. */
  action: string;
  conversationId?: string | null;
  details?: Record<string, unknown>;
}

/** Única forma de escribir en audit_log. Solo inserción: la app no tiene UPDATE ni DELETE. */
export async function recordAudit(m: EntityManager, e: AuditEntry): Promise<void> {
  await m.query(
    `INSERT INTO audit_log (tenant_id, actor, action, conversation_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [e.tenantId, e.actor, e.action, e.conversationId ?? null, JSON.stringify(e.details ?? {})],
  );
}
```

- [ ] **Step 4: Escribir la regla de control**

`apps/api/src/conversations/control.ts`:
```ts
import type { EntityManager } from 'typeorm';
import { recordAudit } from '../audit/audit';

/**
 * Quién habla en una conversación (spec §6). Fuente única de verdad:
 * `conversations.control` + `human_until`. No hay job que devuelva el control
 * al bot: se evalúa en el siguiente evento.
 */
export type ControlReason = 'phone' | 'flow_handoff' | 'operator' | 'history';

export interface ControlState {
  control: 'bot' | 'human';
  humanUntil: Date | null;
  reason: ControlReason | null;
}

/** ¿Manda un humano ahora mismo? Un control humano vencido, o sin plazo, no cuenta. */
export function humanInControl(s: ControlState, now: Date): boolean {
  return s.control === 'human' && s.humanUntil !== null && s.humanUntil.getTime() > now.getTime();
}

/** El humano tuvo el control y se le venció: toca devolvérselo al bot. */
export function humanControlExpired(s: ControlState, now: Date): boolean {
  return s.control === 'human' && !humanInControl(s, now);
}

/**
 * ¿Lo que el bot dejó pendiente ya sobra? Solo si un humano INTERVINO. Cuando
 * el control lo dio el propio flujo, su mensaje de traspaso se produjo en el
 * mismo turno y debe salir.
 */
export function botRepliesSuperseded(s: ControlState, now: Date): boolean {
  return humanInControl(s, now) && s.reason !== 'flow_handoff';
}

export async function readControl(
  m: EntityManager, conversationId: string,
): Promise<ControlState & { channelStatus: string }> {
  const [row] = await m.query(
    `SELECT c.control, c.human_until, c.control_reason, ch.status AS channel_status
       FROM conversations c
       JOIN whatsapp_channels ch ON ch.id = c.channel_id
      WHERE c.id = $1`,
    [conversationId],
  );
  if (!row) throw new Error(`Conversación ${conversationId} no encontrada`);
  return {
    control: row.control,
    humanUntil: row.human_until ? new Date(row.human_until) : null,
    reason: row.control_reason,
    channelStatus: row.channel_status,
  };
}

/** El humano toma la conversación desde `from` por las horas del negocio. */
export async function giveControlToHuman(
  m: EntityManager,
  a: { tenantId: string; conversationId: string; from: Date; reason: ControlReason; actor: string },
): Promise<void> {
  const before = await readControl(m, a.conversationId);
  const [tenant] = await m.query(
    `SELECT human_takeover_hours AS hours FROM tenants WHERE id = $1`, [a.tenantId]);

  // GREATEST ignora NULL: la primera intervención fija el plazo y las
  // siguientes solo lo alargan. Un eco viejo procesado tarde no lo acorta.
  await m.query(
    `UPDATE conversations
        SET control = 'human',
            human_until = GREATEST(human_until, $2::timestamptz + make_interval(hours => $3::int)),
            control_reason = $4,
            updated_at = now()
      WHERE id = $1`,
    [a.conversationId, a.from, tenant.hours, a.reason],
  );

  // Se audita el CAMBIO de quién habla, no cada eco que alarga el plazo.
  if (!humanInControl(before, new Date())) {
    await recordAudit(m, {
      tenantId: a.tenantId, actor: a.actor, action: 'control.to_human',
      conversationId: a.conversationId, details: { reason: a.reason },
    });
  }
}

/** El bot vuelve a hablar: venció el plazo o el operador lo devolvió. */
export async function returnControlToBot(
  m: EntityManager,
  a: { tenantId: string; conversationId: string; cause: 'expired' | 'operator'; actor: string },
): Promise<void> {
  await m.query(
    `UPDATE conversations
        SET control = 'bot', human_until = NULL, control_reason = NULL, updated_at = now()
      WHERE id = $1`,
    [a.conversationId],
  );
  // El dueño pudo haber intervenido a mitad de una captura: retomar ese paso
  // sería absurdo. El siguiente mensaje abre una sesión nueva desde el inicio.
  await m.query(
    `UPDATE conversation_sessions SET status = 'ended', updated_at = now()
      WHERE conversation_id = $1 AND status <> 'ended'`,
    [a.conversationId],
  );
  await recordAudit(m, {
    tenantId: a.tenantId, actor: a.actor, action: 'control.to_bot',
    conversationId: a.conversationId, details: { cause: a.cause },
  });
}
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm test apps/api/test/conversations/control.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/audit apps/api/src/conversations/control.ts apps/api/test/conversations/control.test.ts
git commit -m "feat(conversations): definir la regla de control y la bitácora de quién habla"
```

---

### Task 3: El turno respeta el control

**Files:**
- Modify: `apps/api/src/flow-engine/flow-runner.service.ts`
- Modify: `apps/api/src/tenancy/channel-resolver.service.ts` (`resolveByPhoneNumberId`)
- Test: `apps/api/test/flow-engine/flow-runner.test.ts`
- Test: `apps/api/test/tenancy/channel-resolver.test.ts`

**Interfaces:**
- Consumes: `readControl`, `humanInControl`, `humanControlExpired`, `giveControlToHuman`, `returnControlToBot` (Task 2).
- Produces: `FlowRunner.handle` no responde si manda un humano o el canal está `disconnected`; al vencer, devuelve el control y abre sesión nueva; el paso `handoff` da el control al humano con `reason='flow_handoff'`. `ChannelResolver.resolveByPhoneNumberId` resuelve también canales `disconnected` (la entrada se guarda), `resolveById` sigue exigiendo `active` (no se envía).

- [ ] **Step 1: Escribir los tests de FlowRunner que fallan**

Añadir al final del `describe('FlowRunner', ...)` de `apps/api/test/flow-engine/flow-runner.test.ts`:
```ts
  const conversation = async () => (await adminQuery(
    `SELECT id, control, human_until, control_reason FROM conversations`))[0];
  const say = (wamid: string, text: string) =>
    runner.handle({ tenantId, channelId, message: message({ wamid, text }) });

  it('mientras manda el humano, guarda el entrante y el bot no responde', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.C1', 'Hola');
    await adminQuery(`UPDATE conversations SET control = 'human',
      human_until = now() + interval '1 hour', control_reason = 'phone'`);

    const out = await say('wamid.C2', '¿Siguen abiertos?');

    expect(out).toEqual([]);
    expect(jobs).toHaveLength(1);              // solo el del primer turno
    const [m] = await adminQuery(`SELECT origin FROM messages WHERE wamid = 'wamid.C2'`);
    expect(m.origin).toBe('customer');
  });

  it('al vencer el control humano, el bot retoma desde el inicio y no desde la captura', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.V1', 'Hola');
    await say('wamid.V2', 'agendar');          // la sesión queda en pide_nombre
    await adminQuery(`UPDATE conversations SET control = 'human',
      human_until = now() - interval '1 minute', control_reason = 'phone'`);

    const out = await say('wamid.V3', 'Hola');

    // Sin cerrar la sesión vieja respondería "Perfecto, Hola".
    expect(out.map((o) => o.kind)).toEqual(['text', 'buttons']);
    expect((await conversation()).control).toBe('bot');
    const [a] = await adminQuery(`SELECT action, details FROM audit_log`);
    expect(a).toEqual({ action: 'control.to_bot', details: { cause: 'expired' } });
  });

  it('el paso handoff del flujo dice su mensaje y le da el control al humano', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.H1', 'Hola');

    const out = await say('wamid.H2', 'asesor');

    expect(out).toEqual([{ kind: 'text', body: 'Te comunico con alguien del equipo.' }]);
    const c = await conversation();
    expect(c.control).toBe('human');
    expect(c.control_reason).toBe('flow_handoff');
    const hours = (new Date(c.human_until).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(await say('wamid.H3', '¿Hola?')).toEqual([]);
  });

  it('un canal desconectado guarda lo que llega pero no responde', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await adminQuery(`UPDATE whatsapp_channels SET status = 'disconnected'`);

    expect(await say('wamid.D1', 'Hola')).toEqual([]);
    expect(jobs).toEqual([]);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    expect(n).toBe(1);
  });

  it('si manda el bot, una sesión que quedó en traspaso es un residuo y no lo silencia', async () => {
    await seedFlow(tenantId, DEMO_FLOW);
    await say('wamid.R1', 'Hola');
    const c = await conversation();
    await adminQuery(`UPDATE conversation_sessions SET status = 'handoff' WHERE conversation_id = $1`, [c.id]);

    const out = await say('wamid.R2', 'Hola');

    expect(out.map((o) => o.kind)).toEqual(['text', 'buttons']);
  });
```

- [ ] **Step 2: Escribir el test del resolver que falla**

Añadir dentro del `describe('ChannelResolver', ...)` de `apps/api/test/tenancy/channel-resolver.test.ts`:
```ts
  it('resuelve un canal desconectado para la entrada, pero no para enviar', async () => {
    // Lo que llegue a un número desconectado se guarda (y no se responde);
    // enviar con un canal desconectado no tiene sentido.
    await admin.query(`UPDATE whatsapp_channels SET status = 'disconnected'`);
    try {
      const inbound = await resolver.resolveByPhoneNumberId('106540');
      expect(inbound?.tenantId).toBe(tenantId);
      expect(await resolver.resolveById(inbound!.channelId)).toBeNull();
    } finally {
      await admin.query(`UPDATE whatsapp_channels SET status = 'active'`);
    }
  });
```

- [ ] **Step 3: Correr y verlos fallar**

Run: `pnpm test apps/api/test/flow-engine/flow-runner.test.ts apps/api/test/tenancy/channel-resolver.test.ts`
Expected: FAIL — los cinco tests nuevos de FlowRunner (el bot responde aunque mande el humano, retoma en `pide_nombre`, etc.) y el del resolver (`inbound` es `null`).

- [ ] **Step 4: Resolver canales desconectados para la entrada**

En `apps/api/src/tenancy/channel-resolver.service.ts`, en `resolveByPhoneNumberId`:
```ts
  /**
   * Resuelve el canal por phone_number_id. Devuelve null si no existe o está
   * inactivo. Un canal `disconnected` SÍ se resuelve: lo que llegue se guarda
   * (FlowRunner no responde); `resolveById`, que usa el envío, sigue exigiendo
   * `active`. NO existe un tenant por defecto.
   */
  async resolveByPhoneNumberId(phoneNumberId: string): Promise<ResolvedChannel | null> {
    const [row] = await this.ds.query(
      `SELECT id, tenant_id, waba_id, phone_number_id, access_token_encrypted
         FROM whatsapp_channels
        WHERE phone_number_id = $1 AND status IN ('active', 'disconnected')`,
      [phoneNumberId],
    );
    return row ? this.mapRow(row) : null;
  }
```

- [ ] **Step 5: Aplicar la regla en FlowRunner**

En `apps/api/src/flow-engine/flow-runner.service.ts`, añadir el import:
```ts
import {
  giveControlToHuman, humanControlExpired, humanInControl, readControl, returnControlToBot,
} from '../conversations/control';
```
Reemplazar, dentro de `handle`, las dos líneas finales del callback de `runInTenant` (desde `const outbound = await this.advanceFlow(...)` hasta su `return`) por:
```ts
      // Regla de control (spec §6.2), ya con la conversación bloqueada por el
      // upsert de `persist`: antes de avanzar, ¿quién habla?
      const control = await readControl(m, inbound.conversationId);
      const now = new Date();
      if (control.channelStatus === 'disconnected' || humanInControl(control, now)) {
        // El entrante ya quedó guardado; el bot no responde.
        return { ...inbound, outbound: [] as OutboundContent[], pending: false };
      }
      if (humanControlExpired(control, now)) {
        await returnControlToBot(m, {
          tenantId: job.tenantId, conversationId: inbound.conversationId,
          cause: 'expired', actor: 'system',
        });
      }

      const { outbound, enteredHandoff } =
        await this.advanceFlow(m, job, inbound.conversationId, inbound.messageId);
      if (enteredHandoff) {
        await giveControlToHuman(m, {
          tenantId: job.tenantId, conversationId: inbound.conversationId,
          from: now, reason: 'flow_handoff', actor: 'flow',
        });
      }
      return { ...inbound, outbound, pending: outbound.length > 0 };
```
Cambiar la firma y los retornos de `advanceFlow`:
```ts
  private async advanceFlow(
    m: EntityManager, job: InboundJob, conversationId: string, inboundId: string,
  ): Promise<{ outbound: OutboundContent[]; enteredHandoff: boolean }> {
```
- donde hoy hace `if (!flowRow) return [];` → `if (!flowRow) return { outbound: [], enteredHandoff: false };`
- justo después de leer `sessionRow`, insertar:
```ts
    // Aquí ya se sabe que manda el bot. Una sesión que quedó en 'handoff' es un
    // residuo (el control ya volvió): se cierra para no silenciar al bot.
    if (sessionRow?.status === 'handoff') {
      await m.query(
        `UPDATE conversation_sessions SET status = 'ended', updated_at = now() WHERE id = $1`,
        [sessionRow.id]);
      sessionRow = undefined;
    }
```
  (cambiar `const [sessionRow]` por `let [sessionRow]` en esa consulta).
- el `return result.outbound;` final → 
```ts
    return {
      outbound: result.outbound,
      enteredHandoff: result.state.status === 'handoff' && state?.status !== 'handoff',
    };
```

- [ ] **Step 6: Correr los tests**

Run: `pnpm test apps/api/test/flow-engine apps/api/test/tenancy apps/api/test/harness`
Expected: PASS, incluido el e2e del motor ("el traspaso a humano silencia al bot").

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/flow-engine/flow-runner.service.ts apps/api/src/tenancy/channel-resolver.service.ts apps/api/test/flow-engine/flow-runner.test.ts apps/api/test/tenancy/channel-resolver.test.ts
git commit -m "feat(flow-engine): callar al bot mientras manda un humano y devolverle el turno al vencer"
```

---

### Task 4: El envío no le habla encima al humano

**Files:**
- Modify: `apps/api/src/queues/outbound.processor.ts`
- Test: `apps/api/test/queues/outbound.processor.test.ts`

**Interfaces:**
- Consumes: `botRepliesSuperseded`, `ControlState` (Task 2).
- Produces: estado final `superseded` para salientes `origin='bot'` cuando un humano intervino antes del envío.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir antes del test `'un canal inexistente o inactivo es un error permanente...'` en `apps/api/test/queues/outbound.processor.test.ts`:
```ts
  const humanTookOver = (reason: string, until = `now() + interval '1 hour'`) =>
    adminQuery(`UPDATE conversations SET control = 'human', human_until = ${until},
                control_reason = '${reason}'`);

  it('si el dueño contestó desde el celular antes del envío, lo del bot no sale', async () => {
    // El bot produjo el saludo y, en el mismo segundo, llegó el eco del dueño.
    const job = await seedTurn([HOLA, MENU]);
    await humanTookOver('phone');

    await processor.process(job);

    expect(sender.send).not.toHaveBeenCalled();
    expect((await outRows()).map((r) => r.status)).toEqual(['superseded', 'superseded']);
  });

  it('el mensaje de traspaso del propio flujo sí sale', async () => {
    const job = await seedTurn([HOLA]);
    await humanTookOver('flow_handoff');

    await processor.process(job);

    expect((await outRows()).map((r) => r.status)).toEqual(['sent']);
  });

  it('lo que escribe el operador sale aunque mande un humano', async () => {
    const job = await seedTurn([HOLA]);
    await adminQuery(`UPDATE messages SET origin = 'operator' WHERE direction = 'out'`);
    await humanTookOver('operator');

    await processor.process(job);

    expect((await outRows()).map((r) => r.status)).toEqual(['sent']);
  });

  it('un control humano ya vencido no reemplaza nada', async () => {
    const job = await seedTurn([HOLA]);
    await humanTookOver('phone', `now() - interval '1 minute'`);

    await processor.process(job);

    expect((await outRows()).map((r) => r.status)).toEqual(['sent']);
  });

```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/queues/outbound.processor.test.ts`
Expected: FAIL — el primero ve `['sent', 'sent']` en vez de `superseded`. Los otros tres pasan ya (documentan lo que NO debe cambiar).

- [ ] **Step 3: Implementar `superseded`**

En `apps/api/src/queues/outbound.processor.ts`, añadir el import:
```ts
import { botRepliesSuperseded, type ControlState } from '../conversations/control';
```
En la lectura dentro de `runInTenant`, la consulta de filas selecciona también `origin` (y el tipo de `rows` gana `origin: string`):
```ts
          `SELECT id, status, payload, origin,
                  coalesce(claimed_at > now() - make_interval(secs => $2), false) AS in_flight
             FROM messages
            WHERE reply_to_id = $1 AND direction = 'out' AND status IN ('pending', 'sending')
            ORDER BY seq`,
```
y la de la conversación pasa a:
```ts
      const [conv] = await m.query(
        `SELECT last_inbound_at, control, human_until, control_reason
           FROM conversations WHERE id = $1`, [job.conversationId]);
      const control: ControlState = {
        control: conv?.control ?? 'bot',
        humanUntil: conv?.human_until ? new Date(conv.human_until) : null,
        reason: conv?.control_reason ?? null,
      };
      return { rows, control, lastInboundAt: (conv?.last_inbound_at as Date | undefined) ?? null };
```
(desestructurar `{ rows, control, lastInboundAt }`). En el bucle, inmediatamente después del bloque `if (row.status === 'sending') { ... }`:
```ts
      // Spec §6.3: si un humano intervino después de que el bot produjera esto,
      // ya sobra. Se mide AHORA, justo antes de enviar.
      if (row.origin === 'bot' && botRepliesSuperseded(control, new Date())) {
        await this.transition(tenantId, row.id, 'pending', 'superseded');
        continue;
      }
```
Actualizar el comentario de estados de la clase añadiendo `superseded` (el humano tomó el control antes de que saliera).

- [ ] **Step 4: Correr los tests**

Run: `pnpm test apps/api/test/queues`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/queues/outbound.processor.ts apps/api/test/queues/outbound.processor.test.ts
git commit -m "feat(queues): descartar lo pendiente del bot cuando un humano intervino antes del envío"
```

---

### Task 5: El normalizador entiende la coexistencia

**Files:**
- Modify: `packages/shared/src/inbound-message.ts`
- Modify: `apps/api/src/whatsapp/normalizer.ts`
- Create: `apps/api/test/whatsapp/fixtures/coexistence.ts`
- Test: `apps/api/test/whatsapp/normalizer.test.ts`

**Interfaces:**
- Produces (en `@citara/shared`):
```ts
export interface InboundStatus { wamid: string; phoneNumberId: string; wabaId: string; status: string; timestamp: Date }
export interface PhoneEcho { wamid: string; phoneNumberId: string; wabaId: string; to: string; type: InboundType; text: string | null; mediaId: string | null; timestamp: Date; raw: unknown }
export interface HistoryMessage { wamid: string; from: string; type: InboundType; text: string | null; mediaId: string | null; timestamp: Date; raw: unknown }
export interface HistoryChunk { phoneNumberId: string; wabaId: string; phase: number | null; progress: number | null; declined: boolean; threads: { waId: string; messages: HistoryMessage[] }[] }
export interface ContactSync { phoneNumberId: string; wabaId: string; waId: string; name: string | null; action: 'add' | 'remove' }
export interface AccountUpdate { wabaId: string; event: string; phoneNumber: string | null }
```
- Produces: `normalizeWebhook(payload): NormalizedWebhook` con `{ messages, statuses, echoes, history, contacts, accountUpdates }`. Los wa_id se normalizan sin `+`.

- [ ] **Step 1: Escribir los payloads de ejemplo**

`apps/api/test/whatsapp/fixtures/coexistence.ts`:
```ts
/**
 * Payloads de coexistencia con la FORMA de la documentación de Meta
 * (developers.facebook.com → Onboard WhatsApp Business app users), escritos a
 * mano: NO son grabaciones. Al conectar el primer número real se graban los
 * payloads verdaderos y se reemplazan aquí; si difieren, manda la grabación.
 */
const BUSINESS = '15550001';
const PHONE_NUMBER_ID = '106540';
const WABA = '102290';

const envelope = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field, value }] }],
});
const metadata = { display_phone_number: BUSINESS, phone_number_id: PHONE_NUMBER_ID };
const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));

export const echoPayload = (o: { wamid: string; to: string; text?: string; at?: Date; type?: string }) =>
  envelope('smb_message_echoes', {
    messaging_product: 'whatsapp', metadata,
    message_echoes: [{
      from: BUSINESS, to: o.to, id: o.wamid, timestamp: unix(o.at ?? new Date()),
      type: o.type ?? 'text', ...(o.type && o.type !== 'text' ? {} : { text: { body: o.text ?? 'Ya te atiendo' } }),
    }],
  });

export interface HistoryLine { wamid: string; fromCustomer: boolean; text: string; at: Date }

export const historyPayload = (o: {
  customer: string; lines: HistoryLine[]; phase?: number; progress?: number;
}) => envelope('history', {
  messaging_product: 'whatsapp', metadata,
  history: [{
    metadata: { phase: o.phase ?? 2, chunk_order: 1, progress: o.progress ?? 100 },
    threads: [{
      id: o.customer,
      messages: o.lines.map((l) => ({
        from: l.fromCustomer ? o.customer : BUSINESS, id: l.wamid, timestamp: unix(l.at),
        type: 'text', text: { body: l.text }, history_context: { status: 'READ' },
      })),
    }],
  }],
});

/** VERIFICAR: código y forma del rechazo a compartir el historial. */
export const historyDeclinedPayload = () => envelope('history', {
  messaging_product: 'whatsapp', metadata,
  history: [{ errors: [{ code: 2593109, title: 'History sharing is turned off by the business' }] }],
});

export const contactsPayload = (o: { phone: string; name: string; action: 'add' | 'remove' }) =>
  envelope('smb_app_state_sync', {
    messaging_product: 'whatsapp', metadata,
    state_sync: [{
      type: 'contact', action: o.action, metadata: { timestamp: unix(new Date()) },
      contact: { full_name: o.name, first_name: o.name.split(' ')[0], phone_number: o.phone },
    }],
  });

/** VERIFICAR: nombres de evento de account_update. */
export const accountUpdatePayload = (event: string) =>
  envelope('account_update', { phone_number: BUSINESS, event });

export const statusPayload = (wamid: string, status: string) => envelope('messages', {
  messaging_product: 'whatsapp', metadata,
  statuses: [{ id: wamid, status, timestamp: unix(new Date()), recipient_id: '573001112233' }],
});
```

- [ ] **Step 2: Escribir los tests que fallan**

En `apps/api/test/whatsapp/normalizer.test.ts`, junto a los imports existentes:
```ts
import {
  accountUpdatePayload, contactsPayload, echoPayload, historyDeclinedPayload,
  historyPayload, statusPayload,
} from './fixtures/coexistence';
```
y al final del archivo:
```ts
describe('normalizeWebhook — coexistencia', () => {
  it('normaliza un eco del celular del negocio', () => {
    const at = new Date('2026-10-06T15:00:00Z');
    const n = normalizeWebhook(echoPayload({ wamid: 'wamid.E1', to: '573001112233', text: 'Ya voy', at }));

    expect(n.messages).toEqual([]);
    expect(n.echoes).toEqual([expect.objectContaining({
      wamid: 'wamid.E1', phoneNumberId: '106540', wabaId: '102290',
      to: '573001112233', type: 'text', text: 'Ya voy', timestamp: at,
    })]);
  });

  it('quita el + del destinatario del eco para que caiga en el mismo contacto', () => {
    const n = normalizeWebhook(echoPayload({ wamid: 'wamid.E2', to: '+573001112233' }));
    expect(n.echoes[0].to).toBe('573001112233');
  });

  it('normaliza un chunk de historial con sus hilos y fase', () => {
    const at = new Date('2026-10-05T10:00:00Z');
    const n = normalizeWebhook(historyPayload({
      customer: '573001112233', phase: 1, progress: 40,
      lines: [{ wamid: 'wamid.H1', fromCustomer: true, text: 'Hola', at }],
    }));

    expect(n.history).toHaveLength(1);
    expect(n.history[0]).toMatchObject({ phoneNumberId: '106540', phase: 1, progress: 40, declined: false });
    expect(n.history[0].threads[0].waId).toBe('573001112233');
    expect(n.history[0].threads[0].messages[0]).toMatchObject(
      { wamid: 'wamid.H1', from: '573001112233', text: 'Hola', timestamp: at });
  });

  it('reconoce que el negocio no compartió el historial', () => {
    const n = normalizeWebhook(historyDeclinedPayload());
    expect(n.history).toEqual([expect.objectContaining({ declined: true, threads: [] })]);
  });

  it('normaliza los contactos agregados y quitados', () => {
    const add = normalizeWebhook(contactsPayload({ phone: '573001112233', name: 'Ana Pérez', action: 'add' }));
    const del = normalizeWebhook(contactsPayload({ phone: '573001112233', name: 'Ana Pérez', action: 'remove' }));
    expect(add.contacts).toEqual([expect.objectContaining(
      { waId: '573001112233', name: 'Ana Pérez', action: 'add', phoneNumberId: '106540' })]);
    expect(del.contacts[0].action).toBe('remove');
  });

  it('normaliza un aviso de la cuenta', () => {
    expect(normalizeWebhook(accountUpdatePayload('PARTNER_REMOVED')).accountUpdates)
      .toEqual([{ wabaId: '102290', event: 'PARTNER_REMOVED', phoneNumber: '15550001' }]);
  });

  it('los estados llevan el número por el que salieron', () => {
    const n = normalizeWebhook(statusPayload('wamid.OUT', 'delivered'));
    expect(n.statuses[0]).toMatchObject({ wamid: 'wamid.OUT', status: 'delivered', phoneNumberId: '106540' });
  });

  it('ignora los campos a los que no estamos suscritos', () => {
    const n = normalizeWebhook({ entry: [{ id: '1', changes: [{ field: 'message_template_status_update',
      value: { event: 'APPROVED' } }] }] });
    expect(Object.values(n).every((list) => list.length === 0)).toBe(true);
  });

  const malformados: [string, unknown][] = [
    ['message_echoes no es arreglo', { entry: [{ id: '1', changes: [{ field: 'smb_message_echoes', value: { message_echoes: 'x' } }] }] }],
    ['history trae threads como objeto', { entry: [{ id: '1', changes: [{ field: 'history', value: { history: [{ threads: {} }] } }] }] }],
    ['state_sync es null', { entry: [{ id: '1', changes: [{ field: 'smb_app_state_sync', value: { state_sync: null } }] }] }],
    ['account_update sin event', { entry: [{ id: '1', changes: [{ field: 'account_update', value: {} }] }] }],
  ];
  for (const [nombre, payload] of malformados) {
    it(`no lanza cuando ${nombre}`, () => {
      expect(() => normalizeWebhook(payload)).not.toThrow();
    });
  }
});
```

- [ ] **Step 3: Correr y verlos fallar**

Run: `pnpm test apps/api/test/whatsapp/normalizer.test.ts`
Expected: FAIL — `n.echoes` es `undefined`.

- [ ] **Step 4: Ampliar los tipos compartidos**

En `packages/shared/src/inbound-message.ts`, reemplazar `InboundStatus` y añadir los tipos nuevos:
```ts
export interface InboundStatus {
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
  status: string;
  timestamp: Date;
}

/** Mensaje que el negocio envió desde su app de WhatsApp Business (coexistencia). */
export interface PhoneEcho {
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
  /** wa_id del cliente al que le escribió el negocio, sin '+'. */
  to: string;
  type: InboundType;
  text: string | null;
  mediaId: string | null;
  timestamp: Date;
  raw: unknown;
}

export interface HistoryMessage {
  wamid: string;
  /** wa_id de quien lo escribió: el del hilo si fue el cliente. */
  from: string;
  type: InboundType;
  text: string | null;
  mediaId: string | null;
  timestamp: Date;
  raw: unknown;
}

export interface HistoryChunk {
  phoneNumberId: string;
  wabaId: string;
  phase: number | null;
  progress: number | null;
  /** El negocio no aceptó compartir su historial. */
  declined: boolean;
  threads: { waId: string; messages: HistoryMessage[] }[];
}

export interface ContactSync {
  phoneNumberId: string;
  wabaId: string;
  waId: string;
  name: string | null;
  action: 'add' | 'remove';
}

export interface AccountUpdate {
  wabaId: string;
  event: string;
  phoneNumber: string | null;
}
```

- [ ] **Step 5: Reescribir el normalizador**

`apps/api/src/whatsapp/normalizer.ts` completo:
```ts
import type {
  AccountUpdate, ContactSync, HistoryChunk, HistoryMessage, InboundMessage,
  InboundStatus, InboundType, PhoneEcho,
} from '@citara/shared';

const MEDIA_TYPES = ['image', 'audio', 'document', 'video'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const isMedia = (t: string): t is MediaType =>
  (MEDIA_TYPES as readonly string[]).includes(t);

const toDate = (unixSeconds: string): Date => new Date(Number(unixSeconds) * 1000);

/**
 * Meta manda arreglos en todas partes, pero este normalizador es la frontera
 * del sistema: lo que entra no está bajo nuestro control. `for...of` sobre un
 * objeto lanza TypeError, así que basta un campo con la forma equivocada para
 * tumbar el handler del webhook. Esto degrada lo que no sea arreglo a lista vacía.
 */
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** wa_id sin '+': el mismo cliente llega con y sin prefijo según el evento. */
const waId = (v: unknown): string => String(v ?? '').replace(/^\+/, '');

function parseContent(m: any): { type: InboundType; text: string | null; mediaId: string | null } {
  const rawType = String(m?.type ?? '');
  if (rawType === 'text') return { type: 'text', text: m?.text?.body ?? null, mediaId: null };
  if (rawType === 'interactive') {
    // Botón y lista se aplanan a su id: el motor de flujos ramifica por id.
    const id = m?.interactive?.button_reply?.id ?? m?.interactive?.list_reply?.id ?? null;
    return { type: 'interactive', text: id, mediaId: null };
  }
  if (isMedia(rawType)) return { type: rawType, text: null, mediaId: m?.[rawType]?.id ?? null };
  return { type: 'unsupported', text: null, mediaId: null };
}

export interface NormalizedWebhook {
  messages: InboundMessage[];
  statuses: InboundStatus[];
  echoes: PhoneEcho[];
  history: HistoryChunk[];
  contacts: ContactSync[];
  accountUpdates: AccountUpdate[];
}

/**
 * Traduce el payload de Meta a eventos internos, enrutando por
 * `changes[].field`. Este es el ÚNICO lugar del sistema que conoce el formato
 * de Meta al entrar. Nunca lanza: un payload irreconocible produce listas vacías.
 */
export function normalizeWebhook(payload: unknown): NormalizedWebhook {
  const out: NormalizedWebhook = {
    messages: [], statuses: [], echoes: [], history: [], contacts: [], accountUpdates: [],
  };

  for (const entry of asArray((payload as any)?.entry)) {
    const wabaId = String(entry?.id ?? '');
    for (const change of asArray(entry?.changes)) {
      const value = change?.value;
      if (!value || typeof value !== 'object') continue;
      const phoneNumberId = String(value?.metadata?.phone_number_id ?? '');

      switch (change?.field) {
        case 'smb_message_echoes': collectEchoes(out, value, wabaId, phoneNumberId); break;
        case 'history': collectHistory(out, value, wabaId, phoneNumberId); break;
        case 'smb_app_state_sync': collectContacts(out, value, wabaId, phoneNumberId); break;
        case 'account_update': collectAccountUpdate(out, value, wabaId); break;
        // Sin `field` se trata como `messages`, que es lo que Meta manda desde siempre.
        case 'messages': case undefined: collectMessages(out, value, wabaId, phoneNumberId); break;
        default: break; // campos a los que no estamos suscritos
      }
    }
  }
  return out;
}

function collectMessages(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  const profileByWaId = new Map<string, string | null>(
    asArray(value?.contacts).map((c: any) => [waId(c?.wa_id), c?.profile?.name ?? null]),
  );
  for (const m of asArray(value?.messages)) {
    out.messages.push({
      wamid: String(m?.id ?? ''),
      phoneNumberId,
      wabaId,
      from: waId(m?.from),
      profileName: profileByWaId.get(waId(m?.from)) ?? null,
      ...parseContent(m),
      timestamp: toDate(m?.timestamp ?? '0'),
      raw: m,
    });
  }
  for (const s of asArray(value?.statuses)) {
    out.statuses.push({
      wamid: String(s?.id ?? ''),
      phoneNumberId,
      wabaId,
      status: String(s?.status ?? ''),
      timestamp: toDate(s?.timestamp ?? '0'),
    });
  }
}

function collectEchoes(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  for (const m of asArray(value?.message_echoes)) {
    out.echoes.push({
      wamid: String(m?.id ?? ''),
      phoneNumberId,
      wabaId,
      to: waId(m?.to),
      ...parseContent(m),
      timestamp: toDate(m?.timestamp ?? '0'),
      raw: m,
    });
  }
}

function collectHistory(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  for (const h of asArray(value?.history)) {
    const meta = h?.metadata;
    // VERIFICAR: Meta señala el rechazo a compartir con `errors` en el chunk.
    const declined = asArray(h?.errors).length > 0;
    out.history.push({
      phoneNumberId,
      wabaId,
      phase: typeof meta?.phase === 'number' ? meta.phase : null,
      progress: typeof meta?.progress === 'number' ? meta.progress : null,
      declined,
      threads: declined ? [] : asArray(h?.threads).map((t: any) => ({
        waId: waId(t?.id),
        messages: asArray(t?.messages).map((m: any): HistoryMessage => ({
          wamid: String(m?.id ?? ''),
          from: waId(m?.from),
          ...parseContent(m),
          timestamp: toDate(m?.timestamp ?? '0'),
          raw: m,
        })),
      })),
    });
  }
}

function collectContacts(out: NormalizedWebhook, value: any, wabaId: string, phoneNumberId: string) {
  for (const s of asArray(value?.state_sync)) {
    if (s?.type !== 'contact') continue;
    const action = s?.action === 'add' || s?.action === 'remove' ? s.action : null;
    const phone = waId(s?.contact?.phone_number);
    if (!action || !phone) continue;
    out.contacts.push({
      phoneNumberId, wabaId, waId: phone, action,
      name: s?.contact?.full_name ?? s?.contact?.first_name ?? null,
    });
  }
}

function collectAccountUpdate(out: NormalizedWebhook, value: any, wabaId: string) {
  if (typeof value?.event !== 'string' || !value.event) return;
  out.accountUpdates.push({
    wabaId, event: value.event,
    phoneNumber: value?.phone_number ? String(value.phone_number) : null,
  });
}
```

- [ ] **Step 6: Correr los tests**

Run: `pnpm test apps/api/test/whatsapp && pnpm typecheck`
Expected: PASS, incluidos los tests de normalizador de la Fase 1 y los e2e del webhook.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/inbound-message.ts apps/api/src/whatsapp/normalizer.ts apps/api/test/whatsapp
git commit -m "feat(whatsapp): normalizar ecos, historial, contactos y avisos de cuenta de la coexistencia"
```

---

### Task 6: El eco del celular da el control al dueño

**Files:**
- Create: `apps/api/src/coexistence/echo.processor.ts`
- Modify: `apps/api/src/queues/inbound.queue.ts` (tipo `EchoJob`)
- Modify: `apps/api/src/app.module.ts` (provider)
- Test: `apps/api/test/coexistence/echo.processor.test.ts`

**Interfaces:**
- Consumes: `PhoneEcho` (Task 5), `giveControlToHuman` (Task 2).
- Produces: `interface EchoJob { tenantId: string; channelId: string; echo: PhoneEcho }` en `inbound.queue.ts`; `EchoProcessor.process(job: EchoJob): Promise<{ messageId: string; duplicate: boolean }>`.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/coexistence/echo.processor.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import type { PhoneEcho } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { EchoProcessor } from '../../src/coexistence/echo.processor';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: EchoProcessor;
let tenantId: string, channelId: string;

const echo = (over: Partial<PhoneEcho> = {}): PhoneEcho => ({
  wamid: 'wamid.ECHO1', phoneNumberId: '106540', wabaId: '102290', to: '573001112233',
  type: 'text', text: 'Ya te atiendo', mediaId: null, timestamp: new Date(), raw: {}, ...over,
});
const conversation = async () => (await adminQuery(
  `SELECT control, human_until, control_reason, last_inbound_at FROM conversations`))[0];

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new EchoProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId, channelId } = await seedChannel()); });

describe('EchoProcessor', () => {
  it('guarda el eco como saliente del teléfono y le da el control al dueño', async () => {
    const at = new Date();
    await processor.process({ tenantId, channelId, echo: echo({ timestamp: at }) });

    const [m] = await adminQuery(`SELECT direction, origin, body, occurred_at, status FROM messages`);
    expect(m).toMatchObject({ direction: 'out', origin: 'phone', body: 'Ya te atiendo', status: null });
    expect(new Date(m.occurred_at).toISOString()).toBe(at.toISOString());
    const c = await conversation();
    expect(c.control).toBe('human');
    expect(c.control_reason).toBe('phone');
    expect(new Date(c.human_until).getTime()).toBe(at.getTime() + 12 * 3_600_000);
  });

  it('lo que escribe el negocio no abre la ventana de 24 h', async () => {
    await processor.process({ tenantId, channelId, echo: echo() });
    expect((await conversation()).last_inbound_at).toBeNull();
  });

  it('un eco a un cliente nuevo crea el contacto y la conversación', async () => {
    await processor.process({ tenantId, channelId, echo: echo({ to: '573009990000' }) });
    const [k] = await adminQuery(`SELECT wa_id FROM contacts`);
    expect(k.wa_id).toBe('573009990000');
  });

  it('el mismo eco dos veces no se duplica ni se audita dos veces', async () => {
    await processor.process({ tenantId, channelId, echo: echo() });
    const again = await processor.process({ tenantId, channelId, echo: echo() });

    expect(again.duplicate).toBe(true);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    const [{ a }] = await adminQuery(`SELECT count(*)::int AS a FROM audit_log`);
    expect([n, a]).toEqual([1, 1]);
  });

  it('cada eco nuevo alarga el plazo del dueño', async () => {
    const first = new Date(Date.now() - 3_600_000);
    const second = new Date();
    await processor.process({ tenantId, channelId, echo: echo({ wamid: 'wamid.EA', timestamp: first }) });
    await processor.process({ tenantId, channelId, echo: echo({ wamid: 'wamid.EB', timestamp: second }) });

    expect(new Date((await conversation()).human_until).getTime())
      .toBe(second.getTime() + 12 * 3_600_000);
  });

  it('un eco de un tipo que no entendemos sigue siendo el dueño atendiendo', async () => {
    // Un sticker o una reacción desde el celular: no hay texto, pero el dueño
    // está en la conversación y el bot no debe meterse.
    await processor.process({ tenantId, channelId, echo: echo({ type: 'unsupported', text: null }) });
    expect((await conversation()).control).toBe('human');
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/coexistence/echo.processor.test.ts`
Expected: FAIL con `Failed to load url ../../src/coexistence/echo.processor`.

- [ ] **Step 3: Declarar el job**

En `apps/api/src/queues/inbound.queue.ts`, cambiar el import y añadir el tipo después de `InboundJob`:
```ts
import type { InboundMessage, PhoneEcho } from '@citara/shared';
```
```ts
/** Lo que el negocio envió desde su celular (coexistencia). */
export interface EchoJob {
  tenantId: string;
  channelId: string;
  echo: PhoneEcho;
}
```

- [ ] **Step 4: Escribir el procesador**

`apps/api/src/coexistence/echo.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Import de VALOR, no `import type`: EchoProcessor es @Injectable() y Nest
// resuelve DataSource por el design:paramtype que emite el decorador.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { giveControlToHuman } from '../conversations/control';
import type { EchoJob } from '../queues/inbound.queue';

/**
 * El dueño escribió desde su app de WhatsApp Business. Se guarda en la
 * conversación (es parte de ella) y el control pasa al humano (spec §6.1).
 * Corre en la cola `inbound`: el upsert de la conversación toma el mismo lock
 * que los mensajes del cliente, así que un eco y un mensaje simultáneos no se
 * procesan en desorden.
 */
@Injectable()
export class EchoProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: EchoJob): Promise<{ messageId: string; duplicate: boolean }> {
    const { tenantId, channelId, echo } = job;

    return runInTenant(this.ds, tenantId, async (m) => {
      // El duplicado se reconoce antes de tocar contactos y conversaciones.
      const [seen] = await m.query(`SELECT id FROM messages WHERE wamid = $1`, [echo.wamid]);
      if (seen) return { messageId: seen.id, duplicate: true };

      // DO UPDATE (no DO NOTHING) para que RETURNING devuelva el id existente.
      const [contact] = await m.query(
        `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2)
         ON CONFLICT (tenant_id, wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id
         RETURNING id`,
        [tenantId, echo.to],
      );

      // Sin last_inbound_at: lo que escribe el negocio no abre la ventana de 24 h.
      const [conversation] = await m.query(
        `INSERT INTO conversations (tenant_id, contact_id, channel_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed'
           DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, contact.id, channelId],
      );

      const [saved] = await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type, body,
                               payload, occurred_at)
         VALUES ($1, $2, $3, 'out', 'phone', $4, $5, $6, $7)
         ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantId, conversation.id, echo.wamid, echo.type, echo.text,
         JSON.stringify(echo.raw), echo.timestamp],
      );
      if (!saved) return { messageId: '', duplicate: true }; // ganó otro intento

      await giveControlToHuman(m, {
        tenantId, conversationId: conversation.id,
        from: echo.timestamp, reason: 'phone', actor: 'phone',
      });
      return { messageId: saved.id, duplicate: false };
    });
  }
}
```

- [ ] **Step 5: Registrarlo en el módulo**

En `apps/api/src/app.module.ts`, importar `EchoProcessor` y añadirlo a `providers` al final de la lista:
```ts
import { EchoProcessor } from './coexistence/echo.processor';
```
```ts
    // Lo resuelve apps/worker con ctx.get(...) al despachar la cola inbound
    // (Task 10). Sin esta entrada el worker arranca y revienta después con
    // UnknownElementException, invisible para los tests que lo construyen a mano.
    EchoProcessor,
```

- [ ] **Step 6: Correr los tests**

Run: `pnpm test apps/api/test/coexistence && pnpm typecheck`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/coexistence/echo.processor.ts apps/api/src/queues/inbound.queue.ts apps/api/src/app.module.ts apps/api/test/coexistence/echo.processor.test.ts
git commit -m "feat(coexistence): guardar los ecos del celular y darle el control al dueño"
```

---

### Task 7: Estados de entrega

**Files:**
- Create: `apps/api/src/queues/status.processor.ts`
- Modify: `apps/api/src/queues/inbound.queue.ts` (tipo `StatusJob`)
- Modify: `apps/api/src/app.module.ts` (provider)
- Test: `apps/api/test/queues/status.processor.test.ts`

**Interfaces:**
- Consumes: `InboundStatus` (Task 5).
- Produces: `interface StatusJob { tenantId: string; status: InboundStatus }`; `StatusProcessor.process(job): Promise<{ updated: boolean }>`.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/queues/status.processor.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { StatusProcessor } from '../../src/queues/status.processor';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: StatusProcessor;
let tenantId: string;

const statusOf = async (wamid: string) =>
  (await adminQuery(`SELECT status FROM messages WHERE wamid = $1`, [wamid]))[0]?.status;
const apply = (wamid: string, status: string) => processor.process({
  tenantId, status: { wamid, status, phoneNumberId: '106540', wabaId: '102290', timestamp: new Date() } });

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new StatusProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  let channelId: string;
  ({ tenantId, channelId } = await seedChannel());
  const [k] = await adminQuery(`INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, '573001112233') RETURNING id`, [tenantId]);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, k.id, channelId]);
  await adminQuery(
    `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type, body, status)
     VALUES ($1, $2, 'wamid.S1', 'out', 'bot', 'text', 'Hola', 'sent'),
            ($1, $2, 'wamid.P1', 'out', 'phone', 'text', 'Ya voy', NULL)`,
    [tenantId, c.id]);
});

describe('StatusProcessor', () => {
  it('avanza sent → delivered → read', async () => {
    await apply('wamid.S1', 'delivered');
    expect(await statusOf('wamid.S1')).toBe('delivered');
    await apply('wamid.S1', 'read');
    expect(await statusOf('wamid.S1')).toBe('read');
  });

  it('nunca retrocede: un delivered que llega tarde no pisa un read', async () => {
    await apply('wamid.S1', 'read');
    const r = await apply('wamid.S1', 'delivered');
    expect(r.updated).toBe(false);
    expect(await statusOf('wamid.S1')).toBe('read');
  });

  it('registra un fallo que Meta reporta después de haber aceptado', async () => {
    await apply('wamid.S1', 'failed');
    expect(await statusOf('wamid.S1')).toBe('failed');
  });

  it('no toca los mensajes que no salieron por nosotros', async () => {
    await apply('wamid.P1', 'read');
    expect(await statusOf('wamid.P1')).toBeNull();
  });

  it('ignora un wamid desconocido o un estado que no reconoce', async () => {
    expect((await apply('wamid.NOPE', 'read')).updated).toBe(false);
    expect((await apply('wamid.S1', 'deleted')).updated).toBe(false);
    expect(await statusOf('wamid.S1')).toBe('sent');
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/queues/status.processor.test.ts`
Expected: FAIL con `Failed to load url ../../src/queues/status.processor`.

- [ ] **Step 3: Declarar el job**

En `apps/api/src/queues/inbound.queue.ts`, ampliar el import (`InboundStatus`) y añadir:
```ts
/** Acuse de entrega o lectura de algo que enviamos. */
export interface StatusJob {
  tenantId: string;
  status: InboundStatus;
}
```

- [ ] **Step 4: Escribir el procesador**

`apps/api/src/queues/status.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { StatusJob } from './inbound.queue';

/**
 * De qué estados puede venir cada uno. Solo hacia adelante: Meta no garantiza
 * el orden de los acuses, y un `delivered` tardío no puede deshacer un `read`.
 * Las filas sin estado (ecos, historial) quedan fuera porque NULL no está en
 * ninguna lista.
 */
const PREDECESSORS: Record<string, string[]> = {
  delivered: ['sent'],
  read: ['sent', 'delivered'],
  failed: ['sent', 'delivered'],
};

@Injectable()
export class StatusProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: StatusJob): Promise<{ updated: boolean }> {
    const from = PREDECESSORS[job.status.status];
    if (!from) return { updated: false };

    // Con UPDATE, TypeORM devuelve [filas, conteo].
    const [, affected] = (await runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE messages SET status = $2
        WHERE wamid = $1 AND status = ANY($3::varchar[])`,
      [job.status.wamid, job.status.status, from]))) as [unknown[], number];
    return { updated: affected > 0 };
  }
}
```

- [ ] **Step 5: Registrarlo en el módulo**

En `apps/api/src/app.module.ts`, importar `StatusProcessor` y añadirlo a `providers` (mismo comentario que `EchoProcessor`).

- [ ] **Step 6: Correr los tests**

Run: `pnpm test apps/api/test/queues && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/queues/status.processor.ts apps/api/src/queues/inbound.queue.ts apps/api/src/app.module.ts apps/api/test/queues/status.processor.test.ts
git commit -m "feat(queues): registrar los estados de entrega de meta solo hacia adelante"
```

---

### Task 8: Historial y contactos

**Files:**
- Create: `apps/api/src/queues/sync.queue.ts` (solo tipos y rehidratación; la clase de la cola llega en la Task 10)
- Create: `apps/api/src/coexistence/history.processor.ts`
- Create: `apps/api/src/coexistence/contacts-sync.processor.ts`
- Modify: `apps/api/src/app.module.ts` (dos providers)
- Test: `apps/api/test/coexistence/history.processor.test.ts`
- Test: `apps/api/test/coexistence/contacts-sync.processor.test.ts`

**Interfaces:**
- Consumes: `HistoryChunk`, `ContactSync` (Task 5), `giveControlToHuman` (Task 2), GRANT por columna sobre `history_sync` (Task 1).
- Produces:
  - `interface HistoryJob { tenantId: string; channelId: string; chunk: HistoryChunk }`
  - `interface ContactsSyncJob { tenantId: string; contacts: ContactSync[] }`
  - `rehydrateHistoryJob(d: HistoryJob): HistoryJob`
  - `historyComplete(chunk: HistoryChunk): boolean`
  - `HistoryProcessor.process(job: HistoryJob): Promise<{ imported: number }>`
  - `ContactsSyncProcessor.process(job: ContactsSyncJob): Promise<void>`

- [ ] **Step 1: Escribir los tests del historial que fallan**

`apps/api/test/coexistence/history.processor.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import type { HistoryChunk } from '@citara/shared';
import { createDataSource } from '@citara/db';
import { HistoryProcessor } from '../../src/coexistence/history.processor';
import { EchoProcessor } from '../../src/coexistence/echo.processor';
import { normalizeWebhook } from '../../src/whatsapp/normalizer';
import { historyPayload, historyDeclinedPayload, type HistoryLine } from '../whatsapp/fixtures/coexistence';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: HistoryProcessor;
let tenantId: string, channelId: string;

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const chunkOf = (customer: string, lines: HistoryLine[], phase = 2, progress = 100): HistoryChunk =>
  normalizeWebhook(historyPayload({ customer, lines, phase, progress })).history[0];
const run = (chunk: HistoryChunk) => processor.process({ tenantId, channelId, chunk });
const controlOf = async (waId: string) => (await adminQuery(
  `SELECT c.control, c.control_reason, c.human_until, c.last_inbound_at
     FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.wa_id = $1`, [waId]))[0];

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new HistoryProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  await adminQuery(`UPDATE whatsapp_channels SET mode = 'coexistence', history_sync = 'pending'`);
});

describe('HistoryProcessor', () => {
  it('importa cada mensaje con su dirección, origen history y hora real', async () => {
    await run(chunkOf('573001112233', [
      { wamid: 'wamid.H1', fromCustomer: true, text: 'Hola, ¿tienen cita el martes?', at: ago(50) },
      { wamid: 'wamid.H2', fromCustomer: false, text: 'Sí, a las 3', at: ago(49) },
    ], 1, 50));

    const rows = await adminQuery(
      `SELECT wamid, direction, origin, body FROM messages ORDER BY occurred_at`);
    expect(rows).toEqual([
      { wamid: 'wamid.H1', direction: 'in', origin: 'history', body: 'Hola, ¿tienen cita el martes?' },
      { wamid: 'wamid.H2', direction: 'out', origin: 'history', body: 'Sí, a las 3' },
    ]);
  });

  it('los mensajes del cliente cuentan para la ventana de 24 h', async () => {
    const at = ago(3);
    await run(chunkOf('573001112233', [{ wamid: 'wamid.W1', fromCustomer: true, text: 'Hola', at }], 0, 10));
    const c = await controlOf('573001112233');
    expect(new Date(c.last_inbound_at).getTime()).toBe(Math.floor(at.getTime() / 1000) * 1000);
  });

  it('reimportar el mismo chunk no duplica nada', async () => {
    const chunk = chunkOf('573001112233', [{ wamid: 'wamid.D1', fromCustomer: true, text: 'Hola', at: ago(5) }], 1, 50);
    await run(chunk);
    const second = await run(chunk);
    expect(second.imported).toBe(0);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM messages`);
    expect(n).toBe(1);
  });

  it('un mensaje que ya llegó por eco no se duplica al importar el historial', async () => {
    await new EchoProcessor(ds).process({ tenantId, channelId, echo: {
      wamid: 'wamid.SAME', phoneNumberId: '106540', wabaId: '102290', to: '573001112233',
      type: 'text', text: 'Ya voy', mediaId: null, timestamp: ago(1), raw: {} } });
    await run(chunkOf('573001112233', [{ wamid: 'wamid.SAME', fromCustomer: false, text: 'Ya voy', at: ago(1) }]));

    const rows = await adminQuery(`SELECT origin FROM messages WHERE wamid = 'wamid.SAME'`);
    expect(rows).toEqual([{ origin: 'phone' }]);
  });

  it('si el negocio no compartió el historial, el canal lo registra', async () => {
    await run(normalizeWebhook(historyDeclinedPayload()).history[0]);
    const [ch] = await adminQuery(`SELECT history_sync FROM whatsapp_channels`);
    expect(ch.history_sync).toBe('declined');
  });

  it('al completar, deja en manos del dueño solo donde estuvo activo hace menos de N horas', async () => {
    // Una sola medición: Meta trae segundos, y recalcular `ago(2)` en la
    // aserción podría caer en el segundo siguiente.
    const ownerAt = ago(2);
    await run(chunkOf('573000000001', [
      { wamid: 'wamid.R1', fromCustomer: true, text: '¿A qué hora me dijiste?', at: ago(3) },
      { wamid: 'wamid.R2', fromCustomer: false, text: 'A las 5', at: ownerAt },
    ], 1, 60));
    await run(chunkOf('573000000002', [
      { wamid: 'wamid.O1', fromCustomer: false, text: 'Gracias por venir', at: ago(72) },
    ], 2, 100));

    const reciente = await controlOf('573000000001');
    expect([reciente.control, reciente.control_reason]).toEqual(['human', 'history']);
    expect(new Date(reciente.human_until).getTime())
      .toBe(Math.floor(ownerAt.getTime() / 1000) * 1000 + 12 * 3_600_000);
    expect((await controlOf('573000000002')).control).toBe('bot');
    const [ch] = await adminQuery(`SELECT history_sync FROM whatsapp_channels`);
    expect(ch.history_sync).toBe('done');
  });

  it('un chunk que llega después del final también aplica la regla', async () => {
    // Reentregas: el chunk con progress 100 puede procesarse antes que otro.
    await run(chunkOf('573000000003', [{ wamid: 'wamid.F1', fromCustomer: false, text: 'x', at: ago(80) }], 2, 100));
    await run(chunkOf('573000000004', [{ wamid: 'wamid.L1', fromCustomer: false, text: 'Ya te confirmo', at: ago(1) }], 1, 70));

    expect((await controlOf('573000000004')).control).toBe('human');
  });
});
```

- [ ] **Step 2: Escribir los tests de contactos que fallan**

`apps/api/test/coexistence/contacts-sync.processor.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { ContactsSyncProcessor } from '../../src/coexistence/contacts-sync.processor';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: ContactsSyncProcessor;
let tenantId: string;

const contact = (action: 'add' | 'remove', name = 'Ana Pérez') => ({
  phoneNumberId: '106540', wabaId: '102290', waId: '573001112233', name, action });

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new ContactsSyncProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('ContactsSyncProcessor', () => {
  it('guarda el nombre con que el negocio tiene al cliente, aunque aún no haya escrito', async () => {
    await processor.process({ tenantId, contacts: [contact('add')] });
    expect(await adminQuery(`SELECT wa_id, saved_name FROM contacts`))
      .toEqual([{ wa_id: '573001112233', saved_name: 'Ana Pérez' }]);
  });

  it('actualiza el nombre si el negocio lo cambia y lo borra si quita el contacto', async () => {
    await processor.process({ tenantId, contacts: [contact('add')] });
    await processor.process({ tenantId, contacts: [contact('add', 'Ana P. (martes)')] });
    expect((await adminQuery(`SELECT saved_name FROM contacts`))[0].saved_name).toBe('Ana P. (martes)');

    await processor.process({ tenantId, contacts: [contact('remove')] });
    expect((await adminQuery(`SELECT saved_name FROM contacts`))[0].saved_name).toBeNull();
  });
});
```

- [ ] **Step 3: Correr y verlos fallar**

Run: `pnpm test apps/api/test/coexistence`
Expected: FAIL — no existen `history.processor` ni `contacts-sync.processor`.

- [ ] **Step 4: Declarar los jobs de la cola `sync`**

`apps/api/src/queues/sync.queue.ts`:
```ts
import type { ContactSync, HistoryChunk } from '@citara/shared';

export const SYNC_QUEUE = 'sync';

export interface HistoryJob {
  tenantId: string;
  channelId: string;
  chunk: HistoryChunk;
}

export interface ContactsSyncJob {
  tenantId: string;
  contacts: ContactSync[];
}

/** BullMQ guarda JSON: las fechas del historial llegan como string. */
export function rehydrateHistoryJob(d: HistoryJob): HistoryJob {
  return {
    ...d,
    chunk: {
      ...d.chunk,
      threads: d.chunk.threads.map((t) => ({
        ...t,
        messages: t.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })),
      })),
    },
  };
}
```

- [ ] **Step 5: Escribir el procesador de historial**

`apps/api/src/coexistence/history.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { HistoryChunk } from '@citara/shared';
import { runInTenant } from '../tenancy/tenant-context';
import { giveControlToHuman } from '../conversations/control';
import type { HistoryJob } from '../queues/sync.queue';

/**
 * VERIFICAR contra la documentación: Meta manda el historial en fases (0: el
 * último día, 1: hasta 90 días, 2: hasta 180) y `progress` de 0 a 100. El
 * chunk de la última fase con progress 100 cierra la importación.
 */
export function historyComplete(chunk: HistoryChunk): boolean {
  return chunk.phase === 2 && chunk.progress === 100;
}

/**
 * Importa el historial de un número en coexistencia (spec §5.3) y, al
 * terminar, aplica la regla del dueño activo (§6.2). Corre en la cola `sync`
 * con concurrencia 1: llega en tandas grandes y no debe retrasar a nadie.
 */
@Injectable()
export class HistoryProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: HistoryJob): Promise<{ imported: number }> {
    const { tenantId, channelId, chunk } = job;

    return runInTenant(this.ds, tenantId, async (m) => {
      if (chunk.declined) {
        await m.query(`UPDATE whatsapp_channels SET history_sync = 'declined' WHERE id = $1`, [channelId]);
        return { imported: 0 };
      }

      let imported = 0;
      for (const thread of chunk.threads) {
        if (!thread.waId) continue;
        const fromCustomer = thread.messages.filter((x) => x.from === thread.waId);
        const lastInbound = fromCustomer.length
          ? new Date(Math.max(...fromCustomer.map((x) => x.timestamp.getTime())))
          : null;

        const [contact] = await m.query(
          `INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2)
           ON CONFLICT (tenant_id, wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id
           RETURNING id`,
          [tenantId, thread.waId],
        );
        // GREATEST: la ventana de Meta cuenta mensajes reales del cliente,
        // aunque sean previos a Citara, y nunca se encoge.
        const [conversation] = await m.query(
          `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed'
             DO UPDATE SET last_inbound_at = GREATEST(conversations.last_inbound_at,
                                                      EXCLUDED.last_inbound_at),
                           updated_at = now()
           RETURNING id`,
          [tenantId, contact.id, channelId, lastInbound],
        );

        for (const msg of thread.messages) {
          if (!msg.wamid) continue;
          const rows = await m.query(
            `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, origin, type,
                                   body, payload, occurred_at)
             VALUES ($1, $2, $3, $4, 'history', $5, $6, $7, $8)
             ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
             RETURNING id`,
            [tenantId, conversation.id, msg.wamid, msg.from === thread.waId ? 'in' : 'out',
             msg.type, msg.text, JSON.stringify(msg.raw), msg.timestamp],
          );
          imported += rows.length;
        }
      }

      // La regla corre en el chunk final Y en cualquiera que llegue después:
      // con reentregas, el final puede procesarse antes que otros.
      const [channel] = await m.query(
        `SELECT history_sync FROM whatsapp_channels WHERE id = $1`, [channelId]);
      if (historyComplete(chunk) || channel?.history_sync === 'done') {
        await m.query(
          `UPDATE whatsapp_channels SET history_sync = 'done' WHERE id = $1 AND history_sync <> 'done'`,
          [channelId]);
        await this.applyRecentHumanRule(m, tenantId, channelId);
      }
      return { imported };
    });
  }

  /** El bot solo responde donde el dueño no estuvo activo en las últimas N horas. */
  private async applyRecentHumanRule(m: EntityManager, tenantId: string, channelId: string) {
    const recent: { conversation_id: string; last_out: Date }[] = await m.query(
      `SELECT msg.conversation_id, max(msg.occurred_at) AS last_out
         FROM messages msg
         JOIN conversations c ON c.id = msg.conversation_id
         JOIN tenants t ON t.id = c.tenant_id
        WHERE c.channel_id = $1 AND c.status = 'open'
          AND msg.direction = 'out' AND msg.origin IN ('history', 'phone')
        GROUP BY msg.conversation_id, t.human_takeover_hours
       HAVING max(msg.occurred_at) + make_interval(hours => t.human_takeover_hours) > now()`,
      [channelId],
    );
    for (const r of recent) {
      await giveControlToHuman(m, {
        tenantId, conversationId: r.conversation_id,
        from: new Date(r.last_out), reason: 'history', actor: 'history',
      });
    }
  }
}
```

- [ ] **Step 6: Escribir el procesador de contactos**

`apps/api/src/coexistence/contacts-sync.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { ContactsSyncJob } from '../queues/sync.queue';

/** El nombre con que el negocio guarda a cada cliente en su celular (smb_app_state_sync). */
@Injectable()
export class ContactsSyncProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: ContactsSyncJob): Promise<void> {
    await runInTenant(this.ds, job.tenantId, async (m) => {
      for (const c of job.contacts) {
        if (c.action === 'add') {
          await m.query(
            `INSERT INTO contacts (tenant_id, wa_id, saved_name) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, wa_id) DO UPDATE SET saved_name = EXCLUDED.saved_name`,
            [job.tenantId, c.waId, c.name]);
        } else {
          await m.query(`UPDATE contacts SET saved_name = NULL WHERE wa_id = $1`, [c.waId]);
        }
      }
    });
  }
}
```

- [ ] **Step 7: Registrarlos en el módulo**

En `apps/api/src/app.module.ts`, importar `HistoryProcessor` y `ContactsSyncProcessor` y añadirlos a `providers` (mismo comentario que `EchoProcessor`).

- [ ] **Step 8: Correr los tests**

Run: `pnpm test apps/api/test/coexistence && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/queues/sync.queue.ts apps/api/src/coexistence apps/api/src/app.module.ts apps/api/test/coexistence
git commit -m "feat(coexistence): importar el historial y los contactos del celular del negocio"
```

---

### Task 9: Desconexión del número

**Files:**
- Create: `apps/api/src/coexistence/account-update.processor.ts`
- Modify: `apps/api/src/queues/inbound.queue.ts` (tipo `AccountUpdateJob`)
- Modify: `apps/api/src/app.module.ts` (provider)
- Test: `apps/api/test/coexistence/account-update.processor.test.ts`

**Interfaces:**
- Consumes: `AccountUpdate` (Task 5), `recordAudit` (Task 2), GRANT por columna sobre `status` (Task 1).
- Produces: `interface AccountUpdateJob { update: AccountUpdate }`; `DISCONNECT_EVENTS: Set<string>`; `AccountUpdateProcessor.process(job): Promise<{ disconnected: number }>`.

- [ ] **Step 1: Escribir los tests que fallan**

`apps/api/test/coexistence/account-update.processor.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { AccountUpdateProcessor } from '../../src/coexistence/account-update.processor';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: AccountUpdateProcessor;
let tenantId: string;

const update = (event: string, wabaId = '102290') =>
  processor.process({ update: { wabaId, event, phoneNumber: '15550001' } });
const statuses = async () =>
  (await adminQuery(`SELECT status FROM whatsapp_channels ORDER BY phone_number_id`)).map((r: { status: string }) => r.status);

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new AccountUpdateProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('AccountUpdateProcessor', () => {
  it('una desconexión marca el canal como desconectado y lo audita', async () => {
    const r = await update('PARTNER_REMOVED');

    expect(r.disconnected).toBe(1);
    expect(await statuses()).toEqual(['disconnected']);
    const [a] = await adminQuery(`SELECT actor, action, tenant_id FROM audit_log`);
    expect(a).toEqual({ actor: 'meta', action: 'channel.disconnected', tenant_id: tenantId });
  });

  it('desconecta todos los números de la misma cuenta', async () => {
    const [ch] = await adminQuery(`SELECT access_token_encrypted FROM whatsapp_channels`);
    await adminQuery(
      `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, access_token_encrypted)
       VALUES ($1, '102290', '106541', $2)`, [tenantId, ch.access_token_encrypted]);

    expect((await update('PARTNER_REMOVED')).disconnected).toBe(2);
    expect(await statuses()).toEqual(['disconnected', 'disconnected']);
  });

  it('ignora los eventos que no son desconexión y las cuentas ajenas', async () => {
    expect((await update('VERIFIED_ACCOUNT')).disconnected).toBe(0);
    expect((await update('PARTNER_REMOVED', '999999')).disconnected).toBe(0);
    expect(await statuses()).toEqual(['active']);
  });

  it('repetir el aviso no vuelve a auditar', async () => {
    await update('PARTNER_REMOVED');
    await update('PARTNER_REMOVED');
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM audit_log`);
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: Correr y verlos fallar**

Run: `pnpm test apps/api/test/coexistence/account-update.processor.test.ts`
Expected: FAIL con `Failed to load url ../../src/coexistence/account-update.processor`.

- [ ] **Step 3: Declarar el job**

En `apps/api/src/queues/inbound.queue.ts`, ampliar el import (`AccountUpdate`) y añadir:
```ts
/** Aviso de Meta sobre la cuenta. Llega por WABA, sin phone_number_id. */
export interface AccountUpdateJob {
  update: AccountUpdate;
}
```

- [ ] **Step 4: Escribir el procesador**

`apps/api/src/coexistence/account-update.processor.ts`:
```ts
import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';
import type { AccountUpdateJob } from '../queues/inbound.queue';

/** VERIFICAR contra la documentación: eventos que significan "este número ya no está conectado". */
export const DISCONNECT_EVENTS = new Set(['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED']);

@Injectable()
export class AccountUpdateProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: AccountUpdateJob): Promise<{ disconnected: number }> {
    const { wabaId, event } = job.update;
    if (!DISCONNECT_EVENTS.has(event)) return { disconnected: 0 };

    // Sin RLS: whatsapp_channels se resuelve antes de conocer el tenant. La app
    // solo puede tocar `status` e `history_sync` (GRANT por columna). Con
    // UPDATE, TypeORM devuelve [filas, conteo].
    const [rows] = (await this.ds.query(
      `UPDATE whatsapp_channels SET status = 'disconnected'
        WHERE waba_id = $1 AND status <> 'disconnected'
        RETURNING id, tenant_id`,
      [wabaId])) as [{ id: string; tenant_id: string }[], number];

    for (const ch of rows) {
      await runInTenant(this.ds, ch.tenant_id, (m) => recordAudit(m, {
        tenantId: ch.tenant_id, actor: 'meta', action: 'channel.disconnected',
        details: { channelId: ch.id, event },
      }));
    }
    return { disconnected: rows.length };
  }
}
```

- [ ] **Step 5: Registrarlo en el módulo**

En `apps/api/src/app.module.ts`, importar `AccountUpdateProcessor` y añadirlo a `providers` (mismo comentario que `EchoProcessor`).

- [ ] **Step 6: Correr los tests**

Run: `pnpm test apps/api/test/coexistence && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/coexistence/account-update.processor.ts apps/api/src/queues/inbound.queue.ts apps/api/src/app.module.ts apps/api/test/coexistence/account-update.processor.test.ts
git commit -m "feat(coexistence): marcar como desconectado el número que el negocio retira"
```

---

### Task 10: Cada evento a su cola, y cada cola a su procesador

**Files:**
- Modify: `apps/api/src/queues/inbound.queue.ts` (métodos de encolado y rehidratación)
- Modify: `apps/api/src/queues/sync.queue.ts` (clase `SyncQueue`)
- Modify: `apps/api/src/whatsapp/ingest.service.ts`
- Modify: `apps/api/src/queues/workers.ts`
- Modify: `apps/api/src/app.module.ts` (`SyncQueue`)
- Test: `apps/api/test/whatsapp/ingest.test.ts`
- Test: `apps/api/test/queues/inbound.queue.test.ts`

**Interfaces:**
- Consumes: `NormalizedWebhook` (Task 5); `EchoJob`, `StatusJob`, `AccountUpdateJob`; `HistoryJob`, `ContactsSyncJob`; los cinco procesadores (Tasks 6-9).
- Produces:
  - `InboundQueue.addEcho(job: EchoJob)`, `addStatus(job: StatusJob)`, `addAccountUpdate(job: AccountUpdateJob)`; nombres de job `'process'`, `'phone_echo'`, `'status'`, `'account_update'`.
  - `SyncQueue.addHistory(job: HistoryJob)`, `addContacts(job: ContactsSyncJob)`; nombres `'history_chunk'`, `'contacts_sync'`.
  - `rehydrateEchoJob`, `rehydrateStatusJob`.
  - `IngestService` recibe `SyncQueue` como cuarto parámetro del constructor.
  - `startWorkers` despacha por `job.name` y arranca un worker de `sync` con concurrencia 1.

- [ ] **Step 1: Escribir los tests de ingesta que fallan**

En `apps/api/test/whatsapp/ingest.test.ts`, reemplazar la cola de mentira y el `describe` existentes. La cola falsa registra cada llamada con su método:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { IngestService } from '../../src/whatsapp/ingest.service';
import type { InboundQueue } from '../../src/queues/inbound.queue';
import type { SyncQueue } from '../../src/queues/sync.queue';
import {
  accountUpdatePayload, contactsPayload, echoPayload, historyPayload, statusPayload,
} from './fixtures/coexistence';
import { resetDb, seedChannel, closeHelpers } from '../helpers';

let ds: DataSource;
let channels: ChannelResolver;
let calls: { method: string; job: any }[];
let failNextAdd: boolean;

const recorder = (methods: string[]) => Object.fromEntries(methods.map((method) => [
  method, async (job: unknown) => {
    if (failNextAdd) { failNextAdd = false; throw new Error('Redis caído'); }
    calls.push({ method, job });
  },
]));
const queue = recorder(['add', 'addEcho', 'addStatus', 'addAccountUpdate']) as unknown as InboundQueue;
const sync = recorder(['addHistory', 'addContacts']) as unknown as SyncQueue;
const ingest = () => new IngestService(ds, channels, queue, sync);

const payload = {
  object: 'whatsapp_business_account',
  entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: 'wamid.ING1', timestamp: '1756900000',
                 type: 'text', text: { body: 'Hola' } }],
  } }] }],
};

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
  await enc.ready();
  channels = new ChannelResolver(ds, enc);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); await seedChannel(); calls = []; failNextAdd = false; });

describe('IngestService', () => {
  it('si encolar falla tras registrar el evento, la reentrega de Meta vuelve a encolar', async () => {
    failNextAdd = true;
    await expect(ingest().ingest(payload)).rejects.toThrow('Redis caído');
    const second = await ingest().ingest(payload);

    expect(calls.map((c) => c.job.message.wamid)).toEqual(['wamid.ING1']);
    expect(second.duplicates).toBe(1);
  });

  it('encola el eco del celular con su negocio y canal', async () => {
    await ingest().ingest(echoPayload({ wamid: 'wamid.E1', to: '573001112233' }));
    expect(calls).toEqual([{ method: 'addEcho', job: expect.objectContaining({
      tenantId: expect.any(String), channelId: expect.any(String),
      echo: expect.objectContaining({ wamid: 'wamid.E1' }) }) }]);
  });

  it('un eco reentregado se cuenta como duplicado pero se vuelve a encolar', async () => {
    const p = echoPayload({ wamid: 'wamid.E2', to: '573001112233' });
    await ingest().ingest(p);
    const second = await ingest().ingest(p);
    expect(second.duplicates).toBe(1);
    expect(calls.filter((c) => c.method === 'addEcho')).toHaveLength(2);
  });

  it('encola los estados en la cola de entrada', async () => {
    await ingest().ingest(statusPayload('wamid.OUT', 'read'));
    expect(calls[0]).toMatchObject({ method: 'addStatus', job: { status: { wamid: 'wamid.OUT', status: 'read' } } });
  });

  it('manda el historial y los contactos a la cola sync', async () => {
    await ingest().ingest(historyPayload({ customer: '573001112233',
      lines: [{ wamid: 'wamid.H', fromCustomer: true, text: 'x', at: new Date() }] }));
    await ingest().ingest(contactsPayload({ phone: '573001112233', name: 'Ana', action: 'add' }));
    expect(calls.map((c) => c.method)).toEqual(['addHistory', 'addContacts']);
  });

  it('encola el aviso de la cuenta sin resolver canal', async () => {
    await ingest().ingest(accountUpdatePayload('PARTNER_REMOVED'));
    expect(calls).toEqual([{ method: 'addAccountUpdate',
      job: { update: { wabaId: '102290', event: 'PARTNER_REMOVED', phoneNumber: '15550001' } } }]);
  });

  it('descarta en silencio el eco de un número que no es nuestro', async () => {
    await resetDb();
    await ingest().ingest(echoPayload({ wamid: 'wamid.E3', to: '573001112233' }));
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Escribir el test de rehidratación que falla**

En `apps/api/test/queues/inbound.queue.test.ts`, ampliar el import existente de `inbound.queue` con `rehydrateEchoJob, rehydrateStatusJob` y añadir:
```ts
import { rehydrateHistoryJob } from '../../src/queues/sync.queue';
```
y al final del archivo:
```ts
describe('rehidratación de los jobs de coexistencia', () => {
  const at = new Date('2026-10-06T15:00:00Z');
  const viaRedis = <T>(x: T): T => JSON.parse(JSON.stringify(x));

  it('devuelve como Date las fechas del eco, del estado y del historial', () => {
    const echo = rehydrateEchoJob(viaRedis({ tenantId: 't', channelId: 'c', echo: {
      wamid: 'w', phoneNumberId: 'p', wabaId: 'b', to: '57', type: 'text' as const,
      text: 'x', mediaId: null, timestamp: at, raw: {} } }));
    const status = rehydrateStatusJob(viaRedis({ tenantId: 't', status: {
      wamid: 'w', phoneNumberId: 'p', wabaId: 'b', status: 'read', timestamp: at } }));
    const history = rehydrateHistoryJob(viaRedis({ tenantId: 't', channelId: 'c', chunk: {
      phoneNumberId: 'p', wabaId: 'b', phase: 2, progress: 100, declined: false,
      threads: [{ waId: '57', messages: [{ wamid: 'w', from: '57', type: 'text' as const,
        text: 'x', mediaId: null, timestamp: at, raw: {} }] }] } }));

    expect(echo.echo.timestamp).toBeInstanceOf(Date);
    expect(status.status.timestamp).toBeInstanceOf(Date);
    expect(history.chunk.threads[0].messages[0].timestamp.toISOString()).toBe(at.toISOString());
  });
});
```

- [ ] **Step 3: Correr y verlos fallar**

Run: `pnpm test apps/api/test/whatsapp/ingest.test.ts apps/api/test/queues/inbound.queue.test.ts`
Expected: FAIL — `rehydrateEchoJob` no existe y la ingesta no llama a `addEcho`.

- [ ] **Step 4: Métodos de encolado y rehidratación**

En `apps/api/src/queues/inbound.queue.ts`, añadir después de `rehydrateInboundJob`:
```ts
export function rehydrateEchoJob(d: EchoJob): EchoJob {
  return { ...d, echo: { ...d.echo, timestamp: new Date(d.echo.timestamp) } };
}

export function rehydrateStatusJob(d: StatusJob): StatusJob {
  return { ...d, status: { ...d.status, timestamp: new Date(d.status.timestamp) } };
}
```
y, dentro de la clase `InboundQueue`, después de `add`:
```ts
  // Los ecos van por esta cola y no por `sync`: tienen que pasar por el mismo
  // bloqueo de la conversación que los mensajes del cliente (spec §3.4).
  addEcho(job: EchoJob) {
    return this.queue.add('phone_echo', job, { jobId: job.echo.wamid });
  }

  addStatus(job: StatusJob) {
    // BullMQ rechaza ids con `:`; el mismo acuse reentregado no se encola dos veces.
    const jobId = `st-${job.status.wamid}-${job.status.status}`.replaceAll(':', '_');
    return this.queue.add('status', job, { jobId });
  }

  addAccountUpdate(job: AccountUpdateJob) {
    return this.queue.add('account_update', job);
  }
```
(`Queue<InboundJob>` pasa a `Queue<InboundJob | EchoJob | StatusJob | AccountUpdateJob>`.)

- [ ] **Step 5: La cola `sync`**

Añadir al final de `apps/api/src/queues/sync.queue.ts`:
```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

@Injectable()
export class SyncQueue implements OnModuleDestroy {
  private readonly queue = new Queue<HistoryJob | ContactsSyncJob>(SYNC_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  });

  constructor() {
    this.queue.on('error', (err) => console.error(`[sync] error de la cola: ${err.message}`));
  }

  addHistory(job: HistoryJob) { return this.queue.add('history_chunk', job); }

  addContacts(job: ContactsSyncJob) { return this.queue.add('contacts_sync', job); }

  async onModuleDestroy() { await this.queue.close(); }
}
```
(mover los dos `import` al inicio del archivo, junto al de `@citara/shared`). Registrar `SyncQueue` en `providers` de `app.module.ts`.

- [ ] **Step 6: Enrutar en la ingesta**

`apps/api/src/whatsapp/ingest.service.ts`, cuerpo de la clase completo (los imports ganan `SyncQueue` y `ContactSync`):
```ts
@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly channels: ChannelResolver,
    private readonly queue: InboundQueue,
    private readonly sync: SyncQueue,
  ) {}

  /**
   * Cada evento a su cola. Nada de lógica de negocio aquí: el webhook debe
   * responder 200 en menos de 100 ms (regla de oro, spec §3.5).
   */
  async ingest(payload: unknown): Promise<{ enqueued: number; duplicates: number }> {
    const n = normalizeWebhook(payload);
    let enqueued = 0;
    let duplicates = 0;

    for (const msg of n.messages) {
      // wamid vacío = Meta mandó un mensaje sin `id`. Con cadena vacía, el
      // primero entraría y todos los siguientes chocarían como "duplicados".
      if (!msg.wamid) { this.log.warn('mensaje sin wamid descartado antes de persistir'); continue; }
      const channel = await this.resolve(msg.phoneNumberId);
      if (!channel) continue;
      const fresh = await this.gate(msg.wamid, channel.tenantId, msg.raw);
      // También ante duplicado se encola: si la vez anterior falló Redis justo
      // después del INSERT, la reentrega de Meta es la única oportunidad.
      await this.queue.add({ tenantId: channel.tenantId, channelId: channel.channelId, message: msg });
      if (fresh) enqueued++; else duplicates++;
    }

    for (const echo of n.echoes) {
      if (!echo.wamid) { this.log.warn('eco sin wamid descartado'); continue; }
      const channel = await this.resolve(echo.phoneNumberId);
      if (!channel) continue;
      const fresh = await this.gate(echo.wamid, channel.tenantId, echo.raw);
      await this.queue.addEcho({ tenantId: channel.tenantId, channelId: channel.channelId, echo });
      if (fresh) enqueued++; else duplicates++;
    }

    for (const status of n.statuses) {
      if (!status.wamid) continue;
      const channel = await this.resolve(status.phoneNumberId);
      if (!channel) continue;
      await this.queue.addStatus({ tenantId: channel.tenantId, status });
      enqueued++;
    }

    for (const chunk of n.history) {
      const channel = await this.resolve(chunk.phoneNumberId);
      if (!channel) continue;
      await this.sync.addHistory({ tenantId: channel.tenantId, channelId: channel.channelId, chunk });
      enqueued++;
    }

    const contactsByPhone = new Map<string, ContactSync[]>();
    for (const c of n.contacts) {
      contactsByPhone.set(c.phoneNumberId, [...(contactsByPhone.get(c.phoneNumberId) ?? []), c]);
    }
    for (const [phoneNumberId, contacts] of contactsByPhone) {
      const channel = await this.resolve(phoneNumberId);
      if (!channel) continue;
      await this.sync.addContacts({ tenantId: channel.tenantId, contacts });
      enqueued++;
    }

    // Llega por WABA, sin phone_number_id: el procesador resuelve los canales.
    for (const update of n.accountUpdates) {
      await this.queue.addAccountUpdate({ update });
      enqueued++;
    }

    return { enqueued, duplicates };
  }

  private async resolve(phoneNumberId: string) {
    const channel = await this.channels.resolveByPhoneNumberId(phoneNumberId);
    // 200 igual: un error haría que Meta reintente para siempre.
    if (!channel) this.log.warn(`phone_number_id sin canal: ${phoneNumberId}`);
    return channel;
  }

  /** La idempotencia es la restricción única, no un SELECT previo. Devuelve si es nuevo. */
  private async gate(wamid: string, tenantId: string, raw: unknown): Promise<boolean> {
    const inserted = await this.ds.query(
      `INSERT INTO webhook_events (wamid, tenant_id, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (wamid) DO NOTHING
       RETURNING id`,
      [wamid, tenantId, JSON.stringify(raw)],
    );
    return inserted.length > 0;
  }
}
```

- [ ] **Step 7: Despachar en los workers**

En `apps/api/src/queues/workers.ts`, añadir los imports de los cinco procesadores, de `rehydrateEchoJob`, `rehydrateStatusJob`, de `SYNC_QUEUE`, `rehydrateHistoryJob` y de los tipos de job, más `UnrecoverableError` de `bullmq`. Reemplazar la creación del worker de entrada por:
```ts
  const echoes = ctx.get(EchoProcessor);
  const statuses = ctx.get(StatusProcessor);
  const accounts = ctx.get(AccountUpdateProcessor);
  const history = ctx.get(HistoryProcessor);
  const contacts = ctx.get(ContactsSyncProcessor);

  const inbound = new Worker<InboundJob | EchoJob | StatusJob | AccountUpdateJob>(
    INBOUND_QUEUE,
    (job) => {
      switch (job.name) {
        case 'process': return flowRunner.handle(rehydrateInboundJob(job.data as InboundJob));
        case 'phone_echo': return echoes.process(rehydrateEchoJob(job.data as EchoJob));
        case 'status': return statuses.process(rehydrateStatusJob(job.data as StatusJob));
        case 'account_update': return accounts.process(job.data as AccountUpdateJob);
        default: throw new UnrecoverableError(`job de entrada desconocido: ${job.name}`);
      }
    },
    { connection, concurrency },
  );
```
y, después del worker de salida:
```ts
  // Concurrencia 1: el historial llega en tandas y la regla del dueño activo
  // se aplica al terminar; procesar chunks en paralelo la correría con datos
  // a medias. Nada aquí es urgente.
  const sync = new Worker<HistoryJob | ContactsSyncJob>(
    SYNC_QUEUE,
    (job) => {
      switch (job.name) {
        case 'history_chunk': return history.process(rehydrateHistoryJob(job.data as HistoryJob));
        case 'contacts_sync': return contacts.process(job.data as ContactsSyncJob);
        default: throw new UnrecoverableError(`job de sync desconocido: ${job.name}`);
      }
    },
    { connection, concurrency: 1 },
  );
  sync.on('failed', (job, err) => console.error(`[sync] job ${job?.id} falló: ${err.message}`));
  sync.on('error', (err) => console.error(`[sync] error del worker: ${err.message}`));
```
`close` cierra también `sync`:
```ts
    close: async () => { await inbound.close(); await outbound.close(); await sync.close(); },
```

- [ ] **Step 8: Correr la suite completa y arrancar el worker**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

Run: `pnpm build && (node apps/worker/dist/src/main.js > /tmp/citara-worker.log 2>&1 & pid=$!; sleep 6; kill -TERM $pid; sleep 2; cat /tmp/citara-worker.log)`
Expected: el log muestra `AppModule dependencies initialized` y ningún `UnknownElementException`; el proceso termina con el SIGTERM. (macOS no trae `timeout`.)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/queues apps/api/src/whatsapp/ingest.service.ts apps/api/src/app.module.ts apps/api/test/whatsapp/ingest.test.ts apps/api/test/queues/inbound.queue.test.ts
git commit -m "feat(queues): enrutar cada evento de coexistencia a su cola y su procesador"
```

---

### Task 11: Coexistencia de punta a punta

**Files:**
- Modify: `apps/api/test/pipeline/pipeline.e2e.test.ts`
- Modify: `docs/desarrollo-local.md`

**Interfaces:**
- Consumes: todo lo anterior, a través del webhook real y de `startWorkers`.

- [ ] **Step 1: Escribir los tests de punta a punta**

En `apps/api/test/pipeline/pipeline.e2e.test.ts`:
- importar `SYNC_QUEUE` de `../../src/queues/sync.queue` y `echoPayload`, `historyPayload` de `../whatsapp/fixtures/coexistence`;
- la lista de colas pasa a `[INBOUND_QUEUE, OUTBOUND_QUEUE, SYNC_QUEUE]`;
- añadir un `describe` nuevo al final:
```ts
describe('pipeline real con coexistencia', () => {
  it('después de que el dueño contesta desde el celular, el bot no le habla encima', async () => {
    // Un minuto antes: Meta trae segundos, y empatar con el mensaje del cliente
    // dejaría el orden por occurred_at al azar.
    await post(echoPayload({ wamid: 'wamid.PE1', to: '573001112233', text: 'Hola Ana, ya te atiendo',
                             at: new Date(Date.now() - 60_000) }));
    await quiesce();
    await post(webhook('wamid.PE2', '¿A qué hora puedo ir?'));
    await quiesce();

    expect(sent).toEqual([]);
    const rows = await adminQuery(`SELECT origin FROM messages ORDER BY occurred_at`);
    expect(rows.map((r: { origin: string }) => r.origin)).toEqual(['phone', 'customer']);
  });

  it('cuando vence el plazo del dueño, el bot vuelve a atender', async () => {
    await post(echoPayload({ wamid: 'wamid.PV1', to: '573001112233' }));
    await quiesce();
    await adminQuery(`UPDATE conversations SET human_until = now() - interval '1 minute'`);
    await post(webhook('wamid.PV2', 'Hola'));
    await quiesce();

    expect(sent.map((s) => s.body)).toEqual([SALUDO, MENU]);
  });

  it('al conectar, una conversación donde el dueño estuvo activo queda en sus manos', async () => {
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
    await post(historyPayload({ customer: '573001112233', lines: [
      { wamid: 'wamid.PH1', fromCustomer: true, text: '¿Me guardas el jueves?', at: ago(2) },
      { wamid: 'wamid.PH2', fromCustomer: false, text: 'Claro, a las 4', at: ago(1) },
    ] }));
    await quiesce();
    await post(webhook('wamid.PH3', 'Perfecto, gracias'));
    await quiesce();

    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Correrlos**

Run: `pnpm test apps/api/test/pipeline`
Expected: PASS. Si alguno falla, el defecto está en el cableado de la Task 10 (un nombre de job, un procesador sin registrar o la cola `sync` sin consumidor): se corrige ahí, no en el test.

- [ ] **Step 3: Verificar que el primero muerde**

Comentar temporalmente en `apps/api/src/coexistence/echo.processor.ts` la llamada a `giveControlToHuman` y correr `pnpm test apps/api/test/pipeline`.
Expected: FAIL en "después de que el dueño contesta..." (el bot manda saludo y menú). Restaurar la llamada y volver a correr: PASS.

- [ ] **Step 4: Documentar la coexistencia en el runbook**

En `docs/desarrollo-local.md`, añadir antes de "Qué verificar (criterios de salida de la Fase 1)":
```markdown
## Coexistencia (Fase 1.5)

Con un número conectado en coexistencia (requiere el alta de la Fase 3), en la app de
Meta → WhatsApp → Configuración, además de `messages` se suscriben estos campos:
`smb_message_echoes`, `history`, `smb_app_state_sync` y `account_update`.

Qué hace el sistema con cada uno:

| Campo | Efecto |
|---|---|
| `smb_message_echoes` | Lo que el dueño escribe desde su celular se guarda (`origin='phone'`) y el bot se calla en esa conversación durante `tenants.human_takeover_hours` (12 por defecto); cada mensaje del dueño alarga el plazo |
| `history` | Importa hasta 180 días (`origin='history'`); al terminar, las conversaciones donde el dueño escribió dentro del plazo quedan en sus manos |
| `smb_app_state_sync` | Guarda en `contacts.saved_name` el nombre con que el negocio tiene al cliente |
| `account_update` | Una desconexión deja el canal en `disconnected`: lo que llegue se guarda, el bot no responde y no se envía nada |

Para ver quién manda en cada conversación y por qué:

```bash
docker compose exec postgres psql -U postgres -d citara -c "select c.id, c.control, c.human_until, c.control_reason from conversations c"
```

```bash
docker compose exec postgres psql -U postgres -d citara -c "select created_at, actor, action, details from audit_log order by created_at desc limit 20"
```

Al conectar el primer número real, **grabar los payloads de cada campo** y reemplazar los
ejemplos de `apps/api/test/whatsapp/fixtures/coexistence.ts`; revisar las constantes
marcadas `VERIFICAR` (fases del historial, rechazo a compartir, eventos de desconexión).
```
En la sección "Limitaciones conocidas de la Fase 1", eliminar las líneas de los estados de Meta (ahora se registran) y de "No hay coexistencia".

- [ ] **Step 5: Correr todo**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/pipeline/pipeline.e2e.test.ts docs/desarrollo-local.md
git commit -m "test(pipeline): verificar la coexistencia de punta a punta con el worker real"
```

---

## Criterios de salida de la Fase 1.5

- [ ] `pnpm test` y `pnpm typecheck` en verde, con el guardia de privilegios incluyendo `audit_log` y el GRANT por columna de `whatsapp_channels`.
- [ ] Un eco del celular del dueño silencia al bot en esa conversación durante `N` horas, y cada eco alarga el plazo.
- [ ] Al vencer el plazo, el bot vuelve a atender desde el inicio del flujo, no desde la captura donde quedó.
- [ ] El paso `handoff` del flujo da el control al humano y su mensaje de traspaso sí sale.
- [ ] Lo que el bot dejó pendiente cuando el dueño intervino queda `superseded` y no sale.
- [ ] El historial se importa sin duplicar ecos y deja en manos del dueño las conversaciones donde estuvo activo.
- [ ] Una desconexión de Meta deja el canal en `disconnected`: guarda lo que llega, no responde, no envía.
- [ ] Cada cambio de quién habla queda en `audit_log`.
- [ ] El worker compilado arranca con los procesadores nuevos sin `UnknownElementException`.

## Lo que esta fase deliberadamente NO hace

- Conectar un número real en coexistencia: eso es el Embedded Signup de la Fase 3, y exige la aprobación de Tech Provider.
- Tomar o devolver el control desde un panel: `reason='operator'` existe en el modelo, pero la acción llega con el panel (Fase 6).
- Avisar al operador cuando un canal se desconecta o el dueño deja de abrir su app: queda anotado en el riesgo del spec, sin canal de aviso en v1.
- Retención del historial importado: decisión pendiente antes de operar con clientes reales.
