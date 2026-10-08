# Citara — Chatbot de agendamiento por WhatsApp, operado como servicio

**Versión:** 2.1 (2026-10-08) · v2: 2026-10-06 · v1: 2026-09-03
**Estado:** v2 en revisión
**Autor:** diseño colaborativo (brainstorming)

## Registro de cambios

**v2.1 (2026-10-08)** — al planear la Fase 4
- **Google Calendar en un calendario aparte.** Citara crea un calendario «Citas · <recurso>»
  en la cuenta de cada recurso (`calendar.app.created`) y consulta el principal solo como
  ocupado (`calendar.freebusy`). Permisos mínimos y sin mezclar eventos (§4.1, §7.3).
- **Cambios del dueño en Google:** se reflejan en Citara (cita y recordatorios) sin
  escribirle al cliente final (§7.3).
- **Cola `calendar`** propia, separada de `sync` (§3.4).

**v2 (2026-10-06)**
- **Encuadre del producto.** No es un SaaS de autoservicio: es un chatbot de agendamiento
  que el autor instala y opera para cada cliente. Desaparecen el alta autoservicio, los
  usuarios y roles por negocio y toda UI para el dueño del negocio. El panel es de un
  único operador (§1, §3.3, §8, §10).
- **Coexistencia con la app de WhatsApp Business** (D6). El número del negocio sigue en
  su celular y el bot se suma por encima. La interfaz del dueño es su propia app (§4, §6).
- **Control de la conversación** con una sola fuente de verdad en `conversations`
  (`control`, `human_until`), alimentada por el celular, el flujo, el operador y el
  historial (§6).
- **Camino de salida como outbox**, con los aprendizajes del cierre de la Fase 1:
  un job por turno, encolado tras el commit, transiciones compare-and-set, y estados
  `unconfirmed` y `superseded` (§7).
- **Roadmap reordenado:** nueva fase 1.5 (coexistencia), el alta asistida pasa del final
  al tercer lugar, y el panel se reduce y va al final (§10).
- **Modelos de IA:** se revisan al planear la fase del agente (§3.2).

---

## 1. Resumen

Citara es un chatbot de WhatsApp que **agenda citas automáticamente** para negocios de
cita previa con recurso limitado: consultorios, salones de belleza, talleres, estudios.
El autor lo vende como **servicio**: lo instala, lo configura y lo opera para cada
cliente. El cliente no administra nada.

Tres capacidades definen el producto:

1. **Canal oficial.** WhatsApp Cloud API de Meta, en dos modalidades: número dedicado o
   **coexistencia** con la app de WhatsApp Business que el negocio ya usa.
2. **Conversación híbrida.** Flujos deterministas para lo repetitivo y turnos de LLM donde
   aportan valor. El costo de IA es una decisión de configuración, no una consecuencia de
   la arquitectura.
3. **Agendamiento real.** Disponibilidad, reserva y evento en el Google Calendar de cada
   recurso, con la base de datos propia como fuente de verdad.

**Quién usa qué:**

| Persona | Interfaz |
|---|---|
| Cliente final del negocio | WhatsApp |
| Dueño del negocio | Su app de WhatsApp Business (contesta cuando quiere y el bot se aparta) y su Google Calendar |
| Operador (el autor) | Panel mínimo: chats de todos los negocios, control, auditoría, costos. CLI y archivos YAML para la configuración |

El modelo de datos se construye alrededor de la tripleta `servicio` × `recurso` ×
`franja horaria`.

### 1.1 Qué NO es este proyecto

- **No es un SaaS de autoservicio.** No hay registro de negocios, ni usuarios por negocio,
  ni panel para el dueño.
- **No reutiliza código de `f16` ni de `node-meta`**, que son propiedad del empleador del
  autor. Sí traslada la experiencia operativa: las decisiones de este documento
  incorporan las lecciones de esos sistemas y corrigen de entrada dos cuellos de botella
  conocidos (workers acoplados al proceso HTTP y procesamiento inbound síncrono). La
  coexistencia es una funcionalidad pública de Meta, no propiedad de nadie.

