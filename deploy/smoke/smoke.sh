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
export CITARA_COMPOSE_OVERRIDE="$ROOT/deploy/smoke/compose.override.yml"
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

teardown() {
  local status=$?
  if [ "$status" != "0" ] && [ "${SMOKE_KEEP:-}" = "1" ]; then
    echo "SMOKE_KEEP=1: queda en pie. Variables: $WORK/env. Bórralo con: docker compose -p citara-smoke down -v" >&2
    return
  fi
  CITARA_TAG=x compose --profile cli down -v --remove-orphans >/dev/null 2>&1 || true
  for t in smoke-a smoke-b smoke-bad; do docker image rm "citara:$t" >/dev/null 2>&1 || true; done
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
check "la API corre citara:smoke-a" eq "$(api_image)" "citara:smoke-a"
check "el worker corre sin reinicios" eq "$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$(CITARA_TAG=x compose ps -q worker)")" "running 0"

check "/healthz responde por Caddy con TLS" sh -c "curl -skf https://localhost:8443/healthz | grep -q '\"status\":\"ok\"'"
check "el panel responde por Caddy" eq "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:8443/panel/login)" "200"
check "http redirige a https" eq "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/healthz)" "308"
published() { docker port "$(CITARA_TAG=x compose ps -q "$1")"; }
for svc in postgres redis api worker; do
  [ -z "$(published "$svc")" ] || fail "$svc publica puertos: $(published "$svc")"
done
caddy_publishes_443() { published caddy | grep -q 443; }
check "solo Caddy publica puertos" caddy_publishes_443

out="$("$S" cli migrate.js)"
check "migrar otra vez no hace nada" grep -q "Sin migraciones pendientes" <<<"$out"
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
check "el respaldo queda con permisos 600" eq "$(stat -f %Lp "$dump" 2>/dev/null || stat -c %a "$dump")" "600"
"$S" cli tenant-cli.js create dos "Negocio Dos" >/dev/null
[ "$(sql 'select count(*) from tenants')" = "2" ] || fail "no se creó el segundo negocio"
"$S" restore "$dump" >/dev/null
check "restaurar deja la base como en el respaldo" eq "$(sql "select string_agg(slug, ',') from tenants")" "uno"
check "la API vuelve a responder tras restaurar" curl -skf -o /dev/null https://localhost:8443/healthz
check "la base anterior queda guardada" test -n "$(sql "select datname from pg_database where datname like 'citara_prev_%'")"
check "la base restaurada sigue sin TEMPORARY para la app" eq "$(sql "select has_database_privilege('citara_app', 'citara', 'TEMPORARY')")" "f"

echo "== Respaldo nocturno y poda"
for i in $(seq -w 1 16); do : > "$CITARA_BACKUP_DIR/daily-202601${i}-000000.dump"; done
"$S" backup nightly >/dev/null
check "se quedan 14 respaldos diarios" eq "$(ls -1 "$CITARA_BACKUP_DIR"/daily-*.dump | wc -l | tr -d ' ')" "14"

echo "== Nueva versión y rollback"
docker tag citara:smoke-a citara:smoke-b
"$S" deploy smoke-b >/dev/null
check "despliega smoke-b sin recompilar" eq "$(api_image)" "citara:smoke-b"
"$S" rollback >/dev/null
check "rollback vuelve a smoke-a" eq "$(api_image)" "citara:smoke-a"

echo "== Versiones que no arrancan"
# Una con la API rota y otra con el worker roto: las dos deben volver solas a la anterior.
for broken in apps/api/dist/src/main.js apps/worker/dist/src/main.js; do
  printf 'FROM citara:smoke-a\nRUN rm %s\n' "$broken" | docker build -q -t citara:smoke-bad - >/dev/null
  if CITARA_HEALTH_TIMEOUT=40 "$S" deploy smoke-bad >/dev/null 2>&1; then fail "una versión sin $broken se dio por buena"; fi
  check "sin $broken, vuelve sola a la anterior" eq "$(api_image)" "citara:smoke-a"
  check "y la API sigue respondiendo" curl -skf -o /dev/null https://localhost:8443/healthz
  docker image rm citara:smoke-bad >/dev/null
done

# Al final, varios minutos después del primer despliegue: el worker no se cayó en ningún momento.
check "el worker sigue sin reinicios al final" eq "$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$(CITARA_TAG=x compose ps -q worker)")" "running 0"

printf '\n\033[32m%s comprobaciones en verde\033[0m\n' "$PASS"
