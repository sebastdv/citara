#!/usr/bin/env bash
# Corre en TU MÁQUINA: trae a backups/ del repo el respaldo más reciente del servidor.
# Los respaldos viven en el disco del VPS; esta es la copia fuera de él.
#
#   CITARA_SSH=citara@mi-servidor ./deploy/backup-pull.sh
set -euo pipefail
: "${CITARA_SSH:?Define CITARA_SSH=usuario@servidor}"
DIR="${CITARA_DIR:-/opt/citara}"
# En backups/ del repo (ignorado por git), no en la carpeta desde la que lo corras.
dest="$(cd "$(dirname "$0")/.." && pwd)/backups"
latest="$(ssh "$CITARA_SSH" "ls -1t $DIR/backups/*.dump 2>/dev/null | head -n 1")"
[ -n "$latest" ] || { echo "No hay respaldos en $CITARA_SSH:$DIR/backups" >&2; exit 1; }
mkdir -p "$dest" && chmod 700 "$dest"
scp -p "$CITARA_SSH:$latest" "$dest/"
echo "Copiado: $dest/$(basename "$latest"). Contiene datos de clientes: guárdalo cifrado."