---

## 2. Decisiones de diseño

| # | Decisión | Por qué |
|---|---|---|
| D1 | **Monolito modular** en monorepo, no microservicios | La frontera gateway↔orquestador se conserva como límite de módulo. Extraíble después si lo merece; hoy solo duplicaría despliegue y modos de fallo. |
| D2 | **Postgres single-DB con `tenant_id` + RLS**, no multi-esquema | Aunque un solo operador lo vea todo, los datos de los clientes de un negocio no se mezclan con los de otro. Un job que olvide fijar el tenant devuelve cero filas en vez de datos ajenos. Falla cerrado. |
| D3 | **Workers en proceso aparte desde el día 1** | Cuello medido en sistemas previos: workers compartiendo proceso con HTTP, drenando a una fracción de la capacidad real de la BD. |
| D4 | **La BD propia es la fuente de verdad de las citas**; Google Calendar es proyección | El sistema sigue agendando aunque Google falle, el token muera o el negocio revoque el acceso. |
| D5 | **Doble reserva prevenida por restricción de exclusión de Postgres**, no por código | Consultar y luego reservar es una condición de carrera inevitable. La BD la resuelve; un `if` no. |
| D6 | **Coexistencia como modalidad de canal** (`cloud_api` \| `coexistence`), con el mismo motor para ambas | El cliente típico ya atiende por la app de WhatsApp Business con su número de siempre. Exigirle migrarlo es la mayor barrera de entrada. Con coexistencia su app sigue siendo su interfaz, y Citara no necesita una para él. |

---

## 3. Arquitectura

### 3.1 Estructura del repositorio

```
citara/
├─ apps/
│  ├─ api/          NestJS — HTTP: webhook de Meta, página de conexión, panel del operador
│  └─ worker/       NestJS — mismo código, arranca solo los consumidores de colas
└─ packages/
   ├─ shared/       tipos, contratos, esquemas Zod
   └─ db/           migraciones y entidades
```

`api` y `worker` comparten el código de `apps/api` y difieren solo en el bootstrap. El
cableado de los consumidores vive en `apps/api/src/queues/workers.ts` para que los tests
de punta a punta levanten exactamente el mismo código que producción.

### 3.2 Stack

- **Backend:** NestJS 11, TypeScript, TypeORM
- **Datos:** PostgreSQL 16+ (extensión `btree_gist`), Redis
- **Colas:** BullMQ
- **Panel del operador:** páginas renderizadas por la propia API, con refresco periódico.
  Sin app de frontend aparte y sin WebSocket en v1.
- **LLM:** API de Anthropic, detrás de una interfaz `LlmProvider`. El modelo es un campo
  de `agent_configs`. **Los ids, precios y restricciones de la API se fijan al planear la
  fase del agente**, contra la documentación vigente (hoy existen `claude-opus-5-5`,
  `claude-sonnet-5-5` y `claude-haiku-4-5`). Bajar de modelo es una decisión sobre datos
  del banco de regresión, no un valor por defecto de la arquitectura.
- **Calendario:** Google Calendar API v3, OAuth 2.0 por recurso
- **Despliegue:** VPS con Docker Compose, Caddy para TLS

### 3.3 Módulos

| Módulo | Responsabilidad | Interfaz pública |
|---|---|---|
| `WhatsappGateway` | Verificación GET, HMAC del POST, normalización por campo, envío | Eventos internos tipados (§5.1), `send()`. Nadie más conoce el formato de Meta. |
| `Tenancy` | Resuelve el tenant por `phone_number_id`, propaga el contexto, fija la variable de RLS | `runInTenant` |
| `Conversations` | Contactos, conversaciones, mensajes, ventana de 24 h, **control** | Repositorios, `ControlPolicy` |
| `FlowEngine` | Ejecuta la definición JSON del flujo y decide el siguiente paso | `advance(session, input)` |
| `Agent` | Contexto, prompt de sistema, tool calling, guardarraíles, costos | `respond(conversation, input)` |
| `Scheduling` | Servicios, recursos, horarios, disponibilidad, reservas, recordatorios | Las herramientas invocables por el flujo y el agente |
| `GoogleCalendar` | OAuth, tokens cifrados, refresh, `watch`, sincronización | `freeBusy()`, `createEvent()` |
| `Onboarding` | Alta asistida: enlaces firmados, Embedded Signup, `tenant:apply` | CLI + página de conexión |
| `Operator` | Panel del operador y `audit_log` | HTTP con sesión de operador |
| `Usage` | Tokens, USD y latencia por tenant; topes y degradación | Métricas |

