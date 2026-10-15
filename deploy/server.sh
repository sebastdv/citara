#!/usr/bin/env bash
# Corre EN EL SERVIDOR (o en la prueba de humo local). Desde tu máquina se usa
# a través de deploy/deploy.sh. Ver docs/produccion.md.
#
#   server.sh deploy <rama|tag|sha>   construye, respalda, migra, cambia de versión y verifica
#   server.sh rollback                vuelve a la versión anterior sin recompilar
#   server.sh detached <comando…>     lo mismo, desacoplado de la sesión SSH (lo usa deploy.sh)
#   server.sh backup nightly          respaldo nocturno (lo corre el timer de systemd)
#   server.sh backup pre-deploy       respaldo suelto
#   server.sh restore <archivo>       restaura un respaldo (pide confirmación)
#   server.sh status                  versión desplegada, servicios y últimos respaldos
#   server.sh logs [servicio]         últimos logs y en vivo (api por defecto)
#   server.sh cli <script.js> [args]  la CLI de la app en un contenedor de un solo uso
#
# Compatible con bash 3.2 (macOS) a propósito: la prueba de humo lo corre allí.
set -euo pipefail
# bash ≥ 4.4: que set -e también valga dentro de $(…).
shopt -s inherit_errexit 2>/dev/null || true

# Un checkout cambia este mismo archivo mientras bash lo va leyendo: se
# ejecuta una copia para que el script no cambie bajo los pies.
if [ -z "${CITARA_SELF_COPY:-}" ]; then
  CITARA_ROOT="${CITARA_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
  copy="$(mktemp "${TMPDIR:-/tmp}/citara-server.XXXXXX")"
  cp "$0" "$copy"
  CITARA_SELF_COPY="$copy" CITARA_ROOT="$CITARA_ROOT" exec bash "$copy" "$@"
fi

ROOT="$CITARA_ROOT"
ENV_FILE="${CITARA_ENV_FILE:-$ROOT/.env.production}"
PROJECT="${CITARA_PROJECT:-citara}"
OVERRIDE="${CITARA_COMPOSE_OVERRIDE:-}"
BACKUP_DIR="${CITARA_BACKUP_DIR:-$ROOT/backups}"
# El compose monta esta carpeta en la API (solo lectura) para la pantalla de estado.
export CITARA_BACKUP_DIR="$BACKUP_DIR"
HISTORY="${CITARA_HISTORY:-$ROOT/.deploy-history}"
HEALTH_TIMEOUT="${CITARA_HEALTH_TIMEOUT:-90}"
LOCK_WAIT="${CITARA_LOCK_WAIT:-1800}"
KEEP_DAILY=14
KEEP_WEEKLY=8
KEEP_PRE_DEPLOY_DAYS=30
KEEP_IMAGES=5

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Lo que hay que deshacer si el comando sale con error (ver cleanup).
LOCK_DIR=""
RESTORE_CHECKOUT=""   # commit al que volver si un despliegue o rollback falla
RECOVER_RESTORE=""    # 1 mientras la restauración tiene la app detenida

