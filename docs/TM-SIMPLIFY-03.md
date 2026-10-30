# TM-SIMPLIFY-03: control heights and month header

The primary desktop control heights now match `37c60e5` exactly in both themes. All 83 matched rows pass, including 82 control/state samples and one Calendar event guard. The Saved versions selector and snapshot display state are removed. The complete month group is centered on the entire Task Sheet header. The narrower layouts and stable input focus retain the explicit differences listed below, so this is not a claim of identical heights in every responsive/focused baseline state.

## Source state and changed files

Baseline: `37c60e50a0295c484686ba951fa6d25d8b61c09c`. Current HEAD: `7ad3add5b0857f42bd846beed26c58be7670e22a`, branch `main`, plus this uncommitted correction. At entry, only `docs/TM-AUDIT-01.md` and `docs/evidence/` were untracked. Those existing audit artifacts were preserved. No commit, push, dependency installation, or release packaging was performed.

| File | Correction |
| --- | --- |
| [index.css](../frontend/src/index.css) | Fix each audited family in its existing rules; retain font sizes; equal side columns for the month header; inset segmented-control focus rings. Remove retired selector styles and conflicting sizing overrides. |
| [TaskGrid.jsx](../frontend/src/components/TaskGrid.jsx) | Remove snapshot selection/rendering and keyboard guard; keep the ordinary grid visible; use the centered header layout. |
| `frontend/src/components/MonthHistory.jsx` | Delete the obsolete snapshot selector/display component. |
| [WorkspaceSearch.jsx](../frontend/src/components/WorkspaceSearch.jsx) | Exclude snapshot-only results; ordinary tasks, dated notes, Reading and navigation remain searchable. |
| [navigation.js](../frontend/src/navigation.js), [App.jsx](../frontend/src/App.jsx) | Normalize obsolete archive/history navigation to Main/Grid and discard snapshot IDs from old task targets. |
| [simplify.test.mjs](../frontend/tests/simplify.test.mjs) | Add regression coverage for obsolete targets. |
| [simplify.browser.mjs](../frontend/tests/simplify.browser.mjs) | Replace snapshot-browser expectations with absence, old-preference, ordinary-month and search checks. |
| [simplify-layout.browser.mjs](../frontend/tests/simplify-layout.browser.mjs) | Cover all three widths in both themes; assert header centering, non-overlap and removed snapshot UI. |
| [control-heights.browser.mjs](../frontend/tests/control-heights.browser.mjs) | Add matched rendered measurements, state stability and header checks based on the audit runner. |
| This report and `docs/evidence/tm-simplify-03/` | Measurements, inspected screenshots, reproduction helper and data-preservation results. |

No backend, schema, backup, dependency, Calendar event-layout or urgency code changed. No global fixed control height was added. Add/Edit/Add Book share their own 36 px family; Today, arrows, inputs and segmented controls retain separate metrics.

## Method and reproduction

Final matched run: October 30, 2026. Both builds used installed Playwright 1.56.1 with Chromium **141.0.7390.37** on macOS, viewport heights **900 CSS px**, widths **1440, 1100 and 390**, DPR **1**, zoom **100%**, `en-US`, `America/New_York`. Classic Sheet, blue accent, motion off, default text settings, Calendar Standard density. Each build/theme/width had a fresh disposable browser context. No font family was forced. The runner waited for `document.fonts.ready` and two animation frames, then asserted zoom, DPR, visible nonzero controls and expected label/value before measuring.

Both exact Git exports ran outside the repository; the current export received only the correction. Both used the same synthetic SQLite fixture from [the audit](evidence/tm-audit-01/fixture.sql): eight tasks, Reading records, three scheduled sessions, and a January 2025 legacy snapshot. Browser write tests used this disposable database; restore tests used separate pytest temporary databases. No live database was read, restored or modified.

