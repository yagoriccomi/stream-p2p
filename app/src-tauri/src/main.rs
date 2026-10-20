// Stream P2P desktop: the window loads the same web app as the browser and adds
// native source listing (T12), a system tray (T13) and auto-update (T14).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::io::Cursor;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

const ICON_IDLE: &[u8] = include_bytes!("../icons/tray.png");
const ICON_LIVE: &[u8] = include_bytes!("../icons/tray-live.png");

#[derive(Serialize)]
struct Source {
    id: String,
    kind: &'static str, // "monitor" | "window" (the tabs in T02)
    name: String,
    thumb: Option<String>, // data: URL, 320 px wide
}

fn thumb(img: image::RgbaImage) -> Option<String> {
    let w = 320;
    let h = (img.height() * w / img.width().max(1)).max(1);
    let small = image::imageops::thumbnail(&img, w, h);
    let mut png = Vec::new();
    small.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

// T12 · monitors and open windows with thumbnails. Capture runs off the main thread.
#[tauri::command]
async fn list_sources() -> Result<Vec<Source>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        for (i, m) in xcap::Monitor::all().map_err(|e| e.to_string())?.into_iter().enumerate() {
            let name = m.friendly_name().or_else(|_| m.name()).unwrap_or_else(|_| format!("Monitor {}", i + 1));
            let primary = if m.is_primary().unwrap_or(false) { " (principal)" } else { "" };
            out.push(Source {
                id: format!("monitor:{}", m.id().unwrap_or(i as u32)),
                kind: "monitor",
                name: format!("{name}{primary}"),
                thumb: m.capture_image().ok().and_then(thumb),
            });
        }
        for w in xcap::Window::all().map_err(|e| e.to_string())? {
            let title = w.title().unwrap_or_default();
            if title.is_empty() || w.is_minimized().unwrap_or(false) || w.width().unwrap_or(0) < 120 {
                continue;
            }
            out.push(Source {
                id: format!("window:{}", w.id().unwrap_or(0)),
                kind: "window",
                name: format!("{} · {}", w.app_name().unwrap_or_default(), title),
                thumb: w.capture_image().ok().and_then(thumb),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Tray(TrayIcon);

// T13 · green tray icon + tooltip while this user is the one presenting.
#[tauri::command]
fn set_tray_live(live: bool, tray: State<Tray>) -> Result<(), String> {
    let icon = Image::from_bytes(if live { ICON_LIVE } else { ICON_IDLE }).map_err(|e| e.to_string())?;
    tray.0.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    tray.0
        .set_tooltip(Some(if live { "Stream P2P · Ao vivo" } else { "Stream P2P" }))
        .map_err(|e| e.to_string())
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![list_sources, set_tray_live])
        .setup(|app| {
            // The web app listens to the 'tray' event: stop | mute | copy.
            let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
            let menu = Menu::with_items(app, &[
                &item("open", "Abrir o Stream P2P")?,
                &PredefinedMenuItem::separator(app)?,
                &item("stop", "Parar transmissão")?,
                &item("mute", "Silenciar mic")?,
                &item("copy", "Copiar convite")?,
                &PredefinedMenuItem::separator(app)?,
                &item("quit", "Sair")?,
            ])?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(ICON_IDLE)?)
                .tooltip("Stream P2P")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    cmd => {
                        let _ = app.emit("tray", cmd);
                    }
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(Tray(tray));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Stream P2P");
}
