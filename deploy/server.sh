#!/usr/bin/env bash
# Corre EN EL SERVIDOR (o en la prueba de humo local). Desde tu máquina se usa
# a través de deploy/deploy.sh. Ver docs/produccion.md.
#
#   server.sh deploy <rama|tag|sha>   construye, respalda, migra, cambia de versión y verifica
#   server.sh rollback                vuelve a la versión anterior sin recompilar
#   server.sh backup nightly          respaldo nocturno (lo corre el timer de systemd)
#   server.sh backup pre-deploy       respaldo suelto
#   server.sh restore <archivo>       restaura un respaldo (pide confirmación)
#   server.sh status                  versión desplegada, servicios y últimos respaldos
#   server.sh logs [servicio]         últimos logs y en vivo (api por defecto)
#   server.sh cli <script.js> [args]  la CLI de la app en un contenedor de un solo uso
#
# Compatible con bash 3.2 (macOS) a propósito: la prueba de humo lo corre allí.
set -euo pipefail

# Un checkout cambia este mismo archivo mientras bash lo va leyendo: se
# ejecuta una copia para que el script no cambie bajo los pies.
if [ -z "${CITARA_SELF_COPY:-}" ]; then
  CITARA_ROOT="${CITARA_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
  copy="$(mktemp "${TMPDIR:-/tmp}/citara-server.XXXXXX")"
  cp "$0" "$copy"
  CITARA_SELF_COPY="$copy" CITARA_ROOT="$CITARA_ROOT" exec bash "$copy" "$@"
