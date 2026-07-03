#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore.sh — Restore taskos.db from a backup .db file.
#
# Validates the backup with PRAGMA integrity_check, makes a safety copy of
# the current DB, then replaces it with the backup.
#
# IMPORTANT: Stop the server before running this script.
#   ./start.sh → Ctrl+C first.
#
# Usage:
#   ./scripts/restore.sh <backup-file.db>
#
#   Example:
#   ./scripts/restore.sh backups/taskos-backup-20260703-142650.db
#
# Honors TASKOS_DB_PATH if set (Tauri packaged mode).
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <backup-file.db>"
  echo ""
  echo "  Example:"
  echo "    $0 backups/taskos-backup-20260703-142650.db"
  echo ""
  echo "Stop the server before running this script."
  exit 1
fi

BACKUP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
DB_PATH="${TASKOS_DB_PATH:-$PROJECT_ROOT/taskos.db}"
DB_DIR="$(dirname "$DB_PATH")"
BACKUP_DIR="$DB_DIR/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SAFETY="$BACKUP_DIR/pre-restore-$TIMESTAMP.db"

if ! command -v sqlite3 &>/dev/null; then
  echo "ERROR: sqlite3 CLI not found. Install SQLite3."
  exit 1
fi

if [ ! -f "$BACKUP" ]; then
  echo "ERROR: Backup file not found: $BACKUP"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Validate the backup before touching anything.
# ---------------------------------------------------------------------------

echo "Validating backup integrity: $BACKUP"
INTEGRITY="$(sqlite3 "$BACKUP" "PRAGMA integrity_check;" 2>&1)"
if [ "$INTEGRITY" != "ok" ]; then
  echo "ERROR: Backup failed integrity check:"
  echo "$INTEGRITY"
  exit 1
fi
echo "  integrity_check: ok"

FK_VIOLATIONS="$(sqlite3 "$BACKUP" "PRAGMA foreign_key_check;" 2>&1)"
if [ -n "$FK_VIOLATIONS" ]; then
  echo "WARNING: Backup has foreign key violations:"
  echo "$FK_VIOLATIONS"
  echo "Proceeding anyway — but review the data after restore."
fi

# ---------------------------------------------------------------------------
# 2. Safety copy of current DB (if it exists).
# ---------------------------------------------------------------------------

if [ -f "$DB_PATH" ]; then
  mkdir -p "$BACKUP_DIR"
  echo "Safety backup: $SAFETY"
  sqlite3 "$DB_PATH" ".backup '$SAFETY'"
  echo "  saved."
fi

# ---------------------------------------------------------------------------
# 3. Restore.
# ---------------------------------------------------------------------------

echo "Restoring from: $BACKUP → $DB_PATH"
cp "$BACKUP" "$DB_PATH"
echo "  done."

echo ""
echo "Run scripts/verify.sh to confirm the restore."
