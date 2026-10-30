# TM-AUDIT-01: rendered control-height audit

**Verdict: not restored.** The current interface is compact, but several controls are shorter or taller than `37c60e5`. The 1440 × 900 dark run contains 85 matched control/state rows: 52 controls match exactly, one Calendar event-height guard matches, and 32 control/state rows have material mismatches. One additional Calendar help control has no direct baseline. Counts include explicitly sampled active and disabled states; they are not counts of unique component classes.

## Source state and isolation

- Baseline: `37c60e50a0295c484686ba951fa6d25d8b61c09c`.
- Current HEAD: `7ad3add5b0857f42bd846beed26c58be7670e22a` on `main`.
- `git status --short` was empty before the audit. No uncommitted application changes were included. Both versions ran from exact `git archive` exports, equivalent to isolated checkouts. The user’s working tree was not reset, stashed, or replaced.
- `git ls-remote origin refs/heads/main` returned `7ad3add5b0857f42bd846beed26c58be7670e22a` for `git@github.com:malachiwang/TaskManager.git`. This is a read-only remote observation; this audit did not commit or push.
- `docs/TM-SIMPLIFY-02.md` was read as requested. Its statement that remediation remains uncommitted is stale at this HEAD. Its measurements were treated as claims, not expected values.
- The application, stylesheet, preferences, dependencies, and live database were left unchanged. Only this report and evidence are added. All initially tracked files were checked against their starting SHA-256 hashes.

## Method and reproduction

Used installed Playwright 1.56.1 and headless Chromium **141.0.7390.37** on macOS. Primary viewport: **1440 × 900 CSS px**, DPR **1**, browser zoom **100%**. Also measured **1100 × 900** and **390 × 900** in dark appearance, and **1440 × 900** in light appearance. `visualViewport.scale`, `devicePixelRatio`, and computed root `zoom` were asserted to be 1 for each sample.

Each fresh disposable browser context used Classic Sheet, blue accent, motion off, default text settings, and Calendar Standard density. No font family was forced. `document.fonts.ready` and two animation frames preceded measurement. Both versions used the same copied synthetic SQLite fixture: eight tasks, Reading records, three scheduled sessions, and a January 2025 saved version. Only browser-local navigation, selection, and editor state changed; no task was saved and no backup was restored.

The [runner](evidence/tm-audit-01/audit.mjs) asserts one visible, nonzero-size control and matching label/value before reading `getBoundingClientRect().height`. It scrolls controls into view, records normal/active/disabled states, then measures hover and keyboard focus without invoking the control’s action. Every normal measurement includes computed family, size, line-height, height/min/max-height, vertical padding, borders, box-sizing and alignment. Primary samples also include matched CSS rules and platform-font queries. Empty platform-font results for native input internals are retained, not interpreted as proof of a resolved font.

Evidence data: [complete measurements and matched rules](evidence/tm-audit-01/measurements.json), [computed styles for normal/hover/focus](evidence/tm-audit-01/computed-styles.csv). Fractional values are retained in these files. All measured outer heights happened to be integral in this run; fractional widths and positions are not rounded away.

Run in an unused temporary directory. The preparation script only reads Git and writes that directory. Existing dependencies must already be present; nothing is installed. The fixture contains synthetic records dated October 29, 2026. To repeat the Calendar event guard later, navigate both calendars to that week or run on an equivalent fixed-date test host; the runner intentionally fails if the populated event is absent.

```sh
REPO="/Users/malachiwang/Library/Mobile Documents/com~apple~CloudDocs/TaskManagementOS"
AUDIT="/private/tmp/tm-audit-01-reproduce"
python3 "$REPO/docs/evidence/tm-audit-01/prepare-reproduction.py" "$REPO" "$AUDIT"
```

In three terminals, with those variables set, start only the isolated servers:

```sh
cd "$AUDIT/current"
TASKOS_DB_PATH="$AUDIT/audit.db" "$REPO/.venv/bin/python" -m uvicorn backend.main:app --host 127.0.0.1 --port 18011 --no-access-log

# Second terminal
cd "$AUDIT/baseline"
node frontend/node_modules/vite/bin/vite.js --config audit.vite.mjs

# Third terminal
cd "$AUDIT/current"
node frontend/node_modules/vite/bin/vite.js --config audit.vite.mjs
```

