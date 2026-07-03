#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify.sh — Verify taskos.db integrity and report table row counts.
#
# Safe to run at any time, including while the server is running.
#
# Usage:
#   ./scripts/verify.sh [db-file]
#
#   Default db-file: $TASKOS_DB_PATH or <project-root>/taskos.db
#   Pass a backup file as argument to verify a specific file:
#     ./scripts/verify.sh backups/taskos-backup-20260703-142650.db
#
# Exits 1 if integrity_check fails.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -n "${1:-}" ]; then
  DB_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  DB_PATH="${TASKOS_DB_PATH:-$PROJECT_ROOT/taskos.db}"
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "ERROR: sqlite3 CLI not found. Install SQLite3."
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: Database not found at $DB_PATH"
  exit 1
fi

echo "=== TaskManagementOS DB Verification ==="
echo ""
echo "DB path:  $DB_PATH"
echo "Size:     $(du -sh "$DB_PATH" | cut -f1)"
echo "Modified: $(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$DB_PATH" 2>/dev/null || stat -c '%y' "$DB_PATH" 2>/dev/null || echo 'n/a')"
echo ""

# ---------------------------------------------------------------------------
# 1. Integrity check
# ---------------------------------------------------------------------------

echo "--- integrity_check ---"
INTEGRITY="$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;")"
echo "$INTEGRITY"
if [ "$INTEGRITY" != "ok" ]; then
  echo ""
  echo "FAIL: integrity_check returned non-ok. DB may be corrupt."
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 2. Foreign key check
# ---------------------------------------------------------------------------

echo "--- foreign_key_check ---"
FK="$(sqlite3 "$DB_PATH" "PRAGMA foreign_key_check;" 2>&1)"
if [ -z "$FK" ]; then
  echo "ok (no violations)"
else
  echo "$FK"
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Row counts
# ---------------------------------------------------------------------------

EXPECTED_TABLES="tasks completions cell_notes archive_snapshots task_daily_snapshots"

echo "--- row counts ---"
MISSING=0
for table in $EXPECTED_TABLES; do
  COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "MISSING")
  if [ "$COUNT" = "MISSING" ]; then
    MISSING=1
  fi
  printf "  %-30s %s\n" "$table" "$COUNT"
done
echo ""

if [ "$MISSING" -eq 1 ]; then
  echo "WARNING: One or more expected tables are missing."
fi

# ---------------------------------------------------------------------------
# 4. Tables present
# ---------------------------------------------------------------------------

echo "--- tables in DB ---"
sqlite3 "$DB_PATH" ".tables"
echo ""

echo "=== PASS ==="
