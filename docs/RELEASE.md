# Producing a macOS release build

This is the maintainer-side guide for packaging TaskManager into a
distributable macOS app. End-user install instructions live in
[INSTALL.md](INSTALL.md).

## What gets built

- `src-tauri/target/release/bundle/macos/TaskManager.app` — the app bundle
- `src-tauri/target/release/bundle/dmg/TaskManager_<version>_<arch>.dmg` — the
  disk image to attach to a GitHub Release

The bundle embeds the Python backend as a PyInstaller "sidecar" binary that
the Tauri shell starts on port `8765`. The packaged app stores its database in
the platform app-data directory, completely separate from any dev database.

Builds are **unsigned and not notarized** (no paid Apple Developer account).
Users must right-click → Open on first launch; INSTALL.md documents this
honestly. Do not describe releases as signed, notarized, or auto-updating.

## Prerequisites

- macOS with Xcode command-line tools
- Rust toolchain (`rustup`, stable)
- Python 3.11+ venv with `requirements.txt` installed (includes PyInstaller)
- Node 18+ with frontend deps installed: `npm --prefix frontend ci` (or install)

## One-command build

```bash
./scripts/package-macos.sh
```

The script:

1. verifies it is running at the repo root,
2. runs `scripts/build-sidecar.sh` (PyInstaller backend sidecar),
3. builds the frontend with `VITE_API_BASE=http://127.0.0.1:8765`
   (the packaged backend port — required, do not skip),
4. runs `npm --prefix frontend run tauri:build`,
5. prints the output `.app`/`.dmg` locations.

Architecture note: the build targets the machine it runs on (`aarch64` on
Apple Silicon, `x86_64` on Intel). Cross-builds are not set up.

## Smoke-test the bundle before releasing

```bash
rm -rf "/Applications/TaskManager.app"
ditto "src-tauri/target/release/bundle/macos/TaskManager.app" "/Applications/TaskManager.app"
xattr -dr com.apple.quarantine "/Applications/TaskManager.app" 2>/dev/null || true

open "/Applications/TaskManager.app"
sleep 7
curl -sS http://127.0.0.1:8765/health          # expect {"status":"ok"}
```

Then click around: grid loads, completions toggle, a safe link opens in the
system browser, Settings → backup export downloads.

## Publishing (manual)

1. Bump the version in `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`
   if appropriate.
2. Build with `./scripts/package-macos.sh`.
3. Create a GitHub Release and attach the `.dmg` from
   `src-tauri/target/release/bundle/dmg/`.
4. In the release notes, link to `docs/INSTALL.md` and repeat the one-line
   unsigned-app disclaimer.

There is currently **no CI release workflow** — releases are built manually on
a maintainer's machine with the steps above. (A GitHub Actions build without
signing is possible later; it needs no secrets, but has intentionally not been
added yet.)

## Hygiene

- Never commit `src-tauri/target/`, `frontend/dist/`, `dist-sidecar/`,
  `build-sidecar-tmp/`, `.app` bundles, or `.dmg` files — all are generated.
- Never commit `taskos.db` / `*.db-wal` / `*.db-shm` or personal data.
- Check `git status` after building; the build should leave the tree clean
  apart from intentional source changes.
