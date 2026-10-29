# TM-SIMPLIFY-02: navigation and interface correction

This supersedes the separate Main subtab row described in TM-SIMPLIFY-01. The remediation is left uncommitted for review. No dependencies, backend code, schema, backup format, restore compatibility, urgency formulas, or completion semantics changed.

## Checkpoint

The repository was clean on entry. `main` already contained checkpoint `37c60e50a0295c484686ba951fa6d25d8b61c09c`, **Simplify TaskManager navigation and controls**. `git ls-remote origin refs/heads/main` confirmed that same commit on `origin` (`git@github.com:malachiwang/TaskManager.git`). The existing checkpoint was already pushed; this remediation did not create a commit or perform another push.

## Compact sizing follow-up

Restored compact control heights using `37c60e5` as the sizing reference. Removed the blanket 32 px minimum and oversized shared padding/line-height overrides. Navigation, Calendar tools, search/help, filters, forms, report tabs, and Settings now use compact dimensions. The single font, existing font sizes, inline navigation, and search placement remain unchanged. Calendar event dimensions were not edited.

Compared the reference and corrected app in Chromium at 1440×1000, 100% zoom, and device scale factor 1, using the same synthetic records and dark theme:

| Control | Reference | Before follow-up | Corrected |
| --- | --- | --- | --- |
| Primary navigation | 23 px | 32 px | 23 px |
| Status filters and report tabs | 19 px | 32 px | 19 px |
| Help | 20 px | 32 px | 20 px |
| Calendar Week / Day | 21 px | 32 px | 21 px |
| Settings input | 23 px | 32 px | 23 px |
| Task editor Save | 27 px | 32 px | 27 px |
| Representative Calendar event | 46 px | 46 px | 46 px |

Add/Edit now share a 23 px height, matching the compact navigation scale. Search has a 23 px outer field. These preserve the corrected layout rather than restoring the old tall action band or wide header search. Some bordered form controls differ from the reference by 1 px; the current typography and theme borders are retained.

Reference captures: [Grid](images/tm-simplify-02/reference-37c60e5-grid.png), [Calendar](images/tm-simplify-02/reference-37c60e5-calendar.png). The current gallery below was refreshed after this correction. Desktop captures of all pages, the task editor, and search were visually inspected for centered text and clipping; laptop, narrow, and light-theme captures were checked as well.

For this CSS-only follow-up, the frontend build and existing layout/font browser check passed again (47 captures plus three shortcut-settings captures). Source font declarations and sampled computed font sizes/families were unchanged. The original behavior and backend test results below were not rerun for this sizing-only change. No commit or push was performed.

## Result

- Main, its Grid / Reading / Calendar children, Reports, and Settings share one desktop navigation row. Main's children disappear on Reports and Settings. Returning to Main retains the selected child; first entry opens Grid. Narrow navigation scrolls within its own row.
- Shared header utilities place workspace search immediately left of help on every destination. Grid and Reading retain their existing help handlers. Search keeps its workspace scope, reveal behavior, arrows, Enter, and Escape. Keyboard selection scrolls results into view.
- The existing system UI font is inherited throughout the application, including native controls, shortcut labels, and dialogs. Component font-family overrides, decorative tracking, uppercase transforms, and italic helper styling were removed. Theme-aware form defaults and shared control dimensions replace native-looking controls. Compact grid and Calendar controls keep their appropriate dimensions.
- Add Task and Edit Task sit together in the status/grouping/Jump toolbar. Disabled Edit guidance is an accessible description and tooltip. Reading's Add Book action shares its filter toolbar.
- Normal month navigation remains primary. A compact **Saved versions…** selector appears within the month controls only when relevant legacy snapshots exist. Selecting a version shows the existing read-only historical data; **Current records** returns to the live month. Old names, metadata, saved pressure, counts, and notes remain available.
- The inspector appears only for a selected cell or range. Its actions and notes wrap on narrow screens. Empty selection consumes no row. The task editor footer also wraps without horizontal scrolling.

## Changed files

All paths below are relative to the repository root.

| Files | Change |
| --- | --- |
| `frontend/src/App.jsx` | Inline Main children and shared search navigation context. |
| `frontend/src/components/HeaderUtilities.jsx` (new) | Reusable search/help group; help on Calendar, Reports, and Settings. |
| `frontend/src/components/WorkspaceSearch.jsx` | Keep the active keyboard result visible. |
| `frontend/src/components/TaskGrid.jsx` | Compact header/toolbar, secondary history selector, contextual inspector, concise column labels. |
| `frontend/src/components/MonthHistory.jsx` | Separate the month control from the read-only snapshot display. |
| `frontend/src/components/ReadingSheet.jsx`, `TaskRow.jsx` | Compact Reading toolbar, shared utilities, sentence-case action labels. |
| `frontend/src/components/CalendarView.jsx`, `MonthlyReport.jsx`, `Settings.jsx` | Shared content-header utilities. |
| `frontend/src/index.css` | Inherited typography, shared controls, responsive navigation/headers, bounded popovers and editor/inspector layouts. |
| `frontend/tests/simplify.browser.mjs` | Navigation/header assertions and a saved task-edit/reload regression. |
| `frontend/tests/simplify-layout.browser.mjs` (new) | Viewport/theme captures, computed-font audit, focus, bounded controls, contextual history/selection and retained navigation. |
| `docs/TM-SIMPLIFY-02.md`, `docs/images/tm-simplify-02/` | This report, 20 current screenshots containing synthetic records, and two reference screenshots. |

