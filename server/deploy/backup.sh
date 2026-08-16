#!/usr/bin/env bash
# Daily SQLite backup with rotation (keep 14). Cron: 0 3 * * *  /opt/childtrack/server/deploy/backup.sh
set -euo pipefail

DB="${DB_PATH:-/opt/childtrack/server/data/childtrack.db}"
DEST="${BACKUP_DIR:-/var/backups/childtrack}"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$DEST"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/childtrack-$TS.db"

# Online consistent copy
sqlite3 "$DB" ".backup '$OUT'"
gzip -9 "$OUT"

# Optional off-site copy via rclone (uncomment + configure remote):
# rclone copy "$OUT.gz" "remote:childtrack-backups/" --quiet

# Rotate
ls -1t "$DEST"/childtrack-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "Backup OK: $OUT.gz"
