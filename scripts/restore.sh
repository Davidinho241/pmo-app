#!/bin/sh
# Restaure une sauvegarde : ./scripts/restore.sh backups/pmo_AAAAMMJJ_HHMMSS.sql.gz
# ATTENTION : remplace le contenu actuel de la base.
set -eu
[ $# -eq 1 ] || { echo "Usage : $0 fichier.sql.gz"; exit 1; }
printf "Remplacer la base actuelle par %s ? (oui/non) " "$1"; read -r R; [ "$R" = "oui" ] || exit 1
gunzip -c "$1" | docker compose exec -T db sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE"'
echo "Restauration terminée. Redémarrez l'application : docker compose restart app"