### 3.4 Colas

| Cola | Qué procesa |
|---|---|
| `inbound` | Mensajes del cliente, ecos del celular, estados de entrega, `account_update` |
| `outbound` | Un job por turno o por lote de salida |
| `sync` | Historial y contactos de coexistencia |
| `calendar` | Google Calendar: subir citas, leer cambios, renovar canales de `watch`, salud de las conexiones |
| `reminders` | Recordatorios programados |
| `agent` | Turnos con LLM |

Los ecos van por `inbound` y no por `sync` a propósito: deben pasar por el mismo bloqueo
de la conversación que los mensajes del cliente, o el bot puede contestar justo después
de que el dueño tomó la conversación.

### 3.5 Regla de oro del pipeline

**El webhook de Meta responde `200` en menos de 100 ms, siempre.** Valida HMAC,
deduplica, encola y responde. Nada de LLM, de Google ni de lógica de negocio dentro del
request de Meta.

### 3.6 Flujo de un mensaje del cliente

```
Meta Cloud API
   └─ POST /webhooks/whatsapp ──► api (HMAC, dedup, encola, 200)
                                        │
                                   cola inbound
                                        ▼
                     worker: UNA transacción con RLS y la conversación bloqueada
                        ├─ guarda el entrante
                        ├─ ControlPolicy: ¿manda el humano? → no responde
                        └─ FlowEngine.advance() ─┬─ paso determinista
                                                 ├─ tool → Scheduling (misma transacción)
                                                 └─ ai_turn → Agent.respond()
                        └─ salientes en `pending` (outbox)
                                        │ commit
                                   cola outbound (un job por turno)
                                        ▼
                     worker: control efectivo + ventana 24 h → reclamo → Meta
```

---

## 4. Modelo de datos

Una sola base de datos. `tenant_id` en cada tabla de negocio. Row Level Security con
`ENABLE` y `FORCE`. La aplicación se conecta con un rol sin bypass de RLS y con un
presupuesto cerrado de privilegios por tabla, verificado por test.

```sql
CREATE POLICY tenant_isolation ON appointments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

### 4.1 Tablas

**Identidad**
- `tenants`: slug, nombre, **zona horaria**, estado (`onboarding` | `active` |
  `suspended`), `human_takeover_hours` (12 por defecto)
- `operators`: las cuentas del panel (en v1, una)
- `whatsapp_channels`: `waba_id`, `phone_number_id`, token cifrado, **`mode`**
  (`cloud_api` | `coexistence`), `status` (`active` | `inactive` | `disconnected`),
  **`history_sync`** (`not_applicable` | `pending` | `done` | `declined`)

**Conversación**
- `contacts`: `wa_id`, nombre de perfil, **`saved_name`** (el nombre con que el negocio
  tiene guardado al cliente en su celular)
- `conversations`: `status` (`open` | `closed`), `last_inbound_at` (ventana de 24 h),
  **`control`** (`bot` | `human`), **`human_until`**, **`control_reason`** (`phone` |
  `flow_handoff` | `operator` | `history`)
- `messages`: `wamid` **único** (dedup), `direction` (`in` | `out`), **`origin`**
  (`customer` | `bot` | `phone` | `operator` | `history` | `reminder`), tipo, cuerpo, payload JSONB,
  estado, **`occurred_at`** (hora real según Meta), `reply_to_id` y `seq` (outbox, §7.1),
  `claimed_at`
- `webhook_events`: auditoría e idempotencia de entrada

**Motor**
- `flows`: definición JSONB, versión, triggers, `is_default`, `is_active`
- `conversation_sessions`: flujo actual, paso actual, `vars` JSONB, estado

**IA**
- `agent_configs`: prompt de sistema, modelo, herramientas habilitadas, **versionado con
  rollback**. Se edita por CLI/YAML.
- `agent_runs`: tokens de entrada y salida, USD, latencia y herramientas invocadas, por
  llamada

**Agenda**
- `services`: duración, buffer, precio
- `resources`: quién atiende (el médico, la estilista, la bahía del taller)
- `resource_services`: qué recurso presta qué servicio
- `business_hours`, `time_off`
- `appointments`: **fuente de verdad**
- `google_accounts`: **una por `resource`**, con refresh token cifrado, `calendar_id` (el
  calendario «Citas» que crea la app), `sync_token`, canal de `watch` y estado
  (`active` | `needs_reauth`)

**Operación**
- `audit_log`: actor, acción, negocio y motivo de cada acción del operador y de cada
  cambio de control

### 4.2 Restricción anti-doble-reserva

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'confirmed');
```

