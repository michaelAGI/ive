"""What an agent CLI is doing inside a plain terminal.

A plain terminal (cli_type "shell", see shell_session.py) only knew one rule:
any foreground job means "working". A Claude Code or Codex the user started
by hand is a foreground job for hours, also while it waits at its prompt, so
every such terminal looked busy. Three levels decide instead, the most
reliable one wins:

1. Foreground program. The shell prompt is idle. Any program that is not an
   agent CLI works for as long as it holds the terminal, as before. An agent
   CLI (the binaries of cli_profiles) goes on to level 2.
2. The agent's own lifecycle hooks. The terminal exports its identity
   (shell_session.terminal_identity_env); the hook relay posts turn start,
   turn end and permission requests to hooks.handle_hook_event, which hands
   them to note_hook(). Nothing else of the agent hook pipeline runs.
3. The screen, when no hook has spoken: the "esc to interrupt" footer means
   working, an open permission dialog means the agent waits for the user,
   anything else is done.

The screen also corrects the two things hooks do not report: an Esc
interrupt (Claude sends no Stop) and the end of a Codex turn whose Stop
handler is switched off. Reading the screen is the server's job
(set_screen_probe); this module holds the state and the decision.

State lives per terminal and per foreground job: a new job, a restarted
shell or a restarted backend starts with no hook signal and is decided from
the foreground program and the screen again.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger(__name__)

IDLE = "idle"          # shell prompt, or the agent finished its turn
WORKING = "working"
WAITING = "waiting"    # the agent asks the user (permission, question)

# A Codex turn without a Stop hook ends when its composer is back and stays.
_TURN_END_QUIET_S = 1.5
# The screen may still show the previous frame right after a hook arrived.
_SCREEN_SETTLE_S = 1.0
# A permission hook whose dialog was never recognised on screen: the visible
# running footer says the request was answered.
_ANSWER_GRACE_S = 2.0


@dataclass
class Screen:
    """What the terminal shows right now (filled by the server's probe)."""
    asking: bool = False       # a permission / question dialog is open
    working: bool = False      # the CLI's running footer is visible
    interrupted: bool = False  # Claude's interrupt notice over an empty prompt
    turn_ended: bool = False   # Codex: composer ready, no running footer
    dialog: str = ""           # what the open dialog asks, to tell two apart

    def question(self) -> Optional[str]:
        return (self.dialog or "?") if self.asking else None


@dataclass
class _Foreground:
    """One foreground job of one shell generation."""
    generation: int            # pid of the shell: a restart is a new terminal
    pgid: int
    since: float
    cli: Optional[str] = None  # agent CLI id once recognised
    scanned_at: Optional[float] = None
    scanning: bool = False
    signal: Optional[str] = None   # last word of the hooks: WORKING / WAITING / IDLE
    signal_at: float = 0.0         # monotonic
    signal_wall: float = 0.0       # unix seconds, compared with rollout timestamps
    asked_on_screen: bool = False  # the dialog of this WAITING signal was visible
    closed_dialog: Optional[str] = None  # a dialog a hook proved answered, still on screen
    ended_since: Optional[float] = None
    rollout: Optional[str] = None  # Codex rollout file named by its hooks


_terminals: dict[str, _Foreground] = {}
_screen_probe: Optional[Callable[[str, Optional[str]], Screen]] = None
_executor: Optional[ThreadPoolExecutor] = None


def set_screen_probe(fn: Optional[Callable[[str, Optional[str]], Screen]]) -> None:
    """Injected by server.py: (session_id, cli) -> Screen."""
    global _screen_probe
    _screen_probe = fn


# ─── Level 1: which program holds the terminal ─────────────────────────

# Never an agent by themselves, whatever a user-defined profile names as its
# binary: they run the agent script named in their arguments.
_RUNNERS = {"node", "nodejs", "bun", "bunx", "deno", "npx", "tsx", "env", "python", "python3",
            "sh", "bash", "zsh", "fish", "caffeinate", "nice", "time"}
_PACKAGES = (("@anthropic-ai/claude-code", "claude"), ("@openai/codex", "codex"),
             ("@google/gemini-cli", "gemini"))
_ALIASES = {"claude.exe": "claude", "agy": "antigravity", "antigravity": "antigravity"}
# One-shot forms run a task and exit; they show no prompt and no footer, so
# they count as an ordinary program (working while they run).
_ONE_SHOT_FLAGS = {"-p", "--print", "--prompt", "--version", "-v", "-V", "--help", "-h"}
_ONE_SHOT_COMMANDS = {
    "claude": {"mcp", "update", "doctor", "install", "config", "plugin", "setup-token"},
    "codex": {"exec", "e", "review", "mcp", "login", "logout", "apply", "a", "completion",
              "update", "doctor", "app-server", "cloud", "sandbox", "debug", "features"},
}


def _is_runner(name: str) -> bool:
    return name in _RUNNERS or bool(re.fullmatch(r"python[0-9.]*", name))


def agent_binaries() -> dict[str, str]:
    """Command name -> CLI id for every agent CLI IVE knows."""
    names = dict(_ALIASES)
    try:
        from cli_profiles import PROFILES
        for profile in PROFILES.values():
            for name in (profile.id, os.path.basename(str(getattr(profile, "binary", "") or ""))):
                name = name.strip().lower()
                if name and not _is_runner(name):
                    names.setdefault(name, profile.id)
    except Exception as exc:  # the profile registry must never break a terminal
        logger.debug("CLI profiles unavailable for terminal detection: %s", exc)
    return names


def classify_command(command: str, names: Optional[dict[str, str]] = None) -> Optional[str]:
    """The agent CLI an interactive command line runs, or None.

    ``claude``, ``/opt/homebrew/bin/codex --yolo`` and ``node /x/bin/claude``
    are agents. ``vim claude.md``, ``claude -p …`` and ``codex exec …`` are not.
    """
    tokens = str(command or "").split()
    if not tokens:
        return None
    names = agent_binaries() if names is None else names
    first = os.path.basename(tokens[0]).lstrip("-").lower()
    cli, rest = names.get(first), tokens[1:]
    if cli is None and _is_runner(first):
        script = next((tok for tok in tokens[1:4] if not tok.startswith("-") and "=" not in tok), None)
        if script:
            cli = names.get(os.path.basename(script).lower())
            if cli is None:
                cli = next((pid for marker, pid in _PACKAGES if marker in script), None)
            rest = tokens[tokens.index(script) + 1:]
    if cli is None:
        return None
    if any(tok in _ONE_SHOT_FLAGS for tok in rest):
        return None
    command_word = next((tok for tok in rest if not tok.startswith("-")), "")
    if command_word in _ONE_SHOT_COMMANDS.get(cli, ()):
        return None
    return cli


def foreground_commands(tty: Optional[str], pgid: int) -> list[str]:
    """Command lines of the processes in one foreground process group."""
    ps = shutil.which("ps") or "/bin/ps"
    if tty:
        argv = [ps, "-ww", "-o", "pgid=,command=", "-t", tty.removeprefix("/dev/")]
    else:  # no tty name: at least the group leader
        argv = [ps, "-ww", "-o", "pgid=,command=", "-p", str(pgid)]
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    commands = []
    for line in out.splitlines():
        group, _, command = line.strip().partition(" ")
        if group.isdigit() and int(group) == pgid and command.strip():
            commands.append(command.strip())
    return commands


def _scan(tty: Optional[str], pgid: int) -> Optional[str]:
    names = agent_binaries()
    for command in foreground_commands(tty, pgid):
        cli = classify_command(command, names)
        if cli:
            return cli
    return None


def _submit(job: Callable[[], None]) -> None:
    """Run a process scan off the event loop (tests replace this to run inline)."""
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="terminal-agent")
    _executor.submit(job)


