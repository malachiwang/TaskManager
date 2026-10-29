# TM-SIMPLIFY-01 implementation and verification

Implemented in the existing React/Vite and FastAPI app. No dependencies were added. No commit, push, public deployment, or release packaging was performed. The starting working tree was clean.

## Navigation and reporting

- Top-level pages are Main, Reports, and Settings.
- Main has Grid, Reading, and Calendar tabs at the top. Grid is the initial view. Main remembers its last subview while visiting other pages.
- Removed bottom worksheet tabs and separate Dashboard and Archive page navigation.
- Grid month, Calendar anchor date/view mode, and Reports period/view survive normal page navigation.
- Reports extends the existing report switcher to Today / History / Execution. Today embeds the former Dashboard's current-pressure, recommendation, hygiene, section-pressure, and semester signals without its duplicate page header. History and Execution preserve the existing reporting components. Period controls appear only where relevant.
- Schedule-from-Grid now opens Main > Calendar.

## Grid, history, and search

- Removed Archive Sheet, main-page CSV export, Filters, secondary filters, and saved Views controls.
- Preserved All / Active / Hiatus / Finished, grouping, ordering, row editing, and the existing task editor.
- Edit Task is beside Add Task. It uses the selected date-cell or metadata-cell task. Without selection it is disabled with visible selection guidance.
- Removed obsolete saved-view code and clear its localStorage key on startup. Grouping preferences remain independent.
- Added one header workspace search for task names, subtasks, categories, sections, notes, dated cell notes, text-cell contents, reading titles/authors/notes/purchase notes, reading checkpoint notes, and retained historical snapshot content.
- Navigation search includes Main, Grid, Reading, Calendar, Reports, and Settings.
- Results clear status restrictions, navigate to their month or reading view, and select/reveal the matched content. Finished tasks open in their finish month; dated notes/text cells open their own month. Saved-version results open the read-only saved version.
- Search supports arrow selection, Enter, Escape, clearing, loading/errors, and no-results feedback. Stale requests are aborted. Local Grid and Reading toolbar search fields were removed.
- Search does not consult saved views. Grid loads reject stale month responses.

Historical data was inspected before removing the Archive page. Normal month navigation reads canonical tasks plus dated completions, cell notes, text overrides, and hiatus intervals. `archive_snapshots` is separate frozen JSON: it can contain old names, metadata, counts, and notes that no longer exist in the live view. `task_daily_snapshots` is a third, separate source for pressure reporting.

The Grid's History selector offers saved versions overlapping the displayed month. It is present only when relevant saved versions exist. These views retain saved task metadata, urgency/days/last-done values, completion counts, and notes, with selection highlighting. They are read only. Creating, renaming, and deleting snapshots is no longer exposed in the UI. Legacy snapshot tables, records, read endpoints, and backup payloads remain intact.

Existing hidden reading records remain available through All/Hidden, search, and reactivation. The UI no longer creates new reading archives. CSV import was extracted from the old Archive page and retained under Settings so removing that page did not silently remove importing.

## Settings and shortcuts

- One Export… control expands Full backup (JSON) and Spreadsheet (CSV).
- CSV uses the selected Grid month and is explicitly described as a spreadsheet, not a full backup.
- Restore remains adjacent, requires its existing overwrite confirmation, and keeps the automatic pre-restore safety copy.
- Removed Storage & privacy, local/offline and local/SQLite badges, its reference block, redundant implementation descriptions, and the specified hiatus-history phrase.
- All 34 listed keyboard actions now have Change controls using the existing `taskos-keybinds` preferences and registry. This includes Escape/clear, arrows, four range directions, ten jump digits, increment/decrement, Delete/Backspace alternatives, reading checkpoint/delete/edit/new, workspace search, help, and focus movement.
- Keyboard help is generated from the same registry and reflects overrides. Conflicts are checked across overlapping contexts; individual reset also detects collisions. Reset all restores defaults.
- Shortcut capture permits named keys and modifier combinations. Cancel recording is an explicit button, allowing Escape itself to be recorded.
- Existing input editing and native Escape dismissal remain available. Printable remapped app keys do not close a modal or navigate while typing. Mouse gestures remain separate, informational controls.
- Desktop styling is retained. Narrow layouts wrap navigation/settings controls and allow horizontal grid scrolling past metadata columns to reach date cells.

## Persistence impact

No SQLite schema migration, table removal, urgency change, or completion/date-guard change was made. Search is a read-only endpoint. UI state stays in React/local preferences.

Inspection found that the previous JSON backup omitted Calendar and newer task metadata. Full backup now uses format version 7 and includes all 23 workspace tables, including tasks and newer columns, ordering, contexts, sessions, recurrence/skips, depth windows/templates/skips, external calendars/events/links, academic import records, reading, completions, notes, text cells, hiatus, and both snapshot families.

Restore accepts versions 1–7. Version 7 uses an explicit table allowlist, validates columns, restores in dependency order in one transaction, and checks foreign keys. Invalid inserts roll back. The legacy restore path remains available; newer tables absent from legacy formats are cleared during replacement so stale references are not left behind. Safety-copy filenames now include microseconds to avoid same-second collisions.

Version 7 files require the updated app to restore. Existing version 1–6 files remain supported. UI preferences remain local and are not included in the JSON data backup.

## Changed files

