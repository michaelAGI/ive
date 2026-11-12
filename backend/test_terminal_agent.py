"""A plain terminal's status follows the agent CLI the user started in it.

Three levels (terminal_agent.py): the foreground program, the agent's own
hooks, the screen. Isolated: temp data dir, fake processes or a stand-in
script named `claude` in a temp folder with a real zsh and a temp HOME. Never
starts the server, a model or a real agent CLI.
"""
import ast
import asyncio
import os
import re
import stat
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

from aiohttp.test_utils import make_mocked_request  # noqa: E402

import config  # noqa: E402
import desktop_hook_relay  # noqa: E402
import hook_installer  # noqa: E402
import hooks  # noqa: E402
import session_proofs  # noqa: E402
import shell_session  # noqa: E402
import terminal_agent  # noqa: E402
from output_capture import OutputCaptureProcessor  # noqa: E402
from pty_manager import PTYManager, PTYSession  # noqa: E402
from terminal_agent import IDLE, WAITING, WORKING, Screen  # noqa: E402
from test_codex_turn_end import FINISHED as CODEX_FINISHED, WORKING_ABOVE as CODEX_WORKING  # noqa: E402
from test_codex_turn_end import _load as load_codex_screen  # noqa: E402
from test_interrupt_idle import INTERRUPTED as CLAUDE_INTERRUPTED  # noqa: E402
from test_prompt_menu_parser import fixture_screen, load_parser  # noqa: E402

BACKEND = Path(__file__).resolve().parent
# Claude Code 2.1.3xx after a finished turn: what the owner's screenshot showed
# on a tile that still said "Running".
CLAUDE_DONE = """❯ make the status follow the agent

⏺ Done. The tile now says Done when I wait at the prompt.

✻ Cooked for 13m 55s · done 18:53

────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ← 5 agents
"""


def server_screen_probe(capture_proc):
    """server._terminal_agent_screen with the real dialog and Codex parsers."""
    tree = ast.parse((BACKEND / "server.py").read_text())
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef)
             and n.name in {"_terminal_agent_screen", "_looks_antigravity_busy"}]
    ns = {**load_parser(), **load_codex_screen(), "re": re, "capture_proc": capture_proc}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), ns)
    return ns["_terminal_agent_screen"]


