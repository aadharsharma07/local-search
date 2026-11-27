//! The popup's native side: a global hotkey that shows a search window, a tray icon to quit,
//! start-at-logon, and commands the window calls. Searching itself happens in lsd serve; this
//! side only reads its port and token, and opens files that live in the indexed folders.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_HOTKEY: &str = "Alt+Space";
const DEFAULT_PORT: u16 = 7337;

/// Folders the daemon indexes: the only places the popup may open files or load thumbnails from.
#[derive(Default)]
struct Roots(Mutex<Vec<PathBuf>>);

#[derive(Serialize)]
struct DaemonInfo {
    port: u16,
    token: String,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().home_dir().map_err(|e| e.to_string())?.join(".local-search"))
}

/// `port:` from config.yaml, if set. A one-line read; the daemon owns the full config format.
fn port_from_config(text: &str) -> Option<u16> {
    text.lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("port:"))
        .and_then(|v| v.split('#').next())
        .and_then(|v| v.trim().parse().ok())
}

/// Case-insensitive on Windows, where paths are; component-wise everywhere.
fn under(path: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        let low = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase().replace('/', "\\"));
        low(path).starts_with(low(root))
    } else {
        path.starts_with(root)
    }
}

fn check_allowed(path: &str, roots: &State<Roots>) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("path contains ..".into());
    }
    let roots = roots.0.lock().unwrap();
    if roots.iter().any(|r| under(&p, r)) {
        Ok(p)
    } else {
        Err("not in an indexed folder".into())
    }
}

#[tauri::command]
fn daemon_info(app: AppHandle) -> Result<DaemonInfo, String> {
    let dir = data_dir(&app)?;
    let token = std::fs::read_to_string(dir.join("token"))
        .map_err(|_| "no token: lsd serve has not started".to_string())?
        .trim()
        .to_string();
    let port = std::fs::read_to_string(dir.join("config.yaml"))
        .ok()
        .and_then(|t| port_from_config(&t))
        .unwrap_or(DEFAULT_PORT);
    Ok(DaemonInfo { port, token })
}

#[tauri::command]
fn allow_roots(app: AppHandle, roots: Vec<String>, state: State<Roots>) -> Result<(), String> {
    let scope = app.asset_protocol_scope();
    let mut kept = state.0.lock().unwrap();
    for r in roots {
        let p = PathBuf::from(&r);
        if !p.is_absolute() || kept.contains(&p) {
            continue;
        }
        scope.allow_directory(&p, true).map_err(|e| e.to_string())?;
        kept.push(p);
    }
    Ok(())
}

#[tauri::command]
fn set_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    register_hotkey(&app, &hotkey)
}

#[tauri::command]
fn hide_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn open_file(app: AppHandle, path: String, roots: State<Roots>) -> Result<(), String> {
    let p = check_allowed(&path, &roots)?;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_file(app: AppHandle, path: String, roots: State<Roots>) -> Result<(), String> {
    let p = check_allowed(&path, &roots)?;
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let shortcut: Shortcut = hotkey.parse().map_err(|e| format!("bad hotkey {hotkey}: {e}"))?;
    let gs = app.global_shortcut();
    if gs.is_registered(shortcut) {
        return Ok(());
    }
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.register(shortcut).map_err(|e| e.to_string())
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("popup://shown", ());
    }
}

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show(app);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a second launch (e.g. from the Start menu) shows the running popup instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(Roots::default())
        .invoke_handler(tauri::generate_handler![daemon_info, allow_roots, set_hotkey, hide_popup, open_file, reveal_file])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = register_hotkey(&handle, DEFAULT_HOTKEY) {
                eprintln!("hotkey: {e}");
            }

            // Installed builds on Windows start at logon; dev builds never touch autostart.
            #[cfg(all(windows, not(debug_assertions)))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            let search = MenuItem::with_id(app, "show", "Search", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit local-search", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&search, &quit])?;
            let mut tray = TrayIconBuilder::new().tooltip("local-search").menu(&menu).on_menu_event(|app, e| match e.id.as_ref() {
                "show" => show(app),
                "quit" => app.exit(0),
                _ => {}
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // In dev, show the window right away so there is something to look at.
            if cfg!(debug_assertions) {
                show(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // A launcher popup: clicking elsewhere hides it. The page does the hiding, so it can
            // record the search first (and ignore the blur that opening a file causes).
            if let WindowEvent::Focused(false) = event {
                let _ = window.emit("popup://blur", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the local-search popup");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_port_from_config() {
        assert_eq!(port_from_config("roots:\n  - a\nport: 8123 # custom\n"), Some(8123));
        assert_eq!(port_from_config("rerank: false\n"), None);
        assert_eq!(port_from_config("port: nope"), None);
    }

    #[test]
    fn only_paths_under_a_root() {
        let root = if cfg!(windows) { PathBuf::from("C:\\Users\\me\\Documents") } else { PathBuf::from("/Users/me/Documents") };
        let inside = root.join("Taxes").join("2023.pdf");
        assert!(under(&inside, &root));
        let sibling = PathBuf::from(format!("{}2", root.display()));
        assert!(!under(&sibling, &root)); // Documents2 is not inside Documents
        if cfg!(windows) {
            assert!(under(Path::new("c:/users/ME/documents/x.pdf"), &root));
        }
    }
}
