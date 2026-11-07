//! The eyelid in the macOS menu bar: shows whether the Mac keeps working with
//! the lid closed, switches the mode, and sets its conditions. It talks to the
//! bundled backend over plain HTTP on the loopback interface with the owner
//! token, the same calls the web header uses (`/api/mac-power`).
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, Wry,
};

const DURATIONS: [(u64, &str); 6] = [
    (900, "15 minutes"), (1800, "30 minutes"), (3600, "1 hour"),
    (7200, "2 hours"), (14400, "4 hours"), (28800, "8 hours"),
];
const POLL_SECONDS: u64 = 20;
const OPTIONS_KEY: &str = "mac_power_options";

#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub duration_seconds: u64,
    pub allow_battery: bool,
    pub lid_low_power: bool,
    pub pause_apps: Vec<String>,
}
impl Default for Options {
    fn default() -> Self { Options { duration_seconds: 3600, allow_battery: false, lid_low_power: true, pause_apps: vec![] } }
}
impl Options {
    pub fn from_json(value: &serde_json::Value) -> Option<Options> {
        let duration = value.get("duration_seconds")?.as_u64()?;
        if !DURATIONS.iter().any(|(seconds, _)| *seconds == duration) { return None; }
        Some(Options {
            duration_seconds: duration,
            allow_battery: value.get("allow_battery").and_then(|v| v.as_bool()).unwrap_or(false),
            lid_low_power: value.get("lid_low_power").and_then(|v| v.as_bool()).unwrap_or(true),
            pause_apps: value.get("pause_apps").and_then(|v| v.as_array()).map(|items| items.iter().filter_map(|i| i.as_str().map(String::from)).collect()).unwrap_or_default(),
        })
    }
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "duration_seconds": self.duration_seconds, "allow_battery": self.allow_battery,
            "lid_low_power": self.lid_low_power, "pause_apps": self.pause_apps,
        })
    }
}

/// What the menu shows, derived from the backend's status reply.
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub active: bool,
    pub status_line: String,
    pub toggle_label: String,
    pub toggle_enabled: bool,
}

pub fn view_for(status: &serde_json::Value, now_ms: i64) -> View {
    let state = status.get("state").and_then(|v| v.as_str()).unwrap_or("unknown");
    let message = status.get("message").and_then(|v| v.as_str()).map(String::from);
    match state {
        "active" => {
            let left = status.get("expires_at").and_then(|v| v.as_str()).and_then(parse_rfc3339_ms)
                .map(|end| ((end - now_ms).max(0) / 1000) as u64);
            let line = match left {
                Some(seconds) => format!("Lid closed: on, {} left", short(seconds)),
                None => "Lid closed: on".to_string(),
            };
            View { active: true, status_line: line, toggle_label: "Turn off and restore".into(), toggle_enabled: true }
        }
        "restoring" | "restore_failed" => View {
            active: false, status_line: message.unwrap_or_else(|| "Restoring the normal sleep settings".into()),
            toggle_label: "Turn off and restore".into(), toggle_enabled: true,
        },
        "unavailable" => View { active: false, status_line: "Lid closed: needs the installed IVE Mac app".into(), toggle_label: "Turn on".into(), toggle_enabled: false },
        "offline" => View { active: false, status_line: "Lid closed: IVE is not running".into(), toggle_label: "Turn on".into(), toggle_enabled: false },
        _ => {
            let supported = status.get("lid_saver_supported").and_then(|v| v.as_bool()).unwrap_or(false);
            let line = match (&message, state) {
                (Some(text), _) => format!("Lid closed: off. {text}"),
                (None, "needs_approval") => "Lid closed: off. macOS still has to allow the IVE helper.".into(),
                (None, "not_registered") | (None, "unregistered") => "Lid closed: off. Turning on sets up the Mac helper once.".into(),
                _ => "Lid closed: off".into(),
            };
            View { active: false, status_line: line, toggle_label: "Turn on".into(),
                toggle_enabled: supported || matches!(state, "not_registered" | "unregistered" | "needs_approval") }
        }
    }
}

pub fn short(seconds: u64) -> String {
    if seconds < 60 { return "under a minute".into(); }
    let h = seconds / 3600;
    let m = seconds / 60 % 60;
    if h > 0 { if m > 0 { format!("{h} h {m} min") } else { format!("{h} h") } } else { format!("{m} min") }
}

