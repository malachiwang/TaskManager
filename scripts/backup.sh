#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup.sh — Offline SQLite backup for TaskManager.
#
# Uses the SQLite online backup API (safe while the server is running).
# Backup lands in <db-dir>/backups/ with a timestamp suffix.
#
# Usage:
#   ./scripts/backup.sh
#
# Honors TASKOS_DB_PATH if set (Tauri packaged mode).
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_PATH="${TASKOS_DB_PATH:-$PROJECT_ROOT/taskos.db}"
DB_DIR="$(dirname "$DB_PATH")"
BACKUP_DIR="$DB_DIR/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/taskos-backup-$TIMESTAMP.db"

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: Database not found at $DB_PATH"
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "ERROR: sqlite3 CLI not found. Install SQLite3."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# .backup uses the SQLite online backup API — WAL-safe, even with an active server.
sqlite3 "$DB_PATH" ".backup '$DEST'"

echo "Backup saved: $DEST"
echo "Size:         $(du -sh "$DEST" | cut -f1)"
