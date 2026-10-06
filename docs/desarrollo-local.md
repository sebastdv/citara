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