Then run the read-only browser audit:

```sh
AUDIT_OUT="$AUDIT/evidence" \
PLAYWRIGHT_MODULE="/Users/malachiwang/Projects/last-match/node_modules/playwright/index.mjs" \
PLAYWRIGHT_BROWSERS_PATH="/Users/malachiwang/Projects/last-match/.cache/ms-playwright" \
node "$REPO/docs/evidence/tm-audit-01/audit.mjs"
```

The recorded run used `/private/tmp/tm-audit-01`, backend port 18011, baseline port 15201, current port 15202, and two runner invocations: `--primary`, then `--secondary`. It completed 684 normal control/state samples plus 660 hover and 660 focus samples, with no browser runtime errors in the completed runs. Initial harness attempts stopped on a temporary preview path and mismatched selectors/text assertions; their partial measurements are excluded. No production build or gameplay/backend suite is used as height evidence.

## Verdict rules

- **Exact match:** signed delta is exactly 0 CSS px.
- **Subpixel rounding only:** nonzero absolute delta at most **0.015625 CSS px** (1/64 px, below 0.5). No rows fell in this category.
- **Material mismatch:** any larger positive or negative delta. A 1 px difference is material here; smaller controls do not pass.
- **No direct baseline:** a genuinely new control, with no fabricated old measurement.
- **Unverified:** a requested environment or state not exercised. Coverage gaps appear below, not as passes.

## Per-control desktop comparison

All heights and deltas below are CSS px at 1440 × 900, dark appearance. “Normal” includes the actual selected state at that step; active/disabled cases are named explicitly. B/C source links identify baseline/current CSS line numbers; full matched rules and computed styles are in the evidence data. Most baseline `--font-sans` and `--font-mono` references already alias `--font-ui`, so an old token name alone does not imply a different rendered font.