Dos usuarios pidiendo la misma franja pueden pasar ambos la verificación de
disponibilidad. Con esta restricción el segundo `INSERT` falla en Postgres y el bot
ofrece otra hora. Como la reserva corre dentro de la transacción del turno (§3.6), el
`INSERT` va envuelto en un `SAVEPOINT`: la violación de exclusión aborta solo el savepoint,
no el turno.

### 4.3 Cifrado

Los secretos por tenant (`whatsapp_channels.access_token`,
`google_accounts.refresh_token`) se almacenan cifrados con libsodium `secretbox`
(XSalsa20-Poly1305). La llave maestra va en variable de entorno o KMS, con envelope
versionado por byte de versión para permitir rotación.

---

## 5. Entrada de WhatsApp

### 5.1 Eventos

El normalizador enruta por `changes[].field` y produce eventos tipados:

| Campo de Meta | Evento interno | Cola | Efecto |
|---|---|---|---|
| `messages` → `messages[]` | `customer_message` | `inbound` | Turno del flujo (§6) |
| `messages` → `statuses[]` | `status` | `inbound` | Avanza el estado de entrega por `wamid`, solo hacia adelante |
| `smb_message_echoes` | `phone_echo` | `inbound` | Saliente con `origin='phone'` y control al humano |
| `history` | `history_chunk` | `sync` | Importa mensajes con `origin='history'` |
| `smb_app_state_sync` | `contacts_sync` | `sync` | Upsert de `contacts.saved_name` |
| `account_update` | `account_update` | `inbound` | Canal `disconnected` ante una desconexión |

Los nombres exactos de los eventos de `account_update` y la forma de los payloads de
coexistencia **se fijan contra la documentación oficial** al grabar el primer payload
real. Hasta entonces, los tests usan payloads de ejemplo de la documentación.

### 5.2 Idempotencia

La idempotencia es una restricción, no un `if`. Los eventos con `wamid` (mensajes del
cliente, ecos e historial) se deduplican por el índice único de `messages.wamid`. Las
reentregas de mensajes del cliente se registran además en `webhook_events`. Los eventos
sin `wamid` son idempotentes por naturaleza: los estados solo avanzan, y los contactos y
la cuenta son upserts.

El duplicado se reconoce **antes** de tocar contactos y conversaciones. Si una reentrega
llega después de que la conversación original se cerró, no debe abrir una nueva.

### 5.3 Historial

Meta entrega hasta 180 días si el negocio acepta compartirlo. Se guardan los mensajes
completos (texto y metadatos). Los adjuntos quedan solo como referencia, sin descargarlos:
Meta solo entrega el adjunto en sí para lo de los últimos 14 días. Los mensajes del
cliente actualizan `last_inbound_at` con `GREATEST`, porque la ventana de Meta cuenta
mensajes reales aunque sean previos a Citara. Al terminar la importación se aplica la
regla del §6.2 y `history_sync` pasa a `done`.

