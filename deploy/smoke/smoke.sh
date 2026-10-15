#!/usr/bin/env bash
# Prueba de humo del despliegue en tu máquina: levanta el compose de producción
# (proyecto citara-smoke, base y volúmenes propios), lo ejercita con
# deploy/server.sh y lo borra todo al terminar. No toca tu entorno de desarrollo.
#
#   ./deploy/smoke/smoke.sh
#   SMOKE_KEEP=1 ./deploy/smoke/smoke.sh   si algo falla, deja todo en pie para inspeccionarlo
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/citara-smoke.XXXXXX")"
export CITARA_ROOT="$ROOT" CITARA_PROJECT=citara-smoke CITARA_SKIP_GIT=1 CITARA_YES=1
export CITARA_ENV_FILE="$WORK/env" CITARA_BACKUP_DIR="$WORK/backups" CITARA_HISTORY="$WORK/history"
export CITARA_BACKUP_STATUS_DIR="$WORK/backup-status"
export CITARA_COMPOSE_OVERRIDE="$ROOT/deploy/smoke/compose.override.yml"
# Imagen propia: la poda de server.sh solo borra imágenes con este nombre, así que
# la prueba no toca las citara:* que tengas construidas.
export CITARA_IMAGE=citara-smoke
S="$ROOT/deploy/server.sh"
PASS=0

