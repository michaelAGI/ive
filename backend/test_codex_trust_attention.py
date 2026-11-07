"""Codex's folder-trust screen is a question the chat can see and answer.

The menu contract for the trust screen, the attention an output flush raises,
the guarded reply that walks Codex's "›" cursor, the 409 for plain text, and
the screens that must stay as they were (idle composer, update prompt).
Never starts a server or a CLI.
"""
import ast
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from aiohttp import web

import session_attention as attention
from test_input_contract_review import Request

BACKEND = Path(__file__).resolve().parent
# Codex 0.164 at 120x40 (fixtures/permission_dialogs/codex-trust): the screen
# Codex 0.167 draws in a new project folder too.
TRUST_SCREEN = (BACKEND / "fixtures" / "permission_dialogs" / "codex-trust.screen.txt").read_text()
TRUST_QUESTION = "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings."
TRUST_LABELS = ["Trust and continue", "Back to Agent Command Center"]
IDLE_SCREEN = """>_ OpenAI Codex (v0.167.0)

  model: gpt-5.1-codex   /model to change
  directory: /work/project

› Ask Codex to do anything

  ? for shortcuts
"""
UPDATE_PROMPT = """Update available! 0.166.0 -> 0.167.0
Update Codex by running the installer again.
› 1. Update now
  2. Skip for now
"""
SID = "trust-attention-test"

FUNCTIONS = {
    "_canonical_prompt_screen", "_session_permission_menu", "_is_incomplete_permission_screen",
    "_trust_prompt_selection", "_strip_pty_control_bytes", "_compact_cli_text",
    "_detect_cli_startup_blocker", "_has_codex_update_prompt_text", "_has_codex_trust_prompt_text",
    "_codex_composer_ready", "_looks_ready_for_input", "_looks_codex_busy",
    "_send_guarded_session_prompt", "send_session_input", "_maybe_broadcast_output_inferred_status",
}
CONSTANTS = {"_AUTH_BLOCKER_TYPES", "_STARTUP_BLOCKER_FALLBACK_LINES", "_CODEX_MENU_CURSOR_RE"}


def load(**deps):
    tree = ast.parse((BACKEND / "server.py").read_text())
    nodes = [n for n in tree.body
             if (isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and (n.name in FUNCTIONS or n.name.startswith("_dialog_")))
             or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and (t.id.startswith("_DIALOG_") or t.id in CONSTANTS)
                                                   for t in n.targets))]
    ns = {"re": re, "web": web, **deps}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), ns)
    return ns


def moved_to(screen, key):
    """The trust screen after Codex moved its "›" cursor onto option ``key``."""
    lines = []
    for line in screen.splitlines():
        if re.match(r"\s*›\s*[1-9][.)]\s", line):
            line = line.replace("›", " ", 1)
        if re.match(rf"\s*{key}[.)]\s", line):
            line = re.sub(rf"^(\s*)  ({key}[.)]\s)", rf"\1› \2", line)
        lines.append(line)
    return "\n".join(lines)