/// "2026-11-07T20:12:03.123456+00:00" or "...Z" → milliseconds since the epoch. Only the
/// forms the backend writes; anything else is None and the menu shows no countdown.
pub fn parse_rfc3339_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once('T')?;
    let mut parts = date.split('-');
    let (y, mo, d): (i64, i64, i64) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    let (clock, offset) = if let Some(stripped) = rest.strip_suffix('Z') { (stripped, 0i64) }
        else if let Some(idx) = rest.rfind(['+', '-']) {
            let (clock, zone) = rest.split_at(idx);
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let (zh, zm) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
            (clock, sign * (zh.parse::<i64>().ok()? * 3600 + zm.parse::<i64>().ok()? * 60))
        } else { (rest, 0) };
    let mut hms = clock.split(':');
    let (h, mi): (i64, i64) = (hms.next()?.parse().ok()?, hms.next()?.parse().ok()?);
    let s: f64 = hms.next().unwrap_or("0").parse().ok()?;
    // Days since the epoch (proleptic Gregorian), civil-from-days inverse.
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 - offset) as f64 * 1000.0 + s * 1000.0) as i64)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ── Backend access ───────────────────────────────────────────────────────────

struct Backend { port: u16, data_dir: PathBuf }

impl Backend {
    /// The backend persists its owner token under its data directory; older
    /// installs keep it under ~/.ive. Both are tried, a rejected one is skipped.
    fn tokens(&self) -> Vec<String> {
        let mut paths = vec![self.data_dir.join("token")];
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) { paths.push(home.join(".ive/token")); }
        let mut tokens = Vec::new();
        for path in paths {
            if let Ok(text) = fs::read_to_string(&path) {
                let text = text.trim().to_string();
                if !text.is_empty() && !tokens.contains(&text) { tokens.push(text); }
            }
        }
        tokens
    }

    /// One HTTP/1.0 request on the loopback interface; returns (status, body).
    fn request(&self, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<(u16, String), String> {
        let tokens = self.tokens();
        if tokens.is_empty() { return Err("no owner token".into()); }
        let mut last = Err("no owner token".to_string());
        for token in tokens {
            last = self.request_with(&token, method, path, body);
            if !matches!(last, Ok((401 | 403, _))) { break; }
        }
        last
    }

    fn request_with(&self, token: &str, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<(u16, String), String> {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], self.port));
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| e.to_string())?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(90)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let payload = body.map(|v| v.to_string()).unwrap_or_default();
        let head = format!(
            "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.port, payload.len()
        );
        stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(payload.as_bytes())).map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        parse_response(&raw)
    }

    fn json(&self, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<(u16, serde_json::Value), String> {
        let (status, text) = self.request(method, path, body)?;
        Ok((status, serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)))
    }

    fn status(&self) -> serde_json::Value {
        match self.json("GET", "/api/mac-power", None) {
            Ok((200, value)) if value.is_object() => value,
            Ok((_, value)) if value.get("state").is_some() => value,
            _ => serde_json::json!({ "state": "offline" }),
        }
    }

    fn options(&self) -> Options {
        self.json("GET", &format!("/api/settings/{OPTIONS_KEY}"), None).ok()
            .and_then(|(_, value)| value.get("value").cloned())
            .and_then(|value| if value.is_string() { serde_json::from_str(value.as_str().unwrap_or("")).ok() } else { Some(value) })
            .and_then(|value| Options::from_json(&value))
            .unwrap_or_default()
    }

    fn save_options(&self, options: &Options) {
        let _ = self.json("PUT", &format!("/api/settings/{OPTIONS_KEY}"), Some(&serde_json::json!({ "value": options.to_json() })));
    }
}

pub fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("malformed response")?;
    let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("malformed status line")?;
    Ok((status, body.to_string()))
}

// ── Menu ─────────────────────────────────────────────────────────────────────

struct Items {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    durations: Vec<(u64, CheckMenuItem<Wry>)>,
    battery: CheckMenuItem<Wry>,
    low_power: CheckMenuItem<Wry>,
}

struct Tray {
    backend: Backend,
    icon: TrayIcon<Wry>,
    items: Items,
    options: Mutex<Options>,
    open_eye: Image<'static>,
    closed_eye: Image<'static>,
}

