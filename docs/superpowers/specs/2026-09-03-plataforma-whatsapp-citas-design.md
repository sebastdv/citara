# Citara — Plataforma multi-tenant de atención y agendamiento por WhatsApp

**Fecha:** 2026-09-03
**Estado:** diseño aprobado, pendiente plan de implementación
**Autor:** diseño colaborativo (brainstorming)

---

## 1. Resumen

Citara es una plataforma SaaS multi-tenant que permite a distintos negocios operar su
propio asistente de WhatsApp para atención al cliente y agendamiento de citas, todo
administrado desde un panel central.

Tres capacidades definen el producto:

1. **Canal oficial.** Recepción y envío por WhatsApp Cloud API (Meta), multi-número.
2. **Conversación híbrida.** Flujos deterministas para lo repetitivo, turnos de LLM
   donde aporta valor. El costo de IA es una decisión de configuración, no una
   consecuencia de la arquitectura.
3. **Agendamiento real.** Disponibilidad, reserva y creación del evento en Google
   Calendar del negocio, con la base de datos propia como fuente de verdad.

**Vertical objetivo:** negocios de cita previa con recurso limitado — consultorios,
salones de belleza, talleres, estudios. El modelo de datos está construido alrededor
de la tripleta `servicio` × `recurso` × `franja horaria`.

### 1.1 Qué NO es este proyecto

Este es un proyecto personal, greenfield. **No reutiliza código de `f16` ni de
`node-meta`**, que son propiedad del empleador del autor. Lo que sí se traslada es la
experiencia operativa: las decisiones de diseño de este documento incorporan
deliberadamente las lecciones aprendidas en esos sistemas, y corrigen de entrada dos
cuellos de botella conocidos (workers acoplados al proceso HTTP, y procesamiento
inbound síncrono).

---

## 2. Decisiones de diseño

Las cinco decisiones que definen el sistema, con su justificación:

| # | Decisión | Por qué |
|---|---|---|
| D1 | **Monolito modular** en monorepo, no microservicios | La frontera gateway↔orquestador se conserva como límite de módulo. Extraíble después si lo merece; hoy solo duplicaría despliegue y modos de fallo. |
| D2 | **Postgres single-DB con `tenant_id` + RLS**, no multi-esquema | Un job que olvide fijar el tenant devuelve cero filas en vez de datos ajenos. Falla cerrado. |
| D3 | **Workers en proceso aparte desde el día 1** | Cuello medido en sistemas previos: workers compartiendo proceso con HTTP, drenando a una fracción de la capacidad real de la BD. |
| D4 | **La BD propia es la fuente de verdad de las citas**; Google Calendar es proyección | El sistema sigue agendando aunque Google falle, el token muera o el negocio revoque el acceso. |
| D5 | **Doble reserva prevenida por restricción de exclusión de Postgres**, no por código | Consultar-y-luego-reservar es una condición de carrera inevitable. La BD la resuelve; un `if` no. |

---

## 3. Arquitectura

### 3.1 Estructura del repositorio

```
citara/
├─ apps/
│  ├─ api/          NestJS — HTTP: webhook de Meta + API del panel
│  ├─ worker/       NestJS — mismo código, arranca solo procesadores BullMQ
│  └─ dashboard/    Next.js 15 — panel administrativo
└─ packages/
   ├─ shared/       tipos, contratos, esquemas Zod
   └─ db/           migraciones y entidades
```

`api` y `worker` comparten el código de `apps/api`; difieren únicamente en el bootstrap.

### 3.2 Stack

- **Backend:** NestJS 11, TypeScript, TypeORM
- **Datos:** PostgreSQL 16+ (extensión `btree_gist`), Redis
- **Colas:** BullMQ
- **Panel:** Next.js 15 (App Router)
- **LLM:** API de Anthropic — **`claude-opus-5`** para turnos de agente,
  `claude-haiku-4-5` para clasificación y resúmenes. Ids exactos, **sin sufijo de
  fecha**. Detrás de una interfaz `LlmProvider` para permitir sustitución.
  El modelo es un campo de `agent_configs`, así que bajarlo a `claude-sonnet-5` tras
  medir con el banco de regresión es un cambio de configuración, no de código —
  y esa decisión se toma sobre datos, no como valor por defecto de la arquitectura.
  Precios por millón de tokens: Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5.
  Restricciones de la API que el diseño debe respetar: en Opus 5 el pensamiento está
  activo por defecto, `budget_tokens` fue eliminado (devuelve 400 — la profundidad se
  controla con `output_config.effort`) y el prefill del turno del asistente también
  devuelve 400.
