use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Keeps the sidecar process alive for the lifetime of the app, and gives the
/// exit handler something to terminate. tauri-plugin-shell's CommandChild has
/// no Drop handler, so the child is NOT cleaned up automatically — see the
/// RunEvent::Exit handler at the bottom of run().
struct SidecarChild(Mutex<Option<CommandChild>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // External safe-link opening (P10.0) — the webview intercepts clicks on
        // validated http/https/mailto links and opens them in the system
        // browser / mail client. Scope is restricted in capabilities/default.json.
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarChild(Mutex::new(None)))
        .setup(|app| {
            // Canonical local database (P17 §4): ~/.taskmanager/taskos.db —
            // the same path the dev backend documents, so the packaged app and
            // development share exactly one dataset and the "old app vs new
            // app" split cannot recur. Pre-P17 packaged builds stored the DB
            // in the platform app-data dir; if the canonical file does not
            // exist yet but that legacy DB does, adopt it by copying the DB
            // plus its WAL/SHM companions (safe: this app has not opened it
            // yet). When both exist, the canonical file wins and the legacy
            // copy is left untouched.
            let db_path = match std::env::var("HOME") {
                Ok(home) => {
                    let canonical_dir = std::path::PathBuf::from(&home).join(".taskmanager");
                    std::fs::create_dir_all(&canonical_dir)
                        .map_err(|e| format!("could not create {}: {e}", canonical_dir.display()))?;
                    let canonical = canonical_dir.join("taskos.db");
                    if !canonical.exists() {
                        if let Ok(legacy_dir) = app.path().app_data_dir() {
                            if legacy_dir.join("taskos.db").exists() {
                                for ext in ["", "-wal", "-shm"] {
                                    let src = legacy_dir.join(format!("taskos.db{ext}"));
                                    if src.exists() {
                                        let dst = canonical_dir.join(format!("taskos.db{ext}"));
                                        if let Err(e) = std::fs::copy(&src, &dst) {
                                            eprintln!("[taskos] legacy DB copy failed ({}): {e}", src.display());
                                        }
                                    }
                                }
                                eprintln!(
                                    "[taskos] adopted legacy database from {}",
                                    legacy_dir.display()
                                );
                            }
                        }
                    }
                    canonical
                }
                // No HOME (never the case on macOS) — keep the old app-data
                // behavior rather than failing to launch.
                Err(_) => {
                    let dir = app
                        .path()
                        .app_data_dir()
                        .map_err(|e| format!("could not resolve app data directory: {e}"))?;
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| format!("could not create app data directory: {e}"))?;
                    dir.join("taskos.db")
                }
            };

            eprintln!("[taskos] db_path = {}", db_path.display());

            // Spawn the Python/FastAPI sidecar.
            // Tauri resolves: <Contents/MacOS>/taskos-server  (strips target-triple suffix)
            let (mut rx, child) = app
                .shell()
                .sidecar("taskos-server")
                .map_err(|e| format!("taskos-server sidecar not found — run scripts/build-sidecar.sh first: {e}"))?
                .env("TASKOS_DB_PATH", db_path.to_str().unwrap_or(""))
                .env("TASKOS_PORT", "8765")
                .spawn()
                .map_err(|e| format!("failed to spawn taskos-server sidecar: {e}"))?;

            eprintln!("[taskos] sidecar spawned (pid {})", child.pid());

            // Drain sidecar stdout/stderr in a background task.
            //
            // This is required for two reasons:
            //   1. Observability: sidecar log lines (uvicorn startup, errors, tracebacks)
            //      appear in the Tauri app's stderr and are visible via `open … 2>log`
            //      or Console.app during debugging.
            //   2. Pipe health: tauri-plugin-shell uses a bounded channel (capacity 1).
            //      If nobody reads `rx`, the channel fills and the background reader
            //      thread blocks on tx.send(), stalling the OS-level pipe read. A stalled
            //      pipe causes the sidecar's write to stdout/stderr to block under
            //      back-pressure, which can hang uvicorn's startup logging and prevent
            //      it from reaching the event-loop accept() call on port 8765.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!(
                                "[sidecar] terminated — code={:?}  signal={:?}",
                                payload.code, payload.signal
                            );
                            break;
                        }
                        _ => {}
                    }
                }
                eprintln!("[taskos] sidecar event stream closed");
            });

            // Store child so it stays alive until the app exits.
            *app.state::<SidecarChild>().0.lock().unwrap() = Some(child);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Terminate the sidecar when the app quits.
            //
            // Without this the sidecar outlives the app: tauri-plugin-shell's
            // CommandChild has no Drop handler, so holding it in managed state
            // never stops it — on quit it is reparented to launchd and keeps
            // port 8765 bound. The next launch's sidecar then fails to bind and
            // exits, leaving the new window talking to the stale backend.
            //
            // SIGTERM, not CommandChild::kill(): kill() sends SIGKILL, which
            // terminates the PyInstaller bootloader but orphans the uvicorn
            // process it spawned — that orphan is the one holding the port. The
            // bootloader forwards SIGTERM to its child, so both exit cleanly.
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<SidecarChild>();
                let child = state.0.lock().unwrap().take();
                if let Some(child) = child {
                    let pid = child.pid();
                    let _ = std::process::Command::new("/bin/kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                    eprintln!("[taskos] sent SIGTERM to sidecar (pid {pid}) on exit");
                }
            }
        });
}
