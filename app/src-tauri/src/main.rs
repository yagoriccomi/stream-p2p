// Stream P2P desktop: the window loads the same web app as the browser and adds
// native source listing (T12), a system tray (T13), auto-update (T14) and a command line.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
#[cfg(windows)]
mod picker;
#[cfg(windows)]
mod sysaudio;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{fs, io::Cursor, path::PathBuf, process::ExitCode, time::{SystemTime, UNIX_EPOCH}};
use tauri::{
    image::Image,
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder,
};

// Until there is a public server; --server or the installer's /SERVER= override it.
const DEFAULT_SERVER: &str = "http://localhost:3000";
// Same folder Tauri uses for this identifier; the NSIS hook writes server.txt here too.
const IDENTIFIER: &str = "app.streamp2p.desktop";
const STATUS_STALE_MS: u128 = 10_000; // the web app refreshes status every 2 s
const EXIT_BAD_ARGS: u8 = 2;
const EXIT_NOT_RUNNING: u8 = 3;

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

// The source chosen in the app's grid (an id from list_sources) is picked in Chromium's own
// picker out of sight (see picker.rs), so the person only sees one selection. Call it right
// before getDisplayMedia.
#[cfg(windows)]
#[tauri::command]
async fn pick_source(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    let target = match id.split_once(':') {
        Some(("window", hwnd)) => picker::Target::Window(picker::window_title(hwnd.parse().map_err(|_| "id de janela inválido")?)),
        Some(("monitor", _)) => tauri::async_runtime::spawn_blocking(move || {
            let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
            let pos = monitors.iter().enumerate().position(|(i, m)| format!("monitor:{}", m.id().unwrap_or(i as u32)) == id);
            pos.map(picker::Target::Monitor).ok_or_else(|| "monitor não existe mais".to_string())
        })
        .await
        .map_err(|e| e.to_string())??,
        _ => return Err(format!("fonte desconhecida: {id}")),
    };
    picker::arm(window.hwnd().map_err(|e| e.to_string())?.0 as isize, target);
    Ok(())
}
#[cfg(not(windows))]
#[tauri::command]
async fn pick_source(_id: String) -> Result<(), String> {
    Err("escolha pela lista do app só existe no Windows".into())
}

// System audio for the stream, captured natively (see sysaudio.rs). Chunks of stereo f32 at
// sysaudio::RATE go to `out`; the page checks for these commands, so an older app still works.
// With `window` (the shared window's HWND) only that program's sound goes out.
#[cfg(windows)]
#[tauri::command]
async fn system_audio_start(out: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>, window: Option<u64>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || sysaudio::start(out, window)).await.map_err(|e| e.to_string())??;
    Ok(sysaudio::RATE)
}
#[cfg(not(windows))]
#[tauri::command]
async fn system_audio_start(_out: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>, _window: Option<u64>) -> Result<usize, String> {
    Err("áudio do sistema pelo app só existe no Windows".into())
}

