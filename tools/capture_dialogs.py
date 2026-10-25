#!/usr/bin/env python3
"""Capture real CLI dialogs (Claude Code, Codex) from a pseudo-terminal as fixtures.

Stdlib only; ``pyte`` (installed in .venv) renders the screen so a dialog can be
detected on what a user would actually see, not on the byte stream.

  .venv/bin/python tools/capture_dialogs.py --list
  .venv/bin/python tools/capture_dialogs.py --scratch /tmp/dlg --out backend/fixtures/permission_dialogs
  .venv/bin/python tools/capture_dialogs.py --scenarios extra.json --only codex-main

A scenario is {name, cli, argv, cwd, env, prepare, fresh, steps}; ``cwd``/``env``
values may use ``{scratch}``; ``fresh`` (default true) recreates a cwd that lies
under the scratch folder, so first-run dialogs show again. Steps run in order:
  {"send": "text<enter>"}      keys: <enter> <esc> <tab> <btab> <up> <down> <left> <right> <space> <bs> <ctrl-c> <ctrl-d>
  {"wait": 0.5}                seconds (output keeps being read)
  {"wait_quiet": 1.5}          until no output for N s ("timeout" caps the wait)
  {"wait_for": "regex", "absent": "regex", "timeout": 120}   on the rendered screen
  {"wait_ready": true}         the CLI's composer is idle (per-cli regex) and output is quiet
  {"capture": "name", "kind": "...", "notes": "...", "wait": "dialog|quiet|none",
   "optional": false, "timeout": 120, "dialog": "regex", "question": "...", "options": [...], "footer": "..."}
  {"shell": ["cmd", ...]}      host command in cwd; exit code and output go to the log
  {"quit": true}               polite exit (/exit, then Ctrl-C twice), then kill everything left

A capture waits for a dialog (regex on the screen), then for ~1.5 s of output
quiescence, and writes NAME.txt (every raw byte received since spawn),
NAME.screen.txt (the rendered rows, right-stripped) and upserts an entry in
manifest.json {name, cli, cli_version, kind, question, options, selected_index,
footer, notes, ...}. question/options/footer come from a heuristic parse of the
screen and can be overridden in the step.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import pyte
except ImportError:  # pragma: no cover
    pyte = None

KEYS = {
    "enter": "\r", "esc": "\x1b", "tab": "\t", "btab": "\x1b[Z", "up": "\x1b[A", "down": "\x1b[B",
    "right": "\x1b[C", "left": "\x1b[D", "space": " ", "bs": "\x7f", "ctrl-c": "\x03", "ctrl-d": "\x04",
}
KEY_RE = re.compile("<(" + "|".join(map(re.escape, KEYS)) + ")>")

DIALOG_RE = (r"(?im)esc to (?:cancel|exit|go back|close)|esc back|enter to (?:confirm|select|continue)|enter select|"
             r"enter continue|Do you want|Would you like|Do you trust|Trust this folder|^\s*[❯›]\s*\d{1,2}\.\s|"
             r"↑/↓ to (?:select|navigate)|Tab to amend|\(y\)\s*$|Press enter")
READY = {
    "claude": {"pattern": r"(?m)^❯(?:\s+Try\s.*)?$", "absent": r"esc to interrupt"},
    "codex": {"pattern": r"(?m)^\s*›(?!\s*\d+\.)", "absent": r"(?i)esc to interrupt"},
}
QUIT_KEYS = {"claude": "/exit<enter>", "codex": "/exit<enter>"}
OPTION_RE = re.compile(r"^(\s*[│|]?\s*)([❯›>])?(\s*)(\d{1,2})\.\s+(.*?)\s*[│|]?\s*$")
FOOTER_HINT = re.compile(r"(?i)Esc|Enter|Tab|↑|↓|←|→|confirm|cancel|select|navigate|amend|\(y\)|Ctrl|Space")
RULE_RE = re.compile(r"^\s*[─╌━═▔_-]{8,}\s*$")

# Terminal queries a real emulator would answer; pyte answers CPR (ESC[6n) and DA1 (ESC[c) itself.
QUERIES = [
    (re.compile(rb"\x1b\[>0?c"), b"\x1b[>0;276;0c"),
    (re.compile(rb"\x1b\[>0?q"), b"\x1bP>|xterm(276)\x1b\\"),
    (re.compile(rb"\x1b\]10;\?(?:\x07|\x1b\\)"), b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
    (re.compile(rb"\x1b\]11;\?(?:\x07|\x1b\\)"), b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\"),
    (re.compile(rb"\x1b\[\?(\d+)\$p"), lambda m: b"\x1b[?" + m.group(1) + b";0$y"),
]

CLAUDE_BASE = ["claude", "--settings", '{"disableAllHooks":true}', "--model", "haiku"]
# The account's default permission mode is "auto" (auto-approves safe tools, no dialog), so ask explicitly.
CLAUDE_ARGV = CLAUDE_BASE + ["--permission-mode", "manual"]
CODEX_ARGV = ["codex", "--ask-for-approval", "on-request", "--sandbox", "read-only"]


def _claude_turn(prompt, capture, kind, answer, notes="", extra=None):
    steps = [{"send": prompt}, {"wait": 0.4}, {"send": "<enter>"},
             {"capture": capture, "kind": kind, "notes": notes}]
    steps += extra or []
    steps += [{"send": answer}, {"wait_ready": True}]
    return steps


DEFAULT_SCENARIOS = [
    {
        "name": "claude-main", "cli": "claude", "argv": CLAUDE_ARGV,
        "cwd": "{scratch}/proj-1", "prepare": [["git", "init", "-q"]],
        "steps": [
            {"capture": "claude-trust", "kind": "startup_blocker", "optional": True, "timeout": 30,
             "notes": "First-run folder trust dialog (unnumbered, cursor starts on No, exit; answered with Down+Enter). "
                      "Negative fixture: never answerable as a permission."},
            {"send": "<down>"}, {"wait": 0.3}, {"send": "<enter>"}, {"wait_ready": True},
            *_claude_turn("Run the shell command echo hello-ive > hello.txt with the Bash tool. Do not explain.",
                          "claude-bash", "permission", "<esc>",
                          notes="Bash permission dialog (a plain echo is auto-allowed as read-only, the redirect prompts).",
                          extra=[{"send": "2"}, {"wait": 0.5},
                                 {"capture": "claude-bash-after-digit-2", "kind": "probe", "wait": "none",
                                  "notes": "Screen 0.5 s after pressing the digit 2 on the Bash dialog. Observed with 2.1.310: "
                                           "the digit selects and confirms at once (dialog gone, option 2 applied, command running); "
                                           "no Enter needed, so the Esc that follows interrupts the turn."}]),
            *_claude_turn("Create a file notes.txt containing hi with the Write tool.",
                          "claude-create-file", "permission", "<enter>", notes="Write tool dialog, approved with Enter."),
            {"shell": ["test", "-f", "notes.txt"]},
            *_claude_turn("Edit notes.txt so it says hello, with the Edit tool.",
                          "claude-edit-file", "permission", "<enter>", notes="Edit tool dialog, approved with Enter."),
            *_claude_turn("Fetch https://example.com with WebFetch and tell me its title.",
                          "claude-fetch", "permission", "<esc>", notes="WebFetch dialog, cancelled with Esc."),
            *_claude_turn('Use the AskUserQuestion tool to ask me exactly one question "Which colour?" '
                          "with the options Red, Green and Blue, then wait for my answer.",
                          "claude-ask-single", "ask_user_question", "<esc>", notes="AskUserQuestion, one question."),
            *_claude_turn('Use the AskUserQuestion tool once with two questions in the same call: '
                          '"Which colour?" with options Red, Green, Blue (single choice) and '
                          '"Which sizes?" with options S, M, L (multiSelect true). Then wait for my answers.',
                          "claude-ask-multi", "ask_user_question", "<esc>",
                          notes="AskUserQuestion, two questions, second one multi-select.",
                          extra=[{"send": "<tab>"}, {"wait": 0.6},
                                 {"capture": "claude-ask-multi-q2", "kind": "ask_user_question", "wait": "none",
                                  "notes": "Second question (multi-select) after pressing Tab."}]),
            {"send": "/model"}, {"wait": 0.6}, {"send": "<enter>"},
            {"capture": "claude-model-picker", "kind": "negative", "question": "Select model",
             "footer": "Enter to set as default · s to use this session only · Esc to cancel",
             "notes": "/model picker. Negative fixture."},
            {"send": "<esc>"}, {"wait_ready": True},
            {"send": "/permissions"}, {"wait": 0.6}, {"send": "<enter>"},
            {"capture": "claude-permissions", "kind": "negative", "question": "Permissions",
             "footer": "←/→ to switch · ↓ to select · Esc to cancel",
             "notes": "/permissions screen (Allow tab). Negative fixture."},
            {"send": "<esc>"}, {"wait_ready": True},
            {"quit": True},
        ],
    },
    {
        "name": "claude-plan", "cli": "claude", "argv": CLAUDE_BASE + ["--permission-mode", "plan"],
        "cwd": "{scratch}/proj-2", "prepare": [["git", "init", "-q"]],
        "steps": [
            {"wait_for": r"Yes, I trust this folder", "timeout": 30, "optional": True},
            {"send": "<down>"}, {"wait": 0.3}, {"send": "<enter>"}, {"wait_ready": True},
            *_claude_turn("Make a one-line plan to add a README.md and then call ExitPlanMode.",
                          "claude-plan-approval", "plan_approval", "<esc>",
                          notes="ExitPlanMode approval dialog in --permission-mode plan."),
            {"quit": True},
        ],
    },
    {
        "name": "codex-main", "cli": "codex", "argv": CODEX_ARGV,
        "cwd": "{scratch}/proj-3", "prepare": [["git", "init", "-q"]],
        "env": {"CODEX_HOME": "{scratch}/codex-home"},
        "steps": [
            {"capture": "codex-trust", "kind": "startup_blocker", "optional": True, "timeout": 15,
             "notes": "Folder trust prompt (numbered, › cursor, answered with Enter). Negative fixture."},
            {"send": "<enter>"}, {"wait_ready": True},
            {"send": "Run the command touch created.txt"}, {"wait": 0.4}, {"send": "<enter>"},
            {"capture": "codex-command", "kind": "permission", "notes": "Command approval (read-only sandbox, on-request)."},
            {"send": "2"}, {"wait": 0.5},
            {"capture": "codex-command-after-digit-2", "kind": "probe", "wait": "none",
             "notes": "Screen 0.5 s after pressing the digit 2 on the command approval. Observed with 0.164.0: the digit "
                      "selects and confirms at once (\"You approved codex to always run commands that start with ...\", "
                      "command ran); the letters y/p/esc shown in the labels are hotkeys too."},
            {"send": "<esc>"}, {"wait_ready": True},
            {"quit": True},
        ],
    },
    {
        "name": "codex-model", "cli": "codex", "argv": CODEX_ARGV,
        "cwd": "{scratch}/proj-3", "fresh": False,
        "env": {"CODEX_HOME": "{scratch}/codex-home"},
        "steps": [
            {"wait_for": r"Trust this folder\?", "timeout": 15, "optional": True}, {"wait_quiet": 1.5}, {"send": "<enter>"},
            {"wait_ready": True},
            {"send": "/model"}, {"wait": 0.6}, {"send": "<enter>"},
            {"capture": "codex-model-picker", "kind": "negative", "question": "Select Model and Effort",
             "notes": "/model picker. Negative fixture (cursor sits on the current model, not on 1.)."},
            {"send": "<esc>"}, {"wait_ready": True},
            {"quit": True},
        ],
    },
    {
        "name": "codex-second", "cli": "codex", "argv": CODEX_ARGV,
        "cwd": "{scratch}/proj-4", "prepare": [["git", "init", "-q"]],
        "env": {"CODEX_HOME": "{scratch}/codex-home"},
        "steps": [
            {"wait_for": r"Trust this folder\?", "timeout": 15, "optional": True}, {"wait_quiet": 1.5}, {"send": "<enter>"},
            {"wait_ready": True},
            {"send": "Run the command curl -sI https://example.com and show me the status line."}, {"wait": 0.4}, {"send": "<enter>"},
            {"capture": "codex-network", "kind": "permission", "optional": True, "timeout": 180,
             "notes": "Second approval kind: network access from the read-only sandbox."},
            {"send": "<esc>"}, {"wait_ready": True},
            {"send": "Create a file hello.md containing the single word hello."}, {"wait": 0.4}, {"send": "<enter>"},
            {"capture": "codex-patch", "kind": "permission", "optional": True, "timeout": 180,
             "notes": "Third approval kind: file change (apply_patch) from the read-only sandbox."},
            {"send": "<esc>"}, {"wait_ready": True},
            {"quit": True},
        ],
    },
]


class CaptureError(Exception):
    pass


class Log:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = path.open("a", encoding="utf-8")

    def __call__(self, msg: str):
        line = f"{datetime.now().strftime('%H:%M:%S.%f')[:-3]} {msg}"
        print(line, flush=True)
        self.fh.write(line + "\n")
        self.fh.flush()

    def close(self):
        self.fh.close()


def keys(text: str) -> bytes:
    return KEY_RE.sub(lambda m: KEYS[m.group(1)], text).encode("utf-8")


def child_env(cols: int, rows: int, extra: dict | None) -> dict:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("CLAUDE") and k not in {"CI", "NO_COLOR", "NON_INTERACTIVE"}}
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "COLUMNS": str(cols), "LINES": str(rows)})
    env.update(extra or {})
    return env


def kill_strays(marker: str, log) -> None:
    """Kill leftover processes whose command line names ``marker`` (e.g. Codex's app-server daemon
    under a temporary CODEX_HOME re-parents to launchd and would outlive the CLI)."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return
    rows = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2])
    keep, pid = set(), os.getpid()
    while pid in rows:  # never kill ourselves or the shells that started us
        keep.add(pid)
        pid = rows[pid][0]
    for pid, (_, cmd) in rows.items():
        if marker in cmd and pid not in keep:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.kill(pid, sig)
                    log(f"killed stray pid={pid} {cmd[:120]}")
                    time.sleep(0.2)
                except OSError:
                    break


