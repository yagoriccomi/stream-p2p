// App commands are called from a remote page, so each one needs an ACL permission
// (allow-<command>) that the capability grants; see allow_ipc in main.rs.
const COMMANDS: &[&str] = &["list_sources", "set_tray_live", "set_status", "system_audio_start", "system_audio_stop", "pick_source", "list_audio_sessions"];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build");
}
