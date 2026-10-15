# Citara

Chatbot de WhatsApp que **agenda citas automáticamente** para negocios de cita previa con
recurso limitado: consultorios, salones de belleza, talleres, estudios.

No es un SaaS de autoservicio. El autor lo instala, lo configura y lo opera para cada
cliente; el cliente no administra nada:

| Quién | Qué usa |
|---|---|
| Cliente final del negocio | WhatsApp |
| Dueño del negocio | Su app de WhatsApp Business (contesta cuando quiere y el bot se aparta) y su Google Calendar |
| Operador | El panel en `/panel`, la CLI y un archivo YAML por negocio |

## Qué hace

- **Canal oficial.** WhatsApp Cloud API de Meta, con número dedicado o en **coexistencia**
  con la app de WhatsApp Business que el negocio ya usa.
- **Conversación híbrida.** Menús deterministas para lo repetitivo. Un agente
  (`claude-opus-5-5`) entiende lo que el cliente escribe libre y agenda, mueve o cancela
  conversando. Un intérprete barato (`claude-haiku-5-5`) resuelve las respuestas que no
  encajan en un menú. Cada negocio tiene un tope mensual de gasto en IA; al alcanzarlo
  vuelve a menús.
- **Agendamiento real.** Disponibilidad, reserva y recordatorios. La base de datos es la
  fuente de verdad: la doble reserva la impide una restricción de exclusión de Postgres.
  Cada recurso se proyecta a un calendario «Citas» en su Google Calendar, y los cambios
  que el dueño hace ahí vuelven a Citara.
- **Control de la conversación.** Si el dueño escribe desde su celular, o el flujo pide un
  humano, el bot se calla hasta que vence el plazo o el operador lo devuelve.
- **Panel del operador.** Traspasos abiertos de todos los negocios, chat con tomar, devolver
  y responder, auditoría, costo de IA por cita y una pantalla de estado con lo que hay que
  mirar (respaldos, colas, canales caídos, el dueño que dejó de abrir la app, Google, IA).

## Arquitectura

```
Meta ──webhook──► api (HMAC, dedup, encola, 200)
                       │ cola inbound (Redis)
                       ▼
                  worker: una transacción con RLS por turno
                       ├─ control: ¿manda un humano? → no responde
                       ├─ motor de flujos ─┬─ paso determinista
                       │                   ├─ herramienta de agenda (misma transacción)
                       │                   └─ IA → cola agent (fuera de la transacción)
                       └─ salientes en `pending` (outbox)
                       │ commit → cola outbound
                       ▼
                  worker: control y ventana de 24 h justo antes de enviar → Meta
```

- **Monolito modular** en un monorepo pnpm. La API (HTTP) y el worker (colas) son procesos
  separados con el mismo código; solo cambia el arranque.
- **Postgres único con `tenant_id` y RLS** (`ENABLE` + `FORCE`). La aplicación se conecta
  con un rol sin bypass y con un presupuesto cerrado de privilegios por tabla, verificado
  por test. Un job que olvide fijar el negocio ve cero filas, no las de otro cliente.
- **Outbox de salida.** Las respuestas se guardan en la misma transacción que el turno y se
  encolan tras el commit. Cada transición de estado es compare-and-set.

## Stack

NestJS 11 · TypeScript · TypeORM (migraciones y SQL a mano) · PostgreSQL 16 (`btree_gist`)
· Redis + BullMQ · Luxon · Zod · Anthropic SDK · Google Calendar API v3 · Vitest.
En producción: Docker Compose en un VPS, con Caddy para el TLS.

## Estructura

```
apps/
  api/        NestJS: webhook de Meta, páginas de conexión, panel, CLI y todo el dominio
  worker/     el mismo código, arranca solo los consumidores de colas
packages/
  db/         migraciones (una por tabla) y entidades
  shared/     tipos y contratos compartidos (flujos, contenido saliente)
deploy/       compose de producción, Caddyfile, scripts de despliegue y prueba de humo
docs/
  desarrollo-local.md                   cómo levantarlo y operarlo
  produccion.md                         el servidor, desplegar, respaldos y restaurar
  ejemplos/negocio.yaml                 configuración de ejemplo de un negocio
  superpowers/specs/…-design.md         la spec (fuente de verdad del diseño)
  superpowers/plans/                    el plan de cada fase
```

## Arranque rápido

Requisitos: Node 22+, pnpm 10 y Docker. La guía completa, con la conexión a un número de
WhatsApp de prueba y el túnel para el webhook, está en
[docs/desarrollo-local.md](docs/desarrollo-local.md).

```bash
pnpm install
```

```bash
pnpm db:up
```

```bash
cp .env.example .env
```

