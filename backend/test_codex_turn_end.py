"""Codex turns end on screen when its Stop hook never runs. Never starts a server."""
import ast
import re
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import hooks

NAMES = {"_compact_cli_text", "_detect_cli_startup_blocker", "_has_codex_update_prompt_text",
         "_startup_blocker_text", "_is_startup_control_input", "_has_codex_trust_prompt_text",
         "_codex_composer_ready", "_looks_ready_for_input", "_looks_codex_busy",
         "_trust_prompt_selection", "_strip_pty_control_bytes", "_codex_screen_shows_turn_end"}


def _load():
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    body = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in NAMES]
    body += [n for n in tree.body if isinstance(n, ast.Assign)
             and any(getattr(t, "id", "") in {"_AUTH_BLOCKER_TYPES", "_STARTUP_BLOCKER_FALLBACK_LINES",
                                         "_CODEX_MENU_CURSOR_RE"} for t in n.targets)]
    ns = {"re": re}
    exec(compile(ast.Module(body=body, type_ignores=[]), "server.py", "exec"), ns)
    return ns


# Recorded from Codex 0.166 inside IVE 1.0.20 after a finished turn.
FINISHED = """› hey was geht


• Hey! Alles entspannt, und bei dir?

  Worked for 5s • 23:35


› Ask Codex to do anything

  GPT-6-Astra xhigh · ~/Projekte
  ? for shortcuts                                                       ⚠ 1 warning · f2 to view
"""

WORKING_ABOVE = """› hi


• Working (3s • esc to interrupt)

› Ask Codex to do anything
  ? for shortcuts
"""

WORKING_BELOW = """› hi

› Ask Codex to do anything
• Thinking (2s • esc to interrupt)
"""

UPDATE_PROMPT = """Update available! 0.166.0 -> 0.167.0
Update Codex by running the installer again.
› 1. Update now
  2. Skip for now
"""

STARTING = """Starting MCP servers...
"""


class ScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load()

    def test_finished_turn_shows_turn_end(self):
        self.assertTrue(self.ns["_codex_screen_shows_turn_end"](FINISHED))

    def test_running_turn_never_ends_on_screen(self):
        for screen in (WORKING_ABOVE, WORKING_BELOW):
            self.assertFalse(self.ns["_codex_screen_shows_turn_end"](screen), screen)

    def test_startup_screens_are_not_turn_ends(self):
        for screen in (UPDATE_PROMPT, STARTING, ""):
            self.assertFalse(self.ns["_codex_screen_shows_turn_end"](screen), screen)


class HookStateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old = hooks._broadcast
        self.addCleanup(setattr, hooks, "_broadcast", self.old)
        self.addCleanup(hooks.cleanup_session, "turn-test")
        self.sent = AsyncMock()
        hooks.set_broadcast_fn(self.sent)

    def states(self):
        return [c.args[0] for c in self.sent.await_args_list if c.args[0].get("type") == "session_state"]

    async def test_working_turn_ends_once(self):
        s = hooks._get_state("turn-test")
        s["state"] = "working"
        s["turns_completed"] = 2
        self.assertTrue(await hooks.mark_turn_ended_from_screen("turn-test"))
        self.assertEqual(s["state"], "idle")
        self.assertEqual(s["turns_completed"], 3)
        self.assertEqual(hooks.get_session_logical_status("turn-test", True, "idle"), "idle")
        self.assertEqual(self.states(), [{"type": "session_state", "session_id": "turn-test", "state": "idle", "source": "screen"}])
        self.assertFalse(await hooks.mark_turn_ended_from_screen("turn-test"), "already idle")

    async def test_open_question_is_left_alone(self):
        hooks._get_state("turn-test")["state"] = "prompting"
        self.assertFalse(await hooks.mark_turn_ended_from_screen("turn-test"))
        self.assertEqual(hooks._get_state("turn-test")["state"], "prompting")
        self.assertEqual(self.states(), [])


if __name__ == "__main__":
    unittest.main()
