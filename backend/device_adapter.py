"""Bounded Mac → physical iPhone adapter. No downloads or global installation.

The optional HID helper is built once from the pinned, bundled ipb sources.
It runs only on the tested macOS/Xcode/iOS 27 family; IVE itself still runs on
older Macs. All paths and command names are owned here, never supplied by MCP.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import struct
import tempfile
import time

from device_hub_discovery import normalize_inventory, DiscoveryError
from resource_path import project_root


class DeviceError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.status = code, status


def png_size(data):
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise DeviceError("invalid_frame", "The iPhone did not return a valid screenshot.")
    w, h = struct.unpack(">II", data[16:24])
    if not (1 <= w <= 10000 and 1 <= h <= 10000) or len(data) > 12 * 1024 * 1024:
        raise DeviceError("invalid_frame", "The iPhone screenshot has an unsupported size.")
    return w, h


class AppleDeviceAdapter:
    def __init__(self, data_dir, clock=time.monotonic):
        self.root = Path(data_dir) / "device-hub"
        self.source = project_root() / "packaging/device-control/ipb"
        self.processes = {}  # assignment key → subprocess; Stop kills its process group
        self.starting = set()
        self.cancelled = set()
        self.checks_task = None
        self.checks_cache = None
        self.checks_until = 0
        self.checks_generation = 0
        self.clock = clock
        self.udids = {}

    def runtime(self):
        manifest = self.source / "manifest.json"
        if not manifest.is_file():
            raise DeviceError("helper_source_missing", "This IVE build is missing iPhone support. Reinstall IVE.")
        fingerprint = manifest.read_bytes() + platform.mac_ver()[0].encode() + platform.machine().encode()
        coredevice = Path('/Library/Developer/PrivateFrameworks/CoreDevice.framework/Resources/Info.plist')
        if coredevice.is_file():
            fingerprint += coredevice.read_bytes()
        digest = hashlib.sha256(fingerprint).hexdigest()[:20]
        return self.root / "runtime" / digest

    async def run(self, argv, *, timeout=20, key="setup", cwd=None, env=None):
        if key in self.processes or key in self.starting:
            raise DeviceError("operation_busy", "An operation is already running. Wait or stop it first.")
        # Do not inherit agent secrets or shell/build/helper command overrides.
        clean_env = {k: v for k, v in os.environ.items()
                     if k in {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG"} or k.startswith("LC_")}
        clean_env.update({"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HIDCTL_TIMEOUT_S": "12"})
        clean_env.update(env or {})
        self.starting.add(key)
        spawn = asyncio.create_task(asyncio.create_subprocess_exec(*map(str, argv), cwd=cwd, env=clean_env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True))
        try:
            try:
                proc = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                self.cancelled.add(key)
                proc = await spawn
        except OSError as exc:
            self.cancelled.discard(key)
            raise DeviceError("tool_unavailable", "The required Apple developer tool could not be started.", 503) from exc
        finally:
            self.starting.discard(key)
        self.processes[key] = proc
        if key in self.cancelled:
            self.cancelled.discard(key)
            self.cancel(key)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
            if proc.returncode:
                # No device IDs, clipboard contents, or full compiler logs in API responses.
                raise DeviceError("device_command_failed", "The device operation failed. Unlock the iPhone and check its connection. Run setup to check the Mac.")
            return out
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self.cancel(key)
            await proc.communicate()
            raise DeviceError("outcome_unknown", "The operation stopped before its result was confirmed. Observe the screen before another action.")
        finally:
            if self.processes.get(key) is proc:
                self.processes.pop(key, None)

    def cancel(self, key):
        if key in self.starting:
            self.cancelled.add(key)
        proc = self.processes.get(key)
        if proc and proc.returncode is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    async def close(self):
        for key in set(self.processes) | self.starting:
            self.cancel(key)

    async def prerequisites(self):
        if self.checks_cache is not None and self.clock() < self.checks_until:
            return dict(self.checks_cache)
        if self.checks_task is None or self.checks_task.done():
            self.checks_task = asyncio.create_task(self._prerequisites())
        generation = self.checks_generation
        result = await asyncio.shield(self.checks_task)
        if generation == self.checks_generation:
            self.checks_cache = dict(result)
            self.checks_until = self.clock() + 30
        return dict(result)

    def invalidate_prerequisites(self):
        self.checks_cache = None
        self.checks_until = 0
        self.checks_generation += 1

    async def _prerequisites(self):
        host_ok = platform.system() == "Darwin" and platform.machine() == "arm64"
        try:
            host_ok = host_ok and int(platform.mac_ver()[0].split(".")[0]) >= 27
        except ValueError:
            host_ok = False
        xcode_ok = False
        if host_ok:
            try:
                output = await self.run(["/usr/bin/xcodebuild", "-version"], key="check-xcode", timeout=8)
                match = re.search(rb"Xcode (\d+)", output)
                xcode_ok = bool(match and int(match[1]) >= 27)
            except DeviceError:
                pass
        try:
            helper_ok = os.access(self.runtime() / "build/ipb-helper", os.X_OK)
        except DeviceError:
            helper_ok = False
        return {"supported_mac": host_ok, "xcode_ready": xcode_ok, "helper_ready": helper_ok,
            "requirements": "Apple silicon Mac with macOS 27+, Xcode 27+, and an iPhone with iOS 27+."}

    async def inventory(self):
        if platform.system() != "Darwin":
            return []
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="inventory-", dir=self.root) as temp:
            dest = Path(temp) / "devices.json"
            await self.run(["/usr/bin/xcrun", "devicectl", "list", "devices", "--timeout", "8",
                            "--json-output", dest, "--quiet"], key="inventory", timeout=12)
            try:
                raw = json.loads(dest.read_text())
                devices = normalize_inventory(raw)
                self.udids = {row["identifier"]: (row.get("properties", {}).get("hardware", {}).get("udid")
                    or row.get("hardwareProperties", {}).get("udid")) for row in raw["result"]["devices"]}
            except (ValueError, OSError, KeyError, DiscoveryError) as exc:
                raise DeviceError("discovery_failed", "Apple device discovery failed. Reconnect the iPhone and run setup.", 503) from exc
        # Do not expose the earlier spike's placeholder control state.
        for d in devices:
            d.pop("ive_control", None)
            d.pop("screen_viewing_url", None)
            d.pop("advertised_capabilities", None)
        return [d for d in devices if d["kind"] == "physical" and d["platform"].lower() in {"ios", "iphoneos"}]

    async def prepare(self):
        checks = await self.prerequisites()
        if not checks["supported_mac"]:
            raise DeviceError("unsupported_host", checks["requirements"])
        if not checks["xcode_ready"]:
            raise DeviceError("xcode_required", "Install Xcode 27 or newer, open it and finish Apple's component setup. Then continue here.")
        target = self.runtime()
        manifest = json.loads((self.source / "manifest.json").read_text())
        for name, digest in manifest["files"].items():
            source = self.source / name
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise DeviceError("source_changed", "The bundled iPhone helper failed its integrity check. Reinstall IVE.")
        if checks["helper_ready"]:
            return {"state": "ready", "message": "Mac support is already prepared."}
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in manifest["files"]:
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.source / name, destination)
        # Only the HID helper: never the upstream install/smoke/mirror targets.
        await self.run(["/usr/bin/make", "check-reports", "build/ipb-helper"], cwd=target,
            timeout=180, key="setup", env={"CLANG_MODULE_CACHE_PATH": str(target / "cache"),
                                         "SWIFT_MODULECACHE_PATH": str(target / "cache")})
        self.invalidate_prerequisites()
        return {"state": "ready", "message": "Mac support is prepared. Connect and unlock your iPhone."}

    async def pair(self, device):
        await self.run(["/usr/bin/xcrun", "devicectl", "manage", "pair", "--device", device,
                       "--timeout", "15", "--quiet"], key="setup", timeout=20)
        return {"state": "needs_user", "message": "Accept Trust This Computer on the iPhone if shown, then unlock it."}

    async def developer_mode(self, device):
        udid = self.udids.get(device)
        if not isinstance(udid, str) or not re.fullmatch(r"[0-9A-Fa-f-]{16,64}", udid):
            raise DeviceError("needs_user", "On the iPhone, open Settings → Privacy & Security → Developer Mode. Enable it, restart and confirm.")
        await self.run(["/usr/bin/xcrun", "devmodectl", "single", udid], key="setup", timeout=20)
        return {"state": "needs_user", "message": "Finish the Developer Mode confirmation on your iPhone. If it restarts, unlock it and continue."}

    async def open_xcode(self):
        await self.run(["/usr/bin/open", "macappstore://itunes.apple.com/app/id497799835"], key="setup", timeout=8)
        return {"state": "needs_user", "message": "Install Xcode in the App Store and open it once to finish Apple's component setup."}

    async def observe(self, device, key):
        with tempfile.TemporaryDirectory(prefix="frame-", dir=self.root) as temp:
            path = Path(temp) / "screen.png"
            await self.run(["/usr/bin/xcrun", "devicectl", "device", "capture", "screenshot", "--device", device,
                "--destination", path, "--timeout", "12", "--quiet"], key=key, timeout=16)
            if not path.is_file() or path.stat().st_size > 12 * 1024 * 1024:
                raise DeviceError("invalid_frame", "No fresh iPhone screenshot was returned.")
            image = path.read_bytes()
            width, height = png_size(image)
            return image, width, height

    async def act(self, device, command, key):
        runtime = self.runtime()
        if not os.access(runtime / "build/ipb-helper", os.X_OK):
            raise DeviceError("setup_required", "Let the setup agent prepare iPhone support first.")
        await self.run(["/bin/zsh", "-f", runtime / "bin/ipb", "-s", device, *command], key=key, timeout=20,
            env={"IPB_HELPER": str(runtime / "build/ipb-helper")})
