# TM-SIMPLIFY-04: reference toolbar structure

Add/Edit now occupy a flat dark action strip immediately below navigation and above the sheet header. The separate filter row is compact again. Navigation uses consistent outlined rectangles; metadata and section labels use uppercase styling in the existing UI font. The accepted month centering, search/help placement, inline Main children and contextual inspector remain intact.

## Changes and source state

Reference source: `37c60e50a0295c484686ba951fa6d25d8b61c09c`. Entry and final HEAD: `7ad3add5b0857f42bd846beed26c58be7670e22a`, branch `main`. “Before” means the working tree at entry, including uncommitted TM-SIMPLIFY-03. That work and the existing audit evidence were preserved. [Entry status](evidence/tm-simplify-04/starting-status.txt) and [source hashes](evidence/tm-simplify-04/source-hashes.json) identify the comparison inputs.

| Changed file | Purpose |
| --- | --- |
| [TaskGrid.jsx](../frontend/src/components/TaskGrid.jsx) | Move existing Add/Edit controls into the action strip; shorten PRI/FREQ labels to fit their existing widths. |
| [index.css](../frontend/src/index.css) | Restore original shelf spacing and neutral rectangular actions; compact the Grid filter row; unify nav borders; uppercase metadata/section labels; retain ellipsis for narrow saved widths. |
| [simplify.browser.mjs](../frontend/tests/simplify.browser.mjs) | Replace the obsolete “no action strip” assertion with dedicated-strip assertions. |
| [toolbar.browser.mjs](../frontend/tests/toolbar.browser.mjs) | Matched reference/before/current measurements, screenshots and focused interaction checks. |
| This report and `docs/evidence/tm-simplify-04/` | Inspected screenshots, measurements and provenance. |

No backend, schema, backup, persistence, dependency or Calendar event-layout code changed. No live database or user preference was modified. No commit, push, installation or release packaging was performed.

## Column findings

No column-preference reset was found. `taskos-col-widths`, default widths and sticky-column membership are unchanged across the inspected pre-simplification source and current code. The retired saved-view object stored filters, grouping and search, not column widths. Its removal clears only `taskos-saved-views` in [App.jsx](../frontend/src/App.jsx).

[TaskGrid.jsx](../frontend/src/components/TaskGrid.jsx) freezes metadata through Subtask. Freq, Days and Notes remain non-frozen, resizable columns. Scrolling horizontally by their combined 188 px places dates directly after Subtask, reproducing the reference boundary. This is a scroll-state difference, with no evidence of a visibility-reset regression. The original screenshot's exact stored preferences cannot be recovered from its pixels. No new visibility setting or forced width was introduced.

All three comparison builds used identical explicit Task/Subtask widths of 180/120 px and Freq/Days/Notes widths of 44/44/100 px; remaining widths were defaults. Desktop scroll was 188 px, narrow scroll 0, vertical scroll 0. A separate check displayed FREQ at 44 px, verified that its text fits, then saved 24 px and confirmed reload preserved that width with ellipsis. Clearing a retired saved view also preserved all width overrides. Ordering remains the existing row drag handle; no new ordering control was added.

## Rendered results

October 30, 2026; installed Playwright 1.56.1, Chromium **141.0.7390.37**, macOS, CSS viewports **1440/1100/390 × 900**, DPR **1**, zoom **100%**. Classic Sheet, blue accent, both light/dark modes, motion off, default text settings. Each comparison had a fresh context, fixed date, loaded fonts and settled layout. No font substitution was forced. The current computed UI family was the system-font stack; the existing layout check identified `.SF NS` as the rendered platform font, with zero family mismatches.

The three isolated source copies shared a synthetic database from the [audit fixture](evidence/tm-audit-01/fixture.sql). Only in that disposable fixture, Current active task's creation/start date was set to October 1 for consistent cell selection. Screenshots select that date with Alt-click, without changing completion counts. Native window chrome is excluded.

All spot-checked heights below match the reference exactly in both themes and all three widths. Values are CSS px from `getBoundingClientRect()`, without rounding or tolerance. [Raw measurements](evidence/tm-simplify-04/toolbar-measurements.json) include per-build positions, fonts, padding, borders and state checks.

| Family | Reference | Corrected | Delta |
| --- | ---: | ---: | ---: |
| Add Task / Edit Task | 36 | 36 | 0 |
| Each of six navigation controls | 23 | 23 | 0 |
| All filter / grouping / Jump | 19 | 19 | 0 |
| Grid Today | 18 | 18 | 0 |
| Search input / help | 33 / 20 | 33 / 20 | 0 / 0 |
| Action strip, including bottom border | 38 | 38 | 0 |
| Filter row, 1440/1100 widths | 34 | 34 | 0 |
| Wrapped filter row, 390 width | 61 | 61 | 0 |
| Task rows | 23 | 23 | 0 |

The pre-correction filter row was 53 px on desktop and 109 px at 390. Actions keep the accepted 13 px font, rather than the reference source's 11 px action text. Their original 14 px horizontal padding and existing 36 px height are retained. No general font size or grid row height changed.