| Page / control or state | Baseline | Current | Signed delta | Styling source B / C | Verdict |
| --- | ---: | ---: | ---: | --- | --- |
| navigation / `nav-main` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| navigation / `nav-grid` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| navigation / `nav-reading` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| navigation / `nav-calendar` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| navigation / `nav-reports` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| navigation / `nav-settings` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| grid / `add-task` | 36 | 23 | -13 | [3658](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3658) / [8735](../frontend/src/index.css#L8735) | Material mismatch |
| grid / `edit-disabled` | 36 | 23 | -13 | [3658](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3658) / [8735](../frontend/src/index.css#L8735) | Material mismatch |
| grid / `filter-all` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| grid / `filter-active` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| grid / `filter-hiatus` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| grid / `filter-finished` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| grid / `group` | 19 | 19 | +0 | [5784](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5784) / [8737](../frontend/src/index.css#L8737) | Exact match |
| grid / `jump` | 19 | 19 | +0 | [5213](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5213) / [8737](../frontend/src/index.css#L8737) | Exact match |
| grid / `month-prev` | 21 | 21 | +0 | [3864](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3864) / [8715](../frontend/src/index.css#L8715) | Exact match |
| grid / `month-today` | 18 | 21 | +3 | [3884](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3884) / [8715](../frontend/src/index.css#L8715) | Material mismatch |
| grid / `month-next` | 21 | 21 | +0 | [3864](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3864) / [8715](../frontend/src/index.css#L8715) | Exact match |
| grid / `search` | 33 | 21 | -12 | [8645](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L8645) / [8721](../frontend/src/index.css#L8721) | Material mismatch |
| grid / `help` | 20 | 20 | +0 | [5616](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5616) / [8728](../frontend/src/index.css#L8728) | Exact match |
| grid / `filter-all-active` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| grid / `filter-active-active` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| grid / `task-order` | 15 | 15 | +0 | [1567](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L1567) / [1564](../frontend/src/index.css#L1564) | Exact match |
| grid / `group-open` | 19 | 19 | +0 | [5784](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5784) / [8737](../frontend/src/index.css#L8737) | Exact match |
| grid / `group-section` | 23 | 23 | +0 | [5818](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5818) / [5815](../frontend/src/index.css#L5815) | Exact match |
| grid / `edit-enabled` | 36 | 23 | -13 | [3658](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3658) / [8735](../frontend/src/index.css#L8735) | Material mismatch |
| dialog / `dialog-name` | 25 | 26 | +1 | [4264](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4264) / [8761](../frontend/src/index.css#L8761) | Material mismatch |
| dialog / `dialog-section` | 25 | 26 | +1 | [4264](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4264) / [8761](../frontend/src/index.css#L8761) | Material mismatch |
| dialog / `dialog-interval` | 25 | 26 | +1 | [4264](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4264) / [8761](../frontend/src/index.css#L8761) | Material mismatch |
| dialog / `dialog-status-active` | 26 | 27 | +1 | [4622](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4622) / [4619](../frontend/src/index.css#L4619) | Material mismatch |
| dialog / `dialog-status-hiatus` | 26 | 27 | +1 | [4622](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4622) / [4619](../frontend/src/index.css#L4619) | Material mismatch |
| dialog / `dialog-cancel` | 25 | 25 | +0 | [4719](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4719) / [4716](../frontend/src/index.css#L4716) | Exact match |
| dialog / `dialog-save` | 27 | 27 | +0 | [4737](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4737) / [4734](../frontend/src/index.css#L4734) | Exact match |
| dialog / `dialog-delete` | 25 | 25 | +0 | [4773](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L4773) / [4770](../frontend/src/index.css#L4770) | Exact match |
| history / `saved-version` | 19 | 23 | +4 | [2](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L2) / [8716](../frontend/src/index.css#L8716) | Material mismatch |
| history / `history-month-prev` | 21 | 21 | +0 | [3864](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3864) / [8715](../frontend/src/index.css#L8715) | Exact match |
| history / `saved-version-unselected` | 19 | 23 | +4 | [2](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L2) / [8716](../frontend/src/index.css#L8716) | Material mismatch |
| reading / `reading-tab-active` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| reading / `reading-add` | 36 | 23 | -13 | [3658](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L3658) / [8735](../frontend/src/index.css#L8735) | Material mismatch |
| reading / `reading-library` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reading / `reading-to-buy` | 19 | 19 | +0 | [5256](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5256) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reading / `reading-active` | 19 | 19 | +0 | [5213](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5213) / [8737](../frontend/src/index.css#L8737) | Exact match |
| reading / `reading-finished` | 19 | 19 | +0 | [5213](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5213) / [8737](../frontend/src/index.css#L8737) | Exact match |
| reading / `reading-hidden` | 19 | 19 | +0 | [5213](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5213) / [8737](../frontend/src/index.css#L8737) | Exact match |
| reading / `reading-all` | 19 | 19 | +0 | [5213](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5213) / [8737](../frontend/src/index.css#L8737) | Exact match |
| reading / `reading-edit` | 16 | 17 | +1 | [1527](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L1527) / [1524](../frontend/src/index.css#L1524) | Material mismatch |
| reading / `reading-page` | 20 | 21 | +1 | [6124](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6124) / [6121](../frontend/src/index.css#L6121) | Material mismatch |
| calendar / `calendar-tab-active` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| calendar / `cal-today` | 21 | 23 | +2 | [6988](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6988) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-prev` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-next` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-week` | 21 | 21 | +0 | [7008](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L7008) / [8739](../frontend/src/index.css#L8739) | Exact match |
| calendar / `cal-day` | 21 | 21 | +0 | [7008](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L7008) / [8739](../frontend/src/index.css#L8739) | Exact match |
| calendar / `cal-density` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-command` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-calendars` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-import` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-shift` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-windows` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-hide-done` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-unscheduled` | 24 | 23 | -1 | [6977](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6977) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| calendar / `cal-event` | 46 | 46 | +0 | [7217](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L7217) / [7214](../frontend/src/index.css#L7214) | Exact match |
| calendar / `cal-day-active` | 21 | 21 | +0 | [7008](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L7008) / [8739](../frontend/src/index.css#L8739) | Exact match |
| calendar / `cal-help-new` | — | 20 | — | none / [8728](../frontend/src/index.css#L8728) | No direct baseline |
| reports / `reports-tab-active` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| reports / `report-today` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-history` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-execution` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-dismiss` | 16 | 17 | +1 | [6517](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6517) / [6514](../frontend/src/index.css#L6514) | Material mismatch |
| reports / `report-snooze` | 16 | 17 | +1 | [6517](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6517) / [6514](../frontend/src/index.css#L6514) | Material mismatch |
| reports / `report-history-active` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-period-week` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-period-month` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-period-quarter` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-period-year` | 19 | 19 | +0 | [6728](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6728) / [8736](../frontend/src/index.css#L8736) | Exact match |
| reports / `report-prev` | 24 | 23 | -1 | [6742](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6742) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| reports / `report-current` | 21 | 23 | +2 | [6748](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6748) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| reports / `report-next` | 24 | 23 | -1 | [6742](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6742) / [8738](../frontend/src/index.css#L8738) | Material mismatch |
| settings / `settings-tab-active` | 23 | 23 | +0 | [474](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L474) / [8703](../frontend/src/index.css#L8703) | Exact match |
| settings / `settings-mode-system` | 19 | 19 | +0 | [6612](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6612) / [6609](../frontend/src/index.css#L6609) | Exact match |
| settings / `settings-mode-light` | 19 | 19 | +0 | [6612](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6612) / [6609](../frontend/src/index.css#L6609) | Exact match |
| settings / `settings-mode-dark` | 19 | 19 | +0 | [6612](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L6612) / [6609](../frontend/src/index.css#L6609) | Exact match |
| settings / `settings-section` | 23 | 23 | +0 | [2210](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L2210) / [2207](../frontend/src/index.css#L2207) | Exact match |
| settings / `settings-priority` | 23 | 23 | +0 | [2210](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L2210) / [2207](../frontend/src/index.css#L2207) | Exact match |
| settings / `settings-save` | 27 | 27 | +0 | [2358](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L2358) / [2355](../frontend/src/index.css#L2355) | Exact match |
| settings / `settings-change` | 18 | 19 | +1 | [5153](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L5153) / [5150](../frontend/src/index.css#L5150) | Material mismatch |
| settings / `settings-export` | 27 | 27 | +0 | [2358](https://github.com/malachiwang/TaskManager/blob/37c60e50a0295c484686ba951fa6d25d8b61c09c/frontend/src/index.css#L2358) / [2355](../frontend/src/index.css#L2355) | Exact match |

## Mappings and styling causes

- Main/Reports/Settings and Grid/Reading/Calendar map by label despite moving the child tabs into the primary row. All measured navigation states remain 23 px; the current font is 13 px rather than 12 px, balanced by a 15 px line-height.
- Add Task/Edit Task and Reading Add Book retain `.ws-shelf-btn`. Baseline controls stretch within the 36 px shelf (`.ws-shelf-left` uses `align-items: stretch`); current `.ws-shelf-btn` explicitly sets 23 px in the compact toolbar. This is a real −13 px change, not rounding.
- The former History / Current records native select maps directly to `.month-version-select`, now beside the month controls. It is not a new control: 19 → 23 px. Added 2 px top/bottom padding and inherited typography replace browser-native styling.
- Workspace search maps directly from the old brand-strip input to the content-header input. The measured input is 33 → 21 px. The current **outer field** is 23 px, which is a different box and cannot substitute for the input measurement.
- Calendar help has **no direct baseline on that page**. Its intended shared class is `.ws-kbd-help-btn`, also used by Grid’s existing help. The new Calendar control measures 20 px. Reports/Settings also gained shared help, but their individual instances were not sampled here.
- Ordering is the existing `.drag-handle` on the populated task row (15 → 15 px). There is no independent Order toolbar button in either source. Group Section menu option and open trigger were measured separately.
- Global `box-sizing: border-box` applies in both versions. The current `button, input, select, textarea { font: inherit }` replaces browser font defaults and resets font longhands unless more specific component rules win. The `:where(...)` border/padding defaults have zero selector specificity, so local component rules remain important. No global 32 px minimum survives in the current source.
- The shared current selector at [CSS line 8733](../frontend/src/index.css#L8733) forces 13 px on several families. The [line-height/padding overrides](../frontend/src/index.css#L8735) then set Calendar/report navigation to 15 px line-height. Baseline 13 px text with `line-height: normal` contributes 16 px here, yielding 24 px controls; current 15 px yields 23 px. Today/Current period used 11 px text in the baseline and instead grow 21 → 23 px.
- Grid Today differs from its arrow siblings: baseline 10 px text with `line-height: 1` and 4 px vertical padding yields 18 px. Current 13 px text with the same padding yields 21 px. Reporting all month buttons as 21 px would hide this mismatch.
- Dialog inputs keep the same 13 px family and 4 px vertical padding. Baseline has no top border and a computed 1 px bottom border; current has 1 px on both edges, causing 25 → 26 px. The baseline declared 1.5 px bottom border computes to 1 px at DPR 1; the audit uses the rendered/computed result, not the declaration.
- Dialog status, Reading Edit, and report Dismiss/Snooze use the same family but increase from 10 to 11 px text. They gain 1 px. These are font-size changes, not font-family unification effects.

## Font-unification differences

| Control | Baseline font | Current font | Height consequence |
| --- | --- | --- | --- |
| Shortcut Change | Arial 11 px | system UI 11 px | 18 → 19 px with unchanged 2 px vertical padding and 1 px borders. Platform-font queries report ArialMT → .SFNS-Regular. |
| Reading current-page input | Arial 12 px | system UI 12 px | 20 → 21 px with unchanged padding/borders. Native input platform-font query is empty; computed families and surrounding rules show the font inheritance change. |
| Search | Arial 13.3333 px | system UI 13 px | 33 → 21 px, dominated by explicit height/padding changes; not attributable solely to font unification. |
| Saved-version select | Arial 13.3333 px | system UI 12 px | 19 → 23 px with added padding and native-select metrics. Do not attribute the full difference to font family alone. |

Other sampled text generally resolves to `.SF NS` in both builds. No downloaded web font is required. The earlier claim that font sizes were unchanged referred to the compact follow-up versus its immediate predecessor, not versus `37c60e5`.

## Hover, focus, centering and clipping

All measured hover heights equal their normal heights. Current focus heights also remain unchanged. Baseline dialog Name, Section, and Interval inputs grow from 25 to 26 px on focus because their bottom border changes; current 26 px matches the baseline focused state while mismatching its normal state. Disabled Edit is 36 → 23 px; disabled controls were not assigned an artificial keyboard-focus state.

The inspected primary crops show centered, legible control labels without vertical text clipping. Current saved-version text is horizontally shortened to fit its narrower select; this is separate from height. The narrow baseline Delete Task and Calendar Hide done/Unscheduled labels wrap, shown explicitly below.

The current Reports History focus crop shows its top/bottom ring clipped by `.report-period-modes { overflow: hidden }` while the side edges remain visible. The control stays 19 px. A scoped inset focus indicator for this segmented family would avoid changing heights. The baseline crop has a complete inset ring. Focus crops for Main, Add Task, Jump, search, help, Cancel, Reading Add Book, Calendar Today and Settings Change show visible rings; this is not a claim about every popover or native menu.

## Responsive and light-theme results

Every sampled light-theme height at 1440 px equals that build’s dark-theme height. At narrower widths, unchanged rows retain the desktop measurements; the exceptions are:

| Width / control | Baseline | Current | Delta | Interpretation |
| --- | ---: | ---: | ---: | --- |
| 1100 and 390 / Calendar Hide done | 40 | 23 | −17 | Baseline button text wraps within the constrained toolbar. Current toolbar wraps control groups instead. |
| 1100 and 390 / Calendar Unscheduled | 40 | 23 | −17 | Same content-driven baseline wrapping. |
| 390 / dialog Active and Hiatus | 27 | 28 | +1 | Both gain a deliberate 1 px bottom border in the existing narrow breakpoint; desktop mismatch persists. |
| 390 / dialog Delete Task | 38 | 25 | −13 | Baseline uppercase label wraps in its constrained footer; current footer layout allows one line. |

The dialog’s breakpoint border is an explicit responsive style, not unexplained rounding. Baseline Calendar/Delete wrapping follows available width rather than a height target; reproducing those awkward wraps would undermine the accepted layout. Keep these responsive differences documented separately from the desktop sizing corrections.

## Inspected evidence

Each linked PNG was opened and visually inspected. Plates place baseline on the left and current on the right. Crops retain original CSS-pixel scale with a small margin; they are composed onto labeled sheets without resizing the controls. The primary sheets cover every table row. The responsive/theme sheets show representative controls from every affected family and every additional responsive mismatch.

| Evidence | Matched control crops |
| --- | --- |
| Navigation | [navigation.png](evidence/tm-audit-01/navigation.png) |
| Grid toolbar, search/help and ordering | [grid.png](evidence/tm-audit-01/grid.png) |
| Task dialog | [dialog.png](evidence/tm-audit-01/dialog.png) |
| Saved-version/month controls | [history.png](evidence/tm-audit-01/history.png) |
| Reading | [reading.png](evidence/tm-audit-01/reading.png) |
| Calendar | [calendar.png](evidence/tm-audit-01/calendar.png) |
| Reports | [reports.png](evidence/tm-audit-01/reports.png) |
| Settings | [settings.png](evidence/tm-audit-01/settings.png) |
| Keyboard focus | [focus.png](evidence/tm-audit-01/focus.png) |
| 1100 px dark | [dark-1100.png](evidence/tm-audit-01/dark-1100.png) |
| 390 px dark | [dark-390.png](evidence/tm-audit-01/dark-390.png) |
| 1440 px light | [light-1440.png](evidence/tm-audit-01/light-1440.png) |

## Narrowly scoped recommendations, not implemented

Preserve the current font family and sizes, inline Main navigation, search/help placement, and Calendar event dimensions. To satisfy strict desktop height restoration:

1. Set the existing Add/Edit/Add Book button boxes to the measured 36 px reference within their current toolbar. Set the search input to 33 px within its current utility group. Neither requires restoring the removed full-width bands.
2. Scope month Today to 18 px, Calendar Today and report Current period to 21 px, and ordinary Calendar/report navigation to 24 px. Adjust the relevant line-height/vertical padding or explicitly centered boxes without shrinking fonts. Leave exact 23 px navigation and 19/21 px segmented controls alone.
3. Remove the saved-version select’s added vertical padding to target 19 px while retaining theme styling. For dialog inputs, retain the full border and reduce total vertical padding by 1 px to target a stable 25 px box; explicitly decide whether preserving the baseline focus growth is desirable rather than recreating it accidentally.
4. Reduce total vertical padding by 1 px on dialog status buttons, Reading Edit/current-page, report Dismiss/Snooze, and shortcut Change to compensate for retained text metrics. Validate native input/select rendering and narrow border rules before accepting any proposed CSS.
5. Use an inset focus treatment for clipped segmented tabs. Verify each corrected control again at these matched settings. These are recommendations only; no CSS was tested or applied as a counterfactual during this audit.

## Coverage gaps and final verdict

- Chromium only. Native Tauri/macOS WebView, Safari/WebKit, physical devices, OS menus, and non-1 DPR/zoom were not verified.
- Classic Sheet light/dark only. Other palette themes, alternate Calendar densities, browser text scaling, loading/saving-disabled states, every task/Calendar dialog, and every popup were not sampled.
- Calendar’s shared help was measured as a new control. Individual Reports/Settings help instances were not measured. The representative event guard checks 46 px height, not all event widths or interaction behavior.
- The task editor has a text-based Section combobox, not a native select. Its Name/Section/Interval inputs were sampled; native select coverage comes from the saved-version control. An absent Settings/task-editor select was not counted as passing.
- Normal/active samples include all navigation destinations, Grid All/Active, Calendar Week/Day, Reports History, Settings appearance selection, and dialog Active/Hiatus. Disabled coverage is Edit Task. No save requests were made to manufacture transient disabled states.
- This is a sizing audit, not a general workflow, performance, release-build, deployment, or accessibility certification. No app changes, dependencies, commit, or push were made.

**Final verdict: not restored.** Several headline controls match, but the exact per-control comparison contains substantial shorter-than-baseline controls and smaller 1–4 px mismatches. “Compact” does not mean “restored to `37c60e5`.”
