// OX Island for Windows (Coucou 0.5 for Windows): a bar at the top centre of
// the screen, always on top, never taking the focus, showing ox's island page
// (src/web/island.html, served by `ox island web` on 127.0.0.1 with a token).
// Hold Ctrl+Alt+Space to talk: the page records, ox writes the words where
// you are. The bar grows while the pointer is over it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{path::PathBuf, process::Command, thread, time::Duration};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const SMALL: (f64, f64) = (560.0, 64.0);
const BIG: (f64, f64) = (660.0, 440.0);

fn island_file() -> PathBuf {
    let home = std::env::var("OX_HOME").map(PathBuf::from).unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".ox"));
    home.join("island.json")
}

/// The URL `ox island web` wrote (with its token), once it is up.
fn island_url() -> Option<String> {
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(island_file()).ok()?).ok()?;
    if doc.get("kind")?.as_str()? != "web" { return None; }
    Some(doc.get("url")?.as_str()?.to_string())
}

/// Centred at the top of the screen the window is on.
fn place(w: &WebviewWindow, size: (f64, f64)) {
    let _ = w.set_size(LogicalSize::new(size.0, size.1));
    if let Ok(Some(m)) = w.current_monitor() {
        let scale = m.scale_factor();
        let x = m.position().x + ((m.size().width as f64 - size.0 * scale) / 2.0) as i32;
        let _ = w.set_position(PhysicalPosition::new(x, m.position().y));
    }
}

#[tauri::command]
fn ox_expand(window: WebviewWindow, open: bool) {
    place(&window, if open { BIG } else { SMALL });
}

fn main() {
    let talk = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &talk {
                        let down = event.state() == ShortcutState::Pressed;
                        let _ = app.emit("ox-talk", serde_json::json!({ "down": down }));
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![ox_expand])
        .setup(move |app| {
            app.global_shortcut().register(talk)?;
            let w = app.get_webview_window("island").expect("the island window");
            place(&w, SMALL);
            // Start the island page (ox on PATH), unless one already runs.
            if island_url().is_none() {
                let _ = Command::new("cmd").args(["/C", "ox", "island", "web", "--no-open"]).spawn();
            }
            thread::spawn(move || {
                for _ in 0..120 {
                    if let Some(url) = island_url() {
                        if let Ok(u) = url.parse() { let _ = w.navigate(u); }
                        return;
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("OX Island could not start");
}