ok() { PASS=$((PASS + 1)); printf '\033[32m✓\033[0m %s\n' "$*"; }
# check "<descripción>" <comando…>: la comprobación pasa o la prueba se corta ahí.
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else fail "$desc"; fi; }
eq() { [ "$1" = "$2" ] || { echo "  esperaba «$2», salió «$1»" >&2; return 1; }; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
trap 'fail "falló: $BASH_COMMAND (línea $LINENO)"' ERR
compose() { docker compose -p citara-smoke -f "$ROOT/deploy/compose.yml" -f "$CITARA_COMPOSE_OVERRIDE" --env-file "$CITARA_ENV_FILE" "$@"; }
sql() { CITARA_TAG=x compose exec -T postgres psql -U postgres -d citara -Atc "$1"; }
api_image() { docker inspect --format '{{.Config.Image}}' "$(CITARA_TAG=x compose ps -q api)"; }
# Permisos de un archivo: GNU primero (en GNU, `stat -f` no falla: describe el sistema de archivos).
perms() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

teardown() {
  local status=$?
  if [ "$status" != "0" ] && [ "${SMOKE_KEEP:-}" = "1" ]; then
    echo "SMOKE_KEEP=1: queda en pie. Variables: $WORK/env. Bórralo con: docker compose -p citara-smoke down -v" >&2
    return
  fi
  CITARA_TAG=x compose --profile cli down -v --remove-orphans >/dev/null 2>&1 || true
  docker image ls citara-smoke --format '{{.Repository}}:{{.Tag}}' | xargs docker image rm >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap teardown EXIT

hex() { openssl rand -hex 24; }
cat > "$CITARA_ENV_FILE" <<ENV
DOMAIN=localhost
POSTGRES_PASSWORD=$(hex)
APP_DB_PASSWORD=$(hex)
DB_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
META_APP_SECRET=smoke-secret
META_VERIFY_TOKEN=smoke-verify
ENV
APP_PW="$(grep ^APP_DB_PASSWORD= "$CITARA_ENV_FILE" | cut -d= -f2)"

echo "== Primer despliegue (compila la imagen)"
"$S" deploy smoke-a
check "la API corre citara-smoke:smoke-a" eq "$(api_image)" "citara-smoke:smoke-a"
check "el worker corre sin reinicios" eq "$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$(CITARA_TAG=x compose ps -q worker)")" "running 0"

check "/healthz responde por Caddy con TLS" sh -c "curl -skf https://localhost:8443/healthz | grep -q '\"status\":\"ok\"'"
check "el panel responde por Caddy" eq "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:8443/panel/login)" "200"
check "http redirige a https" eq "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/healthz)" "308"
published() {
  local id; id="$(CITARA_TAG=x compose ps -q "$1")"
  [ -n "$id" ] || fail "no existe el contenedor de $1"
  docker port "$id"
}
for svc in postgres redis api worker; do
  [ -z "$(published "$svc")" ] || fail "$svc publica puertos: $(published "$svc")"
done
caddy_publishes_443() { published caddy | grep -q 443; }
check "solo Caddy publica puertos" caddy_publishes_443

check "Redis tiene tope de memoria (512 MB)" eq "$(CITARA_TAG=x compose exec -T redis redis-cli config get maxmemory | tail -n 1)" "536870912"

out="$("$S" cli migrate.js)"
check "migrar otra vez no hace nada" grep -q "Sin migraciones pendientes" <<<"$out"
# Con una terminal de verdad (en bash 3.2 un arreglo vacío con set -u rompía este camino).
# script(1) le da una al comando; su propia entrada va de /dev/null porque falla si es un socket.
if [ "$(uname)" = "Darwin" ]; then
  check "la CLI funciona desde una terminal" grep -q "Sin migraciones pendientes" <<<"$(script -q /dev/null "$S" cli migrate.js < /dev/null 2>&1)"
fi
# Por la red de compose, como la app: dentro del contenedor de Postgres la imagen
# confía en toda conexión local y cualquier clave entraría.
as_app() { CITARA_TAG=x compose run --rm --no-deps -T -e PGPASSWORD="$1" --entrypoint psql postgres \
             -h postgres -U citara_app -d citara -Atc 'select 1' 2>/dev/null; }
[ "$(as_app citara_app)" = "1" ] && fail "citara_app aún entra con la clave de desarrollo"
check "citara_app entra solo con APP_DB_PASSWORD" eq "$(as_app "$APP_PW")" "1"

echo "== Respaldo y restauración"
"$S" cli tenant-cli.js create uno "Negocio Uno" >/dev/null
"$S" backup pre-deploy smoke >/dev/null
dump="$(ls -1t "$CITARA_BACKUP_DIR"/*.dump | head -n 1)"
check "el respaldo queda con permisos 600" eq "$(perms "$dump")" "600"
"$S" cli tenant-cli.js create dos "Negocio Dos" >/dev/null
[ "$(sql 'select count(*) from tenants')" = "2" ] || fail "no se creó el segundo negocio"
"$S" restore "$dump" >/dev/null
check "restaurar deja la base como en el respaldo" eq "$(sql "select string_agg(slug, ',') from tenants")" "uno"
check "la API vuelve a responder tras restaurar" curl -skf -o /dev/null https://localhost:8443/healthz
check "la base anterior queda guardada" test -n "$(sql "select datname from pg_database where datname like 'citara_prev_%'")"
check "la base restaurada sigue sin TEMPORARY para la app" eq "$(sql "select has_database_privilege('citara_app', 'citara', 'TEMPORARY')")" "f"
check "tras restaurar, la app conserva sus permisos y RLS" eq "$(sql "select has_table_privilege('citara_app', 'conversations', 'SELECT')::text || (select relrowsecurity and relforcerowsecurity from pg_class where relname = 'conversations')::text")" "truetrue"
head -c 3000 "$dump" > "$WORK/truncado.dump"
if "$S" restore "$WORK/truncado.dump" >/dev/null 2>&1; then fail "se restauró un respaldo truncado"; fi
check "un respaldo truncado no se restaura y la base sigue igual" eq "$(sql "select string_agg(slug, ',') from tenants")" "uno"
check "y la API sigue respondiendo" curl -skf -o /dev/null https://localhost:8443/healthz
if printf 'no\n' | CITARA_YES='' "$S" restore "$dump" >/dev/null 2>&1; then fail "una restauración sin confirmar siguió adelante"; fi
check "una restauración cancelada no cambia nada ni deja la base temporal" eq \
  "$(sql "select string_agg(slug, ',') from tenants") $(sql "select count(*) from pg_database where datname = 'citara_restore'")" "uno 0"

echo "== Respaldo nocturno y poda"
mkdir "$ROOT/.deploy-lock"
if CITARA_LOCK_WAIT=4 "$S" backup nightly >/dev/null 2>&1; then rmdir "$ROOT/.deploy-lock"; fail "el respaldo nocturno ignoró el lock"; fi
if CITARA_LOCK_WAIT=4 "$S" cli migrate.js >/dev/null 2>&1; then rmdir "$ROOT/.deploy-lock"; fail "un migrate suelto ignoró el lock"; fi
rmdir "$ROOT/.deploy-lock"
ok "el respaldo nocturno y un migrate suelto esperan el lock de un despliegue en curso"
for i in $(seq -w 1 16); do : > "$CITARA_BACKUP_DIR/daily-202601${i}-000000.dump"; done
"$S" backup nightly >/dev/null
check "la API ve el estado del último nocturno (pantalla de estado)" sh -c "docker exec \"\$1\" cat /app/backup-status/last-nightly | grep -q '^daily-'" _ "$(CITARA_TAG=x compose ps -q api)"
check "la API no ve los respaldos" sh -c "! docker exec \"\$1\" ls /app/backups >/dev/null 2>&1" _ "$(CITARA_TAG=x compose ps -q api)"
check "la carpeta de respaldos queda en 700" eq "$(perms "$CITARA_BACKUP_DIR")" "700"
check "se quedan 14 respaldos diarios" eq "$(ls -1 "$CITARA_BACKUP_DIR"/daily-*.dump | wc -l | tr -d ' ')" "14"
for i in $(seq -w 1 10); do : > "$CITARA_BACKUP_DIR/weekly-202601${i}-000000.dump"; done
: > "$CITARA_BACKUP_DIR/pre-deploy-20250101-000000-viejo.dump"; touch -t 202501010000 "$CITARA_BACKUP_DIR/pre-deploy-20250101-000000-viejo.dump"
"$S" backup nightly >/dev/null
check "se quedan 8 semanales y se borran los de antes de desplegar de hace más de 30 días" eq \
  "$(ls -1 "$CITARA_BACKUP_DIR"/weekly-*.dump | wc -l | tr -d ' ') $(find "$CITARA_BACKUP_DIR" -name '*viejo*' | wc -l | tr -d ' ')" "8 0"

echo "== Pantalla de estado (con un operador de verdad)"
OP_PW="$(hex)"
# Desde apps/api: ahí se resuelve @citara/db. La clave va como argumento, no en el código.
CITARA_TAG=smoke-a compose run --rm -T -w /app/apps/api cli node -e \
  "const { createDataSource } = require('@citara/db'); const { createOperator } = require('./dist/src/cli/operators.js');
   (async () => { const ds = await createDataSource(process.env.DATABASE_ADMIN_URL).initialize();
     await createOperator(ds, 'op@citara.test', process.argv[1]); await ds.destroy(); })();" "$OP_PW" >/dev/null
JAR="$WORK/cookies"
curl -sk -c "$JAR" -o /dev/null -H 'Origin: https://localhost:8443' \
  --data-urlencode 'email=op@citara.test' --data-urlencode "password=$OP_PW" https://localhost:8443/panel/login
check "el panel muestra el estado con el último respaldo nocturno" sh -c \
  "curl -sk -b '$JAR' https://localhost:8443/panel/estado | grep -q 'Último respaldo nocturno: daily-'"

echo "== Apagado limpio"
CITARA_TAG=smoke-a compose stop -t 20 api >/dev/null 2>&1
check "la API se apaga con SIGTERM, sin que Docker la mate" test "$(docker inspect --format '{{.State.ExitCode}}' "$(CITARA_TAG=x compose ps -aq api)")" != "137"
CITARA_TAG=smoke-a compose start api >/dev/null 2>&1
for i in $(seq 1 45); do curl -skf -o /dev/null https://localhost:8443/healthz && break; sleep 2; done

echo "== Nueva versión y rollback"
docker tag citara-smoke:smoke-a citara-smoke:smoke-b
"$S" deploy smoke-b >/dev/null
check "despliega smoke-b sin recompilar" eq "$(api_image)" "citara-smoke:smoke-b"
"$S" rollback >/dev/null
check "rollback vuelve a smoke-a" eq "$(api_image)" "citara-smoke:smoke-a"

echo "== Versiones que no arrancan"
# Una con la API rota y otra con el worker roto: las dos deben volver solas a la anterior.
for broken in apps/api/dist/src/main.js apps/worker/dist/src/main.js; do
  # USER root: /app es de root y solo lectura para node.
  printf 'FROM citara-smoke:smoke-a\nUSER root\nRUN rm %s\nUSER node\n' "$broken" | docker build -q -t citara-smoke:smoke-bad - >/dev/null
  if CITARA_HEALTH_TIMEOUT=40 "$S" deploy smoke-bad >/dev/null 2>&1; then fail "una versión sin $broken se dio por buena"; fi
  check "sin $broken, vuelve sola a la anterior" eq "$(api_image)" "citara-smoke:smoke-a"
  check "y la API sigue respondiendo" curl -skf -o /dev/null https://localhost:8443/healthz
  docker image rm citara-smoke:smoke-bad >/dev/null
done

echo "== Una migración que falla"
printf 'FROM citara-smoke:smoke-a\nUSER root\nRUN printf "process.exit(1)\\n" > apps/api/dist/src/cli/migrate.js\nUSER node\n' \
  | docker build -q -t citara-smoke:smoke-badmig - >/dev/null
if "$S" deploy smoke-badmig >/dev/null 2>&1; then fail "un despliegue con la migración rota se dio por bueno"; fi
check "si la migración falla, no cambia de versión" eq "$(api_image)" "citara-smoke:smoke-a"
docker image rm citara-smoke:smoke-badmig >/dev/null

# Tras el último cambio de versión el worker sigue en pie.
check "el worker sigue sin reinicios al final" eq "$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$(CITARA_TAG=x compose ps -q worker)")" "running 0"

printf '\n\033[32m%s comprobaciones en verde\033[0m\n' "$PASS"
