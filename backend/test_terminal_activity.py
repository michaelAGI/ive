"""Live terminal activity uses kernel/hook evidence, never open-process counts.

The real PTY test uses a temporary HOME and a shell without startup files. It
starts no model, app instance, user session, or network service.
"""
import asyncio
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import hooks
import quick_start
import session_attention
from pty_manager import PTYManager, PTYSession
from test_session_activity import server_objects


class ForegroundEvidenceTests(unittest.TestCase):
    def test_only_plain_shells_use_foreground_groups(self):
        agent = PTYSession("agent", "/tmp")
        with patch("os.tcgetpgrp") as inspect:
            self.assertIsNone(agent.shell_activity())
        inspect.assert_not_called()

    def test_unknown_if_pty_is_dead_or_kernel_evidence_is_unavailable(self):
        shell = PTYSession("shell", "/tmp", plain_shell=True)
        self.assertEqual(shell.shell_activity(), "unknown")
        shell.pid, shell.master_fd, shell._alive = 10, 20, True
        with patch("os.tcgetpgrp", side_effect=OSError("PTY closed")):
            self.assertEqual(shell.shell_activity(), "unknown")
        with patch("os.tcgetpgrp", return_value=0), patch("os.getpgid", return_value=10):
            self.assertEqual(shell.shell_activity(), "unknown")


class RealShellActivityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manager = PTYManager()
        self.addAsyncCleanup(self.manager.stop_all)
        self.output = bytearray()

        async def on_output(_sid, data):
            self.output.extend(data)

        self.manager.on_output(on_output)
        self.manager.on_exit(AsyncMock())

    async def wait_for(self, predicate, timeout=5):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if predicate():
                return
            await asyncio.sleep(0.02)
        self.fail(f"Timed out waiting for terminal state: {self.output[-300:]!r}")

    async def test_silent_foreground_command_interrupt_background_and_exit(self):
        binary = "/bin/zsh" if os.path.exists("/bin/zsh") else "/bin/bash"
        args = ["-f", "-i"] if binary.endswith("zsh") else ["--noprofile", "--norc", "-i"]
        await self.manager.start_session(
            "shell", self.tmp.name, cmd_binary=binary, cmd_args=args,
            extra_env={"HOME": self.tmp.name, "ZDOTDIR": self.tmp.name}, plain_shell=True,
        )
        self.manager.write("shell", b"printf 'READY:%s\\n' 42\r")
        await self.wait_for(lambda: b"READY:42" in self.output)
        await self.wait_for(lambda: self.manager.get_shell_activity("shell") == "idle")
        self.assertEqual(self.manager.shell_activity_snapshot(), {"shell": "idle"})

        self.manager.write("shell", b"sleep 0.2\r")
        await self.wait_for(lambda: self.manager.get_shell_activity("shell") == "working")
        await self.wait_for(lambda: self.manager.get_shell_activity("shell") == "idle")

        # No output is required: a sleeping foreground command still owns
        # the terminal and must appear while an ordinary prompt does not.
        self.manager.write("shell", b"sleep 10\r")
        await self.wait_for(lambda: self.manager.get_shell_activity("shell") == "working")
        self.assertEqual(self.manager.shell_activity_snapshot(), {"shell": "working"})
        self.manager.write("shell", b"\x03")
        await self.wait_for(lambda: self.manager.get_shell_activity("shell") == "idle")

        self.manager.write("shell", b"sleep 0.1 &\r")
        await asyncio.sleep(0.3)
        self.assertEqual(self.manager.get_shell_activity("shell"), "idle")
        self.manager.write("shell", b"exit\r")
        await self.wait_for(lambda: not self.manager.is_alive("shell"))
        self.assertEqual(self.manager.shell_activity_snapshot(), {})


