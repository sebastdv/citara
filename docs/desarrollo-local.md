# Desarrollo local y prueba con WhatsApp real

Cómo levantar Citara en tu máquina y conectarlo a un número de WhatsApp de prueba.
Todo lo de aquí está verificado con los binarios compilados, no solo con los tests.

## Requisitos

- Node 22+ (probado con 24), pnpm 10, Docker Desktop.
- ngrok (o cualquier túnel HTTPS) para que Meta alcance tu máquina.
- Una app en [developers.facebook.com](https://developers.facebook.com) con el producto
  WhatsApp añadido. El número de prueba que da Meta sirve.

## 1. Infraestructura y configuración

```bash
pnpm install
```

```bash
pnpm db:up
```

```bash
cp .env.example .env
```

Completa `.env`:

| Variable | De dónde sale |
|---|---|
| `DB_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `META_APP_SECRET` | App de Meta → Configuración de la app → Básica → Clave secreta |
| `META_VERIFY_TOKEN` | Una cadena que eliges tú; la repites en la consola de Meta |
| `META_WABA_ID` | WhatsApp → Configuración de la API → identificador de la cuenta de WhatsApp Business |
| `META_PHONE_NUMBER_ID` | WhatsApp → Configuración de la API → identificador del número de teléfono |
| `META_ACCESS_TOKEN` | Token del número (el temporal de 24 h sirve para probar; para algo estable, un token de usuario del sistema) |

El token se guarda cifrado en la base y nunca se imprime ni se escribe en logs.

## 2. Compilar, migrar y dar de alta el negocio

```bash
pnpm build
```

```bash
pnpm db:migrate
```

```bash
pnpm dev:provision
```

`dev:provision` es idempotente: repetirlo actualiza el negocio y rota el token. Se niega
a mover a otro negocio un `phone_number_id` que ya tiene dueño. El flujo que deja activo
es el de demostración (`apps/api/src/cli/provision.ts`).

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

## 3. Arrancar los dos procesos

En dos terminales distintas: son procesos separados a propósito, y el worker puede
reiniciarse sin que la API deje de recibir webhooks (los mensajes esperan en Redis).

```bash
pnpm start:api
```

```bash
pnpm start:worker
```

## 4. Exponer el webhook y suscribirlo en Meta

```bash
ngrok http 3000
```

En la app de Meta → WhatsApp → Configuración:

1. **URL de devolución de llamada:** `https://<tu-subdominio-ngrok>/webhooks/whatsapp`
2. **Token de verificación:** el mismo `META_VERIFY_TOKEN` de tu `.env`
3. **Verificar y guardar.** Meta hace un `GET` y la API responde el challenge.
4. En **Campos del webhook**, suscribe `messages`.
5. En Configuración de la API, añade tu propio número como destinatario de prueba.

Escribe "Hola" al número de prueba desde tu WhatsApp: debes recibir el saludo y el menú.

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

Imprime un enlace de un solo uso (vence en 72 h). Se lo mandas al cliente, que lo abre, toca
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

Estado de cada negocio: canal, historial, resultado de pedir las sincronizaciones
(`sync contactos ok, historial FALLÓ`: lo que falló se reintenta con `pnpm tenant sync` dentro
de las 24 h del alta, o se pierde) y **último eco** (la última vez que el dueño escribió
desde su celular). Si el dueño no abre la app en unos 13 días, Meta corta la coexistencia:
vigila esa columna.

Otros comandos: `pnpm tenant link <slug>` (enlace nuevo si se perdió o venció; anula los anteriores),
`pnpm tenant sync <slug>` (reintentar la sincronización, dentro de las 24 h del alta),
`pnpm tenant suspend <slug>` / `pnpm tenant resume <slug>` (suspender corta al instante, incluso lo que
ya estaba en cola, y anula los enlaces sin usar).

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
  vuelve a su hora en Google. Si la borra y la recupera con "Deshacer", la cita vuelve (si la
  franja sigue libre; si no, el evento se borra otra vez). Todo queda en `audit_log` con
  `actor = 'google'`.
- Los avisos de Google (`events.watch`) exigen `PUBLIC_BASE_URL` con HTTPS. Sin HTTPS (en
  desarrollo), los cambios se leen cada 15 minutos.

`pnpm tenant list` muestra, por recurso, `ok`, `RECONECTAR` (revocó el acceso o venció el
modo *testing*: mándale `pnpm tenant google ...` de nuevo), `SIN CALENDARIO` (lo borró; se
recrea solo en menos de una hora), `avisos FALLAN` o `avisos VENCIDOS`, y cuántas citas
faltan por subir.

## El agente (Fase 5)

La conversación es **híbrida**: los menús siguen siendo el camino principal y la IA entra en tres casos.
- **Un primer mensaje con contenido** ("quiero un corte mañana a las 3") va al agente; un "Hola" abre el menú.
- **Una respuesta que no encaja en un menú** ("quiero ver mis citas porfa") la interpreta `claude-haiku-5-5` y el flujo sigue por la opción. Si es un pedido que el menú no cubre, pasa al agente.
- **El agente** (`claude-opus-5-5` por defecto) conversa con las herramientas de la agenda. Agendar, mover y cancelar se confirman **siempre** con un "sí" del cliente en un mensaje posterior. Sale con el menú o pasando la conversación a un humano.

### Encenderlo para un negocio

1. `ANTHROPIC_API_KEY` en `.env`. Sin ella, el bot sigue solo con menús.
2. La sección `agent:` en el YAML del negocio (ver `docs/ejemplos/negocio.yaml`): modelo, effort, tope mensual en USD e instrucciones propias, que se suman al prompt base.
3. El banco de regresión, contra el modelo real (cuesta centavos de dólar):
   ```bash
   pnpm build && pnpm agent:bench clientes/peluqueria-ana.yaml
   ```
   Corre 12 conversaciones-guion sobre un negocio de prueba en la base `citara_bench` y guarda el resultado en `bench-results/`.
4. `pnpm tenant:apply clientes/peluqueria-ana.yaml`. Un cambio de modelo, effort o instrucciones **no se publica** sin el banco aprobado para esa configuración. Cambiar solo el tope o apagarlo no lo pide. `--sin-banco` lo salta y queda auditado.

### Operarlo

- `pnpm tenant list` muestra `IA 3,20/20 USD` (gasto del mes contra el tope), `IA AGOTADA` o `IA apagada`. Al tope, el negocio vuelve a menús hasta el mes siguiente.
- `pnpm tenant agent <slug>` lista las versiones; `pnpm tenant agent-rollback <slug> <versión>` vuelve a una anterior. Las conversaciones en curso terminan con la configuración con que empezaron.
- Cada llamada al modelo queda en `agent_runs` con tokens, USD, latencia y herramientas.
- Si el modelo falla dos veces, se niega o se enreda, el cliente recibe una disculpa y la conversación pasa al dueño. Nunca queda en silencio.
- Mientras el agente piensa, el cliente ve "escribiendo..." (VERIFICAR el formato con el primer número real).

## Coexistencia (Fase 1.5)

Con un número conectado en coexistencia (ver el alta, arriba), en la app de
Meta → WhatsApp → Configuración, además de `messages` se suscriben estos campos:
`smb_message_echoes`, `history`, `smb_app_state_sync` y `account_update`.

Qué hace el sistema con cada uno:

| Campo | Efecto |
|---|---|
| `smb_message_echoes` | Lo que el dueño escribe desde su celular se guarda (`origin='phone'`) y el bot se calla en esa conversación durante `tenants.human_takeover_hours` (12 por defecto); cada mensaje del dueño alarga el plazo |
| `history` | Importa hasta 180 días (`origin='history'`); al terminar, las conversaciones donde el dueño escribió dentro del plazo quedan en sus manos |
| `smb_app_state_sync` | Guarda en `contacts.saved_name` el nombre con que el negocio tiene al cliente |
| `account_update` | Una desconexión deja el canal en `disconnected`: lo que llegue se guarda, el bot no responde y no se envía nada. `ACCOUNT_RECONNECTED` lo devuelve a `active` (nunca reactiva un canal que el operador dejó inactivo) |

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

## Qué verificar (criterios de salida de la Fase 1)

| Criterio | Cómo comprobarlo |
|---|---|
| El usuario recibe la respuesta del flujo | Escribe "Hola"; llegan saludo y menú, en ese orden |
| Botones | Pulsa "Agendar cita"; pide el nombre; respóndelo y cierra |
| Worker reiniciable | Detén `start:worker`, escribe, vuelve a arrancarlo: la respuesta llega al volver |
| Un mismo `wamid` dos veces → una respuesta | Lo cubre `apps/api/test/pipeline`; en real, Meta reentrega solo si no recibe 200 |
| `phone_number_id` desconocido | Responde 200 y no envía nada (`apps/api/test/whatsapp/webhook.e2e.test.ts`) |

Para inspeccionar el estado:

```bash
docker compose exec postgres psql -U postgres -d citara -c "select direction, status, body, created_at from messages order by created_at"
```

## Estados de un mensaje saliente

`pending` (el flujo lo produjo) → `sending` (un envío lo reclamó) → `sent` (Meta lo
aceptó y devolvió `wamid`). Salidas laterales:

- `window_closed`: pasaron 24 h desde el último mensaje del cliente; solo se puede
  escribir con plantilla.
  También cuando Meta responde 131047, aunque nuestro reloj diga otra cosa.
- `failed`: Meta lo rechazó de forma permanente (token inválido, payload mal armado), el
  canal es inválido, o se agotaron los reintentos (~8,5 min de backoff).
- `unconfirmed`: pudo llegar o no — un timeout, una conexión cortada después de enviar,
  un 200 sin `wamid`, o un intento que reclamó la fila y murió. No se reenvía a ciegas
  para no duplicarle el mensaje al usuario.

Los recordatorios (`origin='reminder'`) salen aunque el dueño esté atendiendo: no quedan
`superseded`.

Los límites de tasa de Meta (que llegan con HTTP 400) y los 5xx se reintentan; la lista
de códigos reintentables está en `apps/api/src/whatsapp/sender.ts` y conviene
contrastarla con la tabla oficial al grabar el primer rechazo real.

## Tests

```bash
pnpm test
```

Los tests usan su propia base (`citara_test`, se crea sola) y la db 1 de Redis. Correrlos
**no** toca el negocio que diste de alta ni los mensajes de desarrollo. Se pueden fijar
otras con `TEST_DATABASE_URL`, `TEST_DATABASE_ADMIN_URL` y `TEST_REDIS_URL`.

## Limitaciones conocidas de la Fase 1

Anotadas en la revisión de cierre; ninguna impide la prueba con un número real.

- El orden entre **turnos** distintos no está garantizado (dentro de un turno, sí).
- Las sesiones no caducan: quien vuelve días después sigue en el paso donde quedó, y un
  botón viejo pulsado durante una captura de texto se acepta como dato.
- Reacciones, stickers y ubicación llegan sin texto y repiten el paso actual.
- Un flujo con un paso inexistente o un ciclo deja la conversación atascada.
- Las listas no recortan títulos de fila a 24 caracteres ni limitan a 10 filas.
- Al arrancar no se valida el entorno: sin `META_APP_SECRET` cada webhook da 500.
- Los jobs fallidos se conservan en Redis sin límite (contienen el teléfono del cliente).
