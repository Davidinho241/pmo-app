#!/bin/sh
# Sauvegarde complète de la base (à planifier avec cron, voir README).
# Usage : ./scripts/backup.sh [dossier]   (défaut : ./backups)
set -eu
DIR="${1:-./backups}"; mkdir -p "$DIR"
FILE="$DIR/pmo_$(date +%Y%m%d_%H%M%S).sql.gz"
docker compose exec -T db sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --default-character-set=utf8mb4 "$MYSQL_DATABASE"' | gzip > "$FILE"
echo "Sauvegarde créée : $FILE"
# Conserve les 60 dernières sauvegardes
ls -1t "$DIR"/pmo_*.sql.gz 2>/dev/null | tail -n +61 | xargs -r rm --