## Verification performed

Checks ran from an isolated source copy with the repository's existing dependencies. Vite used `127.0.0.1:15174`, proxying a dedicated backend on `127.0.0.1:18002`. All browser writes used `/tmp/tm-simplify-02-evidence/workspace.db`, with synthetic tasks, completions, reading records, three Calendar sessions, and a legacy snapshot. No backup was restored over the user's database.

| Check | Result |
| --- | --- |
| `npm --prefix frontend run build` | Passed. Existing warning remains for a JavaScript chunk over 500 kB. |
| `node --test frontend/tests/simplify.test.mjs` | 4 passed. |
| `.venv/bin/python -m pytest tests/test_simplify.py -q` | 10 passed, using disposable test databases. Covers historical search and backup/restore compatibility. |
| `node frontend/tests/simplify.browser.mjs <installed-playwright-module>` | Passed against the dedicated test server. |
| `node frontend/tests/simplify-layout.browser.mjs <installed-playwright-module>` | Passed 47 layout/font captures plus three shortcut-settings captures, with no browser runtime errors. |
| `bash scripts/verify.sh /tmp/tm-simplify-02-evidence/workspace.db` | Integrity check passed; no foreign-key violations. |
| `git diff --check` | Checked after applying the reviewed files. |

Browser commands used `TM_TEST_URL=http://127.0.0.1:15174` and the already installed Playwright module/Chromium cache from the local Last Match workspace. No package was installed. The scripts accept `PLAYWRIGHT_MODULE` or a module path argument, and `TM_TEST_ARTIFACTS` for the output directory. They require disposable fixtures from `tests.test_simplify.seed_history` and a current task named `Current active task`; the visual run also used populated Reading and Calendar records.

Behavior checks exercised search activation and reveal, history/month retention, Main child retention, Add/Edit, saving a task edit across reload, actual completion-count changes, text conversion without count loss, range selection, Jump, shortcut remapping/reload/reset, input/modal guards, export choices, and narrow grid scrolling. The layout check verified keyboard focus, search/help ordering, no page-wide overflow, no horizontal task-editor overflow, and inspector controls within the viewport.

Computed `font-family` matched the body for visible text and form controls across the captured surfaces. `document.fonts.ready` resolved; sampled Chromium platform-font queries for titles, editor text, keyboard help, and the native saved-version select reported San Francisco (`.SF NS`). This uses the existing system font stack and does not depend on downloading a web font.

An intermediate capture timed out on Reports after many repeated runs. The health endpoint responded, while the long-running test server's dashboard request stalled. A separate TestClient request against the same disposable database returned 200. Restarting only the disposable server cleared the issue; the final complete capture run passed. The cause was not established, and no backend change was made.

## Inspected screenshots

Screenshots were generated by headless Chromium and opened for visual inspection. Dark captures use Classic Sheet with dark appearance at 1440×1000, 1100×850, and 390×844. Light captures use Classic Sheet at 1440×1000. Narrow screenshots are viewport checks, not physical-device testing.

| Surface | Evidence |
| --- | --- |
| Main/Grid and expanded inline navigation | [Desktop dark](images/tm-simplify-02/dark-1440-grid.png), [laptop dark](images/tm-simplify-02/dark-1100-grid.png), [narrow dark](images/tm-simplify-02/dark-390-grid.png), [desktop light](images/tm-simplify-02/light-1440-grid.png) |
| Reading and Calendar | [Reading](images/tm-simplify-02/dark-1440-reading.png), [Calendar week](images/tm-simplify-02/dark-1440-calendar.png), [narrow Calendar day](images/tm-simplify-02/dark-390-calendar-day.png) |
| Reports and Settings | [Reports](images/tm-simplify-02/dark-1440-reports.png), [Settings dark](images/tm-simplify-02/dark-1440-settings.png), [Settings light](images/tm-simplify-02/light-1440-settings.png) |
| Open workspace search | [Desktop](images/tm-simplify-02/dark-1440-search.png), [narrow](images/tm-simplify-02/dark-390-search.png) |
| Task editor | [Desktop fields](images/tm-simplify-02/dark-1440-editor.png), [narrow fields and footer](images/tm-simplify-02/dark-390-editor-actions.png) |
| Contextual inspector | [Cell](images/tm-simplify-02/dark-390-inspector.png), [range](images/tm-simplify-02/dark-390-range.png) |
| Legacy saved version | [Old metadata and saved pressure](images/tm-simplify-02/dark-1440-history.png), [historical count and note after horizontal scroll](images/tm-simplify-02/dark-1440-history-notes.png) |
| Shortcut typography | [Help](images/tm-simplify-02/dark-1440-help.png), [narrow Settings](images/tm-simplify-02/dark-390-shortcuts.png) |

The captures exposed and guided fixes for clipped short grid headings, inspector overflow, Calendar active-state contrast, excess narrow Settings spacing, task-editor footer overflow, and stretched Calendar completion buttons.

## Limits

Native Tauri/macOS interaction, Safari/WebKit, physical devices, OS-reserved shortcuts, and release packaging were not verified. Only Classic Sheet's light/dark appearance was visually checked; the other palettes inherit the same control and typography rules. Narrow week-view Calendar blocks retain their existing compact titles; Day view exposes readable session details. The full backend suite was not rerun for this frontend correction. Earlier full-suite results remain in [TM-SIMPLIFY-01](TM-SIMPLIFY-01.md).