fi
LOCK_DIR=""
cleanup() { rm -f "$CITARA_SELF_COPY"; [ -n "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

ROOT="$CITARA_ROOT"
ENV_FILE="${CITARA_ENV_FILE:-$ROOT/.env.production}"
PROJECT="${CITARA_PROJECT:-citara}"
OVERRIDE="${CITARA_COMPOSE_OVERRIDE:-}"
BACKUP_DIR="${CITARA_BACKUP_DIR:-$ROOT/backups}"
HISTORY="${CITARA_HISTORY:-$ROOT/.deploy-history}"
HEALTH_TIMEOUT="${CITARA_HEALTH_TIMEOUT:-90}"
KEEP_DAILY=14
KEEP_WEEKLY=8
KEEP_PRE_DEPLOY_DAYS=30
KEEP_IMAGES=5

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

compose() {
  local files=(-f "$ROOT/deploy/compose.yml")
  [ -n "$OVERRIDE" ] && files+=(-f "$OVERRIDE")
  docker compose -p "$PROJECT" "${files[@]}" --env-file "$ENV_FILE" "$@"
}

psql_admin() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "$1"; }

# El historial: una línea por cambio de versión, "<fecha UTC> <deploy|rollback> <tag>".
current_tag() { [ -f "$HISTORY" ] && tail -n 1 "$HISTORY" | awk '{print $3}' || true; }

previous_tag() {
  [ -f "$HISTORY" ] || return 0
  local cur; cur="$(current_tag)"
  awk '{print $3}' "$HISTORY" | grep -vx "$cur" | tail -n 1 || true
}

preflight() {
  [ -f "$ENV_FILE" ] || die "No existe $ENV_FILE (cópialo de .env.production.example)"
  if [ "$(uname)" = "Linux" ] && [ "$(stat -c %a "$ENV_FILE")" != "600" ]; then
    die "$ENV_FILE debe tener permisos 600: chmod 600 $ENV_FILE"
  fi
  local var value
  for var in POSTGRES_PASSWORD APP_DB_PASSWORD; do
    value="$(grep -E "^$var=" "$ENV_FILE" | head -n 1 | cut -d= -f2-)"
    [ -n "$value" ] || die "$var está vacía en $ENV_FILE"
    # Van dentro de URLs de conexión: un @, : o / las rompería.
    printf '%s' "$value" | grep -Eq '^[A-Za-z0-9_-]{24,}$' \
      || die "$var debe tener al menos 24 caracteres y solo letras, números, - y _ (openssl rand -hex 32)"
  done
}

# Espera a que el contenedor del servicio quede healthy; falla si no llega a tiempo.
wait_healthy() {
  local service="$1" waited=0 id status
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    id="$(compose ps -q "$service" 2>/dev/null || true)"
    if [ -n "$id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [ "$status" = "healthy" ] && return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

# El worker no tiene HTTP: cuenta como sano si sigue corriendo, sin reinicios,
# unos segundos después de arrancar (un import que falta lo tumba al instante).
worker_stable() {
  local id state
  sleep "${CITARA_WORKER_SETTLE:-8}"
  id="$(compose ps -q worker 2>/dev/null || true)"
  [ -n "$id" ] || return 1
  state="$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$id" 2>/dev/null || true)"
  [ "$state" = "running 0" ]
}

# Cambia api y worker a la versión dada; es buena si la API responde bien y el worker sigue en pie.
switch_to() {
  local tag="$1"
  CITARA_TAG="$tag" compose up -d --no-deps api worker
  CITARA_TAG="$tag" compose up -d caddy
  CITARA_TAG="$tag" wait_healthy api || { say "La API no respondió bien"; compose logs --tail 30 api >&2 || true; return 1; }
  CITARA_TAG="$tag" worker_stable || { say "El worker no se mantuvo en pie"; compose logs --tail 30 worker >&2 || true; return 1; }
}

# Un despliegue, rollback o restauración a la vez (mkdir es atómico; flock no está en macOS).
lock() {
  LOCK_DIR="$ROOT/.deploy-lock"
  mkdir "$LOCK_DIR" 2>/dev/null || { LOCK_DIR=""; die "Hay otra operación en curso (si no es así, borra $ROOT/.deploy-lock)"; }
}

record() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$HISTORY"; }

prune_images() {
  local keep tag
  # Las últimas versiones distintas del historial, de la más reciente a la más vieja.
  keep="$(awk '{a[NR]=$3} END {for (i = NR; i > 0; i--) if (!seen[a[i]]++) print a[i]}' "$HISTORY" | head -n "$KEEP_IMAGES")"
  for tag in $(docker image ls citara --format '{{.Tag}}'); do
    printf '%s\n' "$keep" | grep -qx "$tag" || docker image rm "citara:$tag" >/dev/null 2>&1 || true
  done
}

# ---------------------------------------------------------------------------
# Respaldos
# ---------------------------------------------------------------------------

# pg_dump en formato custom a un temporal; solo pasa a su nombre final si pg_restore lo puede leer.
dump_to() {
  local name="$1" tmp
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  tmp="$BACKUP_DIR/.$name.partial"
  compose exec -T postgres pg_dump -U postgres -Fc citara > "$tmp"
  compose exec -T postgres pg_restore -l < "$tmp" > /dev/null || { rm -f "$tmp"; die "el respaldo $name salió ilegible"; }
  chmod 600 "$tmp"
  mv "$tmp" "$BACKUP_DIR/$name"
  say "Respaldo: $BACKUP_DIR/$name ($(du -h "$BACKUP_DIR/$name" | cut -f1))"
}

prune_backups() {
  local f
  # Los nombres llevan la fecha en UTC: ordenar el nombre es ordenar en el tiempo.
  for f in $(ls -1 "$BACKUP_DIR"/daily-*.dump 2>/dev/null | sort -r | tail -n +$((KEEP_DAILY + 1))); do rm -f "$f"; done
  for f in $(ls -1 "$BACKUP_DIR"/weekly-*.dump 2>/dev/null | sort -r | tail -n +$((KEEP_WEEKLY + 1))); do rm -f "$f"; done
  find "$BACKUP_DIR" -name 'pre-deploy-*.dump' -mtime +"$KEEP_PRE_DEPLOY_DAYS" -delete 2>/dev/null || true
}

cmd_backup() {
  local kind="${1:-}" stamp
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  export CITARA_TAG="${CITARA_TAG:-$(current_tag)}"
  CITARA_TAG="${CITARA_TAG:-none}"
  case "$kind" in
    nightly)
      dump_to "daily-$stamp.dump"
      # Los domingos, además, uno semanal (copia aparte: se poda por su lado).
      [ "$(date -u +%u)" = "7" ] && cp -p "$BACKUP_DIR/daily-$stamp.dump" "$BACKUP_DIR/weekly-$stamp.dump"
      prune_backups ;;
    pre-deploy)
      dump_to "pre-deploy-$stamp-${2:-manual}.dump" ;;
    *) die "uso: server.sh backup nightly|pre-deploy" ;;
  esac
}

