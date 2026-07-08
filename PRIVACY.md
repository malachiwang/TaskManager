# Privacy

TaskManager is a local-first desktop and browser application. All data stays on your machine.

## What data is stored

- Task records, completion history, cell notes, and archive snapshots are stored in a local SQLite file (`taskos.db`).
- Display preferences (theme, column widths, keyboard shortcuts, saved views) are stored in your browser's localStorage.
- No data is transmitted to any external server.

## What data is NOT collected

- No analytics or telemetry.
- No crash reports.
- No authentication or user accounts.
- No cloud sync of any kind.
- No cookies beyond what your browser stores locally.
- Your data is never sold, shared, or used for advertising.

## Network activity

All network traffic is localhost only. The backend API runs on `localhost:8000` and is not accessible from any other device or the internet.

## Backups

Backup files (`.db` and `.json` exports) are written to your local disk at paths you choose. They are never uploaded anywhere. Because you can export and move these files yourself, protecting them once they leave the app is your responsibility.

## Future changes

TaskManager currently has no cloud sync and no accounts. If optional sync, accounts, or any other feature that transmits data off your device is ever added, this policy will be updated to describe it before that feature ships.

## Third-party services

None. There are no third-party SDKs, ad networks, or external API calls in this application.

## Contact

This is a personal-use tool. There is no support or contact channel.
