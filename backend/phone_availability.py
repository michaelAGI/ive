"""Narrow, local bridge to the signed macOS phone-availability helper.

Lease credentials stay in this process. HTTP clients only receive sanitized
status. There is no shell, configurable executable, or arbitrary root command.
Refusals carry a machine-readable reason so the UI can offer the one fix.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time

MAX_DURATION = 8 * 60 * 60
BATTERY_FLOOR = 20
_VISIBLE = {"battery_percent", "battery_floor", "expires_at", "last_verified_at",
            "allow_battery", "reason", "message", "approval_required", "on_battery",
            "service_status", "bundle_verified"}
_VISIBLE.update({"protocol_version", "lid_saver_supported", "lid_closed", "lid_saver_active",
                 "low_power_active", "lid_low_power", "pause_apps", "paused_processes"})
PAUSE_APPS = {"com.tinyspeck.slackmacgap", "com.hnc.Discord", "net.whatsapp.WhatsApp", "com.spotify.client"}
_LOGIN_ITEMS = "System Settings → General → Login Items & Extensions → Allow in the Background → IVE (administrator)"
# Why a start was refused. Every sentence names the next step; no text points at another panel.
_START_REFUSALS = {
    "battery_not_allowed": "This Mac is running on battery. Allow battery use to continue, or connect the power adapter.",
    "macos_helper_approval_required": f"macOS must allow the IVE background helper once: {_LOGIN_ITEMS}.",
    "macos_helper_not_registered": f"Set up the IVE background helper once: turn the feature on, then allow it under {_LOGIN_ITEMS}.",
    "helper_outdated": "Update the IVE Mac app. If it is already current, turn the IVE item off and on in Login Items & Extensions, or restart the Mac.",
    "helper_connection_failed": "The IVE background helper did not answer. Check that IVE is allowed under Login Items & Extensions, then try again.",
    "mac_app_required": "Closed-lid power control needs the IVE Mac app. Install the latest IVE Mac app and open it from Applications.",
    "already_running": "A Mac power session is already running. Stop it before changing modes.",
    "phone_connection_required": "Start the secure iPhone connection before keeping this Mac available.",
    "sleep_already_disabled_elsewhere": "Another app or setting already keeps this Mac awake. Restore normal sleep first, for example with: sudo pmset -a disablesleep 0",
    "session_already_active_or_blocked": "The background helper is still busy with a previous session. Wait a moment, check the status, then try again.",
    "battery_unavailable": "This feature needs a MacBook with a built-in battery.",
    "battery_cutoff": "The battery is at 20 % or below. Connect the power adapter or charge above 20 %, then try again.",
    "thermal_cutoff": "This Mac is too warm right now. Let it cool down with the lid open, then try again.",
    "thermal_unavailable": "macOS did not report this Mac's temperature state. Try again in a moment.",
    "stale_power_data": "Battery information was out of date. Try again in a moment.",
    "lid_state_unavailable": "macOS did not report whether the lid is open or closed. Turn off the lid actions and try again, or restart the Mac.",
    "power_source_unavailable": "macOS did not report whether this Mac runs on power or battery. Connect the power adapter, then try again.",
    "untrusted_process": "The background helper could not verify IVE's signature. Quit IVE and open the signed app from Applications.",
}
# What happened to a session or what the status means now.
_MESSAGES = {
    "battery_cutoff": "Availability ended because the battery reached 20 %. Connect the power adapter, then turn the feature on again.",
    "thermal_cutoff": "Availability ended because this Mac got too warm. Let it cool down with the lid open, then turn the feature on again.",
    "duration_ended": "The timer has ended and normal sleep is restored. Turn the feature on again if you need more time.",
    "heartbeat_expired": "The connection between IVE and its background helper stopped, so normal sleep is restored. Turn the feature on again while IVE is running.",
    "app_exited": "IVE stopped and normal sleep is restored. Turn the feature on again after reopening IVE.",
    "helper_restarted": "The background helper restarted and restored normal sleep. Turn the feature on again if you still need it.",
    "restore_failed": "Normal sleep could not be verified. Keep the lid open and choose Turn off and restore again (Restore normal sleep in iPhone setup). If that fails, run: sudo pmset -a disablesleep 0, or restart the Mac.",
    "recovery_journal_unreadable": "The background helper could not check a previous session. Keep the lid open and restart the Mac to clear it.",
    "not_found": "The IVE background helper is missing from this app. Install the latest IVE Mac app.",
}
_MESSAGES["embedded_service_missing"] = _MESSAGES["not_found"]
# Which System Settings pane fixes a reason; absent means a sentence is enough.
SETTINGS_PANES = {
    "macos_helper_approval_required": "login_items", "macos_helper_not_registered": "login_items",
    "helper_outdated": "login_items", "helper_connection_failed": "login_items",
    "battery_not_allowed": "battery", "battery_cutoff": "battery",
}
# Registration replies name a state but no reason; the state alone says what to do.
_STATE_REASONS = {"needs_approval": "macos_helper_approval_required", "not_registered": "macos_helper_not_registered",
                  "unregistered": "macos_helper_not_registered", "not_found": "not_found"}


def message_for(reason, *, refusing=False):
    tables = (_START_REFUSALS, _MESSAGES) if refusing else (_MESSAGES, _START_REFUSALS)
    for table in tables:
        if reason in table:
            return table[reason]
    return f"Mac availability needs attention ({str(reason).replace('_', ' ')}). Check the status and try again."


class PowerProblem(Exception):
    """Base of refusals and conflicts: .reason, .state and .settings_pane drive the UI."""

    def __init__(self, reason, *, state=None, message=None):
        super().__init__(message or message_for(reason, refusing=True))
        self.reason = reason
        self.state = state
        self.settings_pane = SETTINGS_PANES.get(reason)


class PowerRefusal(PowerProblem, RuntimeError):
    """macOS, the helper or this bridge refused to change power settings."""


class PowerConflict(PowerProblem, ValueError):
    """The request clashes with the running session or its preconditions."""


def helper_path() -> Path | None:
    if sys.platform != "darwin" or not getattr(sys, "frozen", False) or not os.getenv("IVE_DESKTOP_INSTANCE"):
        return None
    for parent in Path(sys.executable).resolve().parents:
        if parent.suffix == ".app":
            path = parent / "Contents/MacOS/ive-phone-power"
            return path if path.is_file() and os.access(path, os.X_OK) else None
    return None


class PhoneAvailability:
    def __init__(self, *, connected, helper=None, caller=None):
        self.connected = connected
        self.helper = helper if helper is not None else helper_path()
        self.caller = caller or self._call
        self.app_pid = os.getppid()
        self.lease = None
        self.task = None
        self.lock = asyncio.Lock()
        self.last = {"state": "unavailable", "battery_floor": BATTERY_FLOOR}
        if self.helper is None:
            self.last.update(reason="mac_app_required", settings_pane=None, message=message_for("mac_app_required"))
        self.last_check = float("-inf")
        self.revision = 0
        self.purpose = None
        self.options = None

    async def _call(self, payload):
        if self.helper is None:
            raise PowerRefusal("mac_app_required")
        try:
            proc = await asyncio.create_subprocess_exec(
                str(self.helper), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            raise PowerRefusal("helper_connection_failed") from None
        try:
            out, _ = await asyncio.wait_for(proc.communicate(json.dumps(payload).encode() + b"\n"), 25)
        except BaseException:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            raise
        try:
            result = json.loads(out) if len(out) <= 65536 else None
        except (ValueError, TypeError):
            result = None
        if not isinstance(result, dict):
            raise PowerRefusal("helper_connection_failed")
        return result

    def _remember(self, result):
        self.revision += 1
        phase = result.get("status", result.get("state", "blocked"))
        if phase == "active" and result.get("ok") is not True:
            phase = "blocked"
        self.last = {"state": phase, "battery_floor": BATTERY_FLOOR,
                     **{k: v for k, v in result.items() if k in _VISIBLE}}
        if self.purpose and phase in {"active", "restoring", "restore_failed"}:
            self.last["mode_source"] = self.purpose
        for key in ("expires_at", "last_verified_at"):
            value = self.last.get(key)
            if type(value) in (int, float):
                try:
                    self.last[key] = datetime.fromtimestamp(value, timezone.utc).isoformat()
                except (ValueError, OverflowError, OSError):
                    self.last.pop(key, None)
        reason = self.last.get("reason") or _STATE_REASONS.get(phase)
        if reason:
            self.last["reason"] = reason
            self.last["settings_pane"] = SETTINGS_PANES.get(reason)
            if not self.last.get("message"):
                self.last["message"] = message_for(reason)
        self.last_check = time.monotonic()
        return dict(self.last)

    async def status(self):
        if self.helper is None or time.monotonic() - self.last_check < 2:
            return dict(self.last)
        revision = self.revision
        # A slow read must never undo an acknowledged lifecycle change, even
        # when it fails. Do not lock this IPC: Stop must remain able to proceed
        # while a status helper is slow or unavailable.
        try:
            result = await self.caller({"action": "status", "app_pid": self.app_pid})
        except Exception as exc:
            if revision != self.revision:
                return dict(self.last)
            if isinstance(exc, PowerProblem):
                raise
            raise PowerRefusal("helper_connection_failed") from exc
        if revision != self.revision:
            return dict(self.last)
        return self._remember(result)

    async def register(self):
        """Register the background helper with macOS. Approval may still be pending; nothing starts."""
        async with self.lock:
            self.revision += 1
            return self._remember(await self.caller({"action": "register", "app_pid": self.app_pid}))

    async def start(self, *, allow_battery, duration_seconds=MAX_DURATION,
                    purpose="phone", lid_low_power=False, pause_apps=None):
        pause_apps = [] if pause_apps is None else pause_apps
        if (type(allow_battery) is not bool or type(lid_low_power) is not bool
                or type(duration_seconds) is not int or not 60 <= duration_seconds <= MAX_DURATION
                or purpose not in {"phone", "agent"} or not isinstance(pause_apps, list)
                or any(type(app) is not str or app not in PAUSE_APPS for app in pause_apps)
                or len(pause_apps) != len(set(pause_apps))):
            raise ValueError("Choose a timer between 1 minute and 8 hours and supported battery/app options.")
        options = (purpose, allow_battery, duration_seconds, lid_low_power, tuple(sorted(pause_apps)))
        async with self.lock:
            self.revision += 1
            if self.lease:
                if self.options == options:
                    return await self.status()
                if self.purpose != "phone" or purpose != "phone":
                    raise PowerConflict("already_running", state=self.last.get("state"))
                await self._cancel_heartbeat()
                result = await self._stop_lease()
                if result["state"] not in {"ready", "stopped"}:
                    raise PowerRefusal("restore_failed", state=result["state"],
                                       message="Normal sleep must be verified before battery use changes. Keep the lid open and try again in a moment.")
            if purpose == "phone" and not self.connected():
                raise PowerConflict("phone_connection_required")
            status = await self.caller({"action": "status", "app_pid": self.app_pid})
            if (lid_low_power or pause_apps) and status.get("lid_saver_supported") is not True:
                raise PowerRefusal("helper_outdated", state=status.get("status"))
            if status.get("status") == "needs_approval":
                return self._remember(status)
            if status.get("status") in {"not_registered", "unregistered"}:
                status = await self.caller({"action": "register", "app_pid": self.app_pid})
                if status.get("ok") is not True or status.get("status") != "ready":
                    return self._remember(status)
            payload = {"action": "start", "app_pid": self.app_pid,
                       "duration_seconds": duration_seconds, "allow_battery": allow_battery}
            if lid_low_power or pause_apps:
                payload.update(lid_low_power=lid_low_power, pause_apps=pause_apps)
            try:
                result = await self.caller(payload)
            except Exception:
                self._remember({"state": "restoring", "reason": "helper_connection_failed",
                                "message": "Start could not be confirmed. Check status before retrying; the helper restores an unrenewed session automatically."})
                raise
            view = self._remember(result)
            if result.get("ok") is True and result.get("status") == "active" and isinstance(result.get("lease_id"), str) and result["lease_id"]:
                self.lease = result["lease_id"]
                self.purpose = purpose
                self.options = options
                self.last["mode_source"] = purpose
                view = dict(self.last)
                self.task = asyncio.create_task(self._heartbeat())
            else:
                reason, message = result.get("reason"), None
                if view["state"] == "active":
                    reason = "helper_outdated"
                    message = "The background helper answered without a valid session. " + _START_REFUSALS["helper_outdated"]
                    self.last = {"state": "blocked", "battery_floor": BATTERY_FLOOR}
                error = PowerRefusal(reason if type(reason) is str and reason else "start_refused",
                                     state=self.last["state"], message=message)
                self.last.update(reason=error.reason, settings_pane=error.settings_pane, message=str(error))
                raise error
            return view

    async def open_approval(self):
        result = await self.caller({"action": "open-settings", "app_pid": self.app_pid})
        # The registration reply says ready; a live lease stays authoritative until its next renewal.
        return dict(self.last) if self.lease else self._remember(result)

    async def _heartbeat(self):
        try:
            while self.lease:
                await asyncio.sleep(10)
                if self.purpose == "phone" and not self.connected():
                    await self._stop_lease()
                    return
                result = await self.caller({"action": "renew", "lease_id": self.lease, "app_pid": self.app_pid})
                self._remember(result)
                if not result.get("ok") or result.get("status") != "active":
                    if result.get("status") in {"ready", "stopped"}:
                        self.lease = None
                    else:
                        await self._stop_lease()
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            # The independent privileged helper expires an unrenewed lease.
            self.lease = None
            self._remember({"state": "restoring", "battery_floor": BATTERY_FLOOR, "reason": "helper_connection_failed",
                            "message": "Connection to the availability helper was lost. Its safety timeout restores normal sleep."})

    async def _stop_lease(self):
        self.revision += 1
        lease = self.lease
        if lease:
            try:
                view = self._remember(await self.caller({"action": "stop", "lease_id": lease, "app_pid": self.app_pid}))
                if view["state"] in {"ready", "stopped"}:
                    self.lease = None
                    self.purpose = None
                    self.options = None
                return view
            except Exception:
                self._remember({"state": "restoring", "battery_floor": BATTERY_FLOOR, "reason": "helper_connection_failed",
                                "message": "Waiting for the helper's safety timeout to restore normal sleep."})
        return dict(self.last)

    async def stop_phone(self):
        if self.purpose == "agent":
            return {"state": "ready"}
        return await self.stop()

    async def stop(self):
        async with self.lock:
            self.revision += 1
            await self._cancel_heartbeat()
            return await self._stop_lease()

    async def _cancel_heartbeat(self):
        task, self.task = self.task, None
        if task and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def close(self):
        await self.stop()