class TrustMenuContractTests(unittest.TestCase):
    def setUp(self):
        self.ns = load()
        self.menu = self.ns["_session_permission_menu"]

    def test_trust_screen_is_a_question_menu_with_codex_labels(self):
        menu = self.menu(TRUST_SCREEN)
        self.assertIsNotNone(menu)
        self.assertEqual(menu["kind"], "question")
        self.assertTrue(menu["answerable"])
        self.assertTrue(menu["question"].startswith(TRUST_QUESTION), menu["question"])
        self.assertEqual([o["label"] for o in menu["options"]], TRUST_LABELS)
        self.assertEqual(menu["choices"], ("1", "2"))
        self.assertEqual(menu["selected"], "1")
        self.assertEqual([o["selected"] for o in menu["options"]], [True, False])
        self.assertEqual(menu["excerpt"].splitlines()[0], "Folder access")
        self.assertIn("/scratchpad/lane-a/proj-3", menu["excerpt"])
        self.assertIn(TRUST_QUESTION, menu["identity"])
        self.assertFalse(self.ns["_is_incomplete_permission_screen"](TRUST_SCREEN))

    def test_identity_survives_the_cursor_move_and_leaves_with_the_composer(self):
        menu = self.menu(TRUST_SCREEN)
        moved = self.menu(moved_to(TRUST_SCREEN, "2"))
        self.assertEqual(moved["identity"], menu["identity"])
        self.assertEqual(moved["selected"], "2")
        # Accepted: Codex draws its composer under the old text. History, not a menu.
        self.assertIsNone(self.menu(TRUST_SCREEN.rstrip("\n") + "\n› "))
        self.assertIsNone(self.menu(TRUST_SCREEN.rstrip("\n") + "\n\n› Ask Codex to do anything"))

    def test_ambiguous_cursor_is_not_a_menu(self):
        # No cursor or two cursors (mid-repaint): nothing to answer against.
        self.assertIsNone(self.menu(TRUST_SCREEN.replace("› 1.", "  1.")))
        self.assertIsNone(self.menu(TRUST_SCREEN.replace("  2. Back", "› 2. Back")))

    def test_trust_screen_stays_a_startup_blocker(self):
        self.assertEqual(self.ns["_detect_cli_startup_blocker"]("codex", TRUST_SCREEN)["type"], "trust_required")
        self.assertFalse(self.ns["_looks_ready_for_input"]("codex", TRUST_SCREEN))

    def test_idle_codex_screen_is_no_menu_and_no_blocker(self):
        self.assertIsNone(self.menu(IDLE_SCREEN))
        self.assertFalse(self.ns["_is_incomplete_permission_screen"](IDLE_SCREEN))
        self.assertIsNone(self.ns["_detect_cli_startup_blocker"]("codex", IDLE_SCREEN))
        self.assertTrue(self.ns["_looks_ready_for_input"]("codex", IDLE_SCREEN))

    def test_update_prompt_behaves_as_before(self):
        # Dismissed with Escape by _check_startup_selection_prompts; never a question card.
        self.assertIsNone(self.menu(UPDATE_PROMPT))
        self.assertFalse(self.ns["_is_incomplete_permission_screen"](UPDATE_PROMPT))
        self.assertEqual(self.ns["_detect_cli_startup_blocker"]("codex", UPDATE_PROMPT)["type"], "update_required")
        self.assertTrue(self.ns["_has_codex_update_prompt_text"](UPDATE_PROMPT, require_skip_choice=True))
        self.assertFalse(self.ns["_looks_ready_for_input"]("codex", UPDATE_PROMPT))


class TrustAttentionTests(unittest.TestCase):
    def setUp(self):
        self.ns = load()
        attention.clear_attention(SID)
        self.addCleanup(attention.clear_attention, SID)

    def observe(self, screen):
        return attention.observe_terminal(SID, screen, self.ns["_session_permission_menu"](screen))

    def test_trust_menu_raises_attention_as_a_question(self):
        self.assertTrue(self.observe(TRUST_SCREEN))
        pending = attention.get_attention(SID)
        self.assertEqual(pending["kind"], "question")
        self.assertEqual(pending["title"], "Your answer is needed")
        self.assertEqual(pending["source"], "terminal")
        self.assertTrue(pending["message"].startswith(TRUST_QUESTION), pending["message"])
        self.assertEqual([o["label"] for o in pending["menu"]["options"]], TRUST_LABELS)
        # The cursor moving is the same question: no second push, the cursor follows.
        self.assertFalse(self.observe(moved_to(TRUST_SCREEN, "2")))
        self.assertEqual(attention.get_attention(SID)["menu"]["selected"], "2")

    def test_attention_clears_when_codex_shows_its_composer(self):
        self.observe(TRUST_SCREEN)
        self.assertTrue(self.observe(IDLE_SCREEN))
        self.assertIsNone(attention.get_attention(SID))

    def test_idle_and_update_screens_raise_nothing(self):
        self.assertFalse(self.observe(IDLE_SCREEN))
        self.assertFalse(self.observe(UPDATE_PROMPT))
        self.assertIsNone(attention.get_attention(SID))


