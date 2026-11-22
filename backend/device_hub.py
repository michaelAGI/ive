"""Device assignments and setup orchestration; no implicit control on pairing."""
from __future__ import annotations

import asyncio
import base64
import copy
from collections import OrderedDict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import time

from device_adapter import AppleDeviceAdapter, DeviceError
from helper_command import python_command
from resource_path import project_root

DEVICE_ID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
COMMAND_ID = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
LEASE_SECONDS = 3600
FRAME_SECONDS = 45
INVENTORY_SECONDS = 2


def device_id(value):
    if not isinstance(value, str) or not DEVICE_ID.fullmatch(value):
        raise DeviceError("invalid_device", "Choose an iPhone from the device list.", 400)
    return value


def action_command(action, args):
    if not isinstance(args, dict):
        raise DeviceError("invalid_action", "Action arguments must be an object.", 400)
    def number(key, low=0, high=1):
        value = args.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise DeviceError("invalid_action", f"{key} must be between {low} and {high}.", 400)
        return str(value)
    if action == "tap" and set(args) == {"x", "y"}:
        return ["tap", number("x"), number("y")]
    if action == "swipe" and set(args) in ({"x1", "y1", "x2", "y2"}, {"x1", "y1", "x2", "y2", "duration"}):
        return ["swipe", *[number(k) for k in ("x1", "y1", "x2", "y2")],
                number("duration", .1, 2) if "duration" in args else "0.3"]
    if action == "type_text" and set(args) == {"text"}:
        value = args.get("text")
        if isinstance(value, str) and 0 < len(value) <= 4000 and "\x00" not in value:
            return ["text", value]
    if action == "home" and not args:
        return ["home"]
    if action == "key" and set(args) == {"key"} and args.get("key") in {"enter", "backspace", "escape", "tab"}:
        return ["key", args["key"]]
    raise DeviceError("invalid_action", "Use tap, swipe, type_text, home or a supported key with the documented arguments.", 400)