# ---------------------------------------------------------------------------
# Despliegue
# ---------------------------------------------------------------------------

resolve_ref() {
  local ref="$1"
  git -C "$ROOT" fetch --prune --tags origin >/dev/null
  if git -C "$ROOT" rev-parse -q --verify "origin/$ref^{commit}" >/dev/null; then
    git -C "$ROOT" rev-parse --short=12 "origin/$ref^{commit}"
  else
    git -C "$ROOT" rev-parse --short=12 "$ref^{commit}"
  fi
}

cmd_deploy() {
  local ref="${1:-}" tag prev
  [ -n "$ref" ] || die "uso: server.sh deploy <rama|tag|sha>"
  preflight
  lock
  if [ "${CITARA_SKIP_GIT:-0}" = "1" ]; then
    tag="$ref"   # prueba de humo: el árbol actual, con el tag que se le pasa
  else
    tag="$(resolve_ref "$ref")" || die "No existe '$ref' en el repo"
    say "Versión $tag ($ref)"
    git -C "$ROOT" checkout -q --detach "$tag"
  fi
  export CITARA_TAG="$tag"
  prev="$(current_tag)"

  if docker image inspect "citara:$tag" >/dev/null 2>&1; then
    say "La imagen citara:$tag ya existe: no se recompila"
  else
    say "Construyendo citara:$tag"
    docker build -t "citara:$tag" "$ROOT"
  fi

  compose up -d postgres redis
  wait_healthy postgres || die "Postgres no quedó listo"
  wait_healthy redis || die "Redis no quedó listo"

  say "Respaldo antes de migrar"
  dump_to "pre-deploy-$(date -u +%Y%m%d-%H%M%S)-$tag.dump"

  # Si las migraciones fallan, se corta aquí: la versión anterior sigue corriendo.
  say "Migraciones"
  compose run --rm -T cli node apps/api/dist/src/cli/migrate.js || die "Las migraciones fallaron; la versión anterior sigue en servicio"

  say "Cambiando a $tag"
  if switch_to "$tag"; then
    record deploy "$tag"
    prune_images
    say "Desplegada $tag. /healthz responde bien."
    return 0
  fi

  if [ -n "$prev" ] && [ "$prev" != "$tag" ]; then
    say "La API no respondió bien: volviendo a $prev"
    switch_to "$prev" || die "Tampoco respondió $prev. Revisa: server.sh status y docker compose logs"
    die "La versión $tag no arrancó; quedó $prev en servicio"
  fi
  die "La versión $tag no arrancó y no hay una anterior a la que volver"
}

cmd_rollback() {
  local prev
  preflight
  lock
  prev="$(previous_tag)"
  [ -n "$prev" ] || die "No hay una versión anterior en $HISTORY"
  docker image inspect "citara:$prev" >/dev/null 2>&1 || die "La imagen citara:$prev ya no está; despliégala con: server.sh deploy $prev"
  export CITARA_TAG="$prev"
  say "Volviendo a $prev (las migraciones no se revierten)"
  switch_to "$prev" || die "La versión $prev no respondió bien"
  record rollback "$prev"
  say "En servicio: $prev"
}

# ---------------------------------------------------------------------------
# Restauración
# ---------------------------------------------------------------------------

counts() {
  compose exec -T postgres psql -U postgres -d "$1" -Atc \
    "SELECT 'negocios=' || (SELECT count(*) FROM tenants) || ' conversaciones=' || (SELECT count(*) FROM conversations)
         || ' mensajes=' || (SELECT count(*) FROM messages) || ' citas=' || (SELECT count(*) FROM appointments)"
}