Completa `.env` (cada variable está explicada en `.env.example`). Luego compila, migra y da
de alta el negocio de desarrollo:

```bash
pnpm build
```

```bash
pnpm db:migrate
```

```bash
pnpm dev:provision
```

Arranca los dos procesos, cada uno en su terminal:

```bash
pnpm start:api
```

```bash
pnpm start:worker
```

## Comandos

| Comando | Para qué |
|---|---|
| `pnpm build` / `pnpm typecheck` | Compilar / verificar tipos |
| `pnpm test` | Todos los tests (base `citara_test` y Redis db 1, nunca los de desarrollo) |
| `pnpm db:up` / `pnpm db:down` | Levantar / bajar Postgres y Redis en Docker |
| `pnpm db:migrate` | Aplicar las migraciones (conexión admin) |
| `pnpm dev:provision` | Dar de alta el negocio de desarrollo con un número de prueba |
| `pnpm tenant create <slug> "<nombre>"` | Crear un negocio e imprimir su enlace de conexión de WhatsApp |
| `pnpm tenant list` | Estado de los negocios: canal, sincronización, Google, gasto de IA |
| `pnpm tenant google <slug> <recurso>` | Enlace para conectar el Google Calendar de un recurso |
| `pnpm tenant:apply <negocio.yaml>` | Aplicar servicios, recursos, horarios, flujo y agente de un negocio |
| `pnpm agent:bench <negocio.yaml>` | Banco de regresión del agente contra el modelo real (cuesta dinero; fuera de CI) |
| `pnpm operator create <correo>` | Crear el operador del panel |

`pnpm tenant` sin argumentos muestra el resto de subcomandos (`link`, `suspend`, `resume`,
`sync`, `agent`, `agent-rollback`). Todos los comandos de la CLI corren sobre lo compilado:
`pnpm build` primero.

## Producción

Un VPS con Docker Compose: Postgres, Redis, la API, el worker y Caddy, que saca y renueva el
certificado. La imagen se construye en el servidor y cada despliegue lo lanzas tú:

```bash
CITARA_SSH=citara@citas.tudominio.com ./deploy/deploy.sh main
```

Respalda la base, migra, cambia de versión y comprueba que la API responda y el worker siga
en pie; si no, vuelve solo a la versión anterior. `./deploy/deploy.sh rollback` vuelve atrás
sin recompilar. Hay un respaldo nocturno en el disco del VPS. Todo, desde un servidor vacío,
en [docs/produccion.md](docs/produccion.md).

## Tests

`pnpm test` corre contra Postgres y Redis reales. Usa una base exclusiva (`citara_test`) y
una db de Redis aparte, así que no toca tus datos de desarrollo. Meta, Google y el modelo
se reemplazan por dobles; nunca se llama a sus APIs reales. Los tests de punta a punta
levantan el webhook firmado, Redis y los workers reales.

En cada PR y en cada push a `main`, GitHub Actions corre el typecheck, todos los tests y la
construcción de la imagen de producción (`.github/workflows/ci.yml`). Los cambios del
despliegue se prueban con `./deploy/smoke/smoke.sh`, que levanta el compose de producción en
tu máquina, lo ejercita (despliegue, rollback, versión rota, respaldo y restauración) y lo
borra.

El banco de regresión del agente (`pnpm agent:bench`) es la excepción: habla con el modelo
real, cuesta dinero y no corre en CI. `tenant:apply` exige haberlo pasado antes de
publicar un cambio de comportamiento del agente.

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 1 · Cimientos | Gateway, RLS, motor de flujos, outbox | Hecha; falta la prueba con un número real |
| 1.5 · Coexistencia | Control de la conversación, ecos del celular, historial | Hecha y probada con payloads de ejemplo; falta un número real |
| 2 · Agenda | Disponibilidad, reservas, recordatorios, `tenant:apply` | Hecha; faltan las plantillas aprobadas |
| 3 · Alta asistida | Enlaces firmados, Embedded Signup, conexión de WhatsApp | Hecha; falta la aprobación de Meta |
| 4 · Google Calendar | OAuth por recurso, proyección y sincronización inversa | Hecha; falta una cuenta real |
| 5 · El agente | Agente, intérprete, guardarraíles, costos, banco de regresión | Hecha; falta correr el banco con el modelo real |
| 6 · Panel del operador | Bandeja, control, respuestas, auditoría, costo por cita | Hecha; falta probarlo detrás de Caddy |
| 7 · Despliegue | Imagen, compose con Caddy, despliegue y rollback, respaldos, CI | Hecha; falta el primer servidor |

Pendiente fuera del código: la aprobación de Meta como Tech Provider, la verificación OAuth
de Google, las plantillas de recordatorio aprobadas y las pruebas con números reales.