La **retención** del historial importado (p. ej. 180 días) queda por decidir antes de
operar con clientes reales.

---

## 6. Control de la conversación

### 6.1 Fuente única de verdad

`conversations.control` y `human_until` deciden quién habla. El control es efectivo solo
si no ha vencido: `control = 'human' AND human_until > now()`. No hay job que lo
devuelva; se evalúa en el siguiente evento. Cada cambio de control se registra en
`audit_log`.

| Quién da el control al humano | `control_reason` | Vencimiento |
|---|---|---|
| El dueño escribe desde su celular (eco) | `phone` | `occurred_at + N`; cada eco lo extiende (`GREATEST`) |
| El flujo llega a un paso `handoff` | `flow_handoff` | `ahora + N` |
| El operador toma la conversación desde el panel | `operator` | `ahora + N`; cada mensaje del operador lo extiende |
| El historial muestra al dueño activo en las últimas `N` horas | `history` | `último mensaje del dueño + N` |

`N` es `tenants.human_takeover_hours`. El control vuelve al bot con **lo primero que
ocurra**: vence el plazo o el operador lo devuelve desde el panel.

### 6.2 Al llegar un mensaje del cliente

Dentro de la transacción del turno, con la conversación bloqueada:

1. **Manda el humano y no ha vencido:** se guarda el mensaje y el bot no responde.
2. **Manda el humano pero venció:** el control vuelve al bot y se cierra toda sesión de
   flujo no terminada. El dueño pudo haber intervenido a mitad de una captura, y retomar
   ese paso sería absurdo. El mensaje abre una sesión nueva.
3. **Manda el bot:** se avanza el flujo. Si llega a `handoff`, se envía su texto y el
   control pasa al humano.

El estado `handoff` de la sesión deja de ser fuente de verdad: es el paso del flujo que
pidió el traspaso. El agente pasa por la misma regla, porque `ai_turn` es un paso más; no
hay camino por el que la IA se salte el control.

Al conectar un número en coexistencia, el bot solo responde donde el humano no estuvo
activo recientemente (regla `history`). Si el negocio no comparte el historial, el bot
atiende a todos desde el principio.

### 6.3 Al enviar

`OutboundProcessor` revisa el **control efectivo justo antes de enviar**. Si ahora manda
un humano que **intervino** (`control_reason` distinto de `flow_handoff`), los salientes
`origin='bot'` pendientes pasan a `superseded` y no salen. Esto cubre la carrera en que el
dueño contesta desde el celular en el mismo segundo en que el bot produjo su respuesta.
Cuando el control lo dio el propio flujo, su mensaje de traspaso sí sale: se produjo en
el mismo turno que pidió el traspaso. Los mensajes `origin='operator'` siempre salen, y
también los `origin='reminder'`: un recordatorio es una plantilla informativa que el
cliente espera aunque el dueño le haya escrito hace poco.

### 6.4 Diferencia entre modalidades

En `coexistence` el dueño ve sus chats en su app, así que un traspaso le llega solo. En
`cloud_api` el único humano posible es el operador desde el panel. El panel lista los
traspasos abiertos; sin notificaciones push en v1.

---

## 7. Errores y reconciliación

### 7.1 Camino de salida (outbox)

- El turno guarda sus salientes en `messages` con `status='pending'`, `reply_to_id`
  (el entrante) y `seq` (el orden), **en la misma transacción** que el entrante y el
  avance del flujo.
- **Tras el commit** se encola un job por turno, con `jobId` igual al id del entrante (un
  uuid; BullMQ rechaza ids con `:`). El job no lleva contenido: las filas son la fuente
  de verdad. Los envíos sueltos (recordatorios) usan la misma cola con un job por
  mensaje (`jobId` = id de la fila).