def _scan_due(fg: _Foreground, now: float) -> bool:
    if fg.cli is not None or fg.scanning:
        return False
    if fg.scanned_at is None:
        return True
    # A job is still exec'ing right after it took the terminal, and a wrapper
    # (npx, a launcher script) starts the agent later.
    age = now - fg.since
    return now - fg.scanned_at >= (0.4 if age < 3 else 5.0 if age < 60 else 30.0)


def _start_scan(session_id: str, fg: _Foreground, tty: Optional[str]) -> None:
    fg.scanning = True

    def job():
        try:
            cli = _scan(tty, fg.pgid)
        except Exception as exc:
            logger.debug("Foreground scan failed for %s: %s", session_id[:8], exc)
            cli = None
        if cli and fg.cli is None:
            fg.cli = cli
        fg.scanned_at = time.monotonic()
        fg.scanning = False

    try:
        _submit(job)
    except Exception as exc:
        fg.scanning = False
        logger.debug("Foreground scan not started for %s: %s", session_id[:8], exc)


# ─── Level 3: the screen ───────────────────────────────────────────────

def screen_shows_work(screen: str, cli: Optional[str] = None, tail_lines: int = 20) -> bool:
    """The CLI's running footer ("esc to interrupt") is on the current screen.

    Only the lower part counts: the footer sits above the composer, and old
    conversation text further up must not look like live work.
    """
    lines = [line for line in str(screen or "").splitlines() if line.strip()]
    compact = re.sub(r"\s+", "", "\n".join(lines[-tail_lines:])).lower()
    if "esctointerrupt" in compact:
        return True
    return cli == "gemini" and "esctocancel" in compact


