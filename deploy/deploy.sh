#!/usr/bin/env bash
# Corre en TU MÁQUINA: entra por SSH al servidor y ejecuta deploy/server.sh.
#
#   CITARA_SSH=citara@mi-servidor ./deploy/deploy.sh main        despliega la punta de main
#   CITARA_SSH=citara@mi-servidor ./deploy/deploy.sh <sha|tag>   despliega esa versión
#   CITARA_SSH=citara@mi-servidor ./deploy/deploy.sh rollback    vuelve a la anterior
#   CITARA_SSH=citara@mi-servidor ./deploy/deploy.sh status
#   CITARA_SSH=citara@mi-servidor ./deploy/deploy.sh logs [api|worker|caddy|postgres|redis]
#
# CITARA_SSH puede ir en tu ~/.zshrc. CITARA_DIR cambia la carpeta del servidor
# (por defecto /opt/citara).
set -euo pipefail
: "${CITARA_SSH:?Define CITARA_SSH=usuario@servidor}"
DIR="${CITARA_DIR:-/opt/citara}"
case "${1:-}" in
  rollback|status) cmd=("$1") ;;
  logs) cmd=(logs "${2:-api}") ;;
  ""|-h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
  *) cmd=(deploy "$1") ;;
esac
# -t: el despliegue muestra el progreso en vivo y Ctrl-C llega al servidor.
exec ssh -t "$CITARA_SSH" "$DIR/deploy/server.sh" "${cmd[@]}"
