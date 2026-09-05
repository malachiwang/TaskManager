# MVP Scope — TaskManagementOS

## MVP Mission

Build a local-first, spreadsheet-like task-pressure tracker that preserves the user’s existing Google Sheets workflow while replacing fragile formulas and monthly resets with persistent backend logic.

The MVP is not a polished productivity app.  
The MVP is not a public SaaS product.  
The MVP is not an AI agent.  

The MVP should prove the core loop:

> The user can open a local app, see a spreadsheet-like task grid, click date cells to record completions, and have the app automatically calculate last-done, days-since, urgency, paused state, and basic dashboard summaries.

The user should mostly interact by clicking task/date cells.

---

## Product Identity

This app is a personal task-pressure operating system.

It should feel closer to a spreadsheet than a traditional todo app.

Core spreadsheet model:

- Rows = tasks
- Columns = metadata + dates
- Cells = completion events
- Backend = persistent source of truth
- Dashboard = passive summary, not a separate planning ritual

The MVP must preserve the user’s existing workflow instead of replacing it with a generic productivity-app workflow.

---

## MVP Stack

Use:

- Backend: Python FastAPI
- Database: SQLite
- Frontend: React + Vite
- Runtime: local development only
- Storage: local SQLite file
- Export: CSV/JSON if easy, otherwise defer

Do not use:

- Supabase
- Firebase
- PostgreSQL
- cloud hosting
- authentication
- user accounts
- AI APIs
- Google Drive API
- external calendar WRITE APIs / OAuth integrations (read-only ICS feed
  subscriptions — e.g. Google Calendar's secret iCal address — are in scope
  as of P15.0; see "Calendar View (P12)" below)
- notifications
- mobile app framework

---

## MVP Must-Have Features

### 1. Local Database

Create a local SQLite database as the source of truth.

The app must persist:

- tasks
- completion events
- completion counts
- task metadata
- paused state
- manual override dates

The app should still work after closing and reopening the browser/local server.

---

### 2. Task Table

Each task should support these fields:

- id
- name
- category
- subtask
- priority
- interval_days
- status
- notes
- created_at
- paused_at
- is_active
- is_paused
- manual_last_done_override
- display_order

Minimum required task fields for MVP UI:

- Priority
- Status
- Category
- Task
- Subtask
- Frequency / interval
- Days Since
- Urgency
- Manual override
- Notes

---

### 3. Completion Table

Each completion event corresponds to a task/date cell.

Each completion should support:

- id
- task_id
- completion_date
- completion_count
- created_timestamp
- updated_timestamp

Completion count is mission-critical.

Do not store completion cells as only true/false.

---

### 4. Multi-Click Completion Cells

Date-grid cells must support counts.

Behavior:

- empty cell = 0 completions
- first click = checkmark / count 1
- second click = 2
- third click = 3
- additional clicks increment count
- shift-click clears the cell

Display behavior:

- 0 = blank
- 1 = ✓
- 2 = 2
- 3 = 3
- 4+ = number

The backend must store the numeric completion_count.

---

### 5. Spreadsheet-Like Main Grid

The MVP frontend should show a simple spreadsheet-like table.

Columns:

- Status
- Priority
- Category
- Task
- Subtask
- Freq
- Days Since
- Urgency
- Manual
- Notes
- Date columns

The first date-grid can be simple:

- show 14 days, or
- show the current month, whichever is easier

MVP does not require perfect styling.

It should be usable before it is beautiful.

---

### 6. Future Date Behavior

Future date cells should be visible but disabled.

Rules:

- future cells appear in the grid
- future cells are visually muted
- future cells cannot be clicked
- cursor or tooltip may indicate unavailable date
- future cells should become active automatically when the date arrives or when the app reloads on that date

These grid rules are permanent: completion cells never accept future dates.

Future *planning* is now in scope, but it lives exclusively in the Calendar
view as sessions (see "Calendar View (P12)" below) — planning a task for a
future date never creates or modifies a completion record. The original MVP
statement "do not implement future planning" is superseded by the approved
Calendar tickets; the grid's own semantics are unchanged.

---

### 7. Paused Task Behavior

Paused tasks should remain visible but muted.

Paused tasks should:

- stay in the grid
- keep their historical completions
- stop accumulating urgency
- be excluded from dashboard recommendations
- be visually distinguishable from active tasks

Paused should mean:

> This task exists, but it is not currently pressuring me.