cleanup() {
  local status=$?
  if [ "$status" != "0" ]; then
    if [ -n "$RESTORE_CHECKOUT" ]; then
      # Si no, el compose y el Caddyfile del commit fallido quedarían para el
      # respaldo nocturno, el rollback y todo lo demás.
      git -C "$ROOT" checkout -q --detach "$RESTORE_CHECKOUT" 2>/dev/null \
        && say "El checkout volvió a ${RESTORE_CHECKOUT:0:12}"
    fi
    if [ "$RECOVER_RESTORE" = "1" ]; then
      say "La restauración no terminó: se vuelve a levantar la app"
      psql_admin "ALTER DATABASE citara WITH ALLOW_CONNECTIONS true" >/dev/null 2>&1 || true
      compose up -d --no-deps api worker >/dev/null 2>&1 || true
      psql_admin "SELECT datname FROM pg_database WHERE datname LIKE 'citara%'" 2>/dev/null | sed 's/^/  base: /' >&2 || true
    fi
  fi
  rm -f "$CITARA_SELF_COPY"
  [ -n "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

compose() {
  # Si no existiera, Docker crearía la carpeta del montaje como root.
  mkdir -p "$BACKUP_DIR"
  local files=(-f "$ROOT/deploy/compose.yml")
  [ -n "$OVERRIDE" ] && files+=(-f "$OVERRIDE")
  docker compose -p "$PROJECT" "${files[@]}" --env-file "$ENV_FILE" "$@"
}

psql_admin() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "$1"; }

# El historial: una línea por cambio de versión, "<fecha UTC> <deploy|rollback> <tag>".
history_tag() { [ -f "$HISTORY" ] && tail -n 1 "$HISTORY" | awk '{print $3}' || true; }

# La versión que corre DE VERDAD (la imagen del contenedor de la API); si no
# hay contenedor, la última del historial. Un despliegue cortado a la mitad
# puede haber dejado corriendo una versión que el historial no registró.
current_tag() {
  local id image
  id="$(CITARA_TAG=none compose ps -q api 2>/dev/null || true)"
  image="$([ -n "$id" ] && docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null || true)"
  case "$image" in citara:*) echo "${image#citara:}" ;; *) history_tag ;; esac
}

previous_tag() {
  [ -f "$HISTORY" ] || return 0
  local cur; cur="$(current_tag)"
  awk '{print $3}' "$HISTORY" | grep -Fvx "$cur" | tail -n 1 || true
}

preflight() {
  [ -f "$ENV_FILE" ] || die "No existe $ENV_FILE (cópialo de .env.production.example)"
  if [ "$(uname)" = "Linux" ] && [ "$(stat -c %a "$ENV_FILE")" != "600" ]; then
    die "$ENV_FILE debe tener permisos 600: chmod 600 $ENV_FILE"
  fi
  local var value
  for var in POSTGRES_PASSWORD APP_DB_PASSWORD; do
    value="$(grep -E "^$var=" "$ENV_FILE" | head -n 1 | cut -d= -f2- || true)"
    [ -n "$value" ] || die "$var está vacía o falta en $ENV_FILE"
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

# Una operación a la vez: despliegue, rollback, restauración o respaldo (mkdir
# es atómico; flock no está en macOS). Con espera, para el respaldo nocturno:
# si coincide con un despliegue, lo espera en vez de saltarse la noche.
lock() {
  local wait="${1:-0}" waited=0
  while ! mkdir "$ROOT/.deploy-lock" 2>/dev/null; do
    [ "$waited" -lt "$wait" ] || die "Hay otra operación en curso (si no es así, borra $ROOT/.deploy-lock)"
    sleep 5; waited=$((waited + 5))
  done
  LOCK_DIR="$ROOT/.deploy-lock"
}

record() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$HISTORY"; }

prune_images() {
  local keep tag
  # Las últimas versiones distintas del historial, de la más reciente a la más vieja.
  keep="$(awk '{a[NR]=$3} END {for (i = NR; i > 0; i--) if (!seen[a[i]]++) print a[i]}' "$HISTORY" | head -n "$KEEP_IMAGES")"
  for tag in $(docker image ls citara --format '{{.Tag}}'); do
    printf '%s\n' "$keep" | grep -Fqx "$tag" || docker image rm "citara:$tag" >/dev/null 2>&1 || true
  done
}

# ---------------------------------------------------------------------------
# Respaldos
# ---------------------------------------------------------------------------

# pg_dump en formato custom a un temporal; solo pasa a su nombre final si se
# puede leer ENTERO (pg_restore a /dev/null recorre todos los datos, no solo el índice).
dump_to() {
  local name="$1" tmp
  # 755: la API (otro uid, en solo lectura) lista nombres y fechas para el panel;
  # cada .dump queda en 600, así que su contenido sigue siendo solo de este usuario.
  mkdir -p "$BACKUP_DIR"; chmod 755 "$BACKUP_DIR"
  tmp="$BACKUP_DIR/.$name.partial"
  compose exec -T postgres pg_dump -U postgres -Fc citara > "$tmp" || { rm -f "$tmp"; die "pg_dump falló ($name)"; }
  compose exec -T postgres pg_restore -f /dev/null < "$tmp" || { rm -f "$tmp"; die "el respaldo $name salió ilegible"; }
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
      lock "$LOCK_WAIT"
      dump_to "daily-$stamp.dump"
      # Los domingos, además, uno semanal (copia aparte: se poda por su lado).
      if [ "$(date -u +%u)" = "7" ]; then cp -p "$BACKUP_DIR/daily-$stamp.dump" "$BACKUP_DIR/weekly-$stamp.dump"; fi
      prune_backups ;;
    pre-deploy)
      lock "$LOCK_WAIT"
      dump_to "pre-deploy-$stamp-${2:-manual}.dump" ;;
    *) die "uso: server.sh backup nightly|pre-deploy" ;;
  esac
}