The final matrix recorded **1,002 normal, 966 hover and 966 focus samples**, with no browser runtime errors. Selected and disabled cases are explicit table rows. Disabled Edit was not artificially focused. Every measured corrected control kept the same height on hover/focus. [Measurements and matched CSS rules](evidence/tm-simplify-03/measurements.json) and [computed-style CSV](evidence/tm-simplify-03/computed-styles.csv) contain font family/size, line-height, height/min/max-height, vertical padding, borders, box-sizing and positions for each sampled state. Fractional measurements are preserved.

Prepare in an unused temporary directory using existing dependencies:

```sh
REPO="/Users/malachiwang/Library/Mobile Documents/com~apple~CloudDocs/TaskManagementOS"
RUN="/private/tmp/tm-simplify-03-reproduce"
python3 "$REPO/docs/evidence/tm-simplify-03/prepare-reproduction.py" "$REPO" "$RUN"
```

Start these in three terminals with the same variables:

```sh
cd "$RUN/current"
TASKOS_DB_PATH="$RUN/audit.db" "$REPO/.venv/bin/python" -m uvicorn backend.main:app --host 127.0.0.1 --port 18011 --no-access-log --loop asyncio
```

```sh
cd "$RUN/baseline"
node frontend/node_modules/vite/bin/vite.js --config audit.vite.mjs
```

```sh
cd "$RUN/current"
node frontend/node_modules/vite/bin/vite.js --config audit.vite.mjs
```

Run the checks sequentially from `$RUN/current`:

```sh
export PLAYWRIGHT_MODULE="/Users/malachiwang/Projects/last-match/node_modules/playwright/index.mjs"
export PLAYWRIGHT_BROWSERS_PATH="/Users/malachiwang/Projects/last-match/.cache/ms-playwright"
export TM_TEST_URL="http://127.0.0.1:15202"
TM_TEST_ARTIFACTS="$RUN/behavior" node frontend/tests/simplify.browser.mjs
AUDIT_OUT="$RUN/heights" node frontend/tests/control-heights.browser.mjs
TM_TEST_ARTIFACTS="$RUN/layout" node frontend/tests/simplify-layout.browser.mjs
npm --prefix frontend run build
node --test frontend/tests/simplify.test.mjs
"$REPO/.venv/bin/python" -m pytest tests/test_simplify.py -q
```

Actual run directory: `/private/tmp/tm-simplify-03`; ports match the commands. The fixture's Calendar events are October 29, 2026. For a later reproduction, navigate both calendars to that week or use an equivalent fixed-date test environment. Missing events fail the content assertions rather than count as passing.

An initial behavior attempt and a later matrix attempt timed out in the isolated backend. The behavior rerun passed after restarting that server. The final full matrix and layout run used Uvicorn's existing `asyncio` loop instead of its default `uvloop`, with temporary diagnostic logging. No backend source was changed. The cause of the earlier stalls was not established; the successful run does not prove default-loop reliability. Partial runs are excluded from the final evidence.

## Per-control primary measurements

All values below are CSS px at 1440 × 900 in dark appearance. Light appearance has identical heights. Exact means delta **0**. A nonzero absolute delta up to **0.015625 px** (1/64 px) would be classified separately as subpixel rounding; none occurred. Larger positive or negative deltas are mismatches. No direct baseline and unverified environments are not passes. Styling classes below refer to [index.css](../frontend/src/index.css); complete matched rules are in the JSON.

