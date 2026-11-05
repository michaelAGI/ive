"""Removing a source build must leave the hooks of another IVE, such as the Mac app.

Fully isolated: IVE_DATA_DIR and HOME point at a temp dir before any backend import.
"""
import json
import os
import shlex
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_TMP = tempfile.TemporaryDirectory()
_ROOT = Path(_TMP.name)
os.environ["IVE_DATA_DIR"] = str(_ROOT / "state" / ".ive-team-state")
os.environ["HOME"] = str(_ROOT / "home")
(_ROOT / "home").mkdir(parents=True, exist_ok=True)

import hook_installer as hi  # noqa: E402

APP_HOOKS = _ROOT / "home/Library/Application Support/com.ive.desktop/hooks"
APP_HOOKS.mkdir(parents=True)
(APP_HOOKS / "safety_gate.sh").write_text("#!/bin/sh\n")
hi.HOOKS_DIR.mkdir(parents=True, exist_ok=True)
(hi.HOOKS_DIR / "safety_gate.sh").write_text("#!/bin/sh\n")


def _command(folder: Path, name: str = "safety_gate.sh") -> str:
    return shlex.quote(str(folder / name))


def _toml_block(owner: str, folder: Path) -> str:
    return hi._render_toml_hook_block(owner, {"PreToolUse": [
        {"hooks": [{"type": "command", "command": _command(folder)}]},
    ]})


class UninstallScopeTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_ROOT))
        self.claude = self.dir / "claude.json"
        self.gemini = self.dir / "gemini.json"
        self.codex = self.dir / "config.toml"
        for name, value in (("CLAUDE_SETTINGS", self.claude), ("GEMINI_SETTINGS", self.gemini), ("CODEX_SETTINGS", self.codex)):
            patcher = patch.object(hi, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings = {"hooks": {"PreToolUse": [
            {"matcher": "", "hooks": [{"type": "command", "command": _command(hi.HOOKS_DIR)}]},
            {"matcher": "", "hooks": [{"type": "command", "command": _command(APP_HOOKS)}]},
            {"matcher": "", "hooks": [{"type": "command", "command": "/my/own/hook.sh"}]},
        ]}}
        for path in (self.claude, self.gemini):
            path.write_text(json.dumps(settings))

    def commands(self, path: Path) -> list[str]:
        groups = json.loads(path.read_text()).get("hooks", {}).get("PreToolUse", [])
        return [hook["command"] for group in groups for hook in group["hooks"]]

    def test_only_this_install_keeps_the_other_gate_and_the_users_hook(self):
        hi.uninstall_safety_gate_hooks(only_this_install=True)
        for path in (self.claude, self.gemini):
            self.assertEqual(self.commands(path), [_command(APP_HOOKS), "/my/own/hook.sh"])

    def test_default_still_removes_every_gate(self):
        hi.uninstall_safety_gate_hooks()
        for path in (self.claude, self.gemini):
            self.assertEqual(self.commands(path), ["/my/own/hook.sh"])

    def test_codex_block_of_another_install_stays(self):
        block = _toml_block(hi._CODEX_SAFETY_HOOK_OWNER, APP_HOOKS)
        self.codex.write_text(block)
        hi.uninstall_safety_gate_hooks(only_this_install=True)
        self.assertEqual(self.codex.read_text(), block)

    def test_codex_block_of_this_install_goes(self):
        self.codex.write_text(_toml_block(hi._CODEX_SAFETY_HOOK_OWNER, hi.HOOKS_DIR))
        hi.uninstall_safety_gate_hooks(only_this_install=True)
        self.assertNotIn("safety_gate", self.codex.read_text())

    def test_codex_block_with_a_non_ascii_or_quoted_path_is_recognised(self):
        for name in ("Übung", "Max's folder"):
            other = _ROOT / name / "hooks"
            other.mkdir(parents=True)
            (other / "safety_gate.sh").write_text("#!/bin/sh\n")
            block = _toml_block(hi._CODEX_SAFETY_HOOK_OWNER, other)
            self.assertTrue(hi._toml_block_of_another_install(block, hi._CODEX_SAFETY_HOOK_OWNER), name)
            with patch.object(hi, "HOOKS_DIR", other):
                self.assertFalse(hi._toml_block_of_another_install(block, hi._CODEX_SAFETY_HOOK_OWNER), name)

    def test_a_script_that_no_longer_exists_is_removed(self):
        gone = _ROOT / "moved-away" / "hooks"
        self.claude.write_text(json.dumps({"hooks": {"PreToolUse": [
            {"matcher": "", "hooks": [{"type": "command", "command": _command(gone)}]},
        ]}}))
        hi.uninstall_safety_gate_hooks(only_this_install=True)
        self.assertEqual(self.commands(self.claude), [])
        self.codex.write_text(_toml_block(hi._CODEX_SAFETY_HOOK_OWNER, gone))
        hi.uninstall_safety_gate_hooks(only_this_install=True)
        self.assertNotIn("safety_gate", self.codex.read_text())

    def test_a_symlinked_hooks_folder_counts_as_this_install(self):
        link = _ROOT / "link-to-state"
        link.symlink_to(hi.HOOKS_DIR)
        self.assertFalse(hi._hook_of_another_install(_command(link)))


if __name__ == "__main__":
    unittest.main()
