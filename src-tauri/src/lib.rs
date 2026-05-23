use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Keeps the sidecar process alive for the lifetime of the app.
/// Dropping CommandChild sends SIGKILL to the process, so we hold it in
/// managed state and let Tauri drop it on exit.
struct SidecarChild(Mutex<Option<CommandChild>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarChild(Mutex::new(None)))
        .setup(|app| {
            // Compute the platform app-data directory for the packaged DB.
            // On macOS: ~/Library/Application Support/com.taskos.desktop/
            let db_path = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("could not resolve app data directory: {e}"))?
                .join("taskos.db");

            eprintln!("[taskos] db_path = {}", db_path.display());

            // Ensure the directory exists before the sidecar tries to open it.
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create app data directory: {e}"))?;
            }

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