# ---------------------------------------------------------------------------
# Despliegue
# ---------------------------------------------------------------------------

resolve_ref() {
  local ref="$1"
  # Sin fetch se desplegaría la última origin/<rama> descargada, en silencio.
  git -C "$ROOT" fetch --prune --tags origin >/dev/null || { echo "git fetch falló" >&2; return 1; }
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
  prev="$(current_tag)"
  if [ "${CITARA_SKIP_GIT:-0}" = "1" ]; then
    tag="$ref"   # prueba de humo: el árbol actual, con el tag que se le pasa
  else
    tag="$(resolve_ref "$ref")" || die "No se pudo resolver '$ref' (¿hay red hacia GitHub? ¿existe la rama o el sha?)"
    say "Versión $tag ($ref)"
    RESTORE_CHECKOUT="$(git -C "$ROOT" rev-parse HEAD)"
    git -C "$ROOT" checkout -q --detach "$tag"
  fi
  export CITARA_TAG="$tag"

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
    RESTORE_CHECKOUT=""
    prune_images
    say "Desplegada $tag. /healthz responde bien."
    return 0
  fi

  if [ -n "$prev" ] && [ "$prev" != "$tag" ] && docker image inspect "citara:$prev" >/dev/null 2>&1; then
    say "Volviendo a $prev"
    # Con el compose de SU versión, no con el del commit que falló.
    if [ -n "$RESTORE_CHECKOUT" ]; then git -C "$ROOT" checkout -q --detach "$RESTORE_CHECKOUT"; fi
    switch_to "$prev" || die "Tampoco respondió $prev. Revisa: server.sh status y server.sh logs"
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
  if [ "${CITARA_SKIP_GIT:-0}" != "1" ]; then
    # El compose y el Caddyfile de esa versión, no los de la que se abandona.
    RESTORE_CHECKOUT="$(git -C "$ROOT" rev-parse HEAD)"
    git -C "$ROOT" checkout -q --detach "$prev"
  fi
  export CITARA_TAG="$prev"
  say "Volviendo a $prev (las migraciones no se revierten)"
  switch_to "$prev" || die "La versión $prev no respondió bien"
  record rollback "$prev"
  RESTORE_CHECKOUT=""
  say "En servicio: $prev"
}