| Page / control or state | Baseline | Corrected | Signed delta | Styling class | Verdict |
| --- | ---: | ---: | ---: | --- | --- |
| navigation / `nav-main` | 23 | 23 | +0 | `.tab` | Exact match |
| navigation / `nav-grid` | 23 | 23 | +0 | `.tab` | Exact match |
| navigation / `nav-reading` | 23 | 23 | +0 | `.tab` | Exact match |
| navigation / `nav-calendar` | 23 | 23 | +0 | `.tab` | Exact match |
| navigation / `nav-reports` | 23 | 23 | +0 | `.tab` | Exact match |
| navigation / `nav-settings` | 23 | 23 | +0 | `.tab` | Exact match |
| grid / `add-task` | 36 | 36 | +0 | `.ws-shelf-btn` | Exact match |
| grid / `edit-disabled` | 36 | 36 | +0 | `.ws-shelf-btn` | Exact match |
| grid / `filter-all` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| grid / `filter-active` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| grid / `filter-hiatus` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| grid / `filter-finished` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| grid / `group` | 19 | 19 | +0 | `.ws-group-btn` | Exact match |
| grid / `jump` | 19 | 19 | +0 | `.ws-filter-pill` | Exact match |
| grid / `month-prev` | 21 | 21 | +0 | `.ws-sheet-nav` | Exact match |
| grid / `month-today` | 18 | 18 | +0 | `.ws-sheet-nav` | Exact match |
| grid / `month-next` | 21 | 21 | +0 | `.ws-sheet-nav` | Exact match |
| grid / `search` | 33 | 33 | +0 | `.workspace-search-field input` | Exact match |
| grid / `help` | 20 | 20 | +0 | `.ws-kbd-help-btn` | Exact match |
| grid / `filter-all-active` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| grid / `filter-active-active` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| grid / `task-order` | 15 | 15 | +0 | `.drag-handle` | Exact match |
| grid / `group-open` | 19 | 19 | +0 | `.ws-group-btn` | Exact match |
| grid / `group-section` | 23 | 23 | +0 | `.ws-group-option` | Exact match |
| grid / `edit-enabled` | 36 | 36 | +0 | `.ws-shelf-btn` | Exact match |
| dialog / `dialog-name` | 25 | 25 | +0 | `.task-modal-input` | Exact match |
| dialog / `dialog-section` | 25 | 25 | +0 | `.task-modal-input` | Exact match |
| dialog / `dialog-interval` | 25 | 25 | +0 | `.task-modal-input` | Exact match |
| dialog / `dialog-status-active` | 26 | 26 | +0 | `.task-modal-seg-btn` | Exact match |
| dialog / `dialog-status-hiatus` | 26 | 26 | +0 | `.task-modal-seg-btn` | Exact match |
| dialog / `dialog-cancel` | 25 | 25 | +0 | `.task-modal-cancel` | Exact match |
| dialog / `dialog-save` | 27 | 27 | +0 | `.task-modal-save` | Exact match |
| dialog / `dialog-delete` | 25 | 25 | +0 | `.task-modal-delete-btn` | Exact match |
| history / `history-month-prev` | 21 | 21 | +0 | `.ws-sheet-nav` | Exact match |
| reading / `reading-tab-active` | 23 | 23 | +0 | `.tab` | Exact match |
| reading / `reading-add` | 36 | 36 | +0 | `.ws-shelf-btn` | Exact match |
| reading / `reading-library` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| reading / `reading-to-buy` | 19 | 19 | +0 | `.ws-filter-seg-btn` | Exact match |
| reading / `reading-active` | 19 | 19 | +0 | `.ws-filter-pill` | Exact match |
| reading / `reading-finished` | 19 | 19 | +0 | `.ws-filter-pill` | Exact match |
| reading / `reading-hidden` | 19 | 19 | +0 | `.ws-filter-pill` | Exact match |
| reading / `reading-all` | 19 | 19 | +0 | `.ws-filter-pill` | Exact match |
| reading / `reading-edit` | 16 | 16 | +0 | `.action-btn` | Exact match |
| reading / `reading-page` | 20 | 20 | +0 | `.rd-page-input` | Exact match |
| calendar / `calendar-tab-active` | 23 | 23 | +0 | `.tab` | Exact match |
| calendar / `cal-today` | 21 | 21 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-prev` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-next` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-week` | 21 | 21 | +0 | `.cal-seg-btn` | Exact match |
| calendar / `cal-day` | 21 | 21 | +0 | `.cal-seg-btn` | Exact match |
| calendar / `cal-density` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-command` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-calendars` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-import` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-shift` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-windows` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-hide-done` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-unscheduled` | 24 | 24 | +0 | `.cal-nav-btn` | Exact match |
| calendar / `cal-event` | 46 | 46 | +0 | `.cal-block` | Exact match |
| calendar / `cal-day-active` | 21 | 21 | +0 | `.cal-seg-btn` | Exact match |
| calendar / `cal-help-new` | n/a | 20 | n/a | `.ws-kbd-help-btn` | No direct baseline |
| reports / `reports-tab-active` | 23 | 23 | +0 | `.tab` | Exact match |
| reports / `report-today` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-history` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-execution` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-dismiss` | 16 | 16 | +0 | `.dashboard-rec-btn` | Exact match |
| reports / `report-snooze` | 16 | 16 | +0 | `.dashboard-rec-btn` | Exact match |
| reports / `report-history-active` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-period-week` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-period-month` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-period-quarter` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-period-year` | 19 | 19 | +0 | `.report-mode-btn` | Exact match |
| reports / `report-prev` | 24 | 24 | +0 | `.report-nav` | Exact match |
| reports / `report-current` | 21 | 21 | +0 | `.report-nav` | Exact match |
| reports / `report-next` | 24 | 24 | +0 | `.report-nav` | Exact match |
| settings / `settings-tab-active` | 23 | 23 | +0 | `.tab` | Exact match |
| settings / `settings-mode-system` | 19 | 19 | +0 | `.settings-seg-btn` | Exact match |
| settings / `settings-mode-light` | 19 | 19 | +0 | `.settings-seg-btn` | Exact match |
| settings / `settings-mode-dark` | 19 | 19 | +0 | `.settings-seg-btn` | Exact match |
| settings / `settings-section` | 23 | 23 | +0 | `.settings-input` | Exact match |
| settings / `settings-priority` | 23 | 23 | +0 | `.settings-input` | Exact match |
| settings / `settings-save` | 27 | 27 | +0 | `.button-secondary` | Exact match |
| settings / `settings-change` | 18 | 18 | +0 | `.ws-kbd-action-btn` | Exact match |
| settings / `settings-export` | 27 | 27 | +0 | `.button-secondary` | Exact match |

Calendar help uses the same `.ws-kbd-help-btn` family as Grid help and remains 20 px. It was added before this correction and has no direct Calendar counterpart at `37c60e5`. Saved-version selectors are removed, so no replacement measurement is invented. Ordering remains the existing row drag handle, not a new Order button.

## Responsive and focus differences

The following are **material differences from the rendered baseline**, not rounding. They preserve the accepted wrapping layout and the requirement that focus not resize controls. They occur in both themes. All other sampled normal heights at 1100/390 match their corresponding baseline measurements.

| Width/state | Control | Baseline | Corrected | Signed delta | Reason |
| --- | --- | ---: | ---: | ---: | --- |
| 1100 and 390 | Calendar Hide done | 40 | 24 | -16 | Baseline wraps its label. Corrected toolbar wraps whole controls; the label stays on one line. |
| 1100 and 390 | Calendar Unscheduled | 40 | 24 | -16 | Same whole-control wrapping, preserving the required 24 px family. |
| 390 | Dialog Delete Task | 38 | 25 | -13 | Accepted footer permits one line rather than baseline uppercase text wrapping. |
| All tested widths, focused | Dialog Name | 26 | 25 | -1 | Baseline grows its bottom border on focus. Corrected border remains stable and uses an outline. |
| All tested widths, focused | Dialog Section | 26 | 25 | -1 | Same stable focus treatment. |
| All tested widths, focused | Dialog Interval | 26 | 25 | -1 | Same stable focus treatment. |

The 390 px dialog status buttons now match **27 px**, including the existing responsive 1 px bottom border, instead of the audited 28 px. Desktop status buttons match 26 px. The audit explicitly recommends retaining whole-control wrapping rather than reproducing the old awkward Calendar/Delete label wraps. Those layout differences are not hidden in averages or reported as exact matches.

## Header, typography and retained behavior

Equal flexible side columns surround the complete month group. Search remains immediately left of help. At widths up to 900 px the header deliberately stacks, with the month group centered on its own row. The actual bounding-box centers were:

| Width, both themes | Header center X | Date-group center X | Signed delta |
| --- | ---: | ---: | ---: |
| 1440 | 720 | 720 | +0 |
| 1100 | 550 | 550 | +0 |
| 390 | 195 | 195 | +0 |

The same exact centers held after replacing the counts with longer text and changing the utility width to 240 px in the disposable page, then restoring both. Header groups did not overlap. Layout assertions found no page-wide overflow; Grid/Reading tables and narrow navigation retain their intentional internal scrolling.

Every sampled current font family and size matches the accepted pre-correction interface from TM-AUDIT-01. The 74 layout captures checked computed fonts across visible labels, form controls, menus, dialog, help/shortcut text and page content. Platform-font queries resolve ordinary text to `.SF NS`; the drag-handle Braille symbol uses the platform's Apple Braille glyph fallback. Some native input internals return empty platform-font arrays, so those are not claimed as resolved-font proof. No downloaded font is required.

Relative to `37c60e5`, shortcut Change and the Reading page input intentionally retain the unified system UI font instead of Arial. Reducing total vertical padding by 1 px compensates for that font-metric difference while preserving current text sizes. Search retains its current 13 px UI text and restores its explicit 33 px input box. Today and small action families similarly retain the accepted larger text and adjust their own padding/line-height. No text was shrunk.

The Reports History focus ring is now inset within the clipped segmented group and visibly complete. Other inspected controls have centered text without vertical clipping. All measured grid rows remain **23 px**. The sampled one-hour Calendar event stays **46 px** tall at `top: 432px`; its width matches baseline exactly at every viewport: **193.859375**, **145.28125**, and **43.859375 px** respectively. Its ellipsis at narrow widths is existing event behavior, not a control-height workaround.

The browser tests verify removal of `.month-history`, `.month-version-select`, and snapshot rows, including a month that contains a legacy snapshot. Snapshot-only search returns no visible result. Old saved-view preferences cannot select a hidden snapshot; obsolete link targets are normalized by unit-tested code, and missing task targets are consumed while leaving the ordinary grid visible. Normal January/December month navigation, historical-note search, task selection/editing/reload, Reading search, arrows/Enter/Escape, shortcut remapping and persistence, completion count edits, text conversion, range selection and Jump passed.

[Data-preservation evidence](evidence/tm-simplify-03/data-preservation.json) confirms the full synthetic archive record, including stored JSON, is byte-for-value unchanged, as are all 38 application schema entries. Existing backup tests passed for format 7 round trips and legacy versions 1 through 6. The backend's snapshot storage/export/restore APIs remain unchanged. No alternate snapshot browser was introduced. The Reports History tab is ordinary reporting and is unrelated to the removed Saved versions selector.

## Inspected screenshots

Every PNG linked here was opened and visually inspected. The 14 comparison sheets retain the original crop scale, baseline left and corrected right. The 26 full-page captures are the inspected subset of the 80 screenshots produced by the layout run; 74 of those screenshots receive its full layout/font assertions and six additional shortcut screenshots receive a focused font check. The [inspection manifest](evidence/tm-simplify-03/inspected-images.json) identifies the retained PNGs.

| Matched control evidence | Links |
| --- | --- |
| Primary families | [Navigation](evidence/tm-simplify-03/navigation.png), [Grid](evidence/tm-simplify-03/grid.png), [Dialog](evidence/tm-simplify-03/dialog.png), [Month navigation](evidence/tm-simplify-03/history.png) |
| Other pages | [Reading](evidence/tm-simplify-03/reading.png), [Calendar](evidence/tm-simplify-03/calendar.png), [Reports](evidence/tm-simplify-03/reports.png), [Settings](evidence/tm-simplify-03/settings.png) |
| Focus | [Matched focus rings](evidence/tm-simplify-03/focus.png) |
| Responsive dark | [1100](evidence/tm-simplify-03/dark-1100.png), [390](evidence/tm-simplify-03/dark-390.png) |
| Light | [1440](evidence/tm-simplify-03/light-1440.png), [1100](evidence/tm-simplify-03/light-1100.png), [390](evidence/tm-simplify-03/light-390.png) |

| Corrected page/state | Inspected captures |
| --- | --- |
| Centered Grid, dark | [dark-1440-grid](evidence/tm-simplify-03/dark-1440-grid.png), [dark-1100-grid](evidence/tm-simplify-03/dark-1100-grid.png), [dark-390-grid](evidence/tm-simplify-03/dark-390-grid.png) |
| Centered Grid, light | [light-1440-grid](evidence/tm-simplify-03/light-1440-grid.png), [light-1100-grid](evidence/tm-simplify-03/light-1100-grid.png), [light-390-grid](evidence/tm-simplify-03/light-390-grid.png) |
| Reading | [dark-1440-reading](evidence/tm-simplify-03/dark-1440-reading.png), [dark-390-reading](evidence/tm-simplify-03/dark-390-reading.png) |
| Calendar | [dark-1440-calendar](evidence/tm-simplify-03/dark-1440-calendar.png), [dark-390-calendar](evidence/tm-simplify-03/dark-390-calendar.png) |
| Reports | [dark-1440-reports](evidence/tm-simplify-03/dark-1440-reports.png), [dark-390-reports](evidence/tm-simplify-03/dark-390-reports.png) |
| Settings | [dark-1440-settings](evidence/tm-simplify-03/dark-1440-settings.png), [dark-390-settings](evidence/tm-simplify-03/dark-390-settings.png) |
| Search | [dark-1440-search](evidence/tm-simplify-03/dark-1440-search.png), [dark-390-search](evidence/tm-simplify-03/dark-390-search.png) |
| Editor | [dark-1440-editor](evidence/tm-simplify-03/dark-1440-editor.png), [dark-390-editor](evidence/tm-simplify-03/dark-390-editor.png) |
| Calendar wrapping | [dark-1100-calendar](evidence/tm-simplify-03/dark-1100-calendar.png), [light-390-calendar](evidence/tm-simplify-03/light-390-calendar.png) |
| Dialog footer | [dark-390-editor-actions](evidence/tm-simplify-03/dark-390-editor-actions.png), [light-390-editor-actions](evidence/tm-simplify-03/light-390-editor-actions.png) |
| Help and selection | [dark-390-help](evidence/tm-simplify-03/dark-390-help.png), [dark-390-inspector](evidence/tm-simplify-03/dark-390-inspector.png), [dark-390-range](evidence/tm-simplify-03/dark-390-range.png) |
| Ordinary January history | [dark-1440-month-history](evidence/tm-simplify-03/dark-1440-month-history.png) |

## Checks and limitations

- `npm run build` in the isolated frontend: passed. Existing warning about a minified chunk over 500 kB remains.
- `node --test frontend/tests/simplify.test.mjs`: **5 passed**.
- `python -m pytest tests/test_simplify.py -q`: **10 passed**, with disposable databases, including backup compatibility.
- `simplify.browser.mjs`: passed all behavior checks after the isolated-server restart described above.
- `control-heights.browser.mjs`: full six-configuration matched matrix passed, **1,002 samples**, zero runtime errors. Desktop height assertions use the simultaneously rendered baseline, not the earlier audit's numbers.
- `simplify-layout.browser.mjs`: **74 layout/font capture checks passed**, plus shortcut checks, across six configurations; zero runtime errors. [Layout/font data](evidence/tm-simplify-03/layout-audit.json).
- Final `git diff --check`, new-text whitespace checks, report links and evidence paths passed. Applied files were checked against the tested copy; existing unrelated files and prior audit evidence were checked against their starting hashes.

Native Tauri/macOS WebView, Safari, physical devices, other display DPR/zoom settings and non-Classic palettes were not exercised. Narrow Chromium viewports are browser emulation, not physical-device tests. Calendar import/dragging, every native dropdown/date-picker popup, and exhaustive application behavior were not retested. No release build was packaged. The measured default/selected/disabled/hover/focused states do not imply coverage of every possible pressed or popup state.

Final verdict: **all primary desktop baseline control heights match exactly**. The explicitly listed responsive wrapping differences and non-growing focused inputs remain. Saved versions is removed, ordinary monthly history remains, and the complete date group is centered with zero measured error at both desktop widths.