- **Calendario:** Google Calendar API v3, OAuth 2.0 por negocio
- **Despliegue:** VPS con Docker Compose, Caddy para TLS

### 3.3 Módulos

| Módulo | Responsabilidad | Interfaz pública |
|---|---|---|
| `WhatsappGateway` | Verificación GET, HMAC del POST, normalización, envío, sync de plantillas | `InboundMessage` normalizado, `send()`. Nadie más conoce el formato de Meta. |
| `Tenancy` | Resuelve tenant por `phone_number_id`, propaga contexto, fija variable de RLS | `TenantContext` |
| `Conversations` | Contactos, conversaciones, mensajes, ventana de 24 h | Repositorios + eventos de dominio |
| `FlowEngine` | Ejecuta la definición JSON del flujo, decide siguiente paso | `advance(session, input)` |
| `Agent` | Contexto, prompt de sistema, tool calling, guardarraíles, costos | `respond(conversation, input)` |
| `Scheduling` | Servicios, recursos, horarios, disponibilidad, reservas, recordatorios | Las herramientas invocables por el agente |
| `GoogleCalendar` | OAuth, tokens cifrados, refresh, `watch`, sincronización | `freeBusy()`, `createEvent()` |
| `Inbox` | Tiempo real hacia el panel, toma de control humano | WebSocket |
| `Usage` | Tokens, USD y latencia por tenant; topes y degradación | Métricas |

### 3.4 Colas

`inbound` (procesar entrante) · `agent` (turnos con LLM) · `outbound` (envío con
reintentos) · `reminders` (recordatorios programados) · `sync` (calendario, plantillas,
salud de tokens).

### 3.5 Regla de oro del pipeline

**El webhook de Meta responde `200` en menos de 100 ms, siempre.** Valida HMAC,
deduplica por `wamid`, encola y responde. Nada de LLM, de Google ni de lógica de
negocio dentro del request de Meta.

### 3.6 Flujo de un mensaje

```
Meta Cloud API
   └─ POST /webhooks/whatsapp ──► api (HMAC, dedup, encola, 200)
                                        │
                                   cola inbound
                                        ▼
                                     worker
                                        │  Tenancy: SET LOCAL app.tenant_id
                                        ▼
                            ┌──── FlowEngine.advance() ────┐
                            │  paso determinista → ejecuta │
                            │  ai_turn / ai_fallback       │
                            │        └─► Agent.respond()   │
                            │              ├ consultar_disponibilidad
                            │              ├ agendar_cita
                            │              ├ reprogramar / cancelar
                            │              └ escalar_a_humano
                            └──────────────┬───────────────┘
                                           ▼
                     Scheduling ─► appointments (fuente de verdad)
                                           │
                                    cola sync ─► Google Calendar
                                           │
                                  cola outbound ─► Meta
                                           │
                                  WebSocket ─► Panel
```

---

## 4. Modelo de datos

Una sola base de datos. `tenant_id` en cada tabla de negocio. Row Level Security activa.