Paused should not mean deleted.

---

### 8. Never-Done Task Behavior

If a task has never been completed:

- use created_at as the baseline
- calculate days-since from created_at
- display something like “Never” or “Never / X days”
- still compute urgency normally

This prevents new or imported tasks from having undefined urgency.

---

### 9. Manual Override Behavior

Manual override exists because imported tasks may have historical last-done dates from the old spreadsheet.

Effective last done should be:

> max(manual_last_done_override, latest completion_date)

Rules:

- if manual override is newer than latest completion, use manual override
- if latest completion is newer than manual override, use latest completion
- if neither exists, use created_at
- manual override should be visible and editable
- normal use should not require manual override

---

### 10. Days-Since Calculation

Days since should be computed automatically from effective last done.

Rules:

- today’s completion means days_since = 0
- yesterday means days_since = 1
- never-done tasks use created_at
- paused tasks should not keep increasing pressure in the same way active tasks do

The backend should own this calculation.

The frontend should display it.

---

### 11. Urgency Calculation

The MVP must implement the asymptotic urgency formula.

Definitions:

- P = priority
- D = days since last completion
- I = interval_days
- k = growth constant, default 2
- max urgency = 10

Priority base mapping:

```python
if P >= 8:
    base = 0.8 + 0.05 * (P - 8)
elif P >= 5:
    base = 0.35 + 0.15 * (P - 5)
else:
    base = 0.05 + 0.1 * (P - 1)
```

Note: this V1 mapping has since been superseded by Pressure Scoring V2
(`backend/logic.py: calculate_urgency`) — a logistic curve over the overdue
ratio. The invariants above (backend owns the calculation, paused → 0, max 10)
still hold.

---

## Calendar View (P12) — approved extension

The original MVP statements "this is not a calendar app" and "do not implement
future planning" are superseded by the approved Calendar tickets.

The Calendar is:

> an additive first-class scheduling/execution view over the canonical
> TaskManager data model.

It does **not** replace the Grid, and it does **not** change any existing
completion semantics. All original non-negotiables remain in force:

- Grid completion-count behavior (counts, not booleans)
- future-cell behavior (grid completion cells never accept future dates)
- urgency calculations
- existing record semantics and data-integrity rules

The data model distinguishes four concepts. Keep them distinct:

### Task

The canonical objective/record (`tasks` table). One task, many views —
Grid rows and Calendar blocks are the same record.

### Session

A scheduled allocation of time toward a task (`task_sessions` table).
A task may have many sessions; sessions may live in the future; completing a
session is not the same as completing the task. Planned fields
(`planned_start`/`planned_end`) are never overwritten by actual execution
(`actual_*` fields).

### Depth Window

A user-declared cognitive-capacity region (`depth_windows` table): what kind
of work a stretch of time is *for* (D1 deep / D2 focused / D3 shallow).
One-off (date) or recurring (weekday). Not a task; never has completions.

### External Calendar Commitment

Classes, meetings, appointments — externally fixed time (P15.0:
`external_calendars` + `external_events`, populated from read-only ICS
feeds). Commitments are not tasks, are never auto-completed, default to
Fixed for replanning, and their sync failures never affect core surfaces.

External calendar WRITE access (creating/editing events upstream, OAuth
APIs) remains out of scope.

Reference: the approved Calendar MVP as verified —
`docs/images/calendar-mvp.jpg`.

---

## Manual Ordering (P12.1)

The user's manual arrangement is deliberate and authoritative:

- Section order is explicit persisted state (`section_order` table), never
  derived from task encounter order, creation time, or alphabetics.
- Task order is explicit persisted state (`tasks.display_order`); new tasks
  append at the end.
- Ordinary task actions (create, complete, edit, delete, move, reload,
  switching views) must never reorder sections or other tasks.
- Every insertion position is reachable by drag and drop: top, between any
  two rows, the true bottom of a section, and into empty sections.
- Cross-section drag applies the section change and the new position in one
  backend transaction (`POST /tasks/reorder` with `section_updates`).
---

## Semester OS (V5) — approved extension

V5 layers power-user operation, academic import, and execution analytics
over the same canonical records. Nothing below changes Grid or Calendar
completion semantics, and the user remains authoritative throughout: the
system parses, suggests, ranks, and forecasts, but never silently creates
tasks, schedules work, changes deadlines, rewrites estimates, reorders the
Grid, moves sessions, or marks work complete.

