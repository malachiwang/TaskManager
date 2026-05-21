use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Keeps the sidecar process alive for the lifetime of the app.
/// Dropping CommandChild kills the process, so we hold it in managed state
/// and let Tauri drop it on exit.
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
                .expect("could not resolve app data directory")
                .join("taskos.db");

            // Ensure the directory exists before the sidecar tries to open it.
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)
                    .expect("could not create app data directory");
            }

            // Spawn the Python/FastAPI sidecar.
            // Tauri looks for: src-tauri/binaries/taskos-server-{target-triple}
            let (_rx, child) = app
                .shell()
                .sidecar("taskos-server")
                .expect("taskos-server sidecar not found — run scripts/build-sidecar.sh first")
                .env("TASKOS_DB_PATH", db_path.to_str().unwrap_or(""))
                .env("TASKOS_PORT", "8765")
                .spawn()
                .expect("failed to spawn taskos-server sidecar");

            // Store child so it stays alive until the app exits.
            *app.state::<SidecarChild>().0.lock().unwrap() = Some(child);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
