"""On-device dictation for the microphone button: NVIDIA Parakeet TDT 0.6B v3 on Apple silicon.

Nothing of this ships inside the app. The user installs it once from Settings → Dictation,
which creates DATA_DIR/dictation with

  python/    a pinned python-build-standalone interpreter (packaged app only; a source
             checkout makes a venv from the interpreter that runs the backend instead),
  packages   the wheels listed in backend/dictation-requirements.txt, installed with
             pip --require-hashes --only-binary, so nothing is built and nothing unpinned
             is fetched,
  models/    config.json and model.safetensors of mlx-community/parakeet-tdt-0.6b-v3 at a
             pinned revision, SHA-256 checked. No other file of that repository is read.

Speech recognition runs in backend/dictation_worker.py as a child process of that
interpreter, so mlx never loads into the backend and its memory is released after a
few idle minutes. One stream at a time. Audio arrives from the browser over a WebSocket
and is never written to disk.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import platform
import shutil
import struct
import sys
import time
import uuid
from pathlib import Path

import aiohttp
from aiohttp import web

from config import DATA_DIR, VERSION
from resource_path import backend_dir, is_frozen

logger = logging.getLogger(__name__)

MODEL_REPO = "mlx-community/parakeet-tdt-0.6b-v3"
MODEL_REVISION = "ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15"
# name -> (sha256, size). config.json is a plain git blob; model.safetensors is the LFS
# object whose digest the repository publishes.
MODEL_FILES = {
    "config.json": ("f320f1292511f34ec47f513755fe20fd01dbfc09a925d42730e66059a6e1ef4c", 244093),
    "model.safetensors": ("05e01c7f396c298cf7d23f61da7b504adeab698f0aaeafd9c82d198625464592", 2508288736),
}
MODEL_INFO = {
    "name": "Parakeet TDT 0.6B v3",
    "publisher": "NVIDIA",
    "license": "CC-BY-4.0",
    "languages": 25,
    "repo": MODEL_REPO,
    "revision": MODEL_REVISION,
    "bytes": sum(size for _, size in MODEL_FILES.values()),
}
# Same build as packaging/prepare-python.py (test_dictation.py keeps them in sync).
PYTHON_VERSION = "3.12.15"
PYTHON_RELEASE = "20261009"
PYTHON_SHA256 = "233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f"
PYTHON_URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/"
    f"{PYTHON_RELEASE}/cpython-{PYTHON_VERSION}%2B{PYTHON_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz"
)
PACKAGES_BYTES_ESTIMATE = 120_000_000
PYTHON_BYTES_ESTIMATE = 25_000_000

MIN_MACOS = (14, 0)          # the mlx wheels are built for macOS 14
IDLE_SECONDS = 600           # unload the model after this much silence
LOAD_TIMEOUT = 240.0         # seconds the worker may take to load the model
MAX_STREAM_SECONDS = 900.0   # a forgotten microphone stops itself
MAX_WS_FRAME = 64 * 1024     # one binary frame from the browser (16 kHz int16 = 2 s)
PREBUFFER_LIMIT = 4 * 1024 * 1024  # audio kept while the model loads (~2 min)
DEFAULT_CONTEXT = "256,256"  # encoder context (keep, drop); smaller values lose accuracy


class InstallCancelled(Exception):
    pass


def support() -> tuple[bool, str]:
    if sys.platform != "darwin":
        return False, "Dictation runs on macOS only."
    if platform.machine() != "arm64":
        return False, "Dictation needs an Apple silicon Mac."
    try:
        version = tuple(int(part) for part in platform.mac_ver()[0].split(".")[:2])
    except ValueError:
        version = (0, 0)
    if version and version < MIN_MACOS:
        return False, "Dictation needs macOS 14 or newer."
    return True, ""


def sha256_file(path: Path, cancelled=None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            if cancelled is not None and cancelled():
                raise InstallCancelled()
            digest.update(chunk)
    return digest.hexdigest()


def frame(kind: bytes, payload: bytes) -> bytes:
    """One worker protocol frame: kind byte + big-endian length + payload."""
    return kind + struct.pack(">I", len(payload)) + payload


class DictationStream:
    """One browser dictation session: a WebSocket on one side, the worker on the other."""

    def __init__(self) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.events: asyncio.Queue = asyncio.Queue()
        self.sample_rate = 16000
        self.started = False     # the worker accepted "start"
        self.stopped = False     # the browser asked to finish
        self.finished = False    # "done" or an error reached the browser
        self.buffer: list[bytes] = []
        self.buffered = 0
        self.audio_bytes = 0

    @property
    def seconds(self) -> float:
        return self.audio_bytes / 2 / self.sample_rate


class DictationRuntime:
    def __init__(self, root: Path | None = None, *, frozen: bool | None = None, interpreter: str | None = None) -> None:
        self.root = Path(root) if root else DATA_DIR / "dictation"
        self.frozen = is_frozen() if frozen is None else frozen
        self.base_interpreter = interpreter or sys.executable
        self.worker_script = backend_dir() / "dictation_worker.py"
        self.requirements = backend_dir() / "dictation-requirements.txt"
        self.context = DEFAULT_CONTEXT
        self._install_task: asyncio.Task | None = None
        self._progress: dict = {}
        self._error = ""
        self._cancel = False
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._ready_event: asyncio.Event | None = None
        self._worker_ready = False
        self._worker_error = ""
        self._worker_info: dict = {}
        self._worker_lock = asyncio.Lock()
        self._stream: DictationStream | None = None
        self._idle_handle: asyncio.TimerHandle | None = None

    # ─── Layout ───────────────────────────────────────────────────────────

    @property
    def python_dir(self) -> Path:
        return self.root / "python"

    @property
    def venv_dir(self) -> Path:
        return self.root / "venv"

    @property
    def model_dir(self) -> Path:
        return self.root / "models" / MODEL_REPO.split("/")[-1]

    @property
    def packages_marker(self) -> Path:
        return self.root / "packages.json"

    @property
    def model_marker(self) -> Path:
        return self.model_dir / "verified.json"

    @property
    def log_path(self) -> Path:
        return self.root / "install.log"

    def interpreter(self) -> Path:
        if self.frozen:
            return self.python_dir / "python" / "bin" / "python3"
        return self.venv_dir / "bin" / "python"

    # ─── Checks ───────────────────────────────────────────────────────────

    def requirements_sha256(self) -> str:
        try:
            return hashlib.sha256(self.requirements.read_bytes()).hexdigest()
        except OSError:
            return ""

    def python_ok(self) -> bool:
        return self.interpreter().is_file()

    def packages_ok(self) -> bool:
        try:
            marker = json.loads(self.packages_marker.read_text())
        except (OSError, ValueError):
            return False
        return (
            marker.get("lock_sha256") == self.requirements_sha256()
            and marker.get("interpreter") == str(self.interpreter())
            and self.python_ok()
        )

    def model_ok(self) -> bool:
        try:
            marker = json.loads(self.model_marker.read_text())
        except (OSError, ValueError):
            return False
        if marker.get("revision") != MODEL_REVISION:
            return False
        for name, (sha, size) in MODEL_FILES.items():
            path = self.model_dir / name
            if marker.get("files", {}).get(name) != sha:
                return False
            try:
                if path.stat().st_size != size:
                    return False
            except OSError:
                return False
        return True

    def installing(self) -> bool:
        return self._install_task is not None and not self._install_task.done()

    def state(self) -> str:
        ok, _ = support()
        if not ok:
            return "unsupported"
        if self.installing():
            return "installing"
        if self.python_ok() and self.packages_ok() and self.model_ok():
            return "ready"
        if self._error:
            return "error"
        return "not_installed"

    def worker_alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def status(self) -> dict:
        ok, reason = support()
        return {
            "supported": ok,
            "reason": reason,
            "state": self.state(),
            "error": self._error,
            "progress": dict(self._progress) if self.installing() else None,
            "installed": {"python": self.python_ok(), "packages": self.packages_ok(), "model": self.model_ok()},
            "dir": str(self.root),
            "model": MODEL_INFO,
            "download_bytes": MODEL_INFO["bytes"] + PACKAGES_BYTES_ESTIMATE + (PYTHON_BYTES_ESTIMATE if self.frozen else 0),
            "worker": {
                "running": self.worker_alive(),
                "loaded": self.worker_alive() and self._worker_ready,
                "busy": self._stream is not None,
                "load_ms": self._worker_info.get("load_ms"),
            },
            "version": VERSION,
        }

    # ─── Install ──────────────────────────────────────────────────────────

    def _set_progress(self, step: str, done: int = 0, total: int = 0, detail: str = "") -> None:
        percent = int(done * 100 / total) if total else 0
        self._progress = {"step": step, "done": done, "total": total, "percent": min(100, percent), "detail": detail}

    def _log(self, line: str) -> None:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line.rstrip()}\n")
        except OSError:
            pass

    def start_install(self) -> dict:
        ok, reason = support()
        if not ok:
            raise RuntimeError(reason)
        if not self.installing():
            self._error = ""
            self._cancel = False
            self._install_task = asyncio.create_task(self._install())
        return self.status()

    async def _install(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._log(f"install started (IVE {VERSION}, frozen={self.frozen})")
        try:
            await self._ensure_python()
            await self._ensure_packages()
            await self._ensure_model()
            self._log("install finished")
        except (InstallCancelled, asyncio.CancelledError):
            self._log("install cancelled")
            self._error = ""
        except Exception as exc:
            self._error = str(exc) or type(exc).__name__
            self._log(f"install failed: {self._error}")
            logger.warning("dictation install failed: %s", self._error)
        finally:
            self._progress = {}

    async def cancel_install(self) -> dict:
        self._cancel = True
        task = self._install_task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        return self.status()

    async def uninstall(self) -> dict:
        await self.cancel_install()
        await self.stop_worker()
        if self.root.exists():
            await asyncio.to_thread(shutil.rmtree, self.root, True)
        self._error = ""
        return self.status()

    async def _ensure_python(self) -> None:
        if self.python_ok():
            return
        if not self.frozen:
            self._set_progress("python", detail="Creating the Python environment")
            if self.venv_dir.exists():
                await asyncio.to_thread(shutil.rmtree, self.venv_dir, True)
            await self._run([self.base_interpreter, "-m", "venv", "--clear", str(self.venv_dir)], step="python",
                            detail="Creating the Python environment")
            await self._run([str(self.interpreter()), "-m", "pip", "--version"], step="python",
                            detail="Checking pip")
            return
        archive = self.root / "python.tar.gz"
        await self._download(PYTHON_URL, archive, expected_sha=PYTHON_SHA256, step="python",
                             detail=f"Python {PYTHON_VERSION} runtime")
        if self.python_dir.exists():
            await asyncio.to_thread(shutil.rmtree, self.python_dir, True)
        self.python_dir.mkdir(parents=True)
        self._set_progress("python", detail="Unpacking the Python runtime")
        await self._run(["/usr/bin/tar", "-xzf", str(archive), "-C", str(self.python_dir)], step="python",
                        detail="Unpacking the Python runtime")
        archive.unlink(missing_ok=True)
        if not self.python_ok():
            raise RuntimeError("the Python runtime did not unpack as expected")

    async def _ensure_packages(self) -> None:
        if self.packages_ok():
            return
        if not self.requirements.is_file():
            raise RuntimeError(f"missing {self.requirements.name}")
        self._set_progress("packages", detail="Installing speech packages")  # pip reports no byte counts
        await self._run([
            str(self.interpreter()), "-m", "pip", "install", "--isolated", "--no-input", "--no-deps",
            "--require-hashes", "--only-binary=:all:", "--disable-pip-version-check", "--progress-bar", "off",
            "-r", str(self.requirements),
        ], step="packages", detail="Installing speech packages")
        await self._run([
            str(self.interpreter()), "-I", "-c",
            "import importlib.util as u, mlx.core, numpy, dacite; assert u.find_spec('parakeet_mlx')",
        ], step="packages", detail="Checking the speech packages")
        self.packages_marker.write_text(json.dumps({
            "lock_sha256": self.requirements_sha256(),
            "interpreter": str(self.interpreter()),
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }, indent=2) + "\n")

    async def _ensure_model(self) -> None:
        if self.model_ok():
            return
        self.model_dir.mkdir(parents=True, exist_ok=True)
        verified: dict[str, str] = {}
        try:
            previous = json.loads(self.model_marker.read_text())
            if previous.get("revision") == MODEL_REVISION:
                verified = dict(previous.get("files", {}))
        except (OSError, ValueError):
            pass
        base = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/"
        for name, (sha, size) in MODEL_FILES.items():
            path = self.model_dir / name
            if verified.get(name) == sha and path.is_file() and path.stat().st_size == size:
                continue
            await self._download(base + name, path, expected_sha=sha, expected_size=size, step="model", detail=name)
            verified[name] = sha
            self.model_marker.write_text(json.dumps({"revision": MODEL_REVISION, "files": verified}, indent=2) + "\n")
        self.model_marker.write_text(json.dumps({
            "revision": MODEL_REVISION, "files": verified, "verified_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }, indent=2) + "\n")

    async def _download(self, url: str, dest: Path, *, expected_sha: str, expected_size: int = 0,
                        step: str, detail: str) -> None:
        part = dest.with_name(dest.name + ".part")
        start = part.stat().st_size if part.is_file() else 0
        if expected_size and start >= expected_size:
            part.unlink(missing_ok=True)
            start = 0
        headers = {"User-Agent": f"IVE/{VERSION} dictation-install"}
        if start:
            headers["Range"] = f"bytes={start}-"
        self._log(f"download {url} -> {dest.name} (resume at {start})")
        self._set_progress(step, start, expected_size, detail)
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=120)
        async with aiohttp.ClientSession(trust_env=True, timeout=timeout) as session:
            async with session.get(url, headers=headers, allow_redirects=True) as response:
                if start and response.status != 206:
                    start = 0  # the server ignored the range; start over
                if response.status not in (200, 206):
                    raise RuntimeError(f"download of {dest.name} failed with HTTP {response.status}")
                length = response.headers.get("Content-Length")
                total = expected_size or (start + int(length) if length and length.isdigit() else 0)
                done = start
                with part.open("ab" if start else "wb") as handle:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        if self._cancel:
                            raise InstallCancelled()
                        handle.write(chunk)
                        done += len(chunk)
                        self._set_progress(step, done, total, detail)
        size = part.stat().st_size
        if expected_size and size != expected_size:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"{dest.name} is {size} bytes, expected {expected_size}")
        self._set_progress(step, size, size or 1, f"Checking {detail}")
        digest = await asyncio.to_thread(sha256_file, part, lambda: self._cancel)
        if digest != expected_sha:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"checksum mismatch for {dest.name}; the download was discarded")
        part.replace(dest)
        self._log(f"verified {dest.name} sha256={digest}")

    def _clean_env(self) -> dict:
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("PYTHON", "PIP_", "VIRTUAL_ENV", "CONDA"))
        }
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        env["HF_HUB_OFFLINE"] = "1"
        return env

    async def _run(self, command: list[str], *, step: str, detail: str) -> None:
        self._log("run " + " ".join(command))
        proc = await asyncio.create_subprocess_exec(
            *command, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=self._clean_env(), cwd=str(self.root),
        )
        tail: list[str] = []
        try:
            assert proc.stdout is not None
            async for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                tail.append(line)
                del tail[:-5]
                self._log("  " + line)
                progress = dict(self._progress)
                progress.update({"step": step, "detail": detail, "line": line[:160]})
                self._progress = progress
                if self._cancel:
                    proc.terminate()
            await proc.wait()
        except asyncio.CancelledError:
            proc.terminate()
            raise
        if self._cancel:
            raise InstallCancelled()
        if proc.returncode != 0:
            summary = tail[-1] if tail else f"exit code {proc.returncode}"
            raise RuntimeError(f"{Path(command[0]).name} failed: {summary}")

    # ─── Worker ───────────────────────────────────────────────────────────

    async def ensure_worker(self) -> None:
        async with self._worker_lock:
            if self.worker_alive() and self._worker_ready:
                return
            await self._spawn_worker()

    async def _spawn_worker(self) -> None:
        await self._terminate_worker()
        self._worker_ready = False
        self._worker_error = ""
        self._worker_info = {}
        self._ready_event = asyncio.Event()
        self._proc = await asyncio.create_subprocess_exec(
            str(self.interpreter()), "-I", "-u", str(self.worker_script),
            "--model", str(self.model_dir), "--context", self.context,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=self._clean_env(), cwd=str(self.root), limit=4 * 1024 * 1024,
        )
        self._reader_task = asyncio.create_task(self._read_events(self._proc))
        self._stderr_task = asyncio.create_task(self._read_stderr(self._proc))
        try:
            await asyncio.wait_for(self._ready_event.wait(), LOAD_TIMEOUT)
        except asyncio.TimeoutError:
            await self._terminate_worker()
            raise RuntimeError("the speech model did not load in time")
        if not self._worker_ready:
            await self._terminate_worker()
            raise RuntimeError(self._worker_error or "the speech worker stopped while loading")

    async def _read_events(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        try:
            async for raw in proc.stdout:
                try:
                    event = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                kind = event.get("ev")
                if kind == "ready":
                    self._worker_ready = True
                    self._worker_info = {"load_ms": event.get("load_ms"), "context": event.get("context")}
                    logger.info("dictation worker ready in %s ms", event.get("load_ms"))
                    if self._ready_event is not None:
                        self._ready_event.set()
                    continue
                if kind == "error" and event.get("fatal"):
                    self._worker_error = str(event.get("error") or "worker error")
                    logger.warning("dictation worker: %s", self._worker_error)
                stream = self._stream
                if stream is not None:
                    await stream.events.put(event)
        finally:
            self._worker_ready = False
            if self._ready_event is not None:
                self._ready_event.set()
            stream = self._stream
            if stream is not None and not stream.finished:
                await stream.events.put({"ev": "error", "error": self._worker_error or "the speech worker exited"})

    async def _read_stderr(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                logger.debug("dictation worker: %s", line)
                if not self._worker_ready:
                    self._worker_error = line[-300:]

    async def send(self, kind: bytes, payload: bytes) -> None:
        proc = self._proc
        if proc is None or proc.returncode is not None or proc.stdin is None:
            raise RuntimeError("the speech worker is not running")
        proc.stdin.write(frame(kind, payload))
        await proc.stdin.drain()

    async def _terminate_worker(self) -> None:
        proc, self._proc = self._proc, None
        self._worker_ready = False
        if proc is not None and proc.returncode is None:
            try:
                if proc.stdin is not None:
                    proc.stdin.write(frame(b"J", b'{"op":"exit"}'))
                    await proc.stdin.drain()
                    proc.stdin.close()
                await asyncio.wait_for(proc.wait(), 3)
            except Exception:
                try:
                    proc.kill()
                    await asyncio.wait_for(proc.wait(), 3)
                except Exception:
                    pass
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                try:
                    await asyncio.wait_for(task, 2)
                except Exception:
                    task.cancel()
        self._reader_task = self._stderr_task = None

    async def stop_worker(self) -> None:
        self._cancel_idle()
        async with self._worker_lock:
            await self._terminate_worker()

    def _cancel_idle(self) -> None:
        if self._idle_handle is not None:
            self._idle_handle.cancel()
            self._idle_handle = None

    def _touch_idle(self) -> None:
        self._cancel_idle()
        if not self.worker_alive():
            return
        loop = asyncio.get_running_loop()

        def expire() -> None:
            self._idle_handle = None
            if self._stream is None:
                logger.info("dictation worker idle for %s s, unloading", IDLE_SECONDS)
                asyncio.ensure_future(self.stop_worker())

        self._idle_handle = loop.call_later(IDLE_SECONDS, expire)

    async def shutdown(self, app=None) -> None:
        await self.cancel_install()
        await self.stop_worker()

    # ─── HTTP / WebSocket handlers ────────────────────────────────────────

    async def status_handler(self, request: web.Request) -> web.Response:
        return web.json_response(self.status())

    async def install_handler(self, request: web.Request) -> web.Response:
        try:
            return web.json_response(self.start_install())
        except RuntimeError as exc:
            return web.json_response({"error": str(exc), **self.status()}, status=400)

    async def cancel_handler(self, request: web.Request) -> web.Response:
        return web.json_response(await self.cancel_install())

    async def uninstall_handler(self, request: web.Request) -> web.Response:
        return web.json_response(await self.uninstall())

    async def stream_handler(self, request: web.Request) -> web.WebSocketResponse:
        """WS /api/dictation/stream

        Browser → server: {"type":"start","sample_rate":16000} once, then binary
        int16 PCM frames, then {"type":"stop"}. Server → browser: status/ready,
        interim (draft text), final (text that will not change), done (the rest
        after stop), error (with "fallback": true when the browser should use its
        own speech service instead)."""
        ws = web.WebSocketResponse(heartbeat=30.0, max_msg_size=MAX_WS_FRAME * 4)
        await ws.prepare(request)
        state = self.state()
        if state != "ready":
            reasons = {
                "unsupported": support()[1],
                "installing": "Dictation is still being installed.",
                "not_installed": "On-device dictation is not installed.",
                "error": self._error or "Dictation is not available.",
            }
            await ws.send_json({"type": "error", "error": reasons.get(state, "Dictation is not available."), "fallback": True})
            await ws.close()
            return ws
        if self._stream is not None:
            await ws.send_json({"type": "error", "error": "Dictation is already in use in another window.", "fallback": True})
            await ws.close()
            return ws
        stream = DictationStream()
        self._stream = stream
        self._cancel_idle()
        relay = asyncio.create_task(self._relay(stream, ws))
        starter = asyncio.create_task(self._start_stream(stream))
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    if stream.stopped or stream.finished:
                        continue
                    data = bytes(msg.data)
                    if len(data) > MAX_WS_FRAME:
                        # The relay reports the error and closes the socket, which ends this loop.
                        stream.stopped = True
                        stream.events.put_nowait({"ev": "error", "error": "audio frame too large"})
                        continue
                    stream.audio_bytes += len(data)
                    if stream.started:
                        await self.send(b"A", data)
                    else:
                        if stream.buffered + len(data) > PREBUFFER_LIMIT:
                            continue  # the model is still loading; drop the oldest-silence case rather than grow
                        stream.buffer.append(data)
                        stream.buffered += len(data)
                    if stream.seconds >= MAX_STREAM_SECONDS:
                        await self._request_stop(stream)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except ValueError:
                        continue
                    kind = data.get("type")
                    if kind == "start" and not stream.started:
                        try:
                            rate = int(data.get("sample_rate") or 16000)
                        except (TypeError, ValueError):
                            rate = 16000
                        stream.sample_rate = min(96000, max(8000, rate))
                    elif kind == "stop":
                        await self._request_stop(stream)
                    elif kind == "abort":
                        break
                else:
                    break
        except (ConnectionResetError, ConnectionError, RuntimeError):
            pass
        finally:
            starter.cancel()
            if stream.started and not stream.finished and self.worker_alive():
                try:
                    await self.send(b"J", b'{"op":"abort"}')
                except RuntimeError:
                    pass
            stream.finished = True
            relay.cancel()
            self._stream = None
            self._touch_idle()
            if not ws.closed:
                await ws.close()
        return ws

    async def _request_stop(self, stream: DictationStream) -> None:
        if stream.stopped:
            return
        stream.stopped = True
        if stream.started:
            await self.send(b"J", b'{"op":"stop"}')
        # otherwise _start_stream sends the stop right after the buffered audio

    async def _start_stream(self, stream: DictationStream) -> None:
        stream.events.put_nowait({"ev": "_ws", "payload": {"type": "status", "state": "loading"}})
        try:
            await self.ensure_worker()
        except Exception as exc:
            logger.warning("dictation worker unavailable: %s", exc)
            stream.events.put_nowait({"ev": "error", "error": str(exc), "fallback": True})
            return
        if stream.finished:
            return
        await self.send(b"J", json.dumps({"op": "start", "stream": stream.id, "sample_rate": stream.sample_rate}).encode())
        while stream.buffer:
            await self.send(b"A", stream.buffer.pop(0))
        stream.buffered = 0
        stream.started = True
        stream.events.put_nowait({"ev": "_ws", "payload": {"type": "ready", "stream": stream.id}})
        if stream.stopped:
            await self.send(b"J", b'{"op":"stop"}')

    async def _relay(self, stream: DictationStream, ws: web.WebSocketResponse) -> None:
        try:
            while True:
                event = await stream.events.get()
                kind = event.get("ev")
                if kind == "_ws":
                    payload = event["payload"]
                elif kind == "interim":
                    payload = {"type": "interim", "text": event.get("text", "")}
                elif kind == "final":
                    payload = {"type": "final", "text": event.get("text", "")}
                elif kind == "done":
                    payload = {"type": "done", "text": event.get("text", ""), "seconds": event.get("seconds")}
                elif kind == "error":
                    payload = {"type": "error", "error": str(event.get("error") or "dictation failed"),
                               "fallback": bool(event.get("fallback"))}
                elif kind == "aborted":
                    payload = {"type": "aborted"}
                else:
                    continue
                if ws.closed:
                    return
                await ws.send_json(payload)
                if payload["type"] in ("done", "error", "aborted"):
                    stream.finished = True
                    await ws.close()
                    return
        except (ConnectionResetError, ConnectionError, RuntimeError):
            stream.finished = True


_runtime: DictationRuntime | None = None


def runtime() -> DictationRuntime:
    global _runtime
    if _runtime is None:
        _runtime = DictationRuntime()
    return _runtime


def register_dictation_routes(app: web.Application, guard, owner_guard) -> None:
    rt = runtime()
    app.router.add_get("/api/dictation/status", guard(rt.status_handler, "code", "full"))
    app.router.add_post("/api/dictation/install", owner_guard(rt.install_handler))
    app.router.add_post("/api/dictation/install/cancel", owner_guard(rt.cancel_handler))
    app.router.add_post("/api/dictation/uninstall", owner_guard(rt.uninstall_handler))
    app.router.add_get("/api/dictation/stream", guard(rt.stream_handler, "code", "full"))
    app.on_shutdown.append(rt.shutdown)
