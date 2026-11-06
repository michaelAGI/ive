//! Signed GitHub updates. Only our own window can call these commands; no
//! endpoint, key, executable path or replacement bytes come from JavaScript.
use std::{fs, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates {
    origin: Mutex<String>,
    directory: Mutex<PathBuf>,
    pending: Mutex<Option<Update>>,
    automatic: AtomicBool,
    busy: AtomicBool,
    restart_required: AtomicBool,
    error: Mutex<Option<String>>,
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
impl Updates {
    fn claim(&self) -> Result<Busy<'_>, String> {
        self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Busy(&self.busy)).map_err(|_| "An update operation is already running.".into())
    }
    fn directory(&self) -> PathBuf { self.directory.lock().unwrap().clone() }
    fn selected(&self, version: &str) -> Result<Update, String> {
        self.pending.lock().unwrap().as_ref().filter(|u| u.version == version).cloned()
            .ok_or_else(|| "The update changed. Check for updates again.".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    current_version: String,
    automatic: bool,
    version: Option<String>,
    notes: Option<String>,
    downloaded: bool,
    restart_required: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress { downloaded: usize, total: Option<u64> }

fn require_window(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    let origin = app.state::<Updates>().origin.lock().unwrap().clone();
    if window.label() != "main" || window.url().map_err(|e| e.to_string())?.origin().ascii_serialization() != origin {
        return Err("Updates are only available in the local IVE app.".into());
    }
    Ok(())
}

fn validate_update(update: &Update) -> Result<(), String> {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let expected = format!("https://github.com/michaelAGI/ive/releases/download/v{}/IVE-macOS-{arch}.app.tar.gz", update.version);
    if update.download_url.as_str() != expected { return Err("The update is not an official IVE release.".into()); }
    Ok(())
}

fn clear_cache(directory: &Path) {
    for name in ["latest.json", "package.tar.gz", "package.tmp", "latest.tmp"] { let _ = fs::remove_file(directory.join(name)); }
}

fn cache_matches(directory: &Path, update: &Update) -> bool {
    fs::read(directory.join("latest.json")).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|metadata| metadata == update.raw_json) && directory.join("package.tar.gz").is_file()
}

fn verified_cache(directory: &Path, update: &Update) -> Result<Vec<u8>, String> {
    if !cache_matches(directory, update) { return Err("Download the update first.".into()); }
    let path = directory.join("package.tar.gz");
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 512 * 1024 * 1024 { return Err("The cached update is too large.".into()); }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    update.verify(&bytes).map_err(|_| "The update signature could not be verified. Download it again.".to_string())?;
    Ok(bytes)
}

fn snapshot(app: &AppHandle) -> Snapshot {
    let state = app.state::<Updates>();
    let update = state.pending.lock().unwrap();
    let error = state.error.lock().unwrap().clone();
    Snapshot {
        current_version: app.package_info().version.to_string(),
        automatic: state.automatic.load(Ordering::SeqCst),
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.as_ref().and_then(|u| u.body.clone()),
        downloaded: update.as_ref().is_some_and(|u| cache_matches(&state.directory(), u)),
        restart_required: state.restart_required.load(Ordering::SeqCst),
        error,
    }
}

pub fn configure(app: &AppHandle, data: &Path, origin: String) -> Result<(), String> {
    let state = app.state::<Updates>();
    *state.origin.lock().unwrap() = origin;
    let directory = data.join("updates");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let automatic = fs::read(directory.join("preferences.json")).ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v["automatic"] == true);
    state.automatic.store(automatic, Ordering::SeqCst);
    *state.directory.lock().unwrap() = directory.clone();
    if let Ok(bytes) = fs::read(directory.join("latest.json")) {
        let restored = (|| {
            let metadata = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let update = app.updater().map_err(|e| e.to_string())?.restore_update(metadata).map_err(|e| e.to_string())?;
            if let Some(update) = &update { validate_update(update)?; verified_cache(&directory, update)?; }
            Ok::<_, String>(update)
        })();
        match restored {
            Ok(Some(update)) => *state.pending.lock().unwrap() = Some(update),
            Ok(None) => clear_cache(&directory),
            Err(_) => {
                clear_cache(&directory);
                *state.error.lock().unwrap() = Some("A saved update could not be verified. Check for updates to download it again.".into());
            }
        }
    }
    Ok(())
}

// Runs before spawning the backend. A bad cache never prevents IVE from starting.
pub fn install_on_launch(app: &AppHandle) -> bool {
    let state = app.state::<Updates>();
    if !state.automatic.load(Ordering::SeqCst) { return false; }
    let Some(update) = state.pending.lock().unwrap().clone() else { return false };
    let directory = state.directory();
    let result = verified_cache(&directory, &update).and_then(|bytes| update.install(bytes).map_err(|e| e.to_string()));
    clear_cache(&directory);
    *state.pending.lock().unwrap() = None;
    match result {
        Ok(()) => app.restart(),
        Err(_) => {
            *state.error.lock().unwrap() = Some("The saved update could not be installed. IVE started normally; try updating again.".into());
            false
        }
    }
}

#[tauri::command]
pub fn desktop_update_status(window: WebviewWindow, app: AppHandle) -> Result<Snapshot, String> {
    require_window(&window, &app)?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub fn desktop_update_automatic(window: WebviewWindow, app: AppHandle, enabled: bool) -> Result<Snapshot, String> {
    require_window(&window, &app)?;
    let state = app.state::<Updates>();
    let path = state.directory().join("preferences.json");
    fs::write(path.with_extension("tmp"), serde_json::to_vec(&serde_json::json!({"automatic": enabled})).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(path.with_extension("tmp"), &path).map_err(|e| e.to_string())?;
    state.automatic.store(enabled, Ordering::SeqCst);
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn desktop_update_check(window: WebviewWindow, app: AppHandle) -> Result<Snapshot, String> {
    require_window(&window, &app)?;
    let state = app.state::<Updates>();
    let _busy = state.claim()?;
    let update = app.updater_builder().timeout(Duration::from_secs(25)).build().map_err(|e| e.to_string())?
        .check().await.map_err(|_| "Could not check for updates. Check your connection and try again.".to_string())?;
    if let Some(update) = &update { validate_update(update)?; }
    *state.pending.lock().unwrap() = update;
    *state.error.lock().unwrap() = None;
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn desktop_update_download(window: WebviewWindow, app: AppHandle, version: String, progress: Channel<Progress>) -> Result<Snapshot, String> {
    require_window(&window, &app)?;
    let state = app.state::<Updates>();
    let _busy = state.claim()?;
    let mut update = state.selected(&version)?;
    validate_update(&update)?;
    update.timeout = Some(Duration::from_secs(15 * 60));
    let mut downloaded = 0;
    let bytes = update.download(|chunk, total| {
        downloaded += chunk;
        let _ = progress.send(Progress { downloaded, total });
    }, || {}).await.map_err(|_| "The update could not be downloaded or verified. Your current app is unchanged.".to_string())?;
    let directory = state.directory();
    fs::write(directory.join("package.tmp"), bytes).map_err(|e| e.to_string())?;
    fs::rename(directory.join("package.tmp"), directory.join("package.tar.gz")).map_err(|e| e.to_string())?;
    fs::write(directory.join("latest.tmp"), serde_json::to_vec(&update.raw_json).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(directory.join("latest.tmp"), directory.join("latest.json")).map_err(|e| e.to_string())?;
    *state.error.lock().unwrap() = None;
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn desktop_update_install(window: WebviewWindow, app: AppHandle, version: String) -> Result<(), String> {
    require_window(&window, &app)?;
    let state = app.state::<Updates>();
    let _busy = state.claim()?;
    let update = state.selected(&version)?;
    let bytes = verified_cache(&state.directory(), &update).map_err(|error| {
        clear_cache(&state.directory());
        error
    })?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Verify before stopping anything. stop() also restores phone sleep leases.
        handle.state::<Updates>().restart_required.store(true, Ordering::SeqCst);
        handle.state::<super::Backend>().stop();
        let result = update.install(bytes).map_err(|_| "The update could not be installed. Restart IVE to continue, then try again.".to_string());
        clear_cache(&handle.state::<Updates>().directory());
        if result.is_ok() { handle.restart(); }
        result
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn desktop_update_restart(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_window(&window, &app)?;
    if !app.state::<Updates>().restart_required.load(Ordering::SeqCst) { return Err("No update restart is pending.".into()); }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    struct Fixture {
        _directory: tempfile::TempDir,
        app: tauri::App<MockRuntime>,
        update: Update,
        cache: PathBuf,
        installed: PathBuf,
    }

    fn command(program: &Path, args: &[&str]) {
        let output = Command::new(program).args(args).output().unwrap();
        assert!(output.status.success(), "fixture command failed (output intentionally hidden)");
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let key = root.path().join("test.key");
        let signer = Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/.bin/tauri");
        command(&signer, &["signer", "generate", "--ci", "-p", "", "-w", key.to_str().unwrap()]);
        let installed = root.path().join("current/IVE.app");
        let new_app = root.path().join("next/IVE.app");
        for (app, text) in [(&installed, "old app"), (&new_app, "new app")] {
            fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
            fs::write(app.join("Contents/MacOS/ive"), text).unwrap();
        }
        let cache = root.path().join("cache"); fs::create_dir(&cache).unwrap();
        let archive = cache.join("package.tar.gz");
        command(Path::new("/usr/bin/tar"), &["-czf", archive.to_str().unwrap(), "-C", new_app.parent().unwrap().to_str().unwrap(), "IVE.app"]);
        command(&signer, &["signer", "sign", "--private-key-path", key.to_str().unwrap(), "--app-version", "1.0.21", archive.to_str().unwrap()]);
        let public = fs::read_to_string(key.with_extension("key.pub")).unwrap();
        let mut context = mock_context(noop_assets());
        context.package_info_mut().version = "1.0.20".parse().unwrap();
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({"pubkey":public.trim(), "requireSignedVersion":true,
            "endpoints":["https://github.com/michaelAGI/ive/releases/latest/download/latest.json"]}));
        let app = mock_builder().plugin(tauri_plugin_updater::Builder::new().pubkey(public.trim()).build()).build(context).unwrap();
        let updater = app.updater_builder().executable_path(installed.join("Contents/MacOS/ive")).build().unwrap();
        let metadata = serde_json::json!({"version":"1.0.21", "platforms":{"darwin-aarch64":{
            "url":"https://github.com/michaelAGI/ive/releases/download/v1.0.21/IVE-macOS-arm64.app.tar.gz",
            "signature":fs::read_to_string(archive.with_extension("gz.sig")).unwrap().trim(),
        }}});
        fs::write(cache.join("latest.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
        let update = updater.restore_update(metadata).unwrap().unwrap();
        Fixture { _directory: root, app, update, cache, installed }
    }

    #[test]
    fn signed_cached_update_replaces_only_the_selected_test_bundle() {
        let f = fixture();
        let user_data = f._directory.path().join("saved-chats");
        fs::write(&user_data, "keep me").unwrap();
        validate_update(&f.update).unwrap();
        let bytes = verified_cache(&f.cache, &f.update).unwrap();
        f.update.install(bytes).unwrap();
        assert_eq!(fs::read_to_string(f.installed.join("Contents/MacOS/ive")).unwrap(), "new app");
        assert_eq!(fs::read_to_string(user_data).unwrap(), "keep me");
    }

    #[test]
    fn tampered_download_is_rejected_before_replacement() {
        let f = fixture();
        fs::write(f.cache.join("package.tar.gz"), "corrupt download").unwrap();
        assert!(verified_cache(&f.cache, &f.update).is_err());
        assert!(f.update.install(b"corrupt download").is_err());
        assert_eq!(fs::read_to_string(f.installed.join("Contents/MacOS/ive")).unwrap(), "old app");
    }

    #[test]
    fn manifest_cannot_relabel_a_signed_old_package_as_a_new_version() {
        let f = fixture();
        let mut metadata = f.update.raw_json.clone(); metadata["version"] = "1.0.22".into();
        let changed = f.app.updater_builder().executable_path(f.installed.join("Contents/MacOS/ive")).build().unwrap().restore_update(metadata).unwrap().unwrap();
        assert!(changed.verify(&fs::read(f.cache.join("package.tar.gz")).unwrap()).is_err());
    }

    #[test]
    fn same_or_older_versions_and_foreign_downloads_are_rejected() {
        let f = fixture();
        let updater = f.app.updater().unwrap();
        for version in ["1.0.20", "1.0.19"] {
            let mut metadata = f.update.raw_json.clone(); metadata["version"] = version.into();
            assert!(updater.restore_update(metadata).unwrap().is_none());
        }
        let mut update = f.update.clone(); update.download_url = "http://127.0.0.1/private".parse().unwrap();
        assert!(validate_update(&update).is_err());
    }

    #[test]
    fn exclusive_operation_guard_recovers_after_a_failed_operation() {
        let state = Updates::default();
        let busy = state.claim().unwrap(); assert!(state.claim().is_err());
        drop(busy); assert!(state.claim().is_ok());
    }

    #[test]
    #[ignore = "requires the final notarized release and a previous app artifact"]
    fn release_artifact_upgrades_an_isolated_previous_app() {
        let release = PathBuf::from(std::env::var("IVE_QA_UPDATER_RELEASE").expect("release artifact directory"));
        let previous = PathBuf::from(std::env::var("IVE_QA_UPDATER_OLD_APP").expect("previous app artifact"));
        let directory = tempfile::tempdir().unwrap();
        let installed = directory.path().join("IVE.app");
        command(Path::new("/usr/bin/ditto"), &[previous.to_str().unwrap(), installed.to_str().unwrap()]);
        let data = directory.path().join("saved-chat.txt"); fs::write(&data, "preserved").unwrap();
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = mock_context(noop_assets());
        context.package_info_mut().version = "1.0.20".parse().unwrap();
        context.config_mut().plugins.0.insert("updater".into(), config["plugins"]["updater"].clone());
        let app = mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap();
        let updater = app.updater_builder().executable_path(installed.join("Contents/MacOS/ive")).build().unwrap();
        let metadata = serde_json::from_slice(&fs::read(release.join("latest.json")).unwrap()).unwrap();
        let update = updater.restore_update(metadata).unwrap().unwrap();
        validate_update(&update).unwrap();
        let bytes = fs::read(release.join("IVE-macOS-arm64.app.tar.gz")).unwrap();
        update.verify(&bytes).unwrap();
        update.install(bytes).unwrap();
        command(Path::new("/usr/bin/codesign"), &["--verify", "--deep", "--strict", installed.to_str().unwrap()]);
        command(Path::new("/usr/bin/xcrun"), &["stapler", "validate", installed.to_str().unwrap()]);
        command(Path::new("/usr/sbin/spctl"), &["--assess", "--type", "execute", installed.to_str().unwrap()]);
        assert_eq!(fs::read_to_string(&data).unwrap(), "preserved");
    }
}