def descendants(pid: int) -> list[int]:
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    children: dict[int, list[int]] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    found, queue = [], [pid]
    while queue:
        for child in children.get(queue.pop(), []):
            found.append(child)
            queue.append(child)
    return found


if pyte is not None:
    class _Screen(pyte.Screen):
        def __init__(self, cols, rows, reply):
            super().__init__(cols, rows)
            self._reply = reply

        def write_process_input(self, data):
            self._reply(data.encode("utf-8") if isinstance(data, str) else data)

        def report_device_status(self, mode, **kwargs):
            if kwargs.get("private"):  # DECXCPR (ESC[?6n): xterm-style reply, pyte 0.8 would raise
                if mode == 6:
                    self.write_process_input(f"\x1b[?{self.cursor.y + 1};{self.cursor.x + 1};1R")
                return
            super().report_device_status(mode)


class Terminal:
    def __init__(self, argv: list[str], cwd: str, env: dict, cols: int, rows: int, log: Log):
        if pyte is None:
            raise CaptureError("pyte is required (use the project's .venv python)")
        self.cols, self.rows, self.log = cols, rows, log
        self.raw = bytearray()
        self.replies = bytearray()
        self.tail = b""
        self.last_output = time.monotonic()
        self.exit_status: int | None = None
        self.screen = _Screen(cols, rows, self._reply)
        self.stream = pyte.ByteStream(self.screen)
        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            except BaseException as exc:  # pragma: no cover
                os.write(2, f"capture_dialogs: exec failed: {exc}\n".encode())
            finally:
                os._exit(127)
        self.pid, self.fd = pid, fd
        log(f"spawned pid={pid} argv={argv} cwd={cwd} size={cols}x{rows}")

    @property
    def alive(self) -> bool:
        return self.exit_status is None

    def _reply(self, data: bytes):
        self.replies += data
        self.send(data)

    def _answer_queries(self, data: bytes):
        buf = self.tail + data
        cut = 0
        for pattern, answer in QUERIES:
            for m in pattern.finditer(buf):
                reply = answer(m) if callable(answer) else answer
                self.log(f"query {m.group(0)!r} -> reply {reply!r}")
                self._reply(reply)
                cut = max(cut, m.end())
        self.tail = buf[max(cut, len(buf) - 64):]

    def _reap(self):
        if self.exit_status is not None:
            return
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            pid, status = self.pid, 0
        if pid:
            self.exit_status = status
            self.log(f"process exited status={status}")

    def pump(self, timeout: float = 0.05) -> bool:
        """Read what arrives within ``timeout`` seconds; True if anything did."""
        if self.fd is None:
            return False
        got = False
        try:
            readable, _, _ = select.select([self.fd], [], [], timeout)
        except InterruptedError:
            return False
        while readable:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b""
            if not data:
                self._reap()
                if self.exit_status is None:
                    self.exit_status = -1
                return got
            got = True
            self.last_output = time.monotonic()
            self.raw += data
            try:
                self.stream.feed(data)
            except Exception as exc:  # pyte is strict; keep capturing
                self.log(f"pyte feed error: {exc!r}")
            self._answer_queries(data)
            readable, _, _ = select.select([self.fd], [], [], 0)
        self._reap()
        return got

    def send(self, data: bytes):
        if self.fd is None or not self.alive:
            return
        view = memoryview(data)
        while view:
            try:
                n = os.write(self.fd, view)
            except OSError as exc:
                self.log(f"write failed: {exc}")
                return
            view = view[n:]

    def screen_lines(self) -> list[str]:
        return [line.rstrip() for line in self.screen.display]

    def screen_text(self) -> str:
        return "\n".join(self.screen_lines())

    def wait(self, seconds: float):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(min(0.05, max(0.0, deadline - time.monotonic())))

    def wait_quiet(self, quiet: float = 1.5, timeout: float = 20.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if time.monotonic() - self.last_output >= quiet:
                return True
            self.pump(0.05)
        return False

    def wait_for(self, pattern: str, absent: str | None = None, timeout: float = 120.0) -> bool:
        pat, ab = re.compile(pattern), (re.compile(absent) if absent else None)
        deadline = time.monotonic() + timeout
        while True:
            text = self.screen_text()
            if pat.search(text) and not (ab and ab.search(text)):
                return True
            if not self.alive or time.monotonic() > deadline:
                return False
            self.pump(0.05)

    def wait_exit(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self.alive and time.monotonic() < deadline:
            self.pump(0.1)
        return not self.alive

    def kill_tree(self):
        kids = descendants(self.pid)
        if self.alive:
            for sig, grace in ((signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0)):
                for target in (self.pid,):
                    try:
                        os.killpg(target, sig)
                    except ProcessLookupError:
                        pass
                    except OSError:
                        try:
                            os.kill(target, sig)
                        except OSError:
                            pass
                if self.wait_exit(grace):
                    break
        for kid in kids + descendants(self.pid):
            try:
                os.kill(kid, signal.SIGKILL)
                self.log(f"killed leftover pid={kid}")
            except OSError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None
        if self.exit_status is None:
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
            self.exit_status = -9


def _clean(line: str) -> str:
    return line.strip().strip("│|╭╮╰╯─").strip()


def parse_dialog(lines: list[str], cols: int = 120) -> dict:
    """Heuristic: last numbered block starting at 1., its question above and footer below."""
    starts = [i for i, line in enumerate(lines) if (m := OPTION_RE.match(line)) and m.group(4) == "1"]
    if not starts:
        return parse_unnumbered(lines)
    first = starts[-1]
    options, descriptions, selected, glyph, expect, i = [], [], None, "", 1, first
    label_col = None
    while i < len(lines):
        m = OPTION_RE.match(lines[i])
        if m and int(m.group(4)) == expect:
            if m.group(2):
                selected, glyph = len(options), m.group(2)
            label_col = len(m.group(1)) + (1 if m.group(2) else 0) + len(m.group(3)) + len(m.group(4)) + 2
            options.append(m.group(5))
            descriptions.append("")
            expect += 1
        elif options and RULE_RE.match(lines[i]) and i + 1 < len(lines) \
                and (n := OPTION_RE.match(lines[i + 1])) and int(n.group(4)) == expect:
            pass  # a separator inside the list (AskUserQuestion puts "Chat about this" behind one)
        elif options and lines[i].strip() and not RULE_RE.match(lines[i]):
            body = lines[i].rstrip("│| ")
            indent = len(body) - len(body.lstrip())
            if indent < label_col:
                break
            prev = lines[i - 1].rstrip()
            first_word = body.split()[0]
            # Ink wraps a long label at the label column; a description is indented there too,
            # but a wrap only happens when the next word did not fit on the previous line.
            if indent == label_col and len(prev) + 1 + len(first_word) > cols - 4:
                options[-1] = (options[-1] + " " + _clean(body)).strip()
            else:
                descriptions[-1] = (descriptions[-1] + " " + _clean(body)).strip()
        else:
            break
        i += 1
    footer = ""
    for j in range(i, min(i + 4, len(lines))):
        text = _clean(lines[j])
        if text and FOOTER_HINT.search(text):
            footer = text
            break
        if text:
            break
    question = _question_above(lines, first)
    return {"question": question, "options": options, "descriptions": descriptions,
            "selected_index": selected, "footer": footer, "cursor_glyph": glyph}


def _question_above(lines: list[str], index: int) -> str:
    """Nearest line above the options that ends with '?', else one containing '?' (cut there),
    else the nearest non-empty line."""
    above = [(j, _clean(lines[j])) for j in range(index - 1, max(index - 13, -1), -1)]
    above = [(j, t) for j, t in above if t]
    for _, text in above:
        if text.endswith("?"):
            return text
    for _, text in above:
        if "?" in text:
            return text[:text.index("?") + 1]
    return above[0][1] if above else ""


def parse_unnumbered(lines: list[str]) -> dict:
    """Menus without numbers (trust dialog): the cursor line and its equally indented neighbours."""
    empty = {"question": "", "options": [], "descriptions": [], "selected_index": None, "footer": "", "cursor_glyph": ""}
    cursor = [i for i, line in enumerate(lines)
              if re.match(r"^\s*[│|]?\s*[❯›]\s+(?!\d{1,2}\.)(?!Try\s)\S", line) and not re.match(r"^[❯›]\s*$", line)]
    if not cursor:
        return empty
    at = cursor[-1]
    m = re.match(r"^(\s*[│|]?\s*)([❯›])(\s+)", lines[at])
    col, glyph = len(m.group(0)), m.group(2)
    def label(i):
        body = lines[i].rstrip("│| ")
        return _clean(body[col:]) if len(body) > col and body[:col].strip() in ("", glyph) and body[col - 1] == " " else None
    lo = at
    while lo - 1 >= 0 and label(lo - 1) and not FOOTER_HINT.search(lines[lo - 1]):
        lo -= 1
    hi = at
    while hi + 1 < len(lines) and label(hi + 1) and not FOOTER_HINT.search(lines[hi + 1]):
        hi += 1
    options = [label(i) or "" for i in range(lo, hi + 1)]
    footer = next((_clean(lines[j]) for j in range(hi + 1, min(hi + 4, len(lines))) if _clean(lines[j])), "")
    if not FOOTER_HINT.search(footer):
        footer = ""
    return {"question": _question_above(lines, lo), "options": options, "descriptions": [""] * len(options),
            "selected_index": at - lo, "footer": footer, "cursor_glyph": glyph}


def cli_version(argv0: str) -> str:
    try:
        out = subprocess.run([argv0, "--version"], capture_output=True, text=True, timeout=20,
                             env=child_env(80, 24, None))
        return (out.stdout or out.stderr).strip().splitlines()[0]
    except Exception as exc:
        return f"unknown ({exc})"


def upsert_manifest(path: Path, entry: dict):
    entries = []
    if path.exists():
        try:
            entries = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            entries = []
        if isinstance(entries, dict):
            entries = entries.get("fixtures", [])
    entries = [e for e in entries if e.get("name") != entry["name"]] + [entry]
    path.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class Runner:
    def __init__(self, scratch: Path, out: Path, cols: int, rows: int, dialog_re: str):
        self.scratch, self.out, self.cols, self.rows, self.dialog_re = scratch, out, cols, rows, dialog_re
        self.out.mkdir(parents=True, exist_ok=True)
        (self.scratch / "logs").mkdir(parents=True, exist_ok=True)

    def expand(self, value):
        if isinstance(value, str):
            return value.replace("{scratch}", str(self.scratch))
        if isinstance(value, dict):
            return {k: self.expand(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.expand(v) for v in value]
        return value

    def run(self, scenario: dict) -> bool:
        scenario = self.expand(scenario)
        name, cli = scenario["name"], scenario.get("cli", "claude")
        log = Log(self.scratch / "logs" / f"{name}.log")
        cwd = os.path.realpath(scenario["cwd"])
        if scenario.get("fresh", True) and Path(cwd).is_relative_to(self.scratch):
            shutil.rmtree(cwd, ignore_errors=True)
        Path(cwd).mkdir(parents=True, exist_ok=True)
        for cmd in scenario.get("prepare", []):
            subprocess.run(cmd, cwd=cwd, check=False, capture_output=True)
        version = cli_version(scenario["argv"][0])
        log(f"scenario {name}: {version}")
        env = child_env(self.cols, self.rows, scenario.get("env"))
        term = Terminal(scenario["argv"], cwd, env, self.cols, self.rows, log)
        ok = True
        try:
            for index, step in enumerate(scenario["steps"]):
                self.step(term, scenario, version, index, step, log)
        except CaptureError as exc:
            ok = False
            log(f"FAILED: {exc}")
            log("screen at failure:\n" + term.screen_text())
        except KeyboardInterrupt:
            ok = False
            log("interrupted")
        finally:
            self.quit(term, scenario, log)
            (self.scratch / "logs" / f"{name}.raw").write_bytes(term.raw)
            (self.scratch / "logs" / f"{name}.final.screen.txt").write_text(term.screen_text() + "\n", encoding="utf-8")
            log(f"done ok={ok} raw_bytes={len(term.raw)} replies={len(term.replies)}")
            log.close()
        return ok

    def quit(self, term: Terminal, scenario: dict, log: Log):
        if term.alive:
            term.send(keys(scenario.get("quit", QUIT_KEYS.get(scenario.get("cli"), "<ctrl-c><ctrl-c>"))))
            if not term.wait_exit(12):
                for _ in range(2):
                    term.send(b"\x03")
                    term.wait(0.6)
                term.wait_exit(5)
        term.kill_tree()
        # Only this scenario's own temp home/project: scenarios may run concurrently (never two
        # Codex scenarios on one CODEX_HOME, they share its app-server daemon).
        kill_strays((scenario.get("env") or {}).get("CODEX_HOME") or os.path.realpath(scenario["cwd"]), log)
        log(f"quit: exit_status={term.exit_status}")

    def step(self, term: Terminal, scenario: dict, version: str, index: int, step: dict, log: Log):
        if "send" in step:
            data = keys(step["send"])
            log(f"step {index}: send {step['send']!r}")
            term.send(data)
            term.pump(0.05)
        elif "capture" in step:
            self.capture(term, scenario, version, index, step, log)
        elif "wait" in step:
            term.wait(float(step["wait"]))
        elif "wait_quiet" in step:
            term.wait_quiet(float(step["wait_quiet"]), float(step.get("timeout", 20)))
        elif "wait_for" in step:
            log(f"step {index}: wait_for {step['wait_for']!r}")
            if not term.wait_for(step["wait_for"], step.get("absent"), float(step.get("timeout", 120))):
                if step.get("optional"):
                    log(f"step {index}: optional wait_for {step['wait_for']!r} not seen, continuing")
                else:
                    raise CaptureError(f"step {index}: wait_for {step['wait_for']!r} timed out")
        elif "wait_ready" in step:
            ready = READY.get(scenario.get("cli"), READY["claude"])
            timeout = float(step.get("timeout", 180))
            log(f"step {index}: wait_ready")
            deadline = time.monotonic() + timeout
            while True:
                if not term.wait_for(ready["pattern"], ready["absent"], max(0.1, deadline - time.monotonic())):
                    raise CaptureError(f"step {index}: wait_ready timed out")
                term.wait_quiet(1.2, 10)
                text = term.screen_text()
                if re.search(ready["pattern"], text) and not re.search(ready["absent"], text):
                    break
                if time.monotonic() > deadline:
                    raise CaptureError(f"step {index}: wait_ready timed out")
            log(f"step {index}: ready")
        elif "shell" in step:
            res = subprocess.run(step["shell"], cwd=os.path.realpath(scenario["cwd"]), capture_output=True, text=True)
            log(f"step {index}: shell {step['shell']} -> rc={res.returncode} {res.stdout.strip()[:200]} {res.stderr.strip()[:200]}")
        elif "quit" in step:
            self.quit(term, scenario, log)
        else:
            raise CaptureError(f"step {index}: unknown step {step!r}")

    def capture(self, term: Terminal, scenario: dict, version: str, index: int, step: dict, log: Log):
        name, mode = step["capture"], step.get("wait", "dialog")
        dialog = step.get("dialog") or self.dialog_re
        quiet = float(step.get("quiet", 1.5))
        log(f"step {index}: capture {name} (wait={mode})")
        quiescent, found = True, True
        if mode == "dialog":
            found = term.wait_for(dialog, timeout=float(step.get("timeout", 120)))
            for _ in range(6):
                if not found:
                    break
                quiescent = term.wait_quiet(quiet, 20)
                if re.search(dialog, term.screen_text()):
                    break
                found = term.wait_for(dialog, timeout=15)
        elif mode == "quiet":
            quiescent = term.wait_quiet(quiet, 20)
        if not found:
            if step.get("optional"):
                log(f"step {index}: optional capture {name}: no dialog, continuing")
                log("screen:\n" + term.screen_text())
                return
            raise CaptureError(f"step {index}: no dialog for capture {name}")
        lines = term.screen_lines()
        if step.get("kind") == "probe":
            parsed = {"question": None, "options": [], "descriptions": [], "selected_index": None, "footer": None, "cursor_glyph": None}
        else:
            parsed = parse_dialog(lines, self.cols)
        for key in ("question", "options", "footer", "selected_index"):
            if key in step:
                parsed[key] = step[key]
        (self.out / f"{name}.txt").write_bytes(bytes(term.raw))
        (self.out / f"{name}.screen.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        entry = {
            "name": name, "cli": scenario.get("cli"), "cli_version": version, "kind": step.get("kind", ""),
            "question": parsed["question"], "options": parsed["options"], "selected_index": parsed["selected_index"],
            "cursor_glyph": parsed["cursor_glyph"], "footer": parsed["footer"], "notes": step.get("notes", ""),
            **({"descriptions": parsed["descriptions"]} if any(parsed.get("descriptions") or []) else {}),
            "scenario": scenario["name"], "step": index, "argv": scenario["argv"], "size": [self.cols, self.rows],
            "cursor": [term.screen.cursor.y, term.screen.cursor.x], "raw_bytes": len(term.raw),
            "quiescent": quiescent, "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        upsert_manifest(self.out / "manifest.json", entry)
        log(f"captured {name}: question={parsed['question']!r} options={parsed['options']} "
            f"selected={parsed['selected_index']} footer={parsed['footer']!r} raw={len(term.raw)}B")


def reparse(out: Path, scenarios: list[dict], cols: int) -> int:
    steps = {step["capture"]: step for scn in scenarios for step in scn["steps"] if "capture" in step}
    manifest = out / "manifest.json"
    entries = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else []
    for entry in entries:
        screen = out / f"{entry['name']}.screen.txt"
        step = steps.get(entry["name"], {})
        if not screen.exists():
            continue
        if entry.get("kind") == "probe":
            if step.get("notes"):
                entry["notes"] = step["notes"]
            continue
        parsed = parse_dialog(screen.read_text(encoding="utf-8").split("\n")[:entry.get("size", [cols, 40])[1]], cols)
        for key in ("question", "options", "footer", "selected_index"):
            parsed[key] = step.get(key, parsed[key])
        entry.update({k: parsed[k] for k in ("question", "options", "selected_index", "footer", "cursor_glyph")})
        if any(parsed["descriptions"]):
            entry["descriptions"] = parsed["descriptions"]
        else:
            entry.pop("descriptions", None)
        if step.get("notes"):
            entry["notes"] = step["notes"]
        print(f"{entry['name']}: {entry['question']!r} {entry['options']} footer={entry['footer']!r}")
    manifest.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scratch", required=True, help="working folder for projects, logs and temp homes")
    ap.add_argument("--out", required=True, help="fixture folder (NAME.txt, NAME.screen.txt, manifest.json)")
    ap.add_argument("--scenarios", help="JSON file with a list of scenarios (replaces the built-in list)")
    ap.add_argument("--only", action="append", default=[], help="run only these scenario names")
    ap.add_argument("--list", action="store_true", help="print the scenario names and exit")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--dialog-regex", default=DIALOG_RE)
    ap.add_argument("--reparse", action="store_true",
                    help="re-run the screen parser over existing NAME.screen.txt files and refresh manifest.json")
    args = ap.parse_args(argv)

    scenarios = DEFAULT_SCENARIOS
    if args.scenarios:
        scenarios = json.loads(Path(args.scenarios).read_text(encoding="utf-8"))
    if args.only:
        scenarios = [s for s in scenarios if s["name"] in args.only]
    if args.list:
        for s in scenarios:
            print(s["name"], " ".join(s["argv"]))
        return 0
    if args.reparse:
        return reparse(Path(args.out).resolve(), scenarios, args.cols)
    runner = Runner(Path(args.scratch).resolve(), Path(args.out).resolve(), args.cols, args.rows, args.dialog_regex)
    failed = [s["name"] for s in scenarios if not runner.run(s)]
    if failed:
        print(f"failed scenarios: {failed}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
