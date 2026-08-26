# Claude Project Rules

This is a local-first spreadsheet-like task-pressure tracker.

## Core Identity

This is not a generic todo app.
This is not a SaaS product.
This is not an AI agent.

The app should feel like a spreadsheet:
- rows are tasks
- columns are metadata plus date cells
- user mostly interacts by clicking date cells
- backend handles last done, days since, urgency, history, and persistence

The Calendar view (approved P12 direction) is an additive first-class
scheduling/execution view over the same canonical task records. It does not
replace the Grid and does not change completion semantics.

Core concepts — keep these distinct in the data model (V5: never collapse
them into one generic record type):
- Task: the canonical objective/record (tasks table)
- Session: a scheduled allocation of time toward a task (task_sessions);
  sessions may live in the future; session completion ≠ task completion
- Calendar Entry: a task_sessions row with task_id NULL — records time, not
  an obligation; promotion to the Grid is always an explicit user act
- Depth Window: a user-declared cognitive-capacity region (depth_windows)
- External Calendar Commitment: read-only ICS occurrence (external_calendars
  + external_events, P15.0) — not a task, never auto-completed, always Fixed
- Context: a shared real-world course/project (contexts) — relational
  metadata on tasks, entries, and event series; deleting one deletes nothing
- Academic Candidate: parsed syllabus line (academic_* tables, V5.3) —
  isolated until the user approves it into a canonical record

Semester OS analytics (V5) are facts only: medians + sample counts,
insufficient-data states below the floor, no composite productivity or
efficiency score, no inferred biological capacity, and no automatic
scheduler — the system parses/suggests/forecasts, the user decides. The
natural-language and academic parsers are deterministic local regex ("no AI
APIs" still holds).

## Non-Negotiables

Preserve:
- spreadsheet-grid workflow
- local SQLite source of truth
- completion_count cells, not boolean-only checkboxes
- future cells visible but disabled (grid completions never accept future
  dates; future planning lives only in Calendar sessions)
- paused tasks visible but excluded from urgency recommendations
- never-done tasks use created_at
- effective last done = max(manual override, latest completion, created_at)
- manual ordering is authoritative: section order (section_order table) and
  task order (display_order) stay exactly where the user put them; ordinary
  task actions never reorder sections; new tasks append at the end

Must not include:
- auth
- cloud sync
- AI APIs
- Google Drive
- external calendar WRITE access / OAuth API integrations (read-only ICS
  feed subscriptions ARE in scope as of P15.0 — external commitments render
  as fixed, distinct objects and never become tasks)
- notifications
- mobile app
- public deployment
- payment logic
- Supabase
- Firebase
- Postgres

## Development Rules

Before coding:
- say which ticket is being implemented
- list files to be created or edited
- keep the change small

During coding:
- implement one ticket at a time
- prefer simple boring code
- write tests for date, completion, and urgency logic
- do not add dependencies unless needed
- do not touch unrelated files

Never commit:
- .env files
- API keys
- secrets
- database files
- real personal data
- node_modules
- virtual environments

Use docs/MVP_SCOPE.md as the hard implementation boundary.
Use docs/PRD.md only for broader product context.