impl Tray {
    fn apply(&self, status: &serde_json::Value) {
        let view = view_for(status, now_ms());
        let _ = self.items.status.set_text(&view.status_line);
        let _ = self.items.toggle.set_text(&view.toggle_label);
        let _ = self.items.toggle.set_enabled(view.toggle_enabled);
        let _ = self.icon.set_icon(Some(if view.active { self.closed_eye.clone() } else { self.open_eye.clone() }));
        let _ = self.icon.set_tooltip(Some(&view.status_line));
        let locked = view.active || matches!(status.get("state").and_then(|v| v.as_str()), Some("restoring") | Some("restore_failed"));
        let options = self.options.lock().unwrap().clone();
        for (seconds, item) in &self.items.durations {
            let _ = item.set_checked(*seconds == options.duration_seconds);
            let _ = item.set_enabled(!locked);
        }
        let _ = self.items.battery.set_checked(if view.active { status.get("allow_battery").and_then(|v| v.as_bool()).unwrap_or(options.allow_battery) } else { options.allow_battery });
        let _ = self.items.low_power.set_checked(if view.active { status.get("lid_low_power").and_then(|v| v.as_bool()).unwrap_or(options.lid_low_power) } else { options.lid_low_power });
        let _ = self.items.battery.set_enabled(!locked);
        let _ = self.items.low_power.set_enabled(!locked);
    }

    fn refresh(&self) { let status = self.backend.status(); self.apply(&status); }

    fn toggle(&self, app: &AppHandle) {
        let status = self.backend.status();
        let active = matches!(status.get("state").and_then(|v| v.as_str()), Some("active") | Some("restoring") | Some("restore_failed"));
        let result = if active {
            self.backend.json("POST", "/api/mac-power/stop", None)
        } else {
            let mut options = self.options.lock().unwrap().clone();
            // On battery without permission the backend refuses; the menu bar
            // switch grants battery use for this run, like the header does.
            if status.get("on_battery").and_then(|v| v.as_bool()) == Some(true) { options.allow_battery = true; }
            self.backend.json("POST", "/api/mac-power/start", Some(&options.to_json()))
        };
        match result {
            Ok((code, value)) if code < 400 && value.get("state").is_some() => self.apply(&value),
            Ok((_, value)) => {
                let text = value.get("error").and_then(|v| v.as_str()).unwrap_or("The lid-closed mode could not be changed.").to_string();
                notify(app, "Lid-closed mode", &text);
                self.refresh();
            }
            Err(error) => { notify(app, "Lid-closed mode", &format!("IVE did not answer: {error}")); self.refresh(); }
        }
    }