def _probe(session_id: str, cli: Optional[str]) -> Screen:
    if _screen_probe is None:
        return Screen()
    try:
        return _screen_probe(session_id, cli) or Screen()
    except Exception as exc:
        logger.debug("Terminal screen probe failed for %s: %s", session_id[:8], exc)
        return Screen()


# ─── Level 2: hook signals ─────────────────────────────────────────────

def _set_signal(fg: _Foreground, signal: Optional[str]) -> None:
    fg.signal = signal
    fg.signal_at = time.monotonic()
    fg.signal_wall = time.time()
    fg.asked_on_screen = False
    fg.ended_since = None


# Notifications that do not ask the user anything.
_QUIET_NOTIFICATIONS = {"auth_success", "elicitation_complete", "elicitation_response"}


def note_hook(session_id: str, event: str, payload: Optional[dict] = None) -> bool:
    """Apply one lifecycle hook of the agent in this terminal's foreground.

    ``event`` is the canonical name (cli_features.HookEvent value). The
    caller samples the terminal first, so a record exists exactly when a
    foreground job holds it; hooks of anything else (a backgrounded or
    detached agent that inherited the identity) are dropped. Returns whether
    the hook counted.
    """
    fg = _terminals.get(session_id)
    if fg is None:
        return False
    payload = payload if isinstance(payload, dict) else {}
    rollout = payload.get("transcript_path")
    if isinstance(rollout, str) and os.path.basename(rollout).startswith("rollout-") and rollout.endswith(".jsonl"):
        fg.rollout = rollout
        fg.cli = fg.cli or "codex"
    if fg.cli is None:
        # A wrapper the process scan cannot name: the hook proves an agent.
        native = str(payload.get("hook_event_name") or "")
        fg.cli = "gemini" if native in {"BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool"} else "claude"

    if event in {"prompt_submit", "turn_complete", "turn_failure"}:
        # A prompt cannot be submitted and a turn cannot end while a dialog
        # is open: one that is still on screen now is answered text, not a
        # question (a CLI that does not erase it, a quoted transcript).
        fg.closed_dialog = _probe(session_id, fg.cli).question()

    if event == "prompt_submit":
        _set_signal(fg, WORKING)
    elif event == "pre_tool":
        # Parallel tool calls: another one may start while a request is open.
        if fg.signal != WAITING:
            _set_signal(fg, WORKING)
    elif event in {"post_tool", "post_tool_failure", "permission_denied"}:
        # The tool ran or was refused: a question, if any, is answered. A late
        # event must not reopen a finished turn.
        if fg.signal != IDLE:
            _set_signal(fg, WORKING)
    elif event == "permission_request":
        _set_signal(fg, WAITING)
    elif event == "notification":
        kind = str(payload.get("notification_type") or "")
        if kind == "idle_prompt":
            _set_signal(fg, IDLE)
        elif kind not in _QUIET_NOTIFICATIONS and fg.signal != IDLE:
            # Requests come up during a turn. One that arrives after the turn
            # ended is late news about a dialog that is already answered; a
            # dialog that really is open shows on the screen.
            _set_signal(fg, WAITING)
    elif event in {"turn_complete", "turn_failure"}:
        _set_signal(fg, IDLE)
    elif event == "session_start":
        if fg.signal is None:  # also fires after a compaction in the middle of a turn
            _set_signal(fg, IDLE)
    elif event == "session_stop":
        _set_signal(fg, None)
    else:
        return False
    return True