```sql
CREATE POLICY tenant_isolation ON appointments
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

El middleware de `Tenancy` ejecuta `SET LOCAL app.tenant_id = '...'` al abrir la
transacción. Toda ruta de acceso a datos pasa por ahí, incluidos los jobs.

### 4.1 Tablas

**Identidad**
- `tenants` — slug, nombre, **zona horaria**, estado
- `users`, `tenant_users` — rol: `superadmin` / `owner` / `agent`
- `whatsapp_channels` — `waba_id`, `phone_number_id`, token cifrado

**Conversación**
- `contacts` — `wa_id`, nombre, metadatos
- `conversations` — estado, `assigned_to`, `last_inbound_at` (ventana de 24 h)
- `messages` — `wamid` **único** (dedup), dirección, tipo, cuerpo, payload JSONB, estado
- `webhook_events` — auditoría e idempotencia de entrada

**Motor**
- `flows` — definición JSONB, versión, triggers, `is_default`, `is_active`
- `conversation_sessions` — flujo actual, paso actual, `vars` JSONB

**IA**
- `agent_configs` — prompt de sistema, modelo, herramientas habilitadas, **versionado con rollback**
- `agent_runs` — tokens entrada/salida, USD, latencia, herramientas invocadas, por mensaje

**Agenda**
- `services` — duración, buffer, precio
- `resources` — el *quién atiende*: el médico, la estilista, la bahía del taller
- `resource_services` — qué recurso presta qué servicio
- `business_hours`, `time_off`
- `appointments` — **fuente de verdad**
- `google_accounts` — **uno por `resource`**: refresh token cifrado, `calendar_id`,
  `sync_token`, estado de salud. Cada recurso (médico, estilista, bahía) tiene su
  propio calendario; un tenant puede tener varios.

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
disponibilidad. Con esta restricción el segundo `INSERT` falla en Postgres y el agente
responde ofreciendo otra hora.

### 4.3 Cifrado

Los secretos por tenant (`whatsapp_channels.access_token`,
`google_accounts.refresh_token`) se almacenan cifrados con libsodium `secretbox`
(XSalsa20-Poly1305), llave maestra en variable de entorno o KMS, con envelope
versionado por byte de versión para permitir rotación.

---

## 5. Motor conversacional híbrido

### 5.1 Tres modos de intervención de la IA

**Modo 1 — Clasificador de entrada (Haiku).** Solo cuando llega un mensaje sin
conversación activa, o cuando el texto no coincide con ningún trigger. Devuelve una
intención de un catálogo cerrado (`agendar`, `reprogramar`, `cancelar`, `consultar`,
`otro`) y el flujo arranca en el paso correcto.

**Modo 2 — Rescate (`ai_fallback`).** Cualquier paso determinista puede declararlo.
Si el usuario escribe algo fuera del guion, el agente responde y **devuelve el control
al mismo paso**, en vez de un "opción inválida". Un turno, sin herramientas de
escritura.

**Modo 3 — Turno de agente (`ai_turn`).** El agente conduce con herramientas hasta
cumplir el objetivo declarado o rendirse. Aquí vive el agendamiento.

### 5.2 Definición de flujo

```jsonc
{
  // extracto: se omiten los pasos mis_citas, confirmacion y handoff
  "key": "agendamiento",
  "steps": {
    "saludo": {
      "type": "message",
      "text": "¡Hola! Soy el asistente de {{tenant.name}} 👋",
      "next": "menu"
    },
    "menu": {
      "type": "choice",
      "kind": "interactive_buttons",
      "text": "¿En qué te ayudo?",
      "buttons": [
        { "id": "agendar",   "title": "Agendar cita",        "next": "agendar" },
        { "id": "mis_citas", "title": "Mis citas",           "next": "mis_citas" },
        { "id": "asesor",    "title": "Hablar con alguien",  "next": "handoff" }
      ],
      "ai_fallback": true
    },
    "agendar": {
      "type": "ai_turn",
      "goal": "Agendar una cita confirmada para el contacto.",
      "tools": ["consultar_servicios", "consultar_disponibilidad",
                "agendar_cita", "escalar_a_humano"],
      "limits": { "max_turns": 12, "max_tool_calls": 5 },
      "on_success": "confirmacion",
      "on_giveup": "handoff"
    }
  }
}
```

Tipos de paso: `message`, `choice`, `capture`, `tool`, `ai_turn`, `handoff`, `end`.

`ai_turn` entra y sale por la misma puerta que cualquier otro paso. Un tenant puede ser
enteramente determinista (costo de IA cero) o casi enteramente conversacional, con el
mismo motor y sin ramas de código distintas.

### 5.3 Catálogo de herramientas

```
consultar_servicios()                                              → lectura
consultar_disponibilidad(servicio_id, desde, hasta, recurso_id?)   → lectura
consultar_mis_citas()                                              → lectura
agendar_cita(servicio_id, recurso_id, inicio_iso, nombre, notas?)  → escritura
reprogramar_cita(cita_id, nuevo_inicio_iso)                        → escritura, confirma
cancelar_cita(cita_id, motivo?)                                    → escritura, confirma
escalar_a_humano(motivo)                                           → control
```

### 5.4 Las cuatro reglas de las herramientas

**R1 — La herramienta valida; el prompt solo sugiere.** Cada herramienta revalida por su
cuenta contra `business_hours`, `time_off`, duración real del servicio, anticipación
mínima y horizonte máximo. Nunca se asume que el prompt fue obedecido.

**R2 — El modelo no calcula fechas.** Recibe en contexto la fecha y hora actual en la
zona del negocio (`tenants.timezone`, jamás la del servidor). Las herramientas exigen
ISO-8601 con offset y rechazan lo ambiguo o lo pasado.

**R3 — La identidad la inyecta el runtime.** `contact_id` y `tenant_id` **no son
parámetros** de ninguna herramienta: los pone el ejecutor desde el contexto de la
conversación. `consultar_mis_citas` no puede leer las de otra persona; `cancelar_cita`
verifica propiedad en SQL. Una inyección de prompt choca contra una verificación de
propiedad, no contra un párrafo.

**R4 — Lo destructivo se confirma en dos tiempos.** `cancelar_cita` y
`reprogramar_cita`, en su primera invocación, no ejecutan: devuelven los detalles y un
`confirmation_token`. Solo la segunda llamada, con ese token, aplica el cambio.

### 5.5 Contexto y costo

El prompt de sistema se arma en tres bloques, en este orden:

1. **Base del producto** — idéntica para todos los tenants
2. **Bloque del tenant** — `agent_configs.system_prompt`, editable desde el panel
3. **Bloque de negocio** — servicios, horarios, políticas, generado desde la BD

Los tres, más las definiciones de herramientas, van con **prompt caching**. Es la
palanca de costo más grande del sistema: en una conversación de 15 turnos el prompt de
sistema se reenvía 15 veces. Después vienen los últimos K mensajes y un resumen
progresivo generado con Haiku.

Cada llamada escribe en `agent_runs`. La métrica de negocio que importa es **costo de IA
por cita agendada**.

**Degradación por presupuesto:** superado el tope mensual del tenant, `ai_turn` degrada
a un paso determinista de menú. El bot se vuelve más simple, no se cae. Falla hacia lo
barato.

---

## 6. Errores y reconciliación

### 6.1 Por capa

**Entrada.** Meta reintenta si no recibe `200`. La idempotencia es una restricción, no
un `if`: índice único sobre `webhook_events.wamid`; el `INSERT` es la puerta. Si choca,
ya se procesó.

**Colas.** Retroceso exponencial con jitter. Los errores **transitorios** (red, 429,
5xx) se reintentan; los **permanentes** (payload inválido, tenant inexistente) van
directo a la cola muerta sin gastar intentos. Cola muerta con alertas.

**Salida.** Clave de idempotencia derivada de `(conversation_id, step, turn)`, verificada
antes de enviar, para no repetir un mensaje al usuario.

**LLM.** Timeout duro de 30 s, un reintento, y si falla otra vez degrada a mensaje
determinista de disculpa más `handoff`. Al usuario nunca se le deja en silencio.
Durante el turno: marcar como leído e indicador de escritura de la Cloud API (verificar
disponibilidad en la versión de API fijada); si pasa de ~8 s, un mensaje puente corto.

**Ventana de 24 h.** `Conversations` la verifica antes de cada envío contra
`last_inbound_at`. Fuera de la ventana el texto libre se rechaza en código y se exige
plantilla. Los recordatorios siempre son plantilla.

### 6.2 Reconciliación con Google Calendar

**Orden.** El `INSERT` en `appointments` va primero, en su propia transacción, protegido
por la restricción de exclusión. La cita es válida y confirmable sin que Google exista.
Solo después se encola la creación del evento, con `google_sync_status` en la fila.

**Idempotencia del evento.** Si `events.insert` se ejecuta pero la respuesta se pierde,
un reintento ciego duplicaría el evento. Google Calendar acepta un `id` provisto por el
cliente: se usa el UUID del `appointment` en hexadecimal sin guiones — válido porque el
alfabeto de Google es base32hex (`0-9`, `a-v`) y el hexadecimal es subconjunto. El
reintento devuelve `409`, que confirma que ya existía.

**Sincronización inversa.** El negocio moverá citas directamente en su calendario.
`events.watch` (push) más `syncToken` para el delta incremental. Los canales de `watch`
caducan (máximo un mes): un job los renueva, y **ese job debe estar monitoreado** —
cuando falla, se dejan de recibir cambios en silencio.

**Token muerto.** Chequeo diario por `google_account` con una llamada barata. Ante
`invalid_grant`: cuenta a `needs_reauth`, aviso al dueño por correo y panel, y el
sistema **sigue agendando localmente**.

---

## 7. Estrategia de pruebas

**1. Unitarias** — cálculo de slots, validadores de disponibilidad, aritmética de zonas
horarias, formateo de fechas.

**2. Integración** — contra Postgres real. La prueba central del sistema: **dos
inserciones concurrentes de la misma franja, afirmando que exactamente una sobrevive.**
Meta y Google mockeados por contrato (respuestas reales grabadas una vez y
reproducidas). Nunca se llama a las APIs reales en CI.

**3. E2E del motor** — arnés de conversación: se alimenta una lista de mensajes de
usuario y se afirma sobre los mensajes de salida y el estado final de la BD. Sin
WhatsApp, sin red.

**4. Banco de regresión conversacional** — 30 a 50 conversaciones-guion con su desenlace
esperado (¿se creó la cita? ¿a qué hora? ¿escaló cuando debía?). Corre contra el modelo
real, **fuera de CI**, porque cuesta dinero y no es determinista. Afirma sobre
**resultados, no sobre texto**.

**Principio:** un prompt es código desplegado. `agent_configs` está versionado para
esto: cambio de prompt → correr el banco → comparar tasa de éxito contra la versión
anterior → publicar o hacer rollback.

---

## 8. Roadmap

**Semana 0 — arranca de inmediato, en paralelo con todo.**
Radicar la verificación de OAuth con Google. El scope `calendar` es sensible: exige
pantalla de consentimiento completa, política de privacidad publicada en dominio propio
y video de demostración; son semanas de espera no comprimibles. Mientras tanto se
desarrolla en modo *testing* con usuarios de prueba, donde **el refresh token caduca a
los 7 días** — suficiente para desarrollar, inviable en producción. También: proyecto en
GCP, API key de Anthropic, VPS con dominio y TLS.

| Fase | Entrega | Estimado |
|---|---|---|
| **1. Cimientos** | Monorepo, gateway WhatsApp (webhook, dedup, envío), tenancy + RLS, conversaciones y mensajes, motor de flujos determinista | 3–4 sem |
| **2. Agenda** | Servicios, recursos, horarios, disponibilidad, `appointments` con restricción de exclusión. Se agenda por menús, sin IA. | 2–3 sem |
| **3. Google Calendar** | OAuth, tokens cifrados, insert idempotente, `watch`, health check | 2 sem |
| **4. El agente** | `ai_turn`, `ai_fallback`, clasificador, herramientas, guardarraíles, `agent_runs`, banco de regresión | 3 sem |
| **5. Panel** | Bandeja en vivo, toma de control, métricas, editor de prompts versionado | 3–4 sem |
| **6. Multi-tenant** | Alta autoservicio, onboarding de WABA y calendario, topes de gasto | 2 sem |

**Total estimado:** 15–18 semanas a tiempo completo para una persona.

**Orden deliberado:** la agenda determinista va **antes** que el agente. Las herramientas
deben existir y estar probadas antes de ponerlas en manos de un modelo; construir el
agente primero significa depurar dos cosas no deterministas a la vez.

**Punto de corte con valor:** al final de la Fase 2 ya existe un producto usable — un
bot de menús que agenda citas es útil aunque no tenga una línea de IA.

---

## 9. Riesgos abiertos

| Riesgo | Mitigación | Fase |
|---|---|---|
| Verificación de Google demora más de lo previsto | Radicar en Semana 0; desarrollar en modo testing entre tanto | 0 |
| Costo de IA por conversación erosiona el margen | Prompt caching, clasificador con Haiku, flujos deterministas para lo repetitivo, topes con degradación | 4 |
| Latencia percibida en WhatsApp | Indicador de escritura, mensaje puente sobre ~8 s, timeout duro con degradación | 4 |
| Aprobación de plantillas de Meta bloquea recordatorios | Enviar plantillas a aprobación en Fase 2, antes de necesitarlas | 2 |
| Renovación de canales `watch` falla en silencio | Monitoreo explícito del job y alerta por canal vencido | 3 |
| Un cambio de prompt rompe el agendamiento | Banco de regresión obligatorio antes de publicar; `agent_configs` versionado con rollback | 4 |
| Cláusulas contractuales del autor (no competencia / invenciones) | Revisar contrato laboral antes de comercializar | 0 |

---

## 10. Fuera de alcance (v1)

Explícitamente **no** se construye en este ciclo:

- Pagos y cobro anticipado de citas
- Canales adicionales (Instagram, Messenger, web chat)
- Voz o transcripción de notas de audio
- Facturación del SaaS a los tenants (se mide consumo, no se cobra)
- Reventa del gateway de WhatsApp como producto separado
- App móvil del panel