- El procesador envía las filas del turno en orden. Cada transición es
  **compare-and-set** sobre el estado previo. Dos ejecuciones del mismo turno (un job
  atascado que se re-ejecuta) nunca se pisan.

| Estado | Significado |
|---|---|
| `pending` | Lo produjo el flujo |
| `sending` | Un envío lo reclamó (`claimed_at`); si es reciente, otro intento lo tiene en curso |
| `sent` → `delivered` → `read` | Meta lo aceptó, y luego confirmó entrega y lectura |
| `window_closed` | Fuera de las 24 h, por nuestro reloj o porque Meta respondió 131047 |
| `failed` | Rechazo permanente, canal inválido o reintentos agotados |
| `unconfirmed` | Pudo o no llegar a Meta (timeout, corte tras enviar, 200 sin `wamid`, intento muerto). No se reenvía a ciegas |
| `superseded` | El humano tomó el control antes de que saliera (§6.3) |

Los rechazos de Meta se clasifican **por código de error**, no solo por HTTP: los límites
de tasa llegan con HTTP 400 y se reintentan. Un rechazo reintentable devuelve la fila a
`pending` y corta el turno para preservar el orden.

En una reentrega del entrante, si el turno ya se procesó pero quedan salientes
`pending`, se vuelven a encolar.

**No garantizado:** el orden entre turnos distintos de la misma conversación.

### 7.2 Por capa

**Entrada.** Meta reintenta si no recibe `200`. Si encolar falla tras registrar el
evento, la reentrega vuelve a encolar (`jobId` = `wamid`).

**Colas.** Retroceso exponencial. Los errores transitorios se reintentan; los
permanentes van directo a fallido sin gastar intentos.

**LLM.** Timeout duro de 30 s, un reintento, y si falla otra vez degrada a un mensaje
determinista de disculpa más `handoff`. Al usuario nunca se le deja en silencio.

**Ventana de 24 h.** Se verifica al enviar, con un `switch` exhaustivo sobre el tipo de
contenido: el texto libre exige ventana abierta y las plantillas no. Los recordatorios
siempre son plantilla.

**Ritmo de envío.** Los números en coexistencia tienen un tope de 20 mensajes por
segundo. Solo importa en envíos en lote (recordatorios), que respetan un límite por
canal.

### 7.3 Reconciliación con Google Calendar

**Calendario aparte.** Las citas viven en un calendario secundario «Citas · <recurso>» que
crea la app; el calendario principal de la persona solo se consulta con `freeBusy` para no
ofrecer lo que tiene ocupado (con timeout corto y degradación a solo-Citara). Así las citas
propias nunca cuentan dos veces como ocupado y la sincronización inversa solo ve eventos
de citas.

**Cambios del dueño.** Si borra o mueve una cita en «Citas», se cancela o se mueve en
Citara con sus recordatorios, sin escribirle al cliente. Un cambio local pendiente gana
sobre lo leído de Google, y un movimiento que choca con otra cita no se aplica: la hora de
Citara vuelve a Google.

**Orden.** El `INSERT` en `appointments` va primero, protegido por la restricción de
exclusión. La cita es válida y confirmable sin que Google exista. Solo después se encola
la creación del evento, con `google_sync_status` en la fila.

**Idempotencia del evento.** Si `events.insert` se ejecuta pero la respuesta se pierde,
un reintento ciego duplicaría el evento. Google Calendar acepta un `id` provisto por el
cliente: se usa el UUID del `appointment` en hexadecimal sin guiones. Es válido porque el
alfabeto de Google es base32hex (`0-9`, `a-v`) y el hexadecimal es subconjunto. El
reintento devuelve `409`, que confirma que el evento ya existía.

**Sincronización inversa.** El negocio moverá citas directamente en su calendario. Se usa
`events.watch` (push) más `syncToken` para el delta incremental. Los canales de `watch`
caducan (máximo un mes); un job los renueva, y **ese job debe estar monitoreado**:
cuando falla, se dejan de recibir cambios en silencio.

