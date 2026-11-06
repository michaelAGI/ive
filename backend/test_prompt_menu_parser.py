"""The CLIs' dialogs as data: every captured fixture in both rendered forms,
and no menu where there is none (pickers, trust, replies, cut-off screens)."""
import ast
import json
from pathlib import Path
import re
import unittest

import pyte

from test_session_prompt_guard import MENU
from test_startup_blocker import _load as load_startup_blocker

BACKEND = Path(__file__).resolve().parent
FIXTURES = BACKEND / "fixtures" / "permission_dialogs"
KIND = {"permission": "permission", "plan_approval": "plan", "ask_user_question": "question"}
# What the excerpt of each permission dialog must carry: the request itself ...
REQUEST = {
    "claude-bash": "echo hello-ive > hello.txt", "claude-create-file": "notes.txt", "claude-edit-file": "+hello",
    "claude-fetch": "url: https://example.com/", "legacy-claude-create-file": "notes.txt",
    "legacy-claude-edit-file": "+hello", "legacy-claude-fetch": "url: https://example.com/",
    "codex-command": "$ touch created.txt", "codex-network": "$ curl -sI https://example.com",
    "codex-patch": "$ printf 'hello' > hello.md",
}
# ... and, as its first line, Claude's header ("Bash command", "Edit file", ...); Codex prints none.
FIRST_LINE = {
    "claude-bash": "Bash command", "claude-create-file": "Create file", "claude-edit-file": "Edit file",
    "claude-fetch": "Fetch", "legacy-claude-create-file": "Create file", "legacy-claude-edit-file": "Edit file",
    "legacy-claude-fetch": "Fetch", "codex-command": "Environment: local", "codex-network": "Environment: local",
    "codex-patch": "Environment: local",
}


def load_parser():
    tree = ast.parse((BACKEND / "server.py").read_text())
    names = {"_canonical_prompt_screen", "_session_permission_menu", "_is_incomplete_permission_screen"}
    nodes = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and (n.name in names or n.name.startswith("_dialog_")))
             or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id.startswith("_DIALOG_") for t in n.targets))]
    ns = {"re": re}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), ns)
    return ns


class _Screen(pyte.Screen):
    """pyte answers CPR itself; the CLIs' private DECXCPR query would raise."""

    def write_process_input(self, data):
        pass

    def report_device_status(self, mode, **kwargs):
        if not kwargs.get("private"):
            super().report_device_status(mode)


def render(raw: bytes, cols: int, rows: int) -> str:
    """What capture_proc.get_screen returns for these PTY bytes: the visible
    rows, right-stripped, trailing blank rows trimmed."""
    screen = _Screen(cols, rows)
    pyte.ByteStream(screen).feed(raw)
    lines = [line.rstrip() for line in screen.display]
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def manifest():
    return json.loads((FIXTURES / "manifest.json").read_text())


def screens_of(entry):
    """(form, screen) pairs: the pyte rendering of the raw bytes at the
    manifest's size and the captured .screen.txt (legacy entries: the latter)."""
    if entry.get("format") == "json":
        return []
    if entry.get("format") == "screen":
        return [("screen", (FIXTURES / entry["path"]).read_text())]
    cols, rows = entry["size"]
    return [("rendered", render((FIXTURES / f"{entry['name']}.txt").read_bytes(), cols, rows)),
            ("screen", (FIXTURES / f"{entry['name']}.screen.txt").read_text())]


def fixture_screen(name):
    return (FIXTURES / f"{name}.screen.txt").read_text()


