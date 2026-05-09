# Claude Project Rules

This is a local-first spreadsheet-like task-pressure tracker.

## Core Identity

This is not a generic todo app.
This is not a SaaS product.
This is not an AI agent.
This is not a calendar app.

The app should feel like a spreadsheet:
- rows are tasks
- columns are metadata plus date cells
- user mostly interacts by clicking date cells
- backend handles last done, days since, urgency, history, and persistence

## Non-Negotiables

Preserve:
- spreadsheet-grid workflow
- local SQLite source of truth
- completion_count cells, not boolean-only checkboxes
- future cells visible but disabled
- paused tasks visible but excluded from urgency recommendations
- never-done tasks use created_at
- effective last done = max(manual override, latest completion, created_at)

MVP must not include:
- auth
- cloud sync
- AI APIs
- Google Drive
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