**Token muerto.** Chequeo diario por `google_account` con una llamada barata. Ante
`invalid_grant`, la cuenta pasa a `needs_reauth`, se avisa al operador y el sistema
**sigue agendando localmente**.

---

## 8. Alta asistida

El operador da de alta cada negocio; el cliente solo conecta sus cuentas.

1. **`tenant:create`** (CLI) crea el negocio en `onboarding` e imprime un **enlace de
   conexión firmado**: lleva el tenant, caduca y es de un solo uso.
2. **Página de conexión** (HTML servido por la API): lanza el **Embedded Signup** de Meta
   con la opción de coexistencia. El cliente escanea un QR desde su app y decide si
   comparte el historial.
3. **Cierre en el servidor:** canje del `code` por el token del negocio (se guarda
   cifrado), suscripción de la app a los webhooks de su cuenta y solicitud de
   sincronización de contactos e historial. Según la documentación, el plazo para
   solicitarla es de 24 h. El canal queda con `mode='coexistence'` y `history_sync`.
4. **Google Calendar:** un enlace firmado por recurso, con el OAuth de Google.
5. **`tenant:apply cliente.yaml`**: servicios, recursos, horarios, flujo y configuración
   del agente como archivo versionado, aplicado de forma idempotente.
6. El negocio pasa a **`active`** cuando tiene canal, servicios, horarios y flujo.
   Mientras está en `onboarding`, los mensajes se guardan pero no se responden.
   Suspender un negocio lo saca de operación de inmediato.

**Se verifican contra la documentación oficial al grabar la primera alta real:** el
parámetro de coexistencia del Embedded Signup, el endpoint de sincronización y la vigencia
del token canjeado.

`dev:provision` sigue existiendo para desarrollo con un número `cloud_api` de prueba.

---

## 9. Estrategia de pruebas

**1. Unitarias:** cálculo de franjas, validadores de disponibilidad, aritmética de zonas
horarias, formateo de fechas, clasificación de errores de Meta, regla de control.

**2. Integración** contra Postgres real, en una base exclusiva de tests (`citara_test`) y
una db de Redis aparte, nunca sobre los datos de desarrollo. La prueba central de la
agenda: **dos inserciones concurrentes de la misma franja, afirmando que exactamente una
sobrevive.** Meta y Google se mockean por contrato (respuestas reales grabadas una vez y
reproducidas). Nunca se llama a las APIs reales en CI.

**3. Punta a punta del pipeline:** webhook firmado, Redis real y los workers reales en el
mismo proceso, con solo `MetaSender` falso. Fue esta capa la que encontró que el bot
estaba mudo con 108 tests en verde.

**4. E2E del motor:** arnés de conversación sin red.

**5. Banco de regresión conversacional:** 30 a 50 conversaciones-guion con su desenlace
esperado. Corre contra el modelo real, **fuera de CI**, y afirma sobre resultados, no
sobre texto.

**Principio:** un test que no se ha visto fallar no prueba nada. Las garantías de
concurrencia y de estados se verifican con mutaciones (se revierte el arreglo y el test
debe caer por la razón correcta).

---

## 10. Roadmap

**Semana 0. Arranca de inmediato y en paralelo con todo; son esperas no comprimibles:**
- **Verificación OAuth de Google** para los scopes de calendario: pantalla de
  consentimiento, política de privacidad en dominio propio, video de demostración.
  Mientras tanto, modo *testing* (el refresh token caduca a los 7 días).
- **Verificación de la empresa en Meta Business y alta como Tech Provider**: revisión de
  la app para `whatsapp_business_management` y `whatsapp_business_messaging` y un
  Embedded Signup configurado. Sin esto no se puede conectar ningún número en coexistencia.
- App de Meta con número de prueba, API key de Anthropic, VPS con dominio y TLS.