class CommandTests(unittest.TestCase):
    def test_agent_clis_are_recognised_by_their_command_line(self):
        for command, cli in [
            ("claude", "claude"),
            ("claude --model sonnet --permission-mode auto", "claude"),
            ("codex --yolo", "codex"),
            ("/opt/homebrew/bin/codex resume 0199-abc", "codex"),
            ("node /opt/homebrew/bin/claude", "claude"),
            ("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", "codex"),
            ("node /x/node_modules/@anthropic-ai/claude-code/cli.js --continue", "claude"),
            ("/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python /sandbox/bin/claude", "claude"),
            ("gemini", "gemini"),
            ("agy", "antigravity"),
        ]:
            with self.subTest(command=command):
                self.assertEqual(terminal_agent.classify_command(command), cli)

    def test_other_programs_and_one_shot_runs_are_not_an_agent_at_its_prompt(self):
        for command in [
            "sleep 10", "npm run dev", "node server.js", "vim claude.md", "-zsh", "/bin/zsh -l -i",
            "python3 manage.py runserver", "git commit", "make claude", "cat codex",
            # They run one task and exit: working for as long as they run.
            "claude -p summarise this", "claude --print hi", "codex exec fix the tests",
            "claude mcp list", "codex login", "claude --version", "",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(terminal_agent.classify_command(command))

    def test_names_come_from_the_cli_profiles_but_never_a_runner(self):
        names = terminal_agent.agent_binaries()
        for name, cli in [("claude", "claude"), ("codex", "codex"), ("gemini", "gemini"),
                          ("antigravity-cli", "antigravity")]:
            self.assertEqual(names.get(name), cli)
        self.assertNotIn("shell", names)
        self.assertFalse(set(names) & {"node", "python", "python3", "sh", "zsh", "env"})


class _TerminalCase(unittest.TestCase):
    """One plain terminal with a controllable foreground job and screen."""

    SID = "term-1"

    def setUp(self):
        terminal_agent._terminals.clear()
        self.addCleanup(terminal_agent._terminals.clear)
        self.programs = {}          # foreground pgid -> command line
        self.screen = Screen()
        self.foreground = 100       # the shell itself
        self.shell = PTYSession(self.SID, "/tmp", plain_shell=True)
        self.shell.pid, self.shell.master_fd, self.shell._alive = 100, 20, True
        for target, value in [
            ("_submit", lambda job: job()),  # scan inline instead of in a thread
            ("foreground_commands", lambda tty, pgid: [self.programs[pgid]] if pgid in self.programs else []),
        ]:
            p = patch.object(terminal_agent, target, value)
            p.start()
            self.addCleanup(p.stop)
        terminal_agent.set_screen_probe(lambda sid, cli: self.screen)
        self.addCleanup(terminal_agent.set_screen_probe, None)

    def run_program(self, command, pgid=200):
        self.programs[pgid] = command
        self.foreground = pgid

    def activity(self):
        with patch("os.tcgetpgrp", return_value=self.foreground), patch("os.getpgid", return_value=100):
            return self.shell.shell_activity()

    def hook(self, event, **payload):
        self.activity()  # the endpoint samples the terminal before a hook counts
        return terminal_agent.note_hook(self.SID, event, payload)

    def later(self, seconds):
        """Let time pass for the job in the foreground."""
        fg = terminal_agent._terminals[self.SID]
        fg.signal_at -= seconds
        fg.since -= seconds
        if fg.ended_since is not None:
            fg.ended_since -= seconds


class ForegroundProgramTests(_TerminalCase):
    """Level 1: who holds the terminal."""

    def test_shell_prompt_is_idle(self):
        self.assertEqual(self.activity(), IDLE)
        self.assertEqual(terminal_agent._terminals, {})

    def test_any_other_program_works_whatever_its_screen_shows(self):
        for command in ("sleep 600", "npm run dev", "vim notes.md", "claude -p summarise"):
            with self.subTest(command=command):
                terminal_agent._terminals.clear()
                self.run_program(command)
                self.screen = Screen()
                self.assertEqual(self.activity(), WORKING)
                self.screen = Screen(asking=True)  # e.g. git asking a question
                self.assertEqual(self.activity(), WORKING)

    def test_agent_cli_at_its_prompt_is_not_working(self):
        self.run_program("claude")
        self.assertEqual(self.activity(), IDLE)

    def test_a_job_is_working_until_it_is_named(self):
        # The scan runs off the event loop; the old rule holds until it is back.
        self.run_program("claude")
        with patch.object(terminal_agent, "_submit", lambda job: None):
            self.assertEqual(self.activity(), WORKING)
        terminal_agent._terminals[self.SID].scanning = False
        self.later(1)
        terminal_agent._terminals[self.SID].scanned_at = None
        self.assertEqual(self.activity(), IDLE)

    def test_a_wrapper_that_starts_the_agent_later_is_seen_on_a_rescan(self):
        self.run_program("npm exec @anthropic-ai/claude-code")
        self.assertEqual(self.activity(), WORKING)
        self.programs[200] = "node /x/node_modules/@anthropic-ai/claude-code/cli.js"
        terminal_agent._terminals[self.SID].scanned_at -= 1
        self.assertEqual(self.activity(), IDLE)

    def test_back_at_the_prompt_forgets_the_agent(self):
        self.run_program("claude")
        self.hook("prompt_submit")
        self.assertEqual(self.activity(), WORKING)
        self.foreground = 100  # the agent quit
        self.assertEqual(self.activity(), IDLE)
        self.run_program("sleep 5", pgid=300)
        self.assertEqual(self.activity(), WORKING)

    def test_only_plain_shells_are_inspected(self):
        agent = PTYSession("agent", "/tmp")
        with patch.object(terminal_agent, "foreground_activity") as inspect:
            self.assertIsNone(agent.shell_activity())
        inspect.assert_not_called()

    def test_a_broken_detector_falls_back_to_the_old_rule(self):
        self.run_program("claude")
        with patch.object(terminal_agent, "foreground_activity", side_effect=RuntimeError("boom")):
            self.assertEqual(self.activity(), WORKING)


class HookSignalTests(_TerminalCase):
    """Level 2: the agent's own lifecycle hooks."""

    def setUp(self):
        super().setUp()
        self.run_program("claude")

    def test_turn_start_and_end(self):
        self.assertEqual(self.activity(), IDLE)
        self.assertTrue(self.hook("session_start", source="startup"))
        self.assertEqual(self.activity(), IDLE)
        self.hook("prompt_submit", prompt="fix it")
        self.assertEqual(self.activity(), WORKING)
        self.hook("pre_tool", tool_name="Bash")
        self.hook("post_tool", tool_name="Bash")
        self.assertEqual(self.activity(), WORKING)
        self.hook("turn_complete")
        self.assertEqual(self.activity(), IDLE)

    def test_hooks_win_over_the_screen(self):
        # Working although the footer is not (yet) on screen ...
        self.hook("prompt_submit")
        self.screen = Screen(working=False)
        self.assertEqual(self.activity(), WORKING)
        # ... and done although the answer on screen quotes "esc to interrupt".
        self.hook("turn_complete")
        self.screen = Screen(working=True)
        self.assertEqual(self.activity(), IDLE)

    def test_permission_request_needs_the_user_until_answered(self):
        self.hook("prompt_submit")
        self.hook("pre_tool", tool_name="Bash")
        self.hook("permission_request", tool_name="Bash")
        self.assertEqual(self.activity(), WAITING)
        self.hook("notification", notification_type="permission_prompt", message="Claude needs your permission")
        self.screen = Screen(asking=True)
        self.assertEqual(self.activity(), WAITING)
        # Answered: the dialog is gone. The tool may now run for minutes
        # before the next hook, and that is work, not a question.
        self.screen = Screen(working=True)
        self.assertEqual(self.activity(), WORKING)
        self.hook("post_tool", tool_name="Bash")
        self.hook("turn_complete")
        self.assertEqual(self.activity(), IDLE)

    def test_a_parallel_tool_call_does_not_close_an_open_request(self):
        self.hook("prompt_submit")
        self.hook("pre_tool", tool_name="Bash")
        self.hook("permission_request", tool_name="Bash")
        self.hook("pre_tool", tool_name="Read")  # the second call of the same step
        self.assertEqual(self.activity(), WAITING)

    def test_a_dialog_left_on_screen_after_a_prompt_or_stop_is_answered_text(self):
        # A CLI that does not erase its dialog, or a transcript quoting one: a
        # prompt cannot be submitted and a turn cannot end while it is open.
        self.screen = Screen(asking=True, dialog="Trust this folder?")
        self.assertEqual(self.activity(), WAITING)
        self.hook("prompt_submit")
        self.screen = Screen(asking=True, dialog="Trust this folder?", working=True)
        self.assertEqual(self.activity(), WORKING)
        self.hook("turn_complete")
        self.assertEqual(self.activity(), IDLE)
        # A different dialog is a new question ...
        self.hook("prompt_submit")
        self.screen = Screen(asking=True, dialog="Run rm -rf build?")
        self.assertEqual(self.activity(), WAITING)
        # ... and so is the same one after it had left the screen.
        self.hook("turn_complete")
        self.assertEqual(self.activity(), IDLE)
        self.screen = Screen()
        self.assertEqual(self.activity(), IDLE)
        self.screen = Screen(asking=True, dialog="Run rm -rf build?")
        self.assertEqual(self.activity(), WAITING)

    def test_a_dialog_the_parser_never_saw_ends_with_the_running_footer(self):
        self.hook("permission_request", tool_name="Bash")
        self.screen = Screen(working=True)
        self.assertEqual(self.activity(), WAITING, "the previous frame may still be on screen")
        self.later(3)
        self.assertEqual(self.activity(), WORKING)

    def test_a_denied_or_cancelled_request_does_not_stay_open(self):
        self.hook("permission_request", tool_name="Bash")
        self.hook("permission_denied", tool_name="Bash")
        self.assertEqual(self.activity(), WORKING)
        self.hook("permission_request", tool_name="Bash")
        self.screen = Screen(interrupted=True)  # Esc on the dialog: no Stop follows
        self.later(2)
        self.assertEqual(self.activity(), IDLE)

    def test_esc_interrupt_ends_the_turn_without_a_stop_hook(self):
        self.hook("prompt_submit")
        self.screen = Screen(interrupted=True)
        self.assertEqual(self.activity(), WORKING, "the old notice is still on screen at turn start")
        self.later(2)
        self.assertEqual(self.activity(), IDLE)

    def test_idle_notification_and_turn_failure_end_the_turn(self):
        for event, payload in [("notification", {"notification_type": "idle_prompt"}), ("turn_failure", {})]:
            with self.subTest(event=event):
                self.hook("prompt_submit")
                self.assertEqual(self.activity(), WORKING)
                self.hook(event, **payload)
                self.assertEqual(self.activity(), IDLE)

    def test_late_events_cannot_reopen_a_finished_turn(self):
        self.hook("prompt_submit")
        self.hook("turn_complete")
        self.hook("post_tool", tool_name="Bash")
        self.assertEqual(self.activity(), IDLE)
        # The "needs your permission" notification of a dialog answered long ago.
        self.hook("notification", notification_type="permission_prompt")
        self.assertEqual(self.activity(), IDLE)
        self.screen = Screen(asking=True)  # a dialog that really is open still counts
        self.assertEqual(self.activity(), WAITING)

    def test_events_that_say_nothing_about_the_turn_change_nothing(self):
        self.hook("prompt_submit")
        for event in ("pre_compact", "post_compact", "subagent_start", "subagent_stop", "session_start", ""):
            self.hook(event)
            self.assertEqual(self.activity(), WORKING, event)
        self.hook("notification", notification_type="auth_success")
        self.assertEqual(self.activity(), WORKING)

    def test_hooks_without_a_foreground_job_are_dropped(self):
        self.foreground = 100  # shell prompt; a detached agent inherited the identity
        self.assertFalse(self.hook("prompt_submit"))
        self.assertEqual(self.activity(), IDLE)

    def test_a_new_foreground_job_starts_without_the_old_signal(self):
        self.hook("prompt_submit")
        self.assertEqual(self.activity(), WORKING)
        self.run_program("claude", pgid=300)  # quit and started again
        self.assertEqual(self.activity(), IDLE)

    def test_a_hook_proves_an_agent_the_process_list_cannot_name(self):
        self.run_program("happy-launcher --profile work", pgid=400)
        self.assertEqual(self.activity(), WORKING)  # just a program so far
        self.hook("turn_complete")
        self.assertEqual(self.activity(), IDLE)
        self.hook("prompt_submit")
        self.assertEqual(self.activity(), WORKING)


class CodexTurnEndTests(_TerminalCase):
    """Codex reports no turn end by hook unless that handler is switched on."""

    ROLLOUT = "/tmp/sessions/2026/11/11/rollout-2026-11-11T19-00-00-0199.jsonl"

    def setUp(self):
        super().setUp()
        self.run_program("codex --yolo")

    def test_the_screen_ends_the_turn_after_a_quiet_moment(self):
        self.hook("prompt_submit")
        self.screen = Screen(turn_ended=True)
        self.assertEqual(self.activity(), WORKING, "the composer is still on screen at turn start")
        self.later(2)
        self.assertEqual(self.activity(), IDLE)

    def test_a_running_footer_keeps_the_turn_open(self):
        self.hook("prompt_submit")
        self.screen = Screen(turn_ended=True)
        self.activity()
        self.screen = Screen(working=True)  # the footer came back: not over
        self.activity()
        self.later(5)
        self.assertEqual(self.activity(), WORKING)

    def test_the_rollout_names_the_turn_end(self):
        self.hook("prompt_submit", transcript_path=self.ROLLOUT)
        self.assertEqual(terminal_agent.open_codex_turns(), [(self.SID, self.ROLLOUT)])
        fg = terminal_agent._terminals[self.SID]
        self.assertFalse(terminal_agent.note_turn_boundary(self.SID, self.ROLLOUT, "task_complete", fg.signal_wall - 30),
                         "the end of the previous turn")
        self.assertFalse(terminal_agent.note_turn_boundary(self.SID, self.ROLLOUT, "task_started", time.time() + 1))
        self.assertFalse(terminal_agent.note_turn_boundary(self.SID, "/other/rollout-x.jsonl", "task_complete", time.time() + 1))
        self.screen = Screen(working=True)
        self.assertFalse(terminal_agent.note_turn_boundary(self.SID, self.ROLLOUT, "task_complete", time.time() + 1),
                         "the screen is ahead of the file")
        self.screen = Screen()
        self.assertTrue(terminal_agent.note_turn_boundary(self.SID, self.ROLLOUT, "task_complete", time.time() + 1))
        self.assertEqual(self.activity(), IDLE)
        self.assertEqual(terminal_agent.open_codex_turns(), [])

    def test_an_approval_dialog_needs_the_user_without_a_hook(self):
        self.hook("prompt_submit")
        self.screen = Screen(asking=True)
        self.assertEqual(self.activity(), WAITING)
        self.screen = Screen(working=True)
        self.assertEqual(self.activity(), WORKING)

    def test_the_server_loop_reads_a_real_rollout_file(self):
        import datetime
        import json
        from test_session_activity import server_objects

        def record(kind, at):
            stamp = datetime.datetime.fromtimestamp(at, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
            return json.dumps({"timestamp": stamp, "type": "event_msg", "payload": {"type": kind, "turn_id": "turn-1"}}) + "\n"

        with tempfile.TemporaryDirectory() as tmp:
            rollout = Path(tmp) / "rollout-2026-11-11T19-00-00-0199.jsonl"
            rollout.write_text(record("task_started", time.time()))
            self.hook("prompt_submit", transcript_path=str(rollout))
            server = server_objects("_terminal_codex_turn_sync_loop")

            async def one_round():
                async def stop(_seconds):
                    raise asyncio.CancelledError
                with patch("asyncio.sleep", stop), self.assertRaises(asyncio.CancelledError):
                    await server._terminal_codex_turn_sync_loop()

            asyncio.run(one_round())
            self.assertEqual(self.activity(), WORKING, "the turn has only started")
            with rollout.open("a") as fh:
                fh.write(record("task_complete", time.time() + 1))
            asyncio.run(one_round())
            self.assertEqual(self.activity(), IDLE)
            self.assertEqual(terminal_agent.open_codex_turns(), [])


class ScreenFallbackTests(_TerminalCase):
    """Level 3: no hook has spoken (not installed, not trusted, another CLI)."""

    def setUp(self):
        super().setUp()
        self.text = ""
        terminal_agent.set_screen_probe(
            server_screen_probe(SimpleNamespace(get_screen=lambda sid: self.text)))

    def test_claude_done_working_asking(self):
        self.run_program("claude")
        for name, text, expected in [
            ("finished turn", CLAUDE_DONE, IDLE),
            ("running footer", fixture_screen("claude-bash-after-digit-2"), WORKING),
            ("permission dialog", fixture_screen("claude-bash"), WAITING),
            ("question", fixture_screen("claude-ask-single"), WAITING),
            ("plan approval", fixture_screen("claude-plan-approval"), WAITING),
            ("folder trust", fixture_screen("claude-trust"), WAITING),
            ("a picker the user opened", fixture_screen("claude-model-picker"), IDLE),
            ("interrupted", CLAUDE_INTERRUPTED, IDLE),
            ("no screen yet", "", IDLE),
        ]:
            with self.subTest(screen=name):
                self.text = text
                self.assertEqual(self.activity(), expected)

    def test_codex_done_working_asking(self):
        self.run_program("codex")
        for name, text, expected in [
            ("finished turn", CODEX_FINISHED, IDLE),
            ("running footer", CODEX_WORKING, WORKING),
            ("after an approval", fixture_screen("codex-command-after-digit-2"), WORKING),
            ("approval dialog", fixture_screen("codex-command"), WAITING),
            ("folder trust", fixture_screen("codex-trust"), WAITING),
        ]:
            with self.subTest(screen=name):
                self.text = text
                self.assertEqual(self.activity(), expected)

    def test_the_real_screens_also_close_a_hooked_turn(self):
        self.run_program("codex")
        self.hook("prompt_submit")
        self.text = CODEX_WORKING
        self.assertEqual(self.activity(), WORKING)
        self.text = CODEX_FINISHED
        self.activity()
        self.later(2)
        self.assertEqual(self.activity(), IDLE)
        self.run_program("claude", pgid=300)
        self.hook("prompt_submit")
        self.text = CLAUDE_INTERRUPTED
        self.later(2)
        self.assertEqual(self.activity(), IDLE)

    def test_old_text_further_up_is_not_live_work(self):
        self.run_program("claude")
        self.text = "⏺ The footer says esc to interrupt while I work.\n" + "\n".join(f"line {i}" for i in range(30))
        self.assertEqual(self.activity(), IDLE)
        self.assertTrue(terminal_agent.screen_shows_work("✻ Cogitating… (4s · esc to\n  interrupt)\n❯"), "wrapped footer")
        self.assertTrue(terminal_agent.screen_shows_work("Thinking (esc to cancel, 3s)", "gemini"))
        self.assertFalse(terminal_agent.screen_shows_work("Esc to cancel · Tab to amend", "claude"))

    def test_state_is_rebuilt_after_a_backend_restart(self):
        # Hook signals live with the backend process. A new one knows nothing
        # and reads the terminal again: foreground program, then screen.
        self.run_program("claude")
        self.hook("prompt_submit")
        self.text = fixture_screen("claude-bash-after-digit-2")
        self.assertEqual(self.activity(), WORKING)
        terminal_agent._terminals.clear()  # restart: no signal survives
        self.assertEqual(self.activity(), WORKING, "still working on screen")
        terminal_agent._terminals.clear()
        self.text = CLAUDE_DONE
        self.assertEqual(self.activity(), IDLE, "finished while the backend was away")
        terminal_agent._terminals.clear()
        self.text = fixture_screen("claude-bash")
        self.assertEqual(self.activity(), WAITING)
        terminal_agent._terminals.clear()
        self.run_program("npm run dev", pgid=300)
        self.assertEqual(self.activity(), WORKING)
        terminal_agent._terminals.clear()
        self.foreground = 100
        self.assertEqual(self.activity(), IDLE)

    def test_a_restarted_shell_is_a_new_terminal(self):
        self.run_program("claude")
        self.hook("prompt_submit")
        self.assertEqual(self.activity(), WORKING)
        self.shell.pid = 500  # same session id, new shell, pgid reused by chance
        with patch("os.tcgetpgrp", return_value=200), patch("os.getpgid", return_value=500):
            self.assertEqual(self.shell.shell_activity(), IDLE)


class IdentityTests(unittest.TestCase):
    PARENT = {"HOME": "/Users/u", "PATH": "/usr/bin", "COMMANDER_SESSION_ID": "agent", "IVE_TERMINAL_SESSION_ID": "outer",
              "IVE_TERMINAL_SESSION_PROOF": "outer-proof", "IVE_TERMINAL_API_URL": "http://outer"}

    def test_the_shell_gets_its_own_identity_and_nothing_else_from_ive(self):
        own = shell_session.terminal_identity_env("t1", "proof-1", "http://127.0.0.1:5111")
        env = shell_session.shell_env(self.PARENT, {**own, "COMMANDER_SESSION_ID": "x", "IVE_DATA_DIR": "/x"}, "/tmp")
        self.assertEqual({k: v for k, v in env.items() if k.startswith(("IVE_", "COMMANDER_", "WORKER_"))}, own)
        # The agent identity would switch on the Safety Gate and every agent
        # hook for a CLI the user started by hand.
        self.assertNotIn("COMMANDER_SESSION_ID", env)

    def test_a_parent_terminals_identity_is_never_inherited(self):
        env = shell_session.shell_env(self.PARENT, {}, "/tmp")
        self.assertFalse([k for k in env if k.startswith("IVE_")])

    def test_names_survive_cli_env_filters(self):
        for name in shell_session.TERMINAL_ENV_KEYS:
            for word in ("KEY", "SECRET", "TOKEN", "PASSWORD", "AUTH", "CREDENTIAL"):
                self.assertNotIn(word, name)


class RelayTests(unittest.TestCase):
    """The hook relay reports a plain terminal's agent to that terminal."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.calls = Path(self.tmp.name) / "curl-calls"
        curl = Path(self.tmp.name) / "curl"
        curl.write_text('#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" "$*" >> "$CURL_CALLS"\n')
        curl.chmod(curl.stat().st_mode | stat.S_IEXEC)
        self.script = Path(self.tmp.name) / "hook.sh"
        self.script.write_text(hook_installer.HOOK_SCRIPT)

    def relay(self, env):
        import subprocess
        full = {"PATH": f"{self.tmp.name}:/usr/bin:/bin", "CURL_CALLS": str(self.calls),
                "TMPDIR": self.tmp.name, **env}
        subprocess.run(["/bin/bash", str(self.script)], input='{"hook_event_name":"Stop"}', text=True,
                       env=full, timeout=20, check=True)
        for _ in range(40):  # without jq the agent path posts in the background
            if self.calls.exists():
                break
            time.sleep(0.05)
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_shell_relay_posts_the_terminal_identity_and_skips_discovery(self):
        calls = self.relay({"IVE_TERMINAL_SESSION_ID": "t1", "IVE_TERMINAL_SESSION_PROOF": "p1",
                            "IVE_TERMINAL_API_URL": "http://127.0.0.1:5999"})
        self.assertEqual(len(calls), 1, calls)
        self.assertIn("http://127.0.0.1:5999/api/hooks/event", calls[0])
        for header in ("X-Commander-Session-Id: t1", "X-Commander-Session-Proof: p1", "X-IVE-Terminal: 1"):
            self.assertIn(header, calls[0])
        self.assertNotIn("discover", calls[0])

    def test_shell_relay_keeps_the_agent_identity_first(self):
        calls = self.relay({"COMMANDER_SESSION_ID": "agent", "COMMANDER_SESSION_PROOF": "ap",
                            "COMMANDER_API_URL": "http://127.0.0.1:5998",
                            "IVE_TERMINAL_SESSION_ID": "t1", "IVE_TERMINAL_API_URL": "http://127.0.0.1:5999"})
        self.assertEqual(len(calls), 1, calls)
        self.assertIn("http://127.0.0.1:5998/api/hooks/event", calls[0])
        self.assertIn("X-Commander-Session-Id: agent", calls[0])
        self.assertNotIn("X-IVE-Terminal", calls[0])

    def test_desktop_relay_posts_the_terminal_identity_and_skips_discovery(self):
        import io
        import sys
        seen = []

        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, *a):
                return b"{}"

        def urlopen(request, timeout=None):
            seen.append((request.full_url, dict(request.header_items())))
            return _Resp()

        env = {"IVE_TERMINAL_SESSION_ID": "t1", "IVE_TERMINAL_SESSION_PROOF": "p1",
               "IVE_TERMINAL_API_URL": "http://127.0.0.1:5999/"}
        with patch.dict(os.environ, env, clear=True), \
                patch.object(sys, "stdin", io.StringIO('{"hook_event_name":"Stop"}')), \
                patch.object(desktop_hook_relay.urllib.request, "urlopen", urlopen):
            self.assertEqual(desktop_hook_relay.main(), 0)
        self.assertEqual(len(seen), 1, seen)
        url, headers = seen[0]
        self.assertEqual(url, "http://127.0.0.1:5999/api/hooks/event")
        headers = {k.lower(): v for k, v in headers.items()}
        self.assertEqual((headers["x-commander-session-id"], headers["x-commander-session-proof"], headers["x-ive-terminal"]),
                         ("t1", "p1", "1"))


class HookEndpointTests(unittest.IsolatedAsyncioTestCase):
    """POST /api/hooks/event for a plain terminal sets its status and nothing else."""

    SID = "term-hook"

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_TMP.name))
        p = patch.object(config, "DATA_DIR", self.dir)
        p.start()
        self.addCleanup(p.stop)
        session_proofs._cache.clear()
        self.addCleanup(session_proofs._cache.clear)
        terminal_agent._terminals.clear()
        self.addCleanup(terminal_agent._terminals.clear)
        self.plain = True

        def sample(sid):  # an agent CLI holds the terminal
            terminal_agent._terminals.setdefault(
                sid, terminal_agent._Foreground(generation=1, pgid=2, since=time.monotonic(), cli="claude",
                                               scanned_at=time.monotonic()))
            return IDLE

        self.pty = SimpleNamespace(is_plain_shell=lambda sid: self.plain and sid == self.SID,
                                   get_shell_activity=sample)
        p = patch.object(hooks, "_pty_mgr", self.pty)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(hooks.cleanup_session, self.SID)
        self.proof = session_proofs.issue(self.SID)

    async def post(self, event, headers=None, **payload):
        headers = {"X-Commander-Session-Id": self.SID, "X-Commander-Session-Proof": self.proof,
                   "X-IVE-Terminal": "1"} if headers is None else headers
        req = make_mocked_request("POST", "/api/hooks/event", headers=headers)
        req.json = AsyncMock(return_value={"hook_event_name": event, **payload})
        agent_path = AssertionError("agent hook pipeline used for a plain terminal")
        with patch.object(hooks, "_maybe_capture_native_id", AsyncMock(side_effect=agent_path)), \
                patch.object(hooks, "_emit_normalized", AsyncMock(side_effect=agent_path)), \
                patch.object(hooks, "_dispatch_plugin_hooks", AsyncMock(side_effect=agent_path)), \
                patch.object(hooks, "_broadcast", AsyncMock(side_effect=agent_path)):
            return await hooks.handle_hook_event(req)

    def signal(self):
        fg = terminal_agent._terminals.get(self.SID)
        return fg.signal if fg else None

    async def test_claude_and_gemini_hook_names_set_the_terminal_state(self):
        for event, expected in [("SessionStart", IDLE), ("UserPromptSubmit", WORKING), ("PreToolUse", WORKING),
                                ("PermissionRequest", WAITING), ("PostToolUse", WORKING), ("Stop", IDLE),
                                ("BeforeAgent", WORKING), ("AfterAgent", IDLE), ("StopFailure", IDLE)]:
            with self.subTest(event=event):
                resp = await self.post(event)
                self.assertEqual((resp.status, resp.text), (200, "{}"))
                self.assertEqual(self.signal(), expected)
        self.assertNotIn(self.SID, hooks._hook_sessions, "no agent hook state for a terminal")

    async def test_a_live_plain_terminal_never_reaches_agent_handlers_without_the_header(self):
        resp = await self.post("UserPromptSubmit", headers={
            "X-Commander-Session-Id": self.SID, "X-Commander-Session-Proof": self.proof})
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.signal(), WORKING)

    async def test_wrong_or_missing_proof_is_rejected(self):
        for proof in ("guess", ""):
            resp = await self.post("UserPromptSubmit", headers={
                "X-Commander-Session-Id": self.SID, "X-Commander-Session-Proof": proof, "X-IVE-Terminal": "1"})
            self.assertEqual(resp.status, 403)
        # A terminal always has a proof: an id without one is not "legacy".
        resp = await self.post("UserPromptSubmit", headers={
            "X-Commander-Session-Id": "never-started", "X-IVE-Terminal": "1"})
        self.assertEqual(resp.status, 403)
        self.assertIsNone(self.signal())

    async def test_a_terminal_that_is_gone_is_ignored_not_treated_as_an_agent(self):
        self.plain = False  # the shell exited; a detached CLI still has the identity
        resp = await self.post("UserPromptSubmit")
        self.assertEqual((resp.status, resp.text), (200, "{}"))
        self.assertIsNone(self.signal())
        self.assertNotIn(self.SID, hooks._hook_sessions)

    async def test_unknown_events_are_ignored(self):
        resp = await self.post("IveProofProbe")
        self.assertEqual(resp.status, 200)
        self.assertIsNone(self.signal())


class RealTerminalTests(unittest.IsolatedAsyncioTestCase):
    """A real shell in a real PTY runs a stand-in named `claude`: the process
    scan, the screen emulator and the server's screen probe together."""

    AGENT = r"""#!/bin/sh
printf 'FAKE CLAUDE\n\342\235\257 \n'
while IFS= read -r line; do
  case "$line" in
    work) printf '\342\234\273 Working\342\200\246 (2s)\n\342\235\257 \n  esc to interrupt\n' ;;
    finish) printf '\033[2J\033[H\342\234\273 Cooked for 2s\n\342\235\257 \n' ;;
    quit) exit 0 ;;
  esac
done
"""

    async def asyncSetUp(self):
        terminal_agent._terminals.clear()
        self.addCleanup(terminal_agent._terminals.clear)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        agent = Path(self.tmp.name) / "claude"
        agent.write_text(self.AGENT)
        agent.chmod(agent.stat().st_mode | stat.S_IEXEC)
        self.capture = OutputCaptureProcessor()
        terminal_agent.set_screen_probe(server_screen_probe(self.capture))
        self.addCleanup(terminal_agent.set_screen_probe, None)
        self.manager = PTYManager()
        self.addAsyncCleanup(self.manager.stop_all)
        self.output = bytearray()

        async def on_output(sid, data):
            self.output.extend(data)
            await self.capture.process(sid, data)

        self.manager.on_output(on_output)
        self.manager.on_exit(AsyncMock())

    async def wait_for(self, predicate, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if predicate():
                return
            await asyncio.sleep(0.05)
        self.fail(f"Timed out; activity={self.manager.get_shell_activity('shell')} "
                  f"state={terminal_agent._terminals.get('shell')} output={bytes(self.output[-300:])!r}")

    def activity(self):
        return self.manager.get_shell_activity("shell")

    async def test_agent_started_by_hand_is_done_working_done_and_follows_hooks(self):
        binary = "/bin/zsh" if os.path.exists("/bin/zsh") else "/bin/bash"
        args = ["-f", "-i"] if binary.endswith("zsh") else ["--noprofile", "--norc", "-i"]
        await self.manager.start_session(
            "shell", self.tmp.name, cmd_binary=binary, cmd_args=args,
            extra_env={"HOME": self.tmp.name, "ZDOTDIR": self.tmp.name}, plain_shell=True,
        )
        self.manager.write("shell", b"printf 'READY:%s\\n' 42\r")
        await self.wait_for(lambda: b"READY:42" in self.output)
        await self.wait_for(lambda: self.activity() == IDLE)

        # An ordinary program still works for as long as it runs.
        self.manager.write("shell", b"sleep 1.5\r")
        await self.wait_for(lambda: self.activity() == WORKING)
        await self.wait_for(lambda: self.activity() == IDLE)

        # The agent at its prompt: a foreground job for hours, but not working.
        self.manager.write("shell", b"./claude\r")
        await self.wait_for(lambda: b"FAKE CLAUDE" in self.output)
        await self.wait_for(lambda: self.activity() == IDLE)
        self.assertEqual(terminal_agent._terminals["shell"].cli, "claude")

        # Level 3: its screen.
        self.manager.write("shell", b"work\r")
        await self.wait_for(lambda: self.activity() == WORKING)
        self.manager.write("shell", b"finish\r")
        await self.wait_for(lambda: self.activity() == IDLE)

        # Level 2: its hooks win over what the screen shows.
        self.assertTrue(terminal_agent.note_hook("shell", "prompt_submit", {"hook_event_name": "UserPromptSubmit"}))
        self.assertEqual(self.activity(), WORKING)
        self.assertTrue(terminal_agent.note_hook("shell", "turn_complete", {"hook_event_name": "Stop"}))
        self.assertEqual(self.activity(), IDLE)

        self.manager.write("shell", b"quit\r")
        await self.wait_for(lambda: self.activity() == IDLE and "shell" not in terminal_agent._terminals)
        self.assertFalse(terminal_agent.note_hook("shell", "prompt_submit", {}), "the agent is gone")
        self.manager.write("shell", b"exit\r")
        await self.wait_for(lambda: not self.manager.is_alive("shell"))


if __name__ == "__main__":
    unittest.main()
