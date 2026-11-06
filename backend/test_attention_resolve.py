"""Answered questions clear everywhere; both Claude hooks describe one dialog."""
import ast
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

import aiosqlite
from aiohttp import web
from fresh_database_schema import SCHEMA_STATEMENTS
import hooks
import session_attention as attention

SID = "resolve-test"
DIALOG = """Bash command
ls README.md
List the README
Do you want to proceed?
❯ 1. Yes
  2. No
Esc to cancel · Tab to amend"""
GONE_WORKING = "⏺ Bash(ls README.md)\n  ⎿ Running…\n✻ Thinking… (esc to interrupt)"
GONE_IDLE = "⏺ Done.\n\n❯ \n  ? for shortcuts"
PARTIAL_REDRAW = "Bash command\nls README.md\nDo you want to proceed?\n❯ 1. Yes\n  2. No"
FORM = "Which framework should the tests use?\n❯ 1. pytest\n  2. unittest\n\nEnter to select · Esc to cancel"
REQUEST = {"type": "permission_event", "phase": "request", "session_id": SID, "tool_name": "Bash",
           "tool_input": {"command": "ls README.md"}, "notification_type": "permission_prompt", "asked_at": 10.0,
           "actions": [{"label": "Allow", "key": "enter", "style": "primary"}, {"label": "Reject", "key": "escape", "style": "danger"}]}
NOTE = {"type": "session_state", "state": "prompting", "session_id": SID, "notification_type": "permission_prompt",
        "message": "Claude needs your permission to use Bash", "asked_at": 16.0, "source": "hook",
        "actions": [{"label": "Open", "key": "enter", "style": "default"}]}


class ResolveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent = AsyncMock()
        attention.set_broadcast_fn(self.sent)
        self.addCleanup(attention.set_broadcast_fn, None)
        self.addCleanup(attention.clear_attention, SID)

    async def test_resolve_clears_and_broadcasts_the_clear(self):
        attention.observe_event(REQUEST)
        attention.observe_terminal(SID, DIALOG)
        self.assertTrue(await attention.resolve(SID, "the dialog the user answered"))
        self.assertIsNone(attention.get_attention(SID))
        self.sent.assert_awaited_once_with({"type": "session_attention", "session_id": SID, "attention": None})
        # The dialog still drawn for one frame cannot bring the question back.
        self.assertFalse(attention.observe_terminal(SID, DIALOG))
        self.assertIsNone(attention.get_attention(SID))
        self.assertTrue(attention.observe_terminal(SID, GONE_WORKING + "\n" + DIALOG))
        self.assertEqual(attention.get_attention(SID)["source"], "terminal")

    async def test_resolve_keeps_a_newer_question(self):
        attention.observe_event(REQUEST)
        attention._pending[SID]["menu"] = {"identity": "Do you want to proceed?\n1. Yes\n2. No"}
        self.assertFalse(await attention.resolve(SID, "a different dialog"))
        self.assertIsNotNone(attention.get_attention(SID))
        self.sent.assert_not_awaited()
        self.assertTrue(await attention.resolve(SID, "Do you want to proceed?\n1. Yes\n2. No"))
        self.assertIsNone(attention.get_attention(SID))

    async def test_resolve_without_identity_or_question(self):
        self.assertFalse(await attention.resolve(SID))
        self.sent.assert_not_awaited()
        attention.observe_event(REQUEST)
        self.assertTrue(await attention.resolve(SID))
        self.assertIsNone(attention.get_attention(SID))


class TerminalClearsHookAttentionTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(attention.clear_attention, SID)
        attention.observe_event(REQUEST)

    def test_dialog_gone_with_a_running_turn_clears_the_hook_question(self):
        self.assertFalse(attention.observe_terminal(SID, DIALOG))
        self.assertEqual(attention.get_attention(SID)["source"], "hook")
        self.assertTrue(attention.observe_terminal(SID, GONE_WORKING))
        self.assertIsNone(attention.get_attention(SID))

    def test_dialog_gone_with_the_composer_clears_the_hook_question(self):
        attention.observe_terminal(SID, DIALOG)
        self.assertTrue(attention.observe_terminal(SID, GONE_IDLE))
        self.assertIsNone(attention.get_attention(SID))

    def test_a_dialog_never_seen_is_not_cleared_by_an_old_working_line(self):
        # The hook fires before the CLI draws its dialog.
        self.assertFalse(attention.observe_terminal(SID, GONE_WORKING))
        self.assertFalse(attention.observe_terminal(SID, GONE_WORKING))
        self.assertIsNotNone(attention.get_attention(SID))

    def test_one_frame_without_the_footer_does_not_clear(self):
        attention.observe_terminal(SID, DIALOG)
        self.assertFalse(attention.observe_terminal(SID, PARTIAL_REDRAW))
        self.assertIsNotNone(attention.get_attention(SID))
        attention.observe_terminal(SID, DIALOG)
        self.assertFalse(attention.observe_terminal(SID, PARTIAL_REDRAW))
        self.assertTrue(attention.observe_terminal(SID, PARTIAL_REDRAW))
        self.assertIsNone(attention.get_attention(SID))

    def test_unparsed_dialog_keeps_the_hook_question_until_it_leaves(self):
        self.assertIsNone(attention.detect_terminal_attention(FORM))
        self.assertFalse(attention.observe_terminal(SID, FORM))
        self.assertFalse(attention.observe_terminal(SID, FORM))
        self.assertIsNotNone(attention.get_attention(SID))
        self.assertTrue(attention.observe_terminal(SID, GONE_WORKING))
        self.assertIsNone(attention.get_attention(SID))

    def test_plan_approval_without_footer_counts_as_visible(self):
        plan = ("   Claude has written up a plan and is ready to execute. Would you like to proceed?\n"
                "   ❯ 1. Yes, and use auto mode\n     2. Yes, manually approve edits\n     3. Tell Claude what to change\n"
                "        shift+tab to approve with this feedback\n   ctrl+g to edit in Vim · ~/.claude/plans/plan.md")
        self.assertIsNone(attention.detect_terminal_attention(plan))
        self.assertTrue(attention.dialog_visible(plan))
        self.assertFalse(attention.observe_terminal(SID, plan))
        self.assertTrue(attention.observe_terminal(SID, "⏺ Update(README.md)\n  ⎿ Updated README.md\n✻ Working… (esc to interrupt)"))
        self.assertIsNone(attention.get_attention(SID))

    def test_missing_output_never_clears(self):
        attention.observe_terminal(SID, DIALOG)
        for _ in range(3):
            self.assertFalse(attention.observe_terminal(SID, ""))
        self.assertIsNotNone(attention.get_attention(SID))

    def test_terminal_question_still_clears_the_moment_it_is_gone(self):
        attention.clear_attention(SID)
        self.assertTrue(attention.observe_terminal(SID, DIALOG))
        self.assertTrue(attention.observe_terminal(SID, PARTIAL_REDRAW))
        self.assertIsNone(attention.get_attention(SID))


class HookMergeTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(attention.clear_attention, SID)

    def test_notification_after_request_adds_its_message_and_keeps_the_tool(self):
        attention.observe_event(REQUEST)
        attention.observe_event(NOTE)
        pending = attention.get_attention(SID)
        self.assertEqual(pending["tool_name"], "Bash")
        self.assertEqual(pending["tool_input"], {"command": "ls README.md"})
        self.assertEqual(pending["message"], "Claude needs your permission to use Bash")
        self.assertEqual(pending["notification_type"], "permission_prompt")
        self.assertEqual([a["key"] for a in pending["actions"]], ["enter", "escape"])
        self.assertEqual(pending["asked_at"], 10.0)
        self.assertEqual(pending["kind"], "permission")

    def test_request_after_notification_wins_the_tool_and_keeps_the_first_time(self):
        attention.observe_event(NOTE)
        attention.observe_event(REQUEST)
        pending = attention.get_attention(SID)
        self.assertEqual(pending["tool_name"], "Bash")
        self.assertEqual(pending["tool_input"], {"command": "ls README.md"})
        self.assertEqual(pending["message"], "Claude needs your permission to use Bash")
        self.assertEqual([a["key"] for a in pending["actions"]], ["enter", "escape"])
        self.assertEqual(pending["asked_at"], 16.0)

    def test_a_new_request_replaces_the_old_question(self):
        attention.observe_event(REQUEST)
        attention.observe_event(NOTE)
        attention.observe_event({**REQUEST, "tool_name": "Write", "tool_input": {"file_path": "x.py"}, "asked_at": 30.0})
        pending = attention.get_attention(SID)
        self.assertEqual(pending["tool_name"], "Write")
        self.assertEqual(pending["message"], "x.py")
        self.assertEqual(pending["asked_at"], 30.0)

    def test_terminal_detection_never_merges(self):
        attention.observe_event(NOTE)
        attention.observe_terminal(SID, DIALOG)
        self.assertEqual(attention.get_attention(SID)["message"], "Claude needs your permission to use Bash")


class AnsweredStateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old_broadcast = hooks._broadcast
        self.addCleanup(setattr, hooks, "_broadcast", self.old_broadcast)
        self.addCleanup(hooks.cleanup_session, SID)
        self.sent = AsyncMock()
        hooks.set_broadcast_fn(self.sent)

    async def test_answer_moves_prompting_to_working_and_clears_everywhere(self):
        await hooks._handle_permission_request(SID, {"tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual(hooks.get_session_logical_status(SID, True, "idle"), "waiting")
        self.sent.reset_mock()
        self.assertTrue(await hooks.mark_answered(SID))
        self.assertIsNone(attention.get_attention(SID))
        self.assertEqual(hooks.get_session_logical_status(SID, True, "idle"), "running")
        self.sent.assert_awaited_once_with({"type": "session_state", "session_id": SID, "state": "working", "source": "answer"})
        self.assertFalse(await hooks.mark_answered(SID))
        self.sent.assert_awaited_once()

    async def test_status_follows_the_open_question_not_a_stale_hook_state(self):
        await hooks._handle_permission_request(SID, {"tool_name": "Bash"})
        attention.observe_terminal(SID, DIALOG)
        attention.observe_terminal(SID, GONE_WORKING)
        self.assertEqual(hooks._hook_sessions[SID]["state"], "prompting")
        self.assertEqual(hooks.get_session_logical_status(SID, True, "idle"), "idle")


class MenuAttentionTests(unittest.IsolatedAsyncioTestCase):
    """A dialog the parser reads off the screen is attention by itself, pushed
    once per question; hook details stay when a hook also reported it."""

    def setUp(self):
        from test_prompt_menu_parser import fixture_screen, load_parser, move_cursor
        self.parse = load_parser()["_session_permission_menu"]
        self.move_cursor = move_cursor
        self.ask, self.codex = fixture_screen("claude-ask-single"), fixture_screen("codex-command")
        self.network, self.plan = fixture_screen("codex-network"), fixture_screen("claude-plan-approval")
        self.sent = AsyncMock()
        attention.set_broadcast_fn(self.sent)
        self.addCleanup(attention.set_broadcast_fn, None)
        self.addCleanup(attention.clear_attention, SID)

    def observe(self, screen):
        return attention.observe_terminal(SID, screen, self.parse(screen))

    def test_recognised_dialog_raises_attention_without_a_hook(self):
        self.assertTrue(self.observe(self.ask))
        pending = attention.get_attention(SID)
        self.assertEqual((pending["kind"], pending["source"], pending["title"], pending["message"]),
                         ("question", "terminal", "Your answer is needed", "Which colour?"))
        self.assertEqual(pending["menu"], self.parse(self.ask))
        attention.clear_attention(SID)
        self.assertTrue(self.observe(self.codex))
        pending = attention.get_attention(SID)
        self.assertEqual((pending["kind"], pending["title"]), ("permission", "Permission needed"))
        self.assertEqual(pending["menu"]["options"][0]["label"], "Yes, proceed (y)")

    def test_cursor_moves_are_not_pushed_but_recorded(self):
        self.assertTrue(self.observe(self.codex))
        self.assertFalse(self.observe(self.move_cursor(self.codex, 2)))
        self.assertEqual(attention.get_attention(SID)["menu"]["selected"], "2")
        self.assertFalse(self.observe(self.move_cursor(self.codex, 3)))
        self.assertEqual(attention.get_attention(SID)["menu"]["selected"], "3")
        self.assertFalse(self.observe("⏺ redraw above\n" + self.codex))

    def test_a_new_question_is_pushed(self):
        self.assertTrue(self.observe(self.codex))
        self.assertTrue(self.observe(self.network))
        self.assertIn("curl -sI", attention.get_attention(SID)["menu"]["excerpt"])

    def test_hook_question_gets_the_menu_attached_once(self):
        attention.observe_event(REQUEST)
        self.assertTrue(self.observe(DIALOG))
        pending = attention.get_attention(SID)
        self.assertEqual((pending["source"], pending["tool_name"], pending["kind"]), ("hook", "Bash", "permission"))
        self.assertEqual(pending["tool_input"], {"command": "ls README.md"})
        self.assertEqual(pending["menu"]["question"], "Do you want to proceed?")
        self.assertFalse(self.observe(self.move_cursor(DIALOG, 2)))
        self.assertEqual(attention.get_attention(SID)["menu"]["selected"], "2")

    def test_plan_dialog_turns_a_hook_permission_into_a_plan(self):
        attention.observe_event(REQUEST)
        self.assertTrue(self.observe(self.plan))
        pending = attention.get_attention(SID)
        self.assertEqual((pending["kind"], pending["title"], pending["source"]), ("plan", "Plan ready for your approval", "hook"))
        self.assertEqual([o["label"] for o in pending["menu"]["options"]][0], "Yes, and use auto mode")

    def test_second_hook_of_the_same_dialog_keeps_the_menu(self):
        attention.observe_event(REQUEST)
        self.observe(DIALOG)
        attention.observe_event(NOTE)
        pending = attention.get_attention(SID)
        self.assertEqual(pending["message"], "Claude needs your permission to use Bash")
        self.assertEqual(pending["menu"]["identity"], self.parse(DIALOG)["identity"])
        self.assertFalse(self.observe(DIALOG))

    def test_dialog_gone_clears_after_two_frames_or_at_once_with_the_composer(self):
        self.observe(self.codex)
        half = "• Running touch created.txt"
        self.assertFalse(self.observe(half))
        self.assertIsNotNone(attention.get_attention(SID))
        self.assertTrue(self.observe(half))
        self.assertIsNone(attention.get_attention(SID))
        self.observe(self.codex)
        self.assertTrue(self.observe(GONE_WORKING))
        self.assertIsNone(attention.get_attention(SID))

    def test_cut_off_dialog_falls_back_to_the_footer_form(self):
        self.observe(DIALOG)
        cropped = DIALOG[DIALOG.index("Do you want"):]
        self.assertIsNone(self.parse(cropped))
        self.assertFalse(self.observe(cropped))
        self.assertTrue(self.observe(cropped))
        pending = attention.get_attention(SID)
        self.assertEqual((pending["source"], pending["message"]), ("terminal", "Review the request in the terminal."))
        self.assertNotIn("menu", pending)
        self.assertTrue(self.observe(DIALOG))
        self.assertIn("menu", attention.get_attention(SID))

    def test_terminal_menu_is_cleared_in_the_terminal_without_a_hook(self):
        self.observe(self.ask)
        self.assertTrue(self.observe(GONE_IDLE))
        self.assertIsNone(attention.get_attention(SID))

    async def test_answered_question_is_not_raised_again_while_the_cli_redraws(self):
        self.observe(self.codex)
        identity = self.parse(self.codex)["identity"]
        self.assertFalse(await attention.resolve(SID, "another question"))
        self.assertTrue(await attention.resolve(SID, identity))
        self.sent.assert_awaited_once_with({"type": "session_attention", "session_id": SID, "attention": None})
        self.assertFalse(self.observe(self.codex))
        self.assertFalse(self.observe("• spinner\n" + self.codex))
        self.assertIsNone(attention.get_attention(SID))
        self.assertFalse(self.observe(GONE_WORKING))
        # The CLI asks the same thing later: a new question.
        self.assertTrue(self.observe(self.codex))
        self.assertEqual(attention.get_attention(SID)["menu"]["identity"], identity)

    async def test_grace_ends_when_the_dialog_stays(self):
        self.observe(self.codex)
        await attention.resolve(SID)
        attention._answered[SID] = (attention._answered[SID][0], attention._answered[SID][1] - 10)
        self.assertTrue(self.observe("• spinner\n" + self.codex))

    async def test_grace_ends_with_the_first_frame_without_the_dialog(self):
        self.observe(self.codex)
        identity = self.parse(self.codex)["identity"]
        await attention.resolve(SID, identity)
        self.assertTrue(attention.answered_recently(SID, identity))
        self.assertFalse(attention.answered_recently(SID, "another question"))
        self.assertFalse(self.observe(GONE_WORKING))
        self.assertFalse(attention.answered_recently(SID, identity))
        # The same question drawn again right away is a new question.
        self.assertTrue(self.observe(self.codex))
        self.assertEqual(attention.get_attention(SID)["menu"]["identity"], identity)

    def test_an_echoed_prompt_line_is_not_the_composer(self):
        # Claude echoes the user's prompt as a ❯ line; only the last rows are the composer.
        self.assertFalse(attention._composer_or_working("❯ Fetch https://example.com/docs and summarise\n\n⏺ Fetching…\n\nBash command\nls README.md\nDo you want to proceed?"))
        self.assertTrue(attention._composer_or_working(GONE_IDLE))
        self.assertTrue(attention._composer_or_working("⏺ Done.\n\n❯ \n" + "─" * 40 + "\n  ⏸ manual mode on"))
        self.assertTrue(attention._composer_or_working("• Ran touch created.txt\n\n› Ask Codex to do anything\n\n  GPT-6-Astra default · /tmp/proj-3"))
        self.assertTrue(attention._composer_or_working(GONE_WORKING))
        # One half-drawn frame of a hook question keeps the attention even with an echoed ❯ line above.
        attention.observe_event(REQUEST)
        self.assertTrue(self.observe(DIALOG))
        frame = "❯ Fetch https://example.com/docs and summarise\n\n⏺ Fetching…\n\nBash command\nls README.md\nDo you want to proceed?"
        self.assertIsNone(self.parse(frame))
        self.assertFalse(self.observe(frame))
        pending = attention.get_attention(SID)
        self.assertEqual((pending["source"], pending["tool_name"]), ("hook", "Bash"))
        self.assertIn("menu", pending)

    def test_a_new_hook_question_for_another_tool_gets_no_old_menu(self):
        attention.observe_event(REQUEST)
        self.observe(DIALOG)
        attention.observe_event({**REQUEST, "tool_name": "Write", "tool_input": {"file_path": "x.py"}, "asked_at": 30.0})
        pending = attention.get_attention(SID)
        self.assertEqual((pending["tool_name"], pending["kind"], pending["title"]), ("Write", "permission", "Permission needed"))
        self.assertNotIn("menu", pending)
        # The same tool again (a redraw of the same hook) keeps the dialog.
        attention.clear_attention(SID)
        attention.observe_event(REQUEST)
        self.observe(DIALOG)
        attention.observe_event(REQUEST)
        self.assertEqual(attention.get_attention(SID)["menu"]["identity"], self.parse(DIALOG)["identity"])
        # Notification then request: one dialog by design, the menu stays.
        attention.clear_attention(SID)
        attention.observe_event(NOTE)
        self.observe(DIALOG)
        attention.observe_event(REQUEST)
        pending = attention.get_attention(SID)
        self.assertEqual((pending["tool_name"], pending["menu"]["identity"]), ("Bash", self.parse(DIALOG)["identity"]))


class OverviewWaitingCounterTests(unittest.IsolatedAsyncioTestCase):
    """/api/overview counts a session with an open question as waiting."""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ive-overview-")
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / "test.sqlite"
        db = await self.get_db()
        try:
            for statement in SCHEMA_STATEMENTS:
                await db.execute(statement)
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','ws','/tmp/ws')")
            for sid, status in (("asking", "running"), ("busy", "running"), ("done", "idle"), ("gone", "error")):
                await db.execute("INSERT INTO sessions(id,workspace_id,name,status) VALUES(?,?,?,?)", (sid, "ws", sid, status))
            await db.commit()
        finally:
            await db.close()
        for sid in ("asking", "gone"):
            self.addCleanup(attention.clear_attention, sid)
        wanted = {"_OVERVIEW_DETAIL_LIMIT", "_OVERVIEW_SESSION_STATUSES", "_OVERVIEW_BLOCKED_STATUSES",
                  "_OVERVIEW_RESEARCH_TERMINAL_STATUSES", "TEST_QUEUE_ATTENTION_STATUSES"}
        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, "id", "") in wanted for t in n.targets)]
        nodes += [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "get_overview"]
        self.ns = {"web": web, "get_db": self.get_db, "get_auth": lambda _: SimpleNamespace(is_owner=True),
                   "pty_mgr": SimpleNamespace(is_alive=lambda sid: sid != "gone")}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), self.ns)

    async def get_db(self):
        db = await aiosqlite.connect(self.db_path, timeout=0.5)
        db.row_factory = aiosqlite.Row
        return db

    async def test_open_questions_count_as_waiting(self):
        attention.observe_event({**REQUEST, "session_id": "asking"})
        attention.observe_event({**REQUEST, "session_id": "gone"})  # dead PTY: a leftover entry does not count
        response = await self.ns["get_overview"](SimpleNamespace())
        self.assertEqual(response.status, 200)
        workspace = json.loads(response.text)["workspaces"][0]
        by_status = workspace["sessions"]["by_status"]
        self.assertEqual(workspace["sessions"]["total"], 4)
        self.assertEqual((by_status["waiting"], by_status["running"], by_status["idle"], by_status["error"]), (1, 1, 1, 1))
        self.assertEqual(sum(by_status.values()), workspace["sessions"]["total"])
        self.assertEqual(workspace["blocked_sessions"]["total"], 1)
        await attention.resolve("asking")
        workspace = json.loads((await self.ns["get_overview"](SimpleNamespace())).text)["workspaces"][0]
        self.assertEqual((workspace["sessions"]["by_status"]["waiting"], workspace["sessions"]["by_status"]["running"]), (0, 2))


if __name__ == "__main__":
    unittest.main()