def move_cursor(screen, target):
    """The screen after the CLI moved its cursor onto option ``target``."""
    glyph = "›" if "›" in screen else "❯"
    lines = []
    for line in screen.splitlines():
        if re.match(rf"\s*{glyph}\s*[1-9][.)]\s", line):
            line = line.replace(glyph, " ", 1)
        elif re.match(rf"\s*{target}[.)]\s", line):
            line = re.sub(rf"^(\s*) ({target}[.)]\s)", rf"\1{glyph}\2", line)
        lines.append(line)
    return "\n".join(lines)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_parser()
        self.menu = self.ns["_session_permission_menu"]
        self.incomplete = self.ns["_is_incomplete_permission_screen"]

    def test_fixture_set_is_complete(self):
        entries = manifest()
        self.assertEqual(len(entries), 22)
        self.assertEqual(sum(1 for e in entries if e["kind"] in KIND), 14)
        self.assertTrue(all(any(screens_of(e)) or e.get("format") == "json" for e in entries))

    def test_every_positive_fixture_matches_the_manifest(self):
        for entry in manifest():
            if entry["kind"] not in KIND:
                continue
            results = []
            for form, screen in screens_of(entry):
                with self.subTest(fixture=entry["name"], form=form):
                    menu = self.menu(screen)
                    self.assertIsNotNone(menu)
                    self.assertEqual(menu["kind"], KIND[entry["kind"]])
                    self.assertEqual(menu["question"], entry["question"])
                    self.assertEqual([o["label"] for o in menu["options"]], entry["options"])
                    self.assertEqual([o["key"] for o in menu["options"]], [str(n) for n in range(1, len(entry["options"]) + 1)])
                    self.assertEqual([o["selected"] for o in menu["options"]].index(True), entry["selected_index"])
                    self.assertEqual(sum(o["selected"] for o in menu["options"]), 1)
                    self.assertEqual(menu["answerable"], entry["name"] != "claude-ask-multi-q2")
                    self.assertEqual(menu["choices"], tuple(o["key"] for o in menu["options"]))
                    self.assertEqual(menu["selected"], menu["options"][entry["selected_index"]]["key"])
                    if menu["kind"] == "permission":
                        self.assertIn(REQUEST[entry["name"]], menu["excerpt"])
                        self.assertEqual(menu["excerpt"].splitlines()[0], FIRST_LINE[entry["name"]])
                        self.assertNotIn("Do you want", menu["excerpt"])
                        self.assertNotIn("Would you like", menu["excerpt"])
                    else:
                        self.assertEqual(menu["excerpt"], "")
                    self.assertIn(menu["question"], menu["identity"])
                    self.assertFalse(self.incomplete(screen))
                    results.append(menu)
            self.assertTrue(all(result == results[0] for result in results), entry["name"])

    def test_the_transcript_above_the_dialog_is_not_part_of_it(self):
        for name, marker in (("claude-bash", "Writing hello-ive"), ("claude-edit-file", "Brewed for"),
                             ("codex-patch", "Conversation interrupted"), ("claude-ask-single", "Interrupted")):
            with self.subTest(fixture=name):
                menu = self.menu(fixture_screen(name))
                self.assertNotIn(marker, menu["identity"])
                self.assertNotIn(marker, menu["excerpt"])

    def test_identity_survives_cursor_moves_and_what_scrolls_above(self):
        for entry in manifest():
            if entry["kind"] not in KIND or entry.get("format"):
                continue
            screen = fixture_screen(entry["name"])
            menu = self.menu(screen)
            with self.subTest(fixture=entry["name"]):
                moved = self.menu(move_cursor(screen, 2))
                self.assertIsNotNone(moved)
                self.assertEqual(moved["identity"], menu["identity"])
                self.assertEqual(moved["selected"], "2")
                self.assertEqual([o["selected"] for o in moved["options"]], [k == "2" for k in moved["choices"]])
                scrolled = self.menu("⏺ Reading files\n✻ Working… (3s)\n" + "\n".join(screen.splitlines()[3:]))
                self.assertEqual(scrolled["identity"], menu["identity"])

    def test_identity_changes_with_the_request(self):
        codex = {name: self.menu(fixture_screen(name))["identity"] for name in ("codex-command", "codex-network", "codex-patch")}
        self.assertEqual(len(set(codex.values())), 3)
        bash = fixture_screen("claude-bash")
        self.assertNotEqual(self.menu(bash)["identity"], self.menu(bash.replace("echo hello-ive", "rm -rf"))["identity"])
        self.assertNotEqual(self.menu(bash)["identity"], self.menu(bash.replace("4. No", "4. No, never"))["identity"])

    def test_codex_labels_keep_their_hotkeys_and_digit_keys(self):
        menu = self.menu(fixture_screen("codex-command"))
        self.assertEqual(menu["options"][0], {"key": "1", "label": "Yes, proceed (y)", "selected": True})
        self.assertEqual(menu["options"][2]["label"], "No, and tell Codex what to do differently (esc)")
        self.assertEqual(menu["excerpt"].splitlines()[0], "Environment: local")

    def test_wrapped_labels_join_descriptions_do_not(self):
        bash = self.menu(fixture_screen("claude-bash"))
        self.assertTrue(bash["options"][1]["label"].endswith("proj-1 from this project"))
        plan = self.menu(fixture_screen("claude-plan-approval"))
        self.assertEqual(plan["options"][2]["label"], "Tell Claude what to change")
        ask = self.menu(fixture_screen("claude-ask-single"))
        self.assertEqual([o["label"] for o in ask["options"]][:3], ["Red", "Green", "Blue"])

    def test_multi_select_is_a_question_but_not_answerable(self):
        menu = self.menu(fixture_screen("claude-ask-multi-q2"))
        self.assertEqual(menu["kind"], "question")
        self.assertFalse(menu["answerable"])
        self.assertEqual(menu["options"][0]["label"], "[ ] S")
        self.assertTrue(self.menu(fixture_screen("claude-ask-multi"))["answerable"])

    def test_negative_fixtures_are_never_a_menu(self):
        blocker = load_startup_blocker()["_detect_cli_startup_blocker"]
        for entry in manifest():
            if entry["kind"] not in {"startup_blocker", "negative", "probe"}:
                continue
            for form, screen in screens_of(entry):
                with self.subTest(fixture=entry["name"], form=form):
                    self.assertIsNone(self.menu(screen))
                    self.assertFalse(self.incomplete(screen))
                    if entry["kind"] == "startup_blocker":
                        self.assertEqual(blocker(entry["cli"], screen)["type"], "trust_required")

    def test_redraw_sample_keeps_one_identity(self):
        sample = json.loads((FIXTURES / "legacy-2.1.299" / "claude-tool-use-redraw.json").read_text())
        menus = [self.menu(sample[key]) for key in ("before", "expected", "after")]
        self.assertTrue(all(menus))
        self.assertEqual(len({m["identity"] for m in menus}), 1)
        self.assertEqual(menus[0]["question"], "Do you want to proceed?")
        self.assertIn("Submit Result Tool", menus[0]["excerpt"])
        self.assertEqual(menus[0]["choices"], ("1", "2", "3"))


class AdversarialTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_parser()
        self.menu = self.ns["_session_permission_menu"]
        self.incomplete = self.ns["_is_incomplete_permission_screen"]

    def test_numbered_list_in_a_reply_is_not_a_menu(self):
        for screen in ("⏺ Two ways forward:\n  1. Yes\n  2. No\n\n❯ ",
                       "⏺ Do you want to proceed?\n  1. Yes\n  2. No",
                       "Bash command\nls\nDo you want to proceed?\n  1. Yes\n  2. No\n\nEsc to cancel",
                       "Here is the plan. Would you like to proceed?\n1. Yes, and use auto mode\n2. No, keep planning"):
            with self.subTest(screen=screen):
                self.assertIsNone(self.menu(screen))

    def test_half_drawn_dialog_is_not_a_menu(self):
        for screen in ("Bash command\nls\nDo you want to proceed?",
                       "Bash command\nls\nDo you want to proceed?\n ❯ 1. Yes",
                       "  Would you like to run the following command?\n\n  $ ls\n\n› 1. Yes, proceed (y)",
                       "Which colour?\n\n❯ 1. Red\n  2. Green"):
            with self.subTest(screen=screen):
                self.assertIsNone(self.menu(screen))

    def test_cropped_dialogs_are_incomplete_and_never_a_menu(self):
        for screen in (MENU[MENU.index("task_id:"):], MENU[MENU.index(" ❯ 1."):],
                       "  Press enter to confirm or esc to cancel",
                       "› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel",
                       "Enter to select · ↑/↓ to navigate · Esc to cancel",
                       "\n".join(fixture_screen("claude-fetch").splitlines()[34:])):
            with self.subTest(screen=screen[-60:]):
                self.assertIsNone(self.menu(screen))
                self.assertTrue(self.incomplete(screen))

    def test_a_dialog_without_its_request_is_not_a_menu(self):
        codex = "Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n"
        self.assertIsNone(self.menu(codex))
        self.assertIsNotNone(self.menu(codex.replace("?\n", "?\n  $ rm -rf build\n")))

    def test_dialog_followed_by_later_output_is_not_a_menu(self):
        for name in ("claude-bash", "claude-fetch", "codex-command", "claude-plan-approval", "claude-ask-single"):
            screen = fixture_screen(name).rstrip("\n")
            for tail in ("\n❯ ", "\n⏺ Ran the command\n  ⎿  done", "\n› Ask Codex to do anything"):
                with self.subTest(fixture=name, tail=tail):
                    self.assertIsNone(self.menu(screen + tail))
        self.assertIsNone(self.menu(MENU + "\n❯ Try something"))
        # Invariant: nothing but the footer below the options. An assistant-echoed
        # dialog with the composer under it is history, not a question, and not cut off.
        echoed = ("⏺ Earlier I asked:\n  Bash command\n  ls\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n\n"
                  "  Esc to cancel · Tab to amend\n\n❯ \n" + "─" * 40 + "\n  ⏸ manual mode on")
        self.assertIsNone(self.menu(echoed))
        self.assertFalse(self.incomplete(echoed))

    def test_two_dialogs_in_scrollback_only_the_live_one_counts(self):
        fetch = "\n".join(fixture_screen("claude-fetch").splitlines()[29:])
        live_menu = self.menu(fetch + "\n\n" + MENU)
        self.assertEqual(live_menu["question"], "Do you want to proceed?")
        self.assertIn("task_id: test-task", live_menu["excerpt"])
        self.assertNotIn("example.com", live_menu["identity"])
        live_fetch = self.menu(MENU + "\n\n" + fetch)
        self.assertEqual(live_fetch["question"], "Do you want to allow Claude to fetch this content?")
        self.assertNotIn("task_id", live_fetch["identity"])
        self.assertEqual(live_fetch["choices"], ("1", "2", "3"))

    def test_an_earlier_dialog_never_lends_its_header(self):
        fetch = "\n".join(fixture_screen("claude-fetch").splitlines()[29:])
        cropped = MENU[MENU.index("task_id:"):]
        self.assertIsNone(self.menu(fetch + "\n\n" + cropped))
        self.assertTrue(self.incomplete(fetch + "\n\n" + cropped))

    def test_cursor_rules(self):
        self.assertIsNotNone(self.menu(MENU.replace(" ❯ ", " ❯ ")))
        self.assertIsNone(self.menu(MENU.replace("   3. No", " ❯ 3. No")))
        self.assertIsNone(self.menu(MENU.replace(" ❯ 1.", "   1.")))
        self.assertIsNone(self.menu(MENU.replace(" ❯ 1.", " > 1.")))

    def test_yes_first_no_last(self):
        for change in (("1. Yes", "1. Allow"), ("3. No", "3. Cancel"), ("3. No", "3. Nothing else")):
            with self.subTest(change=change):
                self.assertIsNone(self.menu(MENU.replace(*change)))
        self.assertEqual(self.menu(MENU.replace("3. No", "3. No, and tell Claude what to do differently (esc)"))["choices"], ("1", "2", "3"))

    def test_plan_approval_forms(self):
        older = ("   Would you like to proceed?\n\n   ❯ 1. Yes, and auto-accept edits\n     2. Yes, manually approve edits\n"
                 "     3. No, keep planning\n\n   Esc to cancel")
        menu = self.menu(older)
        self.assertEqual((menu["kind"], menu["question"]), ("plan", "Would you like to proceed?"))
        self.assertEqual([o["label"] for o in menu["options"]], ["Yes, and auto-accept edits", "Yes, manually approve edits", "No, keep planning"])
        current = fixture_screen("claude-plan-approval")
        self.assertEqual(self.menu(current)["kind"], "plan")
        self.assertIsNone(self.menu(current.replace("Would you like to proceed?", "Shall we?")))
        self.assertIsNone(self.menu(current.replace("Tell Claude what to change", "Something else").replace("use auto mode", "go")))

    def test_ask_user_question_needs_its_frame(self):
        form = "Which framework should the tests use?\n\n❯ 1. pytest\n  2. unittest\n\nEnter to select · Esc to cancel"
        self.assertIsNone(self.menu(form))
        framed = form.replace("  2. unittest\n", "  2. unittest\n  3. Type something.\n  4. Chat about this\n")
        menu = self.menu(framed)
        self.assertEqual((menu["kind"], menu["question"], menu["answerable"]), ("question", "Which framework should the tests use?", True))
        self.assertEqual([o["label"] for o in menu["options"]], ["pytest", "unittest", "Type something.", "Chat about this"])
        self.assertIsNone(self.menu(framed.replace("Enter to select · Esc to cancel", "Esc to cancel")))
        wrapped = framed.replace("Which framework should the tests use?", "Which framework should the tests use,\ngiven the repo already has fixtures?")
        self.assertEqual(self.menu(wrapped)["question"], "Which framework should the tests use, given the repo already has fixtures?")

    def test_pickers_and_trust_are_never_menus(self):
        for name in ("claude-model-picker", "claude-permissions", "codex-model-picker", "claude-trust", "codex-trust"):
            with self.subTest(fixture=name):
                self.assertIsNone(self.menu(fixture_screen(name)))

    def test_crlf_and_trailing_blank_rows_are_tolerated(self):
        screen = fixture_screen("codex-command")
        self.assertEqual(self.menu(screen.replace("\n", "\r\n")), self.menu(screen))
        self.assertEqual(self.menu(screen.rstrip("\n") + "\n" * 12), self.menu(screen))

    def test_hook_confirmation_header_names_the_tool(self):
        hooked = ("ToolSearch\n│ Hook PreToolUse:ToolSearch requires confirmation for this tool:\n│ missing API key (fail-closed)\n"
                  + MENU.split("\n", 2)[2])
        menu = self.menu(hooked)
        self.assertEqual(menu["kind"], "permission")
        self.assertEqual(menu["excerpt"].splitlines()[0], "ToolSearch")
        self.assertIn("missing API key", menu["excerpt"])
        self.assertIsNone(self.menu(hooked.replace("PreToolUse:ToolSearch", "PreToolUse:Read")))

    def test_unknown_header_right_under_the_top_rule_counts(self):
        screen = ("─" * 120 + "\n Kill shell\n shell-3\n╌" * 1 + "╌" * 119 + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend")
        menu = self.menu(screen)
        self.assertIsNotNone(menu)
        self.assertEqual(menu["excerpt"], "Kill shell\nshell-3")
        self.assertIsNone(self.menu(screen.replace("─" * 120 + "\n", "")))


if __name__ == "__main__":
    unittest.main()