### Contexts on calendar entries

Calendar-only entries may carry a context/course (`task_sessions.context_id`,
Migration 18). Relational metadata only — assigning or clearing it never
alters the entry. Linked sessions keep taking context from their task.

### Event-move proposals

When a linked external event moves, TaskManager computes a repositioning
proposal for related *Flexible* scheduled sessions (`/event-move-proposals`)
and offers it (move all / keep / review individually). Fixed sessions are
never proposed; nothing moves without an explicit choice.

### Command palette, keyboard scheduling, density

⌘K/Ctrl+K palette dispatches to the same handlers the buttons use, with
context-aware session commands. Selected scheduled blocks move with
↑/↓ (±15m, Shift ±30m), jump days with ⌥←/→, and resize with
⌘/Ctrl+Shift+↑/↓ — settled (completed/partial/skipped) sessions never move.
Vertical density (Compact/Standard/Detailed) is persisted and never changes
snapping semantics. Session duplication offers tomorrow / next week / pick
date for sessions **and** entries, always reusing the same canonical record.

### Natural-language scheduling and search

`/nl/parse` is a deterministic regex parser (no AI, no network): it only
interprets, and the creation popover shows the interpretation — including
every assumption — for confirmation. Calendar-only remains the default
outcome. `/search` spans tasks, sessions, entries, external events, and
contexts with type/date/status/context filters; selecting a dated result
navigates the Calendar to it.

### Academic importer

Architecture is fixed as: Source → parser → **candidate records**
(`academic_batches`/`academic_candidates`, Migration 19) → user review →
approved canonical records. Parsing is deterministic and local (pasted
syllabus/schedule text is the supported pathway; PDF/Canvas remain
architectural seams). Candidates keep their exact source line as evidence.
Approval semantics: dated obligations → Grid tasks with `due_date` and the
course as section/context; timed exams → fixed calendar entries; recurring
class/office hours → fixed entries expanded only through a user-chosen
horizon. Duplicates and changed dates are detected and surfaced — an
accepted date change updates the existing task instead of duplicating.
Rejected candidates create nothing; import failures never touch canonical
tables.

### Calendar recurrence (recurring sessions/entries)

A `recurrence_series` row describes a local recurring SCHEDULE ("every
Tuesday 3–4 PM") for one canonical task's sessions or one calendar-only
entry — scheduling recurrence, deliberately distinct from the Grid's
`tasks.interval_days` pressure recurrence, and never offered for external
ICS commitments. Weekly is a one-click action everywhere a block is created
(creator popover, quick popover "Repeat weekly", placement banner
Once/Weekly, NL phrases like "every tuesday", "mwf", "every other thursday",
"until dec 8"); custom rules add multi-weekday, every-N-weeks, and
end-by-date/count.

Occurrences are ordinary `task_sessions` rows materialized lazily over the
fetched window (plus series-start→today for reconciliation), with
deterministic slot identity `(series_id, occurrence_date)` enforced by a
partial UNIQUE index — regeneration is duplicate-proof. Every occurrence
stays individually executable; moving one detaches it (`series_detached`)
and deleting one records a `recurrence_skips` row (the depth-window-skip
pattern). Edits offer This occurrence / This and following (series split) /
All occurrences; executed history and past planned times are never
rewritten, recurrence never duplicates canonical tasks, and a Finished
task's end_date stops future generation without touching history.
Removal follows the same grammar: one-off blocks keep plain "Remove",
recurring occurrences show "Remove…" and always require an explicit scope
choice (defaulting to the narrowest, This occurrence) before anything is
deleted.

### Execution analytics (Reports · Execution, Dashboard signals)

`/reports/execution`, `/reports/estimates`, `/reports/patterns`, and
`/forecast` are read-only facts: planned vs actual (calendar-only entries
totaled separately unless deliberately included), estimate-accuracy medians,
behavioral observations with sample counts, and a weekly load forecast that
separates Fixed commitments from Flexible estimated work and places
remaining effort only in its deadline's week (undated work is listed, never
placed). Hard rules: medians + n over averages; groups under the sample
floor say "not enough history yet"; **no composite productivity/efficiency
score exists**, and **no biological cognitive capacity is ever inferred** —
only user-declared depth windows and estimates are compared.

Reference screenshots: `docs/images/calendar-v5-semester-os.jpg`,
`docs/images/reports-execution-v5.jpg`.