class OutputFlushTests(unittest.IsolatedAsyncioTestCase):
    async def test_output_flush_pushes_the_trust_menu_as_attention(self):
        attention.clear_attention(SID)
        self.addCleanup(attention.clear_attention, SID)
        sent = AsyncMock()
        # No _detect_cli_startup_blocker in this namespace: the flush must not
        # consult it to drop the menu again (the old guard made the session
        # look idle while Codex waited for the trust answer).
        ns = load(
            pty_mgr=SimpleNamespace(is_alive=lambda _: True),
            capture_proc=SimpleNamespace(get_screen=lambda _: TRUST_SCREEN, get_buffer=lambda *_: TRUST_SCREEN),
            _cached_session_cli_type=AsyncMock(return_value="codex"),
            broadcast=sent,
            _schedule_codex_turn_end_check=Mock(),
            _maybe_mark_claude_interrupted=AsyncMock(),
            _output_inferred_status={},
            logger=SimpleNamespace(debug=Mock(), info=Mock()),
        )
        await ns["_maybe_broadcast_output_inferred_status"](SID)
        sent.assert_awaited_once()
        event = sent.await_args.args[0]
        self.assertEqual(event["type"], "session_attention")
        self.assertEqual(event["session_id"], SID)
        self.assertEqual(event["attention"]["kind"], "question")
        self.assertEqual([o["label"] for o in event["attention"]["menu"]["options"]], TRUST_LABELS)
        # The same screen again: no second push.
        await ns["_maybe_broadcast_output_inferred_status"](SID)
        sent.assert_awaited_once()


class TrustReplyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.screen, self.writes = TRUST_SCREEN, []
        self.answered = AsyncMock()
        self.ready = AsyncMock(return_value=True)
        self.ns = load(
            _STARTUP_MENU_WAIT_S=0.5,  # the composer waits briefly for IVE's own auto-accept
            _terminal_streams={"session": object()}, _session_prompt_replies={},
            capture_proc=SimpleNamespace(get_screen=lambda _: self.screen),
            pty_mgr=SimpleNamespace(is_alive=lambda _: True, write=self.write),
            _asyncio=SimpleNamespace(sleep=AsyncMock()),
            _get_visible_session_for_request=AsyncMock(return_value={"id": "session", "cli_type": "codex"}),
            get_auth=lambda _: None, _terminal_control_violation=lambda *_: None,
            _session_cli_type=AsyncMock(return_value="codex"),
            _is_auth_recovery_input=Mock(return_value=False), _broadcast_auth_recovery=AsyncMock(),
            _wait_for_cli_input_ready=self.ready,
            _detect_cli_startup_blocker=lambda *_: {"type": "trust_required", "label": "Workspace trust prompt"},
            _startup_blocker_text=lambda _: self.screen,
            _session_prompt_answered=self.answered,
        )
        self.identity = self.ns["_session_permission_menu"](TRUST_SCREEN)["identity"]

    def write(self, _, data):
        self.writes.append(data)
        if data in (b"\x1b[B", b"\x1b[A"):
            # Codex redraws the "›" cursor on the neighbouring numbered row.
            selected = int(self.ns["_session_permission_menu"](self.screen)["selected"])
            self.screen = moved_to(self.screen, str(selected + (1 if data == b"\x1b[B" else -1)))
        return True

    async def send(self, **body):
        return await self.ns["send_session_input"](Request({"ready_timeout": 0, **body}))

    async def test_trust_and_continue_from_the_card_is_one_enter(self):
        response = await self.send(choice="1", expected_identity=self.identity)
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(self.writes, [b"\r"])
        self.answered.assert_awaited_once()
        self.assertEqual(self.answered.await_args.args[1]["identity"], self.identity)

    async def test_back_to_agent_command_center_walks_the_cursor_first(self):
        response = await self.send(choice="2", expected_identity=self.identity)
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(self.writes, [b"\x1b[B", b"\r"])
        self.assertEqual(self.ns["_session_permission_menu"](self.screen)["selected"], "2")

    async def test_plain_text_is_refused_with_the_trust_question(self):
        response = await self.send(message="hello")
        self.assertEqual(response.status, 409)
        payload = json.loads(response.text)
        self.assertEqual(payload["code"], "question_open")
        self.assertFalse(payload["incomplete"])
        self.assertTrue(payload["menu"]["question"].startswith(TRUST_QUESTION))
        self.assertEqual([o["label"] for o in payload["menu"]["options"]], TRUST_LABELS)
        self.assertEqual(self.writes, [])
        self.ready.assert_not_awaited()

    async def test_a_changed_screen_is_refused_without_enter(self):
        self.screen = IDLE_SCREEN
        response = await self.send(choice="1", expected_identity=self.identity)
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.text)["code"], "stale_session_prompt")
        self.assertEqual(self.writes, [])


if __name__ == "__main__":
    unittest.main()
