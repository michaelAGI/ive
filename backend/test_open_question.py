"""Prompts IVE types on its own never land in an open CLI dialog."""
import unittest
from unittest.mock import AsyncMock, Mock, patch

import hooks
import open_question

SID = "worker-1"


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.addCleanup(open_question.configure, None)

    def test_without_a_probe_nothing_is_open(self):
        open_question.configure(None)
        self.assertFalse(open_question.session_has_open_question(SID))

    def test_the_probe_decides_and_its_errors_mean_free(self):
        open_question.configure(lambda sid: sid == "asking")
        self.assertTrue(open_question.session_has_open_question("asking"))
        self.assertFalse(open_question.session_has_open_question(SID))
        self.assertFalse(open_question.session_has_open_question(""))
        open_question.configure(Mock(side_effect=RuntimeError("no screen")))
        self.assertFalse(open_question.session_has_open_question(SID))

    async def test_wait_returns_at_once_when_free_and_gives_up_after_the_timeout(self):
        open_question.configure(lambda sid: False)
        with patch.object(open_question.asyncio, "sleep", AsyncMock()) as sleep:
            self.assertTrue(await open_question.wait_until_free(SID))
            sleep.assert_not_awaited()
        open_question.configure(lambda sid: True)
        with patch.object(open_question.asyncio, "sleep", AsyncMock()) as sleep:
            self.assertFalse(await open_question.wait_until_free(SID, timeout=30, interval=5))
            self.assertEqual(sleep.await_count, 6)

    async def test_wait_ends_when_the_dialog_clears(self):
        frames = iter([True, True, False])
        open_question.configure(lambda sid: next(frames))
        with patch.object(open_question.asyncio, "sleep", AsyncMock()) as sleep:
            self.assertTrue(await open_question.wait_until_free(SID, timeout=30, interval=5))
            self.assertEqual(sleep.await_count, 2)


class PendingWarningsTests(unittest.IsolatedAsyncioTestCase):
    """The W2W caller: warnings stay queued while a dialog is open, go out once it is gone."""

    def setUp(self):
        self.pty = Mock()
        self.pty.is_alive.return_value = True
        self.pty.write.return_value = True
        self.addCleanup(setattr, hooks, "_pty_mgr", hooks._pty_mgr)
        hooks._pty_mgr = self.pty
        self.addCleanup(hooks._pending_pty_warnings.pop, SID, None)
        hooks._pending_pty_warnings[SID] = [{"message": "src/App.jsx is being edited by another agent", "priority": "warning", "source": "peer"}]
        self.addCleanup(open_question.configure, None)

    async def test_an_open_dialog_keeps_the_queue_and_writes_nothing(self):
        open_question.configure(lambda sid: True)
        with patch("pty_manager.asyncio.sleep", AsyncMock()):
            await hooks._deliver_pending_warnings(SID)
        self.pty.write.assert_not_called()
        self.assertEqual(len(hooks._pending_pty_warnings[SID]), 1)
        open_question.configure(lambda sid: False)
        with patch("pty_manager.asyncio.sleep", AsyncMock()):
            await hooks._deliver_pending_warnings(SID)
        self.assertNotIn(SID, hooks._pending_pty_warnings)
        payloads = [call.args[1] for call in self.pty.write.call_args_list]
        self.assertEqual(payloads[-1], b"\r")
        self.assertTrue(any(b"[W2W]" in payload for payload in payloads))


if __name__ == "__main__":
    unittest.main()