class SessionSnapshotActivityTests(unittest.TestCase):
    def setUp(self):
        self.sid = "terminal-activity-snapshot"
        self.addCleanup(hooks.cleanup_session, self.sid)
        self.alive = True
        self.activity = "idle"
        self.screen = "\n> "
        self.server = server_objects(
            "_decorate_session_dict", "_looks_antigravity_busy",
            pty_mgr=SimpleNamespace(is_alive=lambda _: self.alive, get_shell_activity=lambda _: self.activity),
            capture_proc=SimpleNamespace(get_screen=lambda _: self.screen,
                                         get_buffer=lambda *_: "\n> old task\nGenerating..."),
            _is_brainstormer_session=lambda _: False,
            BRAINSTORMER_PUBLIC_TAG="brainstorm_public", _quick_start=quick_start,
        )

    def snapshot(self, cli="shell", status="running"):
        return self.server._decorate_session_dict({"id": self.sid, "cli_type": cli, "status": status})

    def test_open_shell_and_stale_db_running_are_idle(self):
        snapshot = self.snapshot()
        self.assertEqual((snapshot["status"], snapshot["agentState"], snapshot["terminal_activity"]),
                         ("idle", "idle", "idle"))
        for cli in ("claude", "codex", "gemini", "antigravity"):
            with self.subTest(cli=cli):
                self.assertEqual(self.snapshot(cli)["status"], "idle")

    def test_antigravity_uses_current_screen_not_old_spinner_output(self):
        self.assertEqual(self.snapshot("antigravity")["status"], "idle")
        self.screen = "\n> current task\nGenerating..."
        self.assertEqual(self.snapshot("antigravity")["status"], "running")
        self.screen = ""
        self.assertEqual(self.snapshot("antigravity")["status"], "idle")

    def test_shell_work_unknown_and_exit_are_distinct(self):
        self.activity = "working"
        self.assertEqual(self.snapshot()["agentState"], "working")
        self.activity = "unknown"
        self.assertEqual((self.snapshot()["status"], self.snapshot()["terminal_activity"]), ("idle", "unknown"))
        self.alive = False
        self.activity = "working"  # a previous PTY's sample cannot survive exit
        self.assertEqual((self.snapshot(status="stopped")["status"], self.snapshot()["terminal_activity"]), ("stopped", "unknown"))
        self.assertEqual(self.snapshot("claude", "quota_exceeded")["status"], "quota_exceeded")

    def test_approval_overrides_agent_work_and_dead_pty_overrides_both(self):
        hooks._get_state(self.sid)["state"] = "working"
        self.assertEqual(self.snapshot("claude")["status"], "running")
        session_attention.observe_event({
            "type": "permission_event", "phase": "request", "session_id": self.sid,
            "tool_name": "Bash", "asked_at": time.time(),
        })
        self.assertEqual(self.snapshot("claude")["status"], "waiting")
        self.alive = False
        snapshot = self.snapshot("claude", "stopped")
        self.assertEqual((snapshot["status"], snapshot["attention"]), ("stopped", None))


class ShellBroadcastTests(unittest.IsolatedAsyncioTestCase):
    async def test_changes_and_restarts_broadcast_without_duplicate_ticks(self):
        samples = [({"sh": "idle"}, 10), ({"sh": "working"}, 10),
                   ({"sh": "working"}, 10), ({"sh": "idle"}, 10),
                   ({"sh": "idle"}, 20), ({}, None)]
        index = 0

        async def tick(_seconds):
            nonlocal index
            index += 1
            if index == len(samples):
                raise asyncio.CancelledError

        broadcast = AsyncMock()
        server = server_objects(
            "_shell_activity_sync_loop", broadcast=broadcast,
            pty_mgr=SimpleNamespace(shell_activity_snapshot=lambda: samples[index][0],
                                    get_shell_activity=lambda sid: samples[index][0].get(sid),
                                    get_pid=lambda _: samples[index][1]),
        )
        with patch("asyncio.sleep", tick), self.assertRaises(asyncio.CancelledError):
            await server._shell_activity_sync_loop()
        events = [call.args[0] for call in broadcast.await_args_list]
        self.assertEqual([e["terminal_activity"] for e in events], ["idle", "working", "idle", "idle"])
        self.assertEqual([e["status"] for e in events], ["idle", "running", "idle", "idle"])
        self.assertTrue(all(e["pty_alive"] for e in events))

    async def test_exit_while_another_session_broadcasts_cannot_revive_a_shell(self):
        live = {"first": "working", "gone": "working"}
        events = []

        async def broadcast(event):
            events.append(event)
            live.pop("gone", None)  # its exit was handled during delivery

        async def stop(_seconds):
            raise asyncio.CancelledError

        server = server_objects(
            "_shell_activity_sync_loop", broadcast=broadcast,
            pty_mgr=SimpleNamespace(shell_activity_snapshot=lambda: dict(live),
                                    get_shell_activity=lambda sid: live.get(sid),
                                    get_pid=lambda sid: 10 if sid in live else None),
        )
        with patch("asyncio.sleep", stop), self.assertRaises(asyncio.CancelledError):
            await server._shell_activity_sync_loop()
        self.assertEqual([event["session_id"] for event in events], ["first"])


if __name__ == "__main__":
    unittest.main()