| Fase | Entrega | Estado |
|---|---|---|
| **1. Cimientos** | Monorepo, gateway, tenancy + RLS, conversaciones, motor determinista, outbox de salida | Hecha salvo la prueba con número real y la fusión a `main` |
| **1.5. Coexistencia (núcleo)** | Modelo de datos §4 (incluida `audit_log`, porque los cambios de control se registran desde aquí), eventos §5, control §6, `superseded`. Probada con payloads de ejemplo | Por planear |
| **2. Agenda** | Servicios, recursos, horarios, disponibilidad, `appointments` con exclusión, `tenant:apply`, recordatorios por el outbox con plantillas. Se agenda por menús, sin IA | Plan existente, a ajustar |
| **3. Alta asistida** | §8. El código no depende de la aprobación de Tech Provider; el cierre sí | A replanear (sustituye a la antigua Fase 6) |
| **4. Google Calendar** | OAuth por recurso con enlace firmado, insert idempotente, `watch`, health check | Implementada (2026-10-08); falta la prueba con una cuenta real |
| **5. El agente** | `ai_turn`, `ai_fallback`, clasificador, herramientas, guardarraíles, `agent_runs`, banco de regresión | Plan existente, a ajustar |
| **6. Panel del operador** | `operators` y sesión, bandeja de todos los negocios, tomar o devolver el control, consulta de `audit_log`, traspasos abiertos, costo de IA por cita | A replanear (reducida) |

**Punto de corte con valor:** al terminar la Fase 3 hay un cliente real con su número en
coexistencia, agendando por menús, sin una línea de IA.

**Orden deliberado:** la agenda determinista va antes que el agente. Las herramientas
deben existir y estar probadas antes de ponerlas en manos de un modelo.

**Planes:** cada plan se ajusta o reescribe cuando le toca a su fase. En la Fase 2 ya se
sabe qué cambia: la Task 7 corre las herramientas con el `EntityManager` del turno (con
`SAVEPOINT` alrededor de la reserva) y la Task 8 envía los recordatorios por el outbox,
con su propia fila `pending` y sin entrante asociado.

---

## 11. Riesgos abiertos

| Riesgo | Mitigación | Fase |
|---|---|---|
| La verificación de Google demora más de lo previsto | Radicar en Semana 0; desarrollar en modo testing | 0 |
| La aprobación de Tech Provider demora o se rechaza | Radicar en Semana 0; mientras tanto, un número `cloud_api` dedicado es un plan B viable | 0 |
| El dueño no abre su app en 14 días y se pierde la sincronización | Vigilar `account_update` y la ausencia prolongada de ecos; aviso al operador | 1.5 |
| El costo de IA por conversación erosiona el margen | Prompt caching, clasificador barato, flujos deterministas para lo repetitivo, topes por negocio con degradación | 5 |
| Latencia percibida en WhatsApp | Indicador de escritura, mensaje puente sobre ~8 s, timeout duro con degradación | 5 |
| La aprobación de plantillas de Meta bloquea los recordatorios | Enviar plantillas a aprobación en la Fase 2, antes de necesitarlas | 2 |
| La renovación de canales `watch` falla en silencio | Monitoreo explícito del job y alerta por canal vencido | 4 |
| Un cambio de prompt rompe el agendamiento | Banco de regresión obligatorio antes de publicar; `agent_configs` versionado con rollback | 5 |
| La clasificación de errores de Meta usa una lista de códigos sin verificar | Contrastar con la tabla oficial al grabar el primer rechazo real | 1 |
| Cláusulas contractuales del autor (no competencia, invenciones) | Revisar el contrato laboral antes de comercializar | 0 |

---

## 12. Fuera de alcance (v1)

- Alta autoservicio de negocios, usuarios y roles por negocio, y cualquier UI para el
  dueño del negocio
- Tiempo real en el panel (WebSocket) y editor visual de prompts
- Pagos y cobro anticipado de citas
- Canales adicionales (Instagram, Messenger, web chat)
- Voz o transcripción de notas de audio
- Facturación a los clientes (se mide el consumo, no se cobra)
- Descarga de adjuntos del historial importado
- Notificaciones push al operador
