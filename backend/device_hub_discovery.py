"""Read-only Apple device discovery shared by IVE and local diagnostics.

This module only discovers devices; DeviceHub owns live control. CoreDevice's advertised
features are evidence about Apple's transport, NOT permission for an IVE agent
and NOT evidence that IVE can execute those operations. No device is paired,
launched, captured, or controlled by this module.

Run: python3 backend/device_hub_discovery.py
Reports omit names and identifiers by default; --include-identifiers is local
diagnostic output and must not be copied into a public issue or fixture.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse


FEATURES = {
    "screenshot": "com.apple.coredevice.feature.capturescreenshot",
    "view_screen": "com.apple.coredevice.feature.viewdevicescreen",
    "tap_swipe": "com.apple.coredevice.feature.remote.hid.digitizer",
    "type_text": "com.apple.coredevice.feature.remote.hid.keyboard",
    "scroll": "com.apple.coredevice.feature.remote.hid.scroll",
    "press_button": "com.apple.coredevice.feature.remote.hid.button",
}


class DiscoveryError(RuntimeError):
    """A discovery failure, deliberately without raw device output."""


def _object(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _text(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _version(value: Any) -> str:
    return _text(_object(value).get("stringValue")) or _text(value)


def _developer_mode(value: Any) -> str:
    if isinstance(value, str) and value.lower() in {"enabled", "disabled"}:
        return value.lower()
    if isinstance(value, dict):
        if "enabled" in value and "disabled" not in value:
            return "enabled"
        if "disabled" in value and "enabled" not in value:
            return "disabled"
    return "unknown"


def _screen_url(value: Any, identifier: str) -> str | None:
    # Only accept the URL returned for this exact CoreDevice identifier.
    # Discovery never opens it. Do not turn arbitrary device metadata into a
    # launchable URL or silently invent a URL for an unsupported device.
    raw = _text(_object(value).get("relative")) or _text(value)
    if not raw or not identifier:
        return None
    try:
        parsed = urlparse(raw)
        if (parsed.scheme == "devices" and parsed.netloc == "device"
                and parsed.path == "/open" and not parsed.fragment
                and parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True) == {"id": [identifier]}):
            return raw
    except ValueError:
        pass
    return None


def normalize_inventory(payload: Any) -> list[dict]:
    """Normalize legacy and Xcode 27 CoreDevice JSON; do not infer readiness.

    New properties take precedence over deprecated fields. Simulators remain
    explicitly marked and are never mistaken for physical devices. Partial or
    incompatible command results fail instead of looking like an empty hub.
    """
    if not isinstance(payload, dict):
        raise DiscoveryError("CoreDevice returned an invalid inventory.")
    outcome = _object(payload.get("info")).get("outcome")
    if outcome is not None and outcome != "success":
        raise DiscoveryError("CoreDevice did not complete device discovery.")
    rows = _object(payload.get("result")).get("devices")
    if not isinstance(rows, list):
        raise DiscoveryError("CoreDevice returned no device inventory.")

    devices = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise DiscoveryError("CoreDevice returned an invalid device record.")
        identifier = _text(row.get("identifier"))
        if not identifier or identifier in seen:
            raise DiscoveryError("CoreDevice returned an ambiguous device identity.")
        seen.add(identifier)
        properties = _object(row.get("properties"))
        hardware = {**_object(row.get("hardwareProperties")),
                    **_object(properties.get("hardware"))}
        state = {**_object(row.get("deviceProperties")),
                 **_object(properties.get("state"))}
        connection = {**_object(row.get("connectionProperties")),
                      **_object(properties.get("connection"))}
        software = _object(properties.get("software"))
        raw_features = row.get("capabilities", [])
        if not isinstance(raw_features, list):
            raise DiscoveryError("CoreDevice returned invalid capabilities.")
        advertised = {_text(_object(feature).get("featureIdentifier"))
                      for feature in raw_features}
        connection_state = _text(connection.get("state")) or _text(
            connection.get("tunnelState"), "unknown")
        reality = hardware.get("reality")
        kind = reality if reality in {"physical", "simulated"} else "unknown"
        screen_url = _screen_url(connection.get("screenViewingURL"), identifier)
        devices.append({
            "id": "apple:" + identifier,
            "provider_device_id": identifier,
            "name": _text(state.get("name"), "Apple device"),
            "model": _text(hardware.get("marketingName"), "Unknown model"),
            "platform": _text(hardware.get("platform"), "unknown"),
            "os_version": _version(software.get("osVersionNumber"))
                          or _version(state.get("osVersionNumber")),
            "kind": kind,
            "connection": connection_state,
            "connected": connection_state == "connected",
            "developer_mode": _developer_mode(state.get("developerModeStatus")),
            "pairing": _text(connection.get("pairingState"), "unknown"),
            "transport": _text(connection.get("transportType"), "unknown"),
            "screen_viewing_url": screen_url,
            "advertised_capabilities": {name: feature in advertised
                                        for name, feature in FEATURES.items()},
            "ive_control": {
                "ready": False,
                "reason": "requires_live_control_check",
                "executable_actions": [],
            },
        })
    return sorted(devices, key=lambda device: (
        not device["connected"], device["kind"] != "physical", device["name"], device["id"]))


def discover_devices(*, runner: Callable = subprocess.run,
                     platform: str | None = None, timeout: int = 10) -> list[dict]:
    """Run only `devicectl list devices`, with bounded time and temp output.

    A JSON file also works on older Xcode releases that don't support `-`.
    Avoid stdout/log parsing; the command's JSON is the authoritative result.
    """
    if (platform or sys.platform) != "darwin":
        raise DiscoveryError("Apple Device Hub discovery requires macOS and Xcode.")
    if type(timeout) is not int or not 1 <= timeout <= 30:
        raise ValueError("timeout must be an integer between 1 and 30 seconds")
    with tempfile.TemporaryDirectory(prefix="ive-device-discovery-") as tmp:
        destination = Path(tmp) / "devices.json"
        try:
            result = runner([
                "/usr/bin/xcrun", "devicectl", "list", "devices", "--quiet",
                "--timeout", str(timeout), "--json-output", str(destination),
            ], capture_output=True, timeout=timeout + 3, check=False)
        except subprocess.TimeoutExpired as exc:
            raise DiscoveryError("Device discovery timed out; retry after checking Xcode.") from exc
        except OSError as exc:
            raise DiscoveryError("Could not run Xcode device discovery.") from exc
        if result.returncode != 0:
            raise DiscoveryError("Xcode device discovery failed; check Xcode setup and pairing.")
        try:
            if destination.stat().st_size > 8 * 1024 * 1024:
                raise DiscoveryError("Device inventory exceeded the supported size.")
            payload = json.loads(destination.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DiscoveryError("Xcode returned unreadable device inventory.") from exc
    return normalize_inventory(payload)


def diagnostic_report(devices: list[dict], *, include_identifiers: bool = False) -> dict:
    rows = []
    for device in devices:
        row = dict(device)
        if not include_identifiers:
            for field in ("id", "provider_device_id", "name", "screen_viewing_url"):
                row.pop(field, None)
            row["screen_viewing_url_available"] = bool(device["screen_viewing_url"])
        rows.append(row)
    return {
        "schema_version": 1,
        "status": "discovery_only",
        "note": "Apple-advertised features do not establish authorized, verified IVE control.",
        "devices": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-identifiers", action="store_true")
    args = parser.parse_args()
    try:
        report = diagnostic_report(discover_devices(), include_identifiers=args.include_identifiers)
    except DiscoveryError as exc:
        print(json.dumps({"status": "unavailable", "error": str(exc)}))
        return 1
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