def open_codex_turns() -> list[tuple[str, str]]:
    """(session_id, rollout path) of terminals whose Codex turn is running."""
    return [(sid, fg.rollout) for sid, fg in list(_terminals.items())
            if fg.signal == WORKING and fg.rollout]


def note_turn_boundary(session_id: str, rollout: str, kind: str, at: float) -> bool:
    """Codex wrote the end of a turn to its rollout (no Stop hook needed).

    Older than the last hook means the previous turn; a visible footer or
    dialog means the screen is ahead of the file and decides.
    """
    fg = _terminals.get(session_id)
    if (fg is None or fg.signal != WORKING or fg.rollout != rollout
            or kind not in {"task_complete", "turn_aborted"} or at < fg.signal_wall):
        return False
    screen = _probe(session_id, fg.cli)
    if screen.working or screen.question() not in (None, fg.closed_dialog):
        return False
    _set_signal(fg, IDLE)
    return True


# ─── The decision ──────────────────────────────────────────────────────

def at_prompt(session_id: str) -> None:
    """The shell has the terminal again: whatever ran in it is over."""
    _terminals.pop(session_id, None)


def forget(session_id: str) -> None:
    _terminals.pop(session_id, None)


def _decide(fg: _Foreground, screen: Screen, now: float) -> str:
    question = screen.question()
    if question != fg.closed_dialog:
        fg.closed_dialog = None  # gone, or a new dialog took its place
    if question is not None and fg.closed_dialog is None:
        fg.asked_on_screen = True  # an open question is on screen right now
        return WAITING
    if fg.signal is None:  # level 3
        return WORKING if screen.working else IDLE
    settled = now - fg.signal_at >= _SCREEN_SETTLE_S
    if fg.signal == WAITING:
        if screen.interrupted and settled:
            _set_signal(fg, IDLE)  # Esc on the dialog: no Stop hook follows
        elif fg.asked_on_screen or (screen.working and now - fg.signal_at >= _ANSWER_GRACE_S):
            _set_signal(fg, WORKING)  # answered; the next hook may be minutes away
            return WORKING
        else:
            return WAITING
    if fg.signal == WORKING:
        if screen.interrupted and settled:
            _set_signal(fg, IDLE)  # Esc: Claude sends no Stop
        elif screen.turn_ended:
            fg.ended_since = fg.ended_since or now
            if min(now - fg.ended_since, now - fg.signal_at) >= _TURN_END_QUIET_S:
                _set_signal(fg, IDLE)  # Codex without a Stop hook
        else:
            fg.ended_since = None
    return WORKING if fg.signal == WORKING else IDLE


def foreground_activity(session_id: str, generation: int, pgid: int, tty: Optional[str] = None) -> str:
    """Activity of a plain terminal whose foreground is not its shell."""
    now = time.monotonic()
    fg = _terminals.get(session_id)
    if fg is None or fg.generation != generation or fg.pgid != pgid:
        fg = _Foreground(generation=generation, pgid=pgid, since=now)
        _terminals[session_id] = fg
    if _scan_due(fg, now):
        _start_scan(session_id, fg, tty)
    if fg.cli is None and fg.signal is None:
        return WORKING  # a build, a dev server, any other program
    return _decide(fg, _probe(session_id, fg.cli), now)