#[tauri::command]
fn system_audio_stop() {
    #[cfg(windows)]
    sysaudio::stop();
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

fn config_dir() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join(IDENTIFIER)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

// Written by the web app on every change so `--status` (another process) can read it.
#[tauri::command]
fn set_status(mut status: serde_json::Value) -> Result<(), String> {
    status["updatedAt"] = serde_json::json!(now_ms() as u64);
    status["running"] = serde_json::json!(true);
    write_status(&status)
}

fn write_status(status: &serde_json::Value) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("status.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(status).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("status.json")).map_err(|e| e.to_string()) // atomic: readers never see half a file
}

fn read_status() -> serde_json::Value {
    let mut status = fs::read(config_dir().join("status.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .unwrap_or_else(|| serde_json::json!({ "running": false }));
    let age = status["updatedAt"].as_u64().map(|t| now_ms().saturating_sub(t as u128));
    if age.map_or(true, |a| a > STATUS_STALE_MS) {
        status["running"] = serde_json::json!(false);
        status["stale"] = serde_json::json!(true);
    }
    status
}

fn save_server(server: &str) {
    let _ = fs::create_dir_all(config_dir());
    let _ = fs::write(config_dir().join("server.txt"), server);
}

fn server_from_disk() -> Option<String> {
    let raw = fs::read_to_string(config_dir().join("server.txt")).ok()?;
    cli::valid_server(raw.trim()).ok()
}

// A GUI-subsystem exe has no console; borrow the caller's so --help/--status print there.
fn attach_console() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

// The single-instance plugin's hidden window: present exactly while the app is running.
#[cfg(windows)]
fn instance_running() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW;
    let wide = |s: String| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (class, title) = (wide(format!("{IDENTIFIER}-sic")), wide(format!("{IDENTIFIER}-siw")));
    !unsafe { FindWindowW(class.as_ptr(), title.as_ptr()) }.is_null()
}
#[cfg(not(windows))]
fn instance_running() -> bool {
    read_status()["running"].as_bool().unwrap_or(false)
}

struct Server(String);

// Runs in the first instance for args given to a later one (single-instance plugin).
fn apply(app: &AppHandle, args: cli::Cli) {
    if let Some(server) = &args.server {
        save_server(server);
    }
    let server = args.server.clone().unwrap_or_else(|| app.state::<Server>().0.clone());
    if let (Some(open), Some(w)) = (&args.open, app.get_webview_window("main")) {
        allow_ipc(app, &server);
        let _ = w.navigate(cli::start_url(&server, open));
        show(app);
    }
    if args.remote.is_empty() && args.open.is_none() {
        show(app); // starting the app again just brings it forward
    }
    for cmd in args.remote {
        match cmd {
            cli::Remote::Show => show(app),
            cli::Remote::Quit => app.exit(0),
            other => {
                let _ = app.emit("tray", other.event());
            }
        }
    }
}

// The page is remote and its URL is only known at runtime: grant IPC to that origin alone.
fn allow_ipc(app: &AppHandle, server: &str) {
    let cap = CapabilityBuilder::new(format!("server-{server}"))
        .remote(format!("{server}/*"))
        .window("main")
        .permission("core:default")
        .permission("core:event:default")
        .permission("updater:default")
        .permission("process:allow-restart")
        .permission("allow-list-sources")
        .permission("allow-set-tray-live")
        .permission("allow-set-status")
        .permission("allow-system-audio-start")
        .permission("allow-system-audio-stop")
        .permission("allow-pick-source");
    if let Err(e) = app.add_capability(cap) {
        eprintln!("capability: {e}");
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() -> ExitCode {
    let args = match cli::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(e) => {
            attach_console();
            eprintln!("{e}\n\n{}", cli::HELP);
            return ExitCode::from(EXIT_BAD_ARGS);
        }
    };
    if let Some(query) = args.query {
        attach_console();
        match query {
            cli::Query::Help => println!("{}", cli::HELP),
            cli::Query::Version => println!("{}", env!("CARGO_PKG_VERSION")),
            cli::Query::Status => println!("{}", serde_json::to_string_pretty(&read_status()).unwrap_or_default()),
        }
        return ExitCode::SUCCESS;
    }
    // A remote command with no running instance: single-instance would have forwarded it otherwise.
    let only_remote = args.open.is_none() && args.server.is_none() && !args.remote.is_empty();
    if only_remote && !args.remote.contains(&cli::Remote::Show) && !instance_running() {
        attach_console();
        eprintln!("O Stream P2P não está aberto.");
        return ExitCode::from(EXIT_NOT_RUNNING);
    }
    if let Some(s) = &args.server {
        save_server(s);
    }
    let server = args.server.clone().or_else(server_from_disk).unwrap_or_else(|| DEFAULT_SERVER.into());
    let start = cli::start_url(&server, args.open.as_ref().unwrap_or(&cli::Open::Home));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| match cli::parse(argv.into_iter().skip(1)) {
            Ok(args) => apply(app, args),
            Err(e) => eprintln!("{e}"),
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![list_sources, set_tray_live, set_status, system_audio_start, system_audio_stop, pick_source])
        .manage(Server(server.clone()))
        .setup(move |app| {
            allow_ipc(app.handle(), &server);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start.clone()))
                .additional_browser_args(&cli::browser_args(&server))
                .title("Stream P2P")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
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
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Stream P2P");
    app.run(|_, event| {
        if let RunEvent::Exit = event {
            let _ = write_status(&serde_json::json!({ "running": false, "updatedAt": now_ms() as u64 }));
        }
    });
    ExitCode::SUCCESS
}
