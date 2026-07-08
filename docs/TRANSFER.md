# Moving TaskManager to Another Device

TaskManager is local-first: your workspace lives in a local SQLite database on
each device. To move it, you export a backup file on the old device and restore
it on the new one. There are no accounts and no cloud sync.

## On the old device

1. Open **Settings → Data & backup**.
2. Click **Download JSON** under *Export full backup*.
3. Save the `taskos-backup-<date>.json` file somewhere safe (USB drive, shared
   folder, AirDrop — your choice).

## On the new device

1. Install and run TaskManager (packaged app, or the dev setup in the README).
2. Open **Settings → Data & backup**.
3. Under *Restore from backup*, click **Choose backup file…** and pick the
   backup JSON.
4. Read the overwrite warning, then confirm **Restore & overwrite**.
5. Switch to the **Tasks sheet** and verify your tasks, completions, reading
   books, and archives are all present.

Keep the backup file until you have verified the result.

## What transfers

- All tasks (including finished and hiatus), with status, priority, interval,
  section/category, subtask, notes, active-from / end / manual-last-done dates
- All completion history (per-date counts)
- Per-cell date notes
- Date-cell text overrides (cells converted from checkbox to text)
- Reading books and their page-checkpoint history
- Archive snapshots
- Links written in task/subtask/notes text (they are part of the text fields)

Note: the CSV sheet export remains task-list/completion oriented — date-cell
text overrides are included in JSON backups only.

## What does not transfer

UI preferences are stored in the browser/app localStorage on each device and
are intentionally **not** part of backups:

- dashboard section/card visibility and dismissed suggestions
- grid column widths
- theme choice
- keyboard shortcut overrides
- Quick Jump and task-default settings

Re-set these on the new device if you had customized them.

## Safety notes

- **Restoring overwrites the current workspace** on the device where you
  restore — every task, completion, reading book, note, and archive is
  replaced by the backup's contents.
- Before anything is overwritten, the backend writes a safety copy of the
  current database to `backups/pre-restore-<timestamp>.db` next to the live
  database file.
- If a restore fails partway, the change rolls back and the previous data is
  kept; the error is shown in Settings.
- Backup files are unencrypted local files containing your task data. Store
  and share them accordingly.
