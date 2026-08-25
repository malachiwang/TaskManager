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
- external calendar APIs (Google Calendar sync, etc. — the built-in Calendar
  view is in scope; see "Calendar View (P12)" below)
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

A future concept: classes, meetings, appointments — externally fixed time.
Not yet implemented. When added, commitments are not tasks and are never
auto-completed.

External calendar *integration* (Google Calendar APIs, sync) remains out of
scope for now.

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