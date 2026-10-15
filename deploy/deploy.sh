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
  # Desacoplados de esta sesión: si se corta el SSH o pulsas Ctrl-C, solo dejas
  # de mirar; la operación termina en el servidor (log en .deploy-last.log).
  rollback) cmd=(detached rollback) ;;
  status) cmd=(status) ;;
  logs) cmd=(logs "${2:-api}") ;;
  ""|-h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
  *) cmd=(detached deploy "$1") ;;
esac
# -t: el progreso se ve en vivo.
exec ssh -t "$CITARA_SSH" "$DIR/deploy/server.sh" "${cmd[@]}"