Header/date centers are **720/720**, **550/550**, and **195/195** at the three widths, in both themes: zero drift. At 390, the month group occupies its own centered row; search stays beside help. Navigation and the grid retain their own horizontal scrolling. No page-wide overflow was found.

## Inspected screenshots

Every image linked here was visually inspected. “Reference” is a fresh render of `37c60e5`, not a claim to reconstruct the unavailable original upload exactly. Its obsolete second navigation row is intentionally absent from the correction.

| View | Reference | Before correction | Corrected |
| --- | --- | --- | --- |
| Dark 1440 | [Image](evidence/tm-simplify-04/baseline-dark-1440-selected.png) | [Image](evidence/tm-simplify-04/before-dark-1440-selected.png) | [Image](evidence/tm-simplify-04/current-dark-1440-selected.png) |
| Light 1440 | [Image](evidence/tm-simplify-04/baseline-light-1440-selected.png) | [Image](evidence/tm-simplify-04/before-light-1440-selected.png) | [Image](evidence/tm-simplify-04/current-light-1440-selected.png) |
| Dark 1100 | [Image](evidence/tm-simplify-04/baseline-dark-1100-selected.png) | [Image](evidence/tm-simplify-04/before-dark-1100-selected.png) | [Image](evidence/tm-simplify-04/current-dark-1100-selected.png) |
| Light 1100 | [Image](evidence/tm-simplify-04/baseline-light-1100-selected.png) | [Image](evidence/tm-simplify-04/before-light-1100-selected.png) | [Image](evidence/tm-simplify-04/current-light-1100-selected.png) |
| Dark 390 | [Image](evidence/tm-simplify-04/baseline-dark-390-selected.png) | [Image](evidence/tm-simplify-04/before-dark-390-selected.png) | [Image](evidence/tm-simplify-04/current-dark-390-selected.png) |
| Light 390 | [Image](evidence/tm-simplify-04/baseline-light-390-selected.png) | [Image](evidence/tm-simplify-04/before-light-390-selected.png) | [Image](evidence/tm-simplify-04/current-light-390-selected.png) |

Also inspected: [no selection or empty inspector](evidence/tm-simplify-04/current-dark-1440-grid.png), [focused action and visible FREQ](evidence/tm-simplify-04/current-dark-1440-focus-columns.png), [Reading](evidence/tm-simplify-04/dark-1440-reading.png), and [narrow search results](evidence/tm-simplify-04/light-390-search.png). Uppercase labels fit at default widths; narrower saved widths ellipsize. The decorative header canvas remains in place; motion was disabled for matched captures.

## Checks and limits

Passed:

- Frontend production build, with the existing greater-than-500-kB bundle warning.
- Five existing navigation/keybinding unit tests.
- All 18 reference/before/current browser configurations. Add/Edit dialogs, status filtering, grouping, Jump, month navigation, search activation, Main child retention, disabled Edit guidance, hover/focus height stability, widths/theme retention and snapshot-selector absence passed.
- Existing interaction regression: saved task edits, Reading/history search, ordinary months, rebound completion editing, text conversion, range/Jump shortcuts and persistence. A separate pointer-drag check reordered two tasks, verified persistence after reload, then restored the original fixture order. Writes used only the disposable database.
- Existing layout check: 74 captures across pages, both themes and three widths; font consistency, visible keyboard focus, search/help placement, non-overlap and overflow checks. [Layout results](evidence/tm-simplify-04/layout-audit.json). Captures beyond the linked set were checked programmatically, not all visually inspected.
- `git diff --check`, report links, and a hash comparison confirming unrelated working files were unchanged.

Commands used in the isolated current copy:

```sh
npm --prefix frontend run build
node --test frontend/tests/simplify.test.mjs
node frontend/tests/toolbar.browser.mjs
node frontend/tests/simplify.browser.mjs
node frontend/tests/simplify-layout.browser.mjs
```

Browser commands used `PLAYWRIGHT_MODULE=/Users/malachiwang/Projects/last-match/node_modules/playwright/index.mjs` and `PLAYWRIGHT_BROWSERS_PATH=/Users/malachiwang/Projects/last-match/.cache/ms-playwright`. Three Vite instances used ports 15301/15302/15303; existing browser checks used `TM_TEST_URL=http://127.0.0.1:15303`. Their proxy targeted Uvicorn on 18014 with `TASKOS_DB_PATH=/tmp/tm-simplify-04/fixture.db` and `--loop asyncio`. No unrelated server was stopped. An initial fixture timestamp error prevented loading tasks; it was corrected before the final comparison and is excluded from the evidence.

This focused pass reused the prior full height audit. It did not rerun backend suites or exhaustive sizing checks. Native Tauri/macOS integration, Safari, physical devices and other theme palettes were not verified. The responsive and focused-state differences already documented in [TM-SIMPLIFY-03](TM-SIMPLIFY-03.md#responsive-and-focus-differences) remain outside this toolbar correction.
