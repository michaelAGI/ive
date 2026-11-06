"""Missing Stop: terminal is done, but chat/queued replies still say working."""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import codex_turn_state
import hooks
import server
from pty_manager import PTYSession


READY = "• Hey! Alles entspannt, und bei dir?\nWorked for 5s\n\n› Ask Codex to do anything\nGPT-6-Astra xhigh · ~/Example\n? for shortcuts"


def event(kind, at=200, turn="a"):
    return {"timestamp": datetime.fromtimestamp(at, timezone.utc).isoformat(),
            "type": "event_msg", "payload": {"type": kind, "turn_id": turn}}


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name, "rollout.jsonl")

    def write(self, *records):
        self.path.write_text("".join(json.dumps(r) + "\n" for r in records))

    def test_final_answer_is_not_turn_completion(self):
        self.write(event("task_started"), {"type": "response_item", "payload": {
            "type": "message", "role": "assistant", "phase": "final_answer"}})
        self.assertEqual(codex_turn_state.read_turn_boundary(self.path)[0], "task_started")

    def test_complete_then_new_turn_and_late_old_completion(self):
        self.write(event("task_complete"), event("task_started", 210, "b"), event("task_complete", 211))
        self.assertEqual(codex_turn_state.read_turn_boundary(self.path), ("task_started", "b", 210))

    def test_partial_record_does_not_release_queue(self):
        self.write(event("task_started"))
        with self.path.open("a") as f:
            f.write(json.dumps(event("task_complete", 205)))
        self.assertEqual(codex_turn_state.read_turn_boundary(self.path)[0], "task_started")
        with self.path.open("a") as f:
            f.write("\n")
        self.assertEqual(codex_turn_state.read_turn_boundary(self.path)[0], "task_complete")

    def test_tail_is_bounded_and_rewrites_invalidate_cache(self):
        self.write({"huge": "x" * (codex_turn_state._TAIL_BYTES * 2)}, event("task_complete"))
        self.assertEqual(codex_turn_state.read_turn_boundary(self.path)[0], "task_complete")
        self.write(event("task_started", 210, "b"))
        self.assertEqual(codex_turn_state.read_turn_boundary(self.path)[0], "task_started")
        self.path.unlink()
        self.assertIsNone(codex_turn_state.read_turn_boundary(self.path))


class TurnSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name, "rollout.jsonl")
        self.write(event("task_started", 100), event("task_complete", 200))
        self.sid = "codex-turn-sync-test"
        self.state = hooks._get_state(self.sid)
        self.state.update(state="working", last_event_at=100, turns_completed=0)
        self.addCleanup(hooks._hook_sessions.pop, self.sid, None)
        self.broadcast = AsyncMock()
        self.config = {"cli_type": "codex", "native_session_id": "native-test", "workspace_path": temp.name}
        self.alive = True
        self.submitted_at = 90
        self.screen = READY
        self.attention = None
        for p in (
            patch.object(hooks, "_broadcast", self.broadcast),
            patch.object(server, "get_session_config", AsyncMock(side_effect=lambda _: self.config)),
            patch.object(server, "_get_native_transcript_path", return_value=self.path),
            patch.object(server, "_cached_session_cli_type", AsyncMock(return_value="codex")),
            patch.object(server.pty_mgr, "is_alive", side_effect=lambda _: self.alive),
            patch.object(server.pty_mgr, "get_last_submit_at", side_effect=lambda _: self.submitted_at),
            patch.object(server.capture_proc, "get_screen", side_effect=lambda _: self.screen),
            patch("session_attention.get_attention", side_effect=lambda _: self.attention),
        ):
            p.start()
            self.addCleanup(p.stop)

    def write(self, *records):
        self.path.write_text("".join(json.dumps(r) + "\n" for r in records))

    async def sync(self):
        return await server._sync_codex_turn_completion(self.sid)

    async def test_missing_stop_recovers_shared_state_once(self):
        self.assertTrue(await self.sync())
        self.assertEqual(hooks.get_session_logical_status(self.sid, True, "running"), "idle")
        self.assertFalse(await self.sync())
        self.assertEqual(self.state["turns_completed"], 1)
        events = [c.args[0] for c in self.broadcast.call_args_list]
        self.assertEqual([e["type"] for e in events], ["prompt_state", "session_state"])
        self.assertEqual(events[-1]["source"], "codex_transcript")

    async def test_ready_input_endpoint_recovers_before_timeout(self):
        self.assertTrue(await server._wait_for_cli_input_ready(self.sid, "codex", 1))
        self.assertEqual(self.state["state"], "idle")

    async def test_background_loop_recovers_without_open_chat_or_new_output(self):
        task = asyncio.create_task(server._codex_turn_sync_loop())
        try:
            async with asyncio.timeout(2):
                while self.state["state"] != "idle":
                    await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_new_turn_blocks_old_completion(self):
        self.write(event("task_complete", 200), event("task_started", 201, "b"))
        self.assertFalse(await self.sync())

    async def test_new_raw_terminal_submit_blocks_old_completion_before_hook(self):
        self.submitted_at = 201
        self.assertFalse(await self.sync())

    async def test_new_hook_blocks_old_completion(self):
        self.state["last_event_at"] = 201
        self.assertFalse(await self.sync())

    async def test_submit_arriving_during_transcript_read_wins(self):
        def read(_):
            self.submitted_at = 201
            return ("task_complete", "a", 200)
        with patch("codex_turn_state.read_turn_boundary", side_effect=read):
            self.assertFalse(await self.sync())
        self.assertEqual(self.state["state"], "working")

    async def test_new_hook_during_broadcast_does_not_send_stale_idle(self):
        async def broadcast(event):
            if event["type"] == "prompt_state":
                self.state.update(state="working", last_event_at=201)
        self.broadcast.side_effect = broadcast
        self.assertFalse(await self.sync())
        self.assertEqual(self.broadcast.call_count, 1)
        self.assertEqual(self.state["state"], "working")

    async def test_followup_uses_actual_input_handler_without_busy_timeout(self):
        from test_input_contract_review import Request
        writes = []
        with patch.object(server, "_get_visible_session_for_request", AsyncMock(return_value=self.config)), \
             patch.object(server, "get_auth", return_value=None), \
             patch.object(server, "_terminal_control_violation", return_value=None), \
             patch.object(server, "_session_cli_type", AsyncMock(return_value="codex")), \
             patch.object(server.pty_mgr, "write", side_effect=lambda sid, data: writes.append(data) or True):
            async with asyncio.timeout(3):
                response = await server.send_session_input(Request({"message": "Next message", "ready_timeout": 8}))
        self.assertEqual(response.status, 200)
        self.assertEqual(writes, [b"\x1b" + b"\x7f" * 50, b"Next message", b"\r"])

    async def test_open_question_busy_screen_or_dead_pty_are_not_idle(self):
        self.attention = {"kind": "question"}
        self.assertFalse(await self.sync())
        self.attention = None
        for screen in ("", "› old prompt\nWorking… esc to interrupt",
                       "Working… esc to interrupt\n› Ask Codex to do anything",
                       "Would you like to run the following command?\n$ touch a\n› 1. Yes, proceed (y)\n2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel"):
            with self.subTest(screen=screen):
                self.screen = screen
                self.assertFalse(await self.sync())
        self.screen = READY
        self.alive = False
        self.assertFalse(await self.sync())

    async def test_no_native_id_other_cli_or_already_idle_are_untouched(self):
        for change in ({"native_session_id": None}, {"cli_type": "claude"}):
            with patch.dict(self.config, change):
                self.assertFalse(await self.sync())
        self.state["state"] = "idle"
        self.assertFalse(await self.sync())
        self.broadcast.assert_not_called()

    async def test_prompt_submit_records_new_work(self):
        self.state["state"] = "idle"
        with patch("hooks.time.time", return_value=201):
            await hooks._handle_prompt_submit(self.sid, {})
        self.assertEqual(self.state["last_event_at"], 201)
        self.assertFalse(await self.sync())


class SubmitTrackingTests(unittest.TestCase):
    def test_raw_and_chat_enter_share_tracking_but_failed_writes_do_not(self):
        pty = PTYSession("test", "/tmp")
        pty.master_fd = 123
        pty._alive = True
        with patch("pty_manager.time.time", return_value=200):
            self.assertTrue(pty.write(b"hello"))
            self.assertEqual(pty.last_submit_at, 0)
            self.assertTrue(pty.write(b"\r"))
            self.assertEqual(pty.last_submit_at, 200)
        pty._alive = False
        self.assertFalse(pty.write(b"\r"))
        self.assertEqual(pty.last_submit_at, 200)


if __name__ == "__main__":
    unittest.main()