| File(s) | Change |
|---|---|
| `backend/main.py` | Workspace search; complete version-7 backup/export/restore; legacy compatibility and safety-copy handling. |
| `frontend/src/App.jsx` | Navigation, retained view state, search routing, obsolete preference cleanup. |
| `frontend/src/navigation.js` (new) | Searchable destinations and keyboard result-index helper. |
| `frontend/src/api.js` | Removed unused frontend snapshot mutation helpers; retained read compatibility. |
| `frontend/src/components/WorkspaceSearch.jsx` (new) | Header search and keyboard interaction. |
| `frontend/src/components/MonthHistory.jsx` (new) | Read-only saved monthly-version compatibility. |
| `frontend/src/components/TaskGrid.jsx` | Toolbar/filter simplification, Edit Task, month retention, search reveal, shortcut handlers, stale-response guard. |
| `frontend/src/components/ReadingSheet.jsx` | Search targets, checkpoint highlighting, removal of local search/archive creation, configurable handlers. |
| `frontend/src/components/ReadingBookModal.jsx` | Preserve hidden legacy statuses without offering new archive creation; concise copy. |
| `frontend/src/components/CalendarView.jsx` | Retained date/view and shared configurable dismissal. |
| `frontend/src/components/MonthlyReport.jsx` | Unified Today / History / Execution and retained period. |
| `frontend/src/components/Dashboard.jsx` | Embed existing useful content without duplicate header. |
| `frontend/src/components/Settings.jsx` | Combined export, import placement, concise copy, configurable shortcuts/conflicts/reset. |
| `frontend/src/components/CsvImport.jsx` (new) | Existing import preview/apply flow extracted from Archive. |
| `frontend/src/components/DateCell.jsx`, `EditBar.jsx` | Removed the specified hiatus-history wording. |
| `frontend/src/keybinds.js` | Editable action registry, matching, conflict scopes, dynamic help, input guards. |
| `frontend/src/index.css` | Search dropdown, Main tabs, history selection, responsive controls. |
| `frontend/src/components/Archive.jsx`, `FilterMenu.jsx`, `SavedViewsControl.jsx`, `frontend/src/savedViews.js` (deleted) | Retired UI and saved-view persistence code. |
| `frontend/tests/simplify.test.mjs` (new) | Navigation, binding persistence, conflicts, matching, help, typing guards. |
| `frontend/tests/simplify.browser.mjs` (new) | Repeatable headless browser behavior checks against disposable fixtures. |
| `tests/test_simplify.py` (new) | Historical search, snapshot preservation, all-table backup round trip, legacy restore, rollback. |
| `tests/test_api.py`, `tests/test_hiatus.py`, `tests/test_reading.py` | Update expected current backup version from 6 to 7. |
| `docs/TM-SIMPLIFY-01.md` (new) | This report. |

## Checks actually run

- `npm --prefix frontend run build`: passed. Vite retains its warning about a JavaScript chunk exceeding 500 kB; no dependency or bundling overhaul was introduced.
- `node --test frontend/tests/simplify.test.mjs`: 4 passed. One test iterates every action to verify saved overrides, reloading, matching, and help labels.
- `.venv/bin/python -m pytest tests/test_simplify.py -q`: 10 passed.
- `.venv/bin/python -m pytest -q`: 721 passed, 21 failed, 32 deprecation warnings.
- The same full pytest command on an untouched `git archive HEAD` copy: 711 passed, the same 21 failures, the same 32 warnings. These failures are in external-calendar/context/V5 fixtures with August 2026 dates and the existing time-relative sync horizon; they are outside this ticket and were not modified.
- `node frontend/tests/simplify.browser.mjs <installed-playwright-module>`: passed against dedicated local ports and `/tmp/tm-simplify-ui/workspace.db`, using a fresh browser profile. No dependency installation was needed.
- `bash scripts/verify.sh /tmp/tm-simplify-ui/workspace.db`: integrity check passed; no foreign-key violations.
- `git diff --check`: passed.

The browser regression exercised navigation, removed controls, old saved-view cleanup, status-filter clearing, Add/Edit editors, historical month retention, snapshot access, reading book/checkpoint search, empty results, Escape/arrow/Enter interactions, export choices, all 34 Change controls, representative actual remapped handlers, reload persistence, text/modal guards, and reset. Rebound increment/decrement and text-cell conversion issued real writes to the disposable database and checked the resulting counts. Desktop and 390-pixel layouts were captured and visually inspected; narrow grid date cells were checked as reachable by horizontal scrolling. The final run reported no browser runtime errors.

The full backup test populates every workspace table, exports it, adds a disposable extra task, restores, compares every table's rows, confirms the extra task remains in the automatic safety copy, and checks SQLite integrity/foreign keys. Separate tests restore versions 1–6 and confirm saved historical names/counts/notes and reading progress survive. Invalid version-7 references are rejected without partial data replacement.

## Verification limits

- No restore was run against the user's live database; no personal data was used. Historical verification used synthetic prior-month records and disposable SQLite files, not a claim that every personal month was manually inspected.
- Browser checks were automated in headless Chromium, with screenshots reviewed. Native Tauri/macOS interaction, Safari/WebKit, exhaustive manual keyboard use, and OS-reserved shortcut combinations were not tested.
- Every binding was tested through persistence/resolution/help and counted in Settings; representative handlers were exercised end to end, not every possible key combination for every action.
- The 21 existing external-calendar test failures remain. Native release build/package verification was intentionally not performed.
- Workspace search returns at most 100 content matches by default; more specific queries narrow broad result sets. Existing Calendar-specific search remains within Calendar for sessions/events.