# Corre otro comando de server.sh en su propia sesión, con salida a
# .deploy-last.log, y la muestra en vivo. Si se corta el SSH o pulsas Ctrl-C,
# solo se deja de mirar: la operación sigue en el servidor.
cmd_detached() {
  [ -n "${1:-}" ] || die "uso: server.sh detached <deploy|rollback> …"
  command -v setsid >/dev/null || die "setsid no está disponible (¿no es Linux?)"
  local log="$ROOT/.deploy-last.log" pid tailer code
  : > "$log"
  # env -u: el hijo debe hacer su propia copia de server.sh (ver arriba).
  env -u CITARA_SELF_COPY LOG="$log" setsid bash -c \
    '"$0" "$@" >> "$LOG" 2>&1 < /dev/null; echo "__EXIT $?" >> "$LOG"' "$ROOT/deploy/server.sh" "$@" &
  pid=$!
  trap 'echo; say "Dejaste de mirar; sigue en el servidor. Log: $log"; kill "$tailer" 2>/dev/null; exit 130' INT
  tail -n +1 -f "$log" & tailer=$!
  while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  sleep 1; kill "$tailer" 2>/dev/null || true
  code="$(grep '^__EXIT ' "$log" | tail -n 1 | awk '{print $2}')"
  exit "${code:-1}"
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
  compose exec -T postgres pg_restore -U postgres -d citara_restore --exit-on-error < "$file" \
    || { psql_admin "DROP DATABASE citara_restore" >/dev/null || true; die "El respaldo no se pudo restaurar; la base actual no se tocó"; }

  echo "  ahora:     $(counts citara)"
  echo "  respaldo:  $(counts citara_restore)"
  echo "La API y el worker se detienen unos segundos. Lo que esté en cola en Redis se descarta"
  echo "(se refiere a la base actual). La base actual queda guardada como citara_prev_$stamp."
  if [ "${CITARA_YES:-}" != "1" ]; then
    printf 'Escribe "restaurar" para continuar: '
    read -r answer || answer=""
    [ "$answer" = "restaurar" ] || { psql_admin "DROP DATABASE citara_restore" >/dev/null; die "Cancelado"; }
  fi

  RECOVER_RESTORE=1
  compose stop api worker
  # Nadie puede volver a entrar mientras se cambia de base (un `citara …` en curso, el respaldo).
  psql_admin "ALTER DATABASE citara WITH ALLOW_CONNECTIONS false" >/dev/null
  psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('citara', 'citara_restore') AND pid <> pg_backend_pid()" >/dev/null
  # Las dos en una sola transacción: o cambian las dos o ninguna.
  psql_admin "ALTER DATABASE citara RENAME TO citara_prev_$stamp; ALTER DATABASE citara_restore RENAME TO citara;" >/dev/null
  compose exec -T redis redis-cli FLUSHALL >/dev/null
  # El respaldo puede ser de antes de la última migración: se pone al día con el código que corre.
  say "Migraciones sobre la base restaurada"
  compose run --rm -T cli node apps/api/dist/src/cli/migrate.js
  switch_to "$CITARA_TAG" || die "La API no respondió tras restaurar; la base anterior está en citara_prev_$stamp"
  RECOVER_RESTORE=""
  say "Restaurado. Cuando confirmes que todo está bien: server.sh cli-sql \"DROP DATABASE citara_prev_$stamp\""
}

cmd_status() {
  local cur last age
  cur="$(current_tag)"
  echo "Versión: ${cur:-ninguna} (anterior: $(previous_tag))"
  CITARA_TAG="${cur:-none}" compose ps
  echo "Últimos respaldos:"
  ls -1t "$BACKUP_DIR" 2>/dev/null | head -n 5 | sed 's/^/  /'
  # Los respaldos viven solo aquí: que se note si el nocturno dejó de correr.
  last="$(ls -1t "$BACKUP_DIR"/daily-*.dump 2>/dev/null | head -n 1 || true)"
  if [ -z "$last" ]; then
    echo "AVISO: no hay ningún respaldo nocturno (¿está activo citara-backup.timer?)"
  else
    age=$(( ($(date +%s) - $(stat -c %Y "$last" 2>/dev/null || stat -f %m "$last")) / 3600 ))
    [ "$age" -lt 26 ] || echo "AVISO: el último respaldo nocturno tiene $age horas: journalctl -u citara-backup"
  fi
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
  # ${tty[@]+…}: en bash < 4.4, un arreglo vacío con set -u es "unbound variable".
  compose run --rm ${tty[@]+"${tty[@]}"} cli node "apps/api/dist/src/cli/$script" "$@"
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
  detached) shift; cmd_detached "$@" ;;
  backup) shift; cmd_backup "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  status) cmd_status ;;
  logs) CITARA_TAG="$(current_tag)"; CITARA_TAG="${CITARA_TAG:-none}" compose logs --tail 100 -f "${2:-api}" ;;
  cli) shift; cmd_cli "$@" ;;
  cli-sql) shift; cmd_cli_sql "$@" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