cmd_restore() {
  local file="${1:-}" stamp answer
  [ -n "$file" ] && [ -f "$file" ] || die "uso: server.sh restore <archivo.dump>"
  preflight
  lock
  export CITARA_TAG="${CITARA_TAG:-$(current_tag)}"
  [ -n "$CITARA_TAG" ] || die "No hay versión desplegada"
  stamp="$(date -u +%Y%m%d%H%M%S)"

  say "Restaurando $file en una base aparte (citara_restore)"
  psql_admin "DROP DATABASE IF EXISTS citara_restore" >/dev/null
  psql_admin "CREATE DATABASE citara_restore" >/dev/null
  # Los permisos de la BASE (no los de sus tablas) no viajan en un pg_dump. La
  # migración de la Fase 3 le quitó TEMPORARY a la app (cierra el secuestro por
  # pg_temp); una base nueva lo trae de vuelta por defecto.
  psql_admin "REVOKE TEMPORARY ON DATABASE citara_restore FROM PUBLIC, citara_app" >/dev/null
  compose exec -T postgres pg_restore -U postgres -d citara_restore --exit-on-error < "$file"

  echo "  ahora:     $(counts citara)"
  echo "  respaldo:  $(counts citara_restore)"
  echo "La API y el worker se detienen unos segundos. Lo que esté en cola en Redis se descarta"
  echo "(se refiere a la base actual). La base actual queda guardada como citara_prev_$stamp."
  if [ "${CITARA_YES:-}" != "1" ]; then
    printf 'Escribe "restaurar" para continuar: '
    read -r answer
    [ "$answer" = "restaurar" ] || { psql_admin "DROP DATABASE citara_restore" >/dev/null; die "Cancelado"; }
  fi

  compose stop api worker
  psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('citara', 'citara_restore') AND pid <> pg_backend_pid()" >/dev/null
  psql_admin "ALTER DATABASE citara RENAME TO citara_prev_$stamp" >/dev/null
  psql_admin "ALTER DATABASE citara_restore RENAME TO citara" >/dev/null
  compose exec -T redis redis-cli FLUSHALL >/dev/null
  switch_to "$CITARA_TAG" || die "La API no respondió tras restaurar; la base anterior está en citara_prev_$stamp"
  say "Restaurado. Cuando confirmes que todo está bien: server.sh cli-sql \"DROP DATABASE citara_prev_$stamp\""
}

cmd_status() {
  echo "Versión: $(current_tag) (anterior: $(previous_tag))"
  CITARA_TAG="$(current_tag)" compose ps
  echo "Últimos respaldos:"
  ls -1t "$BACKUP_DIR" 2>/dev/null | head -n 5 | sed 's/^/  /'
}

cmd_cli() {
  local script="${1:-}" tty=()
  [ -n "$script" ] || die "uso: server.sh cli <script.js> [args]"
  shift
  export CITARA_TAG="${CITARA_TAG:-$(current_tag)}"
  [ -n "$CITARA_TAG" ] || die "No hay versión desplegada"
  mkdir -p "$ROOT/clientes" "$ROOT/bench-results"
  # Sin terminal (scripts, la prueba de humo) no se pide TTY.
  [ -t 0 ] || tty=(-T)
  compose run --rm "${tty[@]}" cli node "apps/api/dist/src/cli/$script" "$@"
}

# SQL suelto como superusuario (para limpiar tras una restauración, por ejemplo).
cmd_cli_sql() {
  [ -n "${1:-}" ] || die "uso: server.sh cli-sql \"<sql>\""
  export CITARA_TAG="${CITARA_TAG:-$(current_tag)}"
  CITARA_TAG="${CITARA_TAG:-none}"
  psql_admin "$1"
}

case "${1:-}" in
  deploy) shift; cmd_deploy "$@" ;;
  rollback) cmd_rollback ;;
  backup) shift; cmd_backup "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  status) cmd_status ;;
  logs) CITARA_TAG="$(current_tag)"; CITARA_TAG="${CITARA_TAG:-none}" compose logs --tail 100 -f "${2:-api}" ;;
  cli) shift; cmd_cli "$@" ;;
  cli-sql) shift; cmd_cli_sql "$@" ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