    fn update_options(&self, change: impl FnOnce(&mut Options)) {
        let mut guard = self.options.lock().unwrap();
        change(&mut guard);
        let snapshot = guard.clone();
        drop(guard);
        self.backend.save_options(&snapshot);
        self.refresh();
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Installs the menu bar item once the backend answers. Safe to call once per launch.
pub fn install(app: &AppHandle, port: u16, data_dir: PathBuf) -> Result<(), String> {
    let backend = Backend { port, data_dir };
    let options = backend.options();
    let status = MenuItem::with_id(app, "lid-status", "Lid closed: checking", false, None::<&str>).map_err(|e| e.to_string())?;
    let toggle = MenuItem::with_id(app, "lid-toggle", "Turn on", false, None::<&str>).map_err(|e| e.to_string())?;
    let mut durations = Vec::new();
    for (seconds, label) in DURATIONS {
        let item = CheckMenuItem::with_id(app, format!("lid-duration-{seconds}"), label, true, seconds == options.duration_seconds, None::<&str>).map_err(|e| e.to_string())?;
        durations.push((seconds, item));
    }
    let duration_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = durations.iter().map(|(_, item)| item as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let duration_menu = Submenu::with_id_and_items(app, "lid-durations", "For at most", true, &duration_refs).map_err(|e| e.to_string())?;
    let battery = CheckMenuItem::with_id(app, "lid-battery", "Also on battery", true, options.allow_battery, None::<&str>).map_err(|e| e.to_string())?;
    let low_power = CheckMenuItem::with_id(app, "lid-low-power", "Low Power Mode while closed", true, options.lid_low_power, None::<&str>).map_err(|e| e.to_string())?;
    let open = MenuItem::with_id(app, "lid-open", "Open IVE", true, None::<&str>).map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(app, "lid-settings", "Mac & Power settings…", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[
        &status, &toggle, &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        &duration_menu, &battery, &low_power, &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        &open, &settings,
    ]).map_err(|e| e.to_string())?;

    let open_eye = Image::from_bytes(include_bytes!("../icons/tray-eye-open.png")).map_err(|e| e.to_string())?.to_owned();
    let closed_eye = Image::from_bytes(include_bytes!("../icons/tray-eye-closed.png")).map_err(|e| e.to_string())?.to_owned();
    let icon = TrayIconBuilder::with_id("ive-lid")
        .icon(open_eye.clone())
        .icon_as_template(true)
        .tooltip("Lid closed: checking")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app).map_err(|e| e.to_string())?;

    let tray = Arc::new(Tray {
        backend, icon, items: Items { status, toggle, durations, battery, low_power },
        options: Mutex::new(options), open_eye, closed_eye,
    });
    let handler = tray.clone();
    app.on_menu_event(move |app, event| {
        let id = event.id().as_ref();
        match id {
            "lid-toggle" => handler.toggle(app),
            "lid-battery" => { let next = handler.items.battery.is_checked().unwrap_or(false); handler.update_options(|o| o.allow_battery = next) }
            "lid-low-power" => { let next = handler.items.low_power.is_checked().unwrap_or(true); handler.update_options(|o| o.lid_low_power = next) }
            "lid-open" => { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); } }
            "lid-settings" => {
                if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
                let _ = app.emit("ive://open-panel", "mac-power");
            }
            other => {
                if let Some(seconds) = other.strip_prefix("lid-duration-").and_then(|s| s.parse::<u64>().ok()) {
                    handler.update_options(|o| o.duration_seconds = seconds);
                }
            }
        }
    });
    tray.refresh();
    let poller = tray.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(POLL_SECONDS));
        poller.refresh();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_status_shows_time_left_and_closed_eye() {
        let status = serde_json::json!({ "state": "active", "expires_at": "2026-11-07T21:00:00+00:00" });
        let now = parse_rfc3339_ms("2026-11-07T19:30:30Z").unwrap();
        let view = view_for(&status, now);
        assert!(view.active);
        assert_eq!(view.status_line, "Lid closed: on, 1 h 29 min left");
        assert_eq!(view.toggle_label, "Turn off and restore");
    }

    #[test]
    fn ready_without_support_cannot_turn_on_and_shows_the_helper_message() {
        let status = serde_json::json!({ "state": "ready", "reason": "client_path_mismatch", "message": "Mac availability needs attention." });
        let view = view_for(&status, 0);
        assert!(!view.active);
        assert_eq!(view.status_line, "Lid closed: off. Mac availability needs attention.");
        assert!(!view.toggle_enabled);
        let ok = view_for(&serde_json::json!({ "state": "ready", "lid_saver_supported": true }), 0);
        assert!(ok.toggle_enabled);
        assert_eq!(ok.status_line, "Lid closed: off");
    }

    #[test]
    fn offline_and_unavailable_cannot_toggle() {
        assert!(!view_for(&serde_json::json!({ "state": "offline" }), 0).toggle_enabled);
        assert!(!view_for(&serde_json::json!({ "state": "unavailable" }), 0).toggle_enabled);
    }

    #[test]
    fn options_round_trip_and_reject_unknown_durations() {
        let options = Options { duration_seconds: 7200, allow_battery: true, lid_low_power: false, pause_apps: vec!["com.spotify.client".into()] };
        assert_eq!(Options::from_json(&options.to_json()), Some(options));
        assert_eq!(Options::from_json(&serde_json::json!({ "duration_seconds": 1234 })), None);
    }

    #[test]
    fn parses_backend_timestamps() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_rfc3339_ms("2026-11-07T20:12:03.5+00:00"), Some(1_794_082_323_500));
        assert_eq!(parse_rfc3339_ms("nonsense"), None);
    }

    #[test]
    fn parses_http_responses() {
        let (status, body) = parse_response(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"state\":\"ready\"}").unwrap();
        assert_eq!((status, body.as_str()), (200, "{\"state\":\"ready\"}"));
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn short_durations_read_naturally() {
        assert_eq!(short(30), "under a minute");
        assert_eq!(short(1800), "30 min");
        assert_eq!(short(3600), "1 h");
        assert_eq!(short(5400), "1 h 30 min");
    }
}