class DeviceHub:
    def __init__(self, data_dir, adapter=None, clock=time.time):
        self.root = Path(data_dir) / "device-hub"
        self.adapter = adapter or AppleDeviceAdapter(data_dir)
        self.clock = clock
        self.assignments = {}
        self.frames = {}
        self.locks = {}
        self.setup = None
        self.setup_task = None
        self.scan_task = None
        self.inventory_cache = None
        self.inventory_at = 0
        self.inventory_generation = 0
        self.journal = self.root / "commands.json"
        self.results = OrderedDict()
        self.journal_error = False
        try:
            if self.journal.stat().st_size > 2 * 1024 * 1024:
                raise ValueError("Oversized input journal")
            rows = json.loads(self.journal.read_text())
            if not isinstance(rows, dict):
                raise ValueError("Invalid input journal")
            for key, value in rows.items():
                if (not isinstance(value, dict) or not isinstance(value.get("digest"), str)
                        or value.get("state") not in {"running", "submitted", "outcome_unknown"}):
                    raise ValueError("Invalid input record")
                if value["state"] == "running":
                    value["state"] = "outcome_unknown"
                self.results[key] = value
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            self.journal_error = True

    def save_results(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        while len(self.results) > 256:
            self.results.popitem(last=False)
        path = self.root / (".commands-" + secrets.token_hex(8))
        try:
            with path.open("x") as handle:
                os.chmod(path, 0o600)
                json.dump(self.results, handle)
            os.replace(path, self.journal)
        finally:
            path.unlink(missing_ok=True)

    def invalidate_inventory(self):
        self.inventory_cache = None
        self.inventory_generation += 1

    async def inventory(self, *, refresh=False):
        if refresh:
            self.invalidate_inventory()
        if self.inventory_cache is not None and 0 <= self.clock() - self.inventory_at < INVENTORY_SECONDS:
            return copy.deepcopy(self.inventory_cache)
        if self.scan_task is None or self.scan_task.done():
            self.scan_task = asyncio.create_task(self.adapter.inventory())
        generation = self.inventory_generation
        try:
            devices = await asyncio.shield(self.scan_task)
        except Exception:
            self.invalidate_inventory()
            raise
        rows = [{**d, "id": d["provider_device_id"]} for d in devices]
        if generation == self.inventory_generation:
            self.inventory_cache = copy.deepcopy(rows)
            self.inventory_at = self.clock()
        return rows

    async def find(self, identifier, *, refresh=False):
        device_id(identifier)
        devices = await self.inventory(refresh=refresh)
        found = next((d for d in devices if d["id"] == identifier), None)
        if not found:
            self.revoke(identifier)
            raise DeviceError("device_disconnected", "This iPhone is not available. Reconnect and unlock it.")
        return found

    def lease(self, identifier, session_id=None):
        grant = self.assignments.get(identifier)
        if not grant or grant["expires_at"] <= self.clock():
            self.revoke(identifier)
            raise DeviceError("assignment_required", "Assign this iPhone to the agent in Devices first.", 403)
        if session_id is not None and grant["session_id"] != session_id:
            raise DeviceError("assignment_required", "This iPhone is assigned to a different session.", 403)
        return grant

    async def assign(self, identifier, session_id):
        await self.find(identifier, refresh=True)
        current = self.assignments.get(identifier)
        if current and current["expires_at"] > self.clock() and current["session_id"] != session_id:
            raise DeviceError("device_busy", "Stop the current agent before assigning another one.")
        grant = {"session_id": session_id, "lease_id": secrets.token_hex(16),
                 "expires_at": self.clock() + LEASE_SECONDS}
        self.assignments[identifier] = grant
        self.frames.pop(identifier, None)
        return grant

    def revoke(self, identifier):
        self.assignments.pop(identifier, None)
        self.frames.pop(identifier, None)
        self.adapter.cancel(identifier)
        self.invalidate_inventory()
        if self.setup and self.setup.get("device_id") == identifier and self.setup.get("state") == "ready":
            self.stop_setup()

    def setup_grant(self, session_id, identifier=None, control_after_setup=False):
        if (self.setup and self.setup["state"] != "ready" and self.setup["expires_at"] > self.clock()
                and self.setup["session_id"] != session_id):
            raise DeviceError("setup_busy", "Stop the current setup agent first.")
        self.setup = {"session_id": session_id, "device_id": device_id(identifier) if identifier else None,
            "control_after_setup": control_after_setup is True,
            "expires_at": self.clock() + LEASE_SECONDS, "state": "waiting_for_agent",
            "message": "The setup agent will check the Mac and the connected iPhone."}
        return dict(self.setup)

    def require_setup(self, session_id):
        if not self.setup or self.setup["session_id"] != session_id or self.setup["expires_at"] <= self.clock():
            raise DeviceError("setup_grant_required", "Choose Let an agent set it up in Devices first.", 403)
        return self.setup

    def stop_setup(self):
        self.setup = None
        if self.setup_task and not self.setup_task.done():
            self.setup_task.cancel()
        self.adapter.cancel("setup")

    async def setup_action(self, session_id, action, identifier=None, wait_seconds=0):
        grant = self.require_setup(session_id)
        if (isinstance(wait_seconds, bool) or not isinstance(wait_seconds, (int, float))
                or not math.isfinite(wait_seconds) or not 0 <= wait_seconds <= 20):
            raise DeviceError("invalid_wait", "wait_seconds must be between 0 and 20.", 400)
        if action == "check":
            if wait_seconds and self.setup_task and not self.setup_task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(self.setup_task), wait_seconds)
                except asyncio.TimeoutError:
                    pass
                except asyncio.CancelledError:
                    if self.setup is grant:
                        raise
                self.require_setup(session_id)
            return await self.status(session_id)
        if wait_seconds:
            raise DeviceError("invalid_wait", "Use wait_seconds only with check.", 400)
        if self.setup_task and not self.setup_task.done():
            return dict(grant)
        if action not in {"prepare", "pair", "developer_mode", "open_xcode", "verify"}:
            raise DeviceError("invalid_setup_action", "Unknown setup step.", 400)
        if action in {"pair", "developer_mode", "verify"}:
            devices = await self.inventory()
            chosen = grant["device_id"]
            if not chosen:
                candidates = [d for d in devices if d["connected"] or d["transport"] == "wired"]
                if len(candidates) != 1:
                    raise DeviceError("choose_device", "Connect one iPhone, or choose the intended iPhone in Devices.")
                chosen = candidates[0]["id"]
            if identifier and identifier != chosen:
                raise DeviceError("wrong_device", "Setup is assigned to a different iPhone.", 403)
            device = await self.find(chosen)
            grant["device_id"] = chosen
        if self.require_setup(session_id) is not grant:
            raise DeviceError("setup_replaced", "Setup was stopped or replaced. Check its current state.", 403)
        grant.update(state="running", step=action, message={
            "prepare": "Preparing Mac support…", "pair": "Pairing with your iPhone…",
            "developer_mode": "Requesting Developer Mode…", "open_xcode": "Opening Xcode in the App Store…",
            "verify": "Checking a fresh screenshot…"}[action])
        self.invalidate_inventory()
        invalidate_checks = getattr(self.adapter, "invalidate_prerequisites", None)
        if invalidate_checks:
            invalidate_checks()
        async def work():
            try:
                if action == "verify":
                    self.validate_device(device)
                    if not (await self.adapter.prerequisites())["helper_ready"]:
                        raise DeviceError("setup_required", "Prepare Mac support before verifying setup.")
                    await self.adapter.observe(chosen, "setup")
                    if self.setup is not grant:
                        return
                    self.require_setup(session_id)
                    if grant["control_after_setup"]:
                        await self.assign(chosen, session_id)
                    result = {"state": "ready", "message": "Your iPhone is connected. The agent can now observe its screen and perform your tasks."
                        if grant["control_after_setup"] else "Your iPhone screen is reachable. Choose an agent to start control."}
                elif action in {"pair", "developer_mode"}:
                    result = await getattr(self.adapter, action)(chosen)
                else:
                    result = await getattr(self.adapter, action)()
                if action != "verify" and result.get("state") == "ready":
                    result = {**result, "state": "step_complete"}
                if self.setup is grant:
                    grant.update(result)
            except DeviceError as exc:
                if self.setup is grant:
                    grant.update(state="needs_user", code=exc.code, message=str(exc))
            except asyncio.CancelledError:
                pass
            except Exception:
                if self.setup is grant:
                    grant.update(state="failed", code="setup_failed", message="Setup could not finish. Check Xcode and reconnect the iPhone, then continue.")
            finally:
                self.invalidate_inventory()
                if invalidate_checks:
                    invalidate_checks()
        self.setup_task = asyncio.create_task(work())
        return dict(grant)

    @staticmethod
    def validate_device(device):
        try:
            supported = int(device["os_version"].split(".")[0]) >= 27
        except (ValueError, KeyError):
            supported = False
        if not supported:
            raise DeviceError("unsupported_ios", "iPhone control requires iOS 27 or newer.")
        if device["developer_mode"] != "enabled":
            raise DeviceError("developer_mode_required", "Enable Developer Mode in Settings → Privacy & Security on your iPhone, restart and confirm.")

    async def status(self, session_id=None, *, refresh=False):
        if refresh:
            self.invalidate_inventory()
            invalidate_checks = getattr(self.adapter, "invalidate_prerequisites", None)
            if invalidate_checks:
                invalidate_checks()
        checks = await self.adapter.prerequisites()
        error = None
        try:
            devices = await self.inventory() if checks["supported_mac"] and checks["xcode_ready"] else []
        except DeviceError as exc:
            devices, error = [], {"code": exc.code, "message": str(exc)}
        for identifier in list(self.assignments):
            if (self.assignments[identifier]["expires_at"] <= self.clock()
                    or (not error and identifier not in {d["id"] for d in devices})):
                self.revoke(identifier)
        if self.setup and self.setup["expires_at"] <= self.clock():
            self.stop_setup()
        setup = self.setup if self.setup and (session_id is None or self.setup["session_id"] == session_id) else None
        visible = []
        for d in devices:
            grant = self.assignments.get(d["id"])
            if session_id and not setup and (not grant or grant["session_id"] != session_id):
                continue
            try:
                self.validate_device(d)
                ready = bool(checks["supported_mac"] and checks["xcode_ready"] and checks["helper_ready"]
                             and (d["connected"] or d["transport"] == "wired"))
            except DeviceError:
                ready = False
            visible.append({**d, "assignment": dict(grant) if grant else None,
                "control_available": ready,
                "frame_available": d["id"] in self.frames})
        return {"checks": checks, "devices": visible, "setup": dict(setup) if setup else None, "error": error,
            "photo_duplicate_report": {"argv_prefix": python_command(str(project_root() / "scripts/photo_duplicate_report.py")),
                "usage": "Append the explicitly chosen export folder, optionally --output NEW_REPORT.json. "
                         "Read-only exact SHA-256 duplicates; no iPhone filesystem access, deletion, models or network. "
                         "Never point it at the Photos library. Similar images require separate review."}}

    async def observe(self, identifier, session_id=None):
        grant = self.lease(identifier, session_id)
        async with self.locks.setdefault(identifier, asyncio.Lock()):
            device = await self.find(identifier)
            self.validate_device(device)
            return await self.capture_frame(identifier, session_id, grant)

    async def capture_frame(self, identifier, session_id, grant):
        """Capture while the caller holds the device lock; never rediscover mid-step."""
        if self.assignments.get(identifier) is not grant or grant["expires_at"] <= self.clock():
            raise DeviceError("control_stopped", "Control was stopped.", 403)
        try:
            image, width, height = await self.adapter.observe(identifier, identifier)
        except (DeviceError, OSError) as exc:
            self.invalidate_inventory()
            if session_id is not None:
                self.frames.pop(identifier, None)
            if isinstance(exc, OSError):
                raise DeviceError("capture_failed", "The screenshot could not be read. Observe again before another input.") from exc
            raise
        if self.assignments.get(identifier) is not grant or grant["expires_at"] <= self.clock():
            raise DeviceError("control_stopped", "Control was stopped. The screenshot was discarded.", 403)
        frame = {"frame_id": secrets.token_hex(16), "observed_at": self.clock(),
                 "width": width, "height": height, "lease_id": grant["lease_id"],
                 "image_sha256": hashlib.sha256(image).hexdigest()}
        # Owner preview must not invalidate the agent's in-flight frame.
        if session_id is not None:
            self.frames[identifier] = frame
        return {**frame, "device_id": identifier, "image_base64": base64.b64encode(image).decode(), "mime_type": "image/png"}

    async def act(self, identifier, session_id, body):
        started = time.perf_counter()
        grant = self.lease(identifier, session_id)
        observe_after = body.get("observe_after", True)
        if not isinstance(observe_after, bool):
            raise DeviceError("invalid_action", "observe_after must be a boolean.", 400)
        if self.journal_error:
            raise DeviceError("history_unavailable", "IVE cannot read its device input history. Control is paused to prevent repeated input. Restore the history or contact support before continuing.", 503)
        command = action_command(body.get("action"), body.get("arguments", {}))
        cid = body.get("command_id", "")
        if not isinstance(cid, str) or not COMMAND_ID.fullmatch(cid):
            raise DeviceError("command_id_required", "Supply a unique command_id (8–100 letters, digits, underscores or hyphens).", 400)
        key = f"{session_id}:{identifier}:{cid}"
        digest = hashlib.sha256(json.dumps(command, ensure_ascii=True).encode()).hexdigest()
        async with self.locks.setdefault(identifier, asyncio.Lock()):
            if key in self.results:
                previous = self.results[key]
                if previous["digest"] != digest:
                    raise DeviceError("command_id_reused", "This command_id belongs to a different action.")
                return {**{k: v for k, v in previous.items() if k != "digest"},
                        "replayed": True,
                        "next_step": "Read the previous result or observe again. This input was not sent again."}
            if self.assignments.get(identifier) is not grant or grant["expires_at"] <= self.clock():
                raise DeviceError("control_stopped", "Control was stopped.", 403)
            frame = self.frames.get(identifier)
            if (not frame or frame["frame_id"] != body.get("frame_id") or frame["lease_id"] != grant["lease_id"]
                    or self.clock() - frame["observed_at"] > FRAME_SECONDS):
                raise DeviceError("fresh_frame_required", "Observe the iPhone again before sending this action.")
            device = await self.find(identifier)
            self.validate_device(device)
            # Confirm orientation immediately before coordinate-based actions.
            if command[0] in {"tap", "swipe"}:
                try:
                    _, width, height = await self.adapter.observe(identifier, identifier)
                except DeviceError:
                    self.frames.pop(identifier, None)
                    self.invalidate_inventory()
                    raise
                if width >= height or (width, height) != (frame["width"], frame["height"]):
                    self.frames.pop(identifier, None)
                    raise DeviceError("orientation_changed", "Hold the iPhone in portrait and observe its screen again.")
            if self.assignments.get(identifier) is not grant or grant["expires_at"] <= self.clock():
                raise DeviceError("control_stopped", "Control was stopped.", 403)
            if self.clock() - frame["observed_at"] > FRAME_SECONDS:
                self.frames.pop(identifier, None)
                raise DeviceError("fresh_frame_required", "The observation expired while preparing input. Observe again.")
            self.frames.pop(identifier, None)
            record = {"command_id": cid, "digest": digest, "state": "running"}
            self.results[key] = record
            self.save_results()  # Persist before dispatch. A restart cannot blindly replay input.
            try:
                input_started = time.perf_counter()
                await self.adapter.act(identifier, command, identifier)
                record.update(state="submitted", message="Input submitted. Observe the iPhone to verify the result.")
            except DeviceError as exc:
                record.update(state="outcome_unknown", message=str(exc), code=exc.code)
                self.invalidate_inventory()
            finally:
                if self.assignments.get(identifier) is not grant:
                    record.update(state="outcome_unknown", message="Control stopped during the action. Check the screen before continuing.")
                self.save_results()
            result = {k: v for k, v in record.items() if k != "digest"}
            timings = {"input_ms": round((time.perf_counter() - input_started) * 1000, 1)}
            if observe_after and record["state"] == "submitted":
                capture_started = time.perf_counter()
                try:
                    observation = await self.capture_frame(identifier, session_id, grant)
                    result.update(observation)
                    result["screen_changed"] = observation["image_sha256"] != frame["image_sha256"]
                    result["message"] = "Input submitted. Inspect the returned screenshot; use its frame_id for the next action."
                except DeviceError as exc:
                    # The input is already journaled. A failed screenshot cannot
                    # turn this into a safe-to-retry input or lose its outcome.
                    result["observation_error"] = {"code": exc.code, "message": str(exc)}
                    result["next_step"] = "Observe again before another input; do not repeat the submitted input."
                    if self.assignments.get(identifier) is not grant or grant["expires_at"] <= self.clock():
                        record.update(state="outcome_unknown", message="Control stopped while observing the action result.")
                        self.save_results()
                        result.update(state=record["state"], message=record["message"])
                timings["capture_ms"] = round((time.perf_counter() - capture_started) * 1000, 1)
            timings["total_ms"] = round((time.perf_counter() - started) * 1000, 1)
            result["timings_ms"] = timings
            return result

    async def close(self):
        self.stop_setup()
        for identifier in list(self.assignments):
            self.revoke(identifier)
        await self.adapter.close()
        pending = [t for t in (self.setup_task, self.scan_task) if t and not t.done()]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
