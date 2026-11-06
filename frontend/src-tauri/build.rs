fn main() {
    // The UI is served by our loopback backend. Tauri requires explicit
    // capability grants for app commands invoked from that origin.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "needs_you_notify", "set_badge_count", "focus_main_window", "window_is_focused",
            "desktop_update_status", "desktop_update_check", "desktop_update_automatic",
            "desktop_update_download", "desktop_update_install", "desktop_update_restart",
        ]),
    )).expect("Could not build the IVE command permissions");
}
