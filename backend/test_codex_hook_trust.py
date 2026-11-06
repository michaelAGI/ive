"""Codex 0.16x hook trust: IVE keeps its own config.toml hooks trusted, stable
and honestly attested, and never overrides a Codex-side `enabled = false`.

Fully isolated: IVE_DATA_DIR and HOME point at a temp dir before any backend
import; every config.toml lives in that temp dir. Never touches ~/.codex.
"""
import json
import os
import stat
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

_TMP = tempfile.TemporaryDirectory()
_ROOT = Path(_TMP.name)
os.environ["IVE_DATA_DIR"] = str(_ROOT / "state" / ".ive-team-state")
os.environ["HOME"] = str(_ROOT / "home")
(_ROOT / "home").mkdir(parents=True, exist_ok=True)

import hook_installer as hi  # noqa: E402
from cli_profiles import get_profile  # noqa: E402

_HOOKS_DIR = _ROOT / "state" / ".ive-team-state" / "hooks"
RELAY = str(_HOOKS_DIR / hi.HOOK_SCRIPT_NAME)
GATE = _HOOKS_DIR / "safety_gate.sh"
GATE_POST = _HOOKS_DIR / "safety_gate_post.sh"

USER_HOOKS = """model = "gpt-6-astra"

[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "/Users/someone/bin/audit.sh"
"""


def _relay_groups():
    profile = get_profile("codex")
    return {
        event: [{"matcher": "", "hooks": [{"type": "command", "command": RELAY}]}]
        for event in hi.relay_hook_events(profile)
    }


def _gate_groups():
    return {
        "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": str(GATE), "timeout": 135}]}],
        "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": str(GATE_POST), "timeout": 2}]}],
    }


def _myelin_groups():
    return {
        "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "/py /m/hook.py --event user_prompt"}]}],
        "PreToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "/py /m/hook.py --event pre_tool"}]}],
    }


def _states(path):
    return tomllib.loads(path.read_text()).get("hooks", {}).get("state", {})


class CodexHashTests(unittest.TestCase):
    # Same algorithm codex-cli 0.162.1 uses after /hooks review; the values were
    # first checked against hashes codex wrote itself, then recomputed for this path.
    P = "/Users/dev/ive/.ive-team-state/hooks/"

    def test_matches_codex_written_hashes(self):
        cases = [
            ("SessionStart", "", "hook.sh", None, "fc3acb23ec7a8dae97bce5df851f7668c9835003fcd66c92428d941b5722a266"),
            ("SessionEnd", "", "hook.sh", None, "268fec82e63e5400fab6ffdb6172b2e1bcc0479669b3d1c4c64a43f34204eca1"),
            ("Stop", "", "hook.sh", None, "f7a21e2a264ba3de6fdb0b1205e6591decda32f3f4853a2bd0db004f85f4b760"),
            ("UserPromptSubmit", "", "hook.sh", None, "2f0297a56fe38fac2a58712329f19ebdb1af2997d7c17a89299f25ba450d948d"),
            ("PreToolUse", "", "safety_gate.sh", 135, "8921c6d791737992329fcc3e1e624f947240adb63947670289f96bed0c1837f9"),
            ("PreToolUse", "", "hook.sh", None, "80ccbf17f4bb4c3923e3e675243ffbba4db2818f786c2979e2df685da8f72c20"),
            ("PostToolUse", "", "safety_gate_post.sh", 2, "75e021a0006e47a36b3b1363c3a8d1d53182003a29c2da89a032e5fb474665d5"),
            ("PermissionRequest", "", "hook.sh", None, "c190d74630b35e5aa857b06dfb0a2b9fb1b466ce78a79d7d9db2f9fb2df34453"),
            ("SubagentStop", "", "hook.sh", None, "386efc7228ca23d52ad0fb3d2ed1938e0fd2921466bcc8703eecf1d404ae60dd"),
        ]
        for event, matcher, script, timeout, expected in cases:
            handler = {"type": "command", "command": self.P + script}
            if timeout is not None:
                handler["timeout"] = timeout
            with self.subTest(event=event, script=script):
                self.assertEqual(
                    hi.codex_hook_hash(event, {"matcher": matcher}, handler),
                    "sha256:" + expected,
                )


class CodexTrustInstallTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_ROOT))
        self.codex_home = self.dir / ".codex"
        self.codex_home.mkdir()
        self.path = self.codex_home / "config.toml"
        self.key = str(self.codex_home.resolve()) + "/config.toml"

    def install_all_blocks(self):
        hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, _gate_groups())
        return hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())

    def test_trusts_only_ive_handlers(self):
        self.path.write_text(USER_HOOKS)
        report = self.install_all_blocks()
        self.assertTrue(report["all_ive_trusted"], report)
        states = _states(self.path)
        # User hook keeps index 0 and is NOT trusted by IVE.
        self.assertNotIn(f"{self.key}:pre_tool_use:0:0", states)
        self.assertIn(f"{self.key}:pre_tool_use:1:0", states)  # safety gate
        self.assertIn(f"{self.key}:pre_tool_use:2:0", states)  # relay
        user = [e for e in report["hooks"] if e["owner"] is None]
        self.assertEqual([e["status"] for e in user], ["untrusted"])
        self.assertIsNone(hi.codex_hooks_notice(report))
        self.assertTrue(tomllib.loads(self.path.read_text())["model"] == "gpt-6-astra")

    def test_reinstall_is_byte_identical(self):
        self.path.write_text(USER_HOOKS)
        self.install_all_blocks()
        before = self.path.read_bytes()
        mtime = self.path.stat().st_mtime_ns
        report = self.install_all_blocks()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, mtime)
        self.assertEqual(report["auto_trusted"], 0)
        self.assertTrue(report["all_ive_trusted"])

    def test_codex_state_tables_inside_ive_block_survive(self):
        # Exactly what codex 0.162 did: it appended trust tables before the
        # trailing "<<< commander-relay" comment, i.e. inside IVE's block.
        self.path.write_text(USER_HOOKS)
        self.install_all_blocks()
        text = self.path.read_text()
        user_key = f"{self.key}:pre_tool_use:0:0"
        end = hi._toml_hook_marker(hi._CODEX_COMMANDER_HOOK_OWNER, end=True)
        # Move IVE's own trust tables inside the block too, and add the user's.
        block_end = text.index(end)
        tail = text[block_end + len(end):]
        text = text[:block_end] + tail.strip() + "\n\n" + hi._state_header(user_key) + '\ntrusted_hash = "sha256:userhash"\n' + end + "\n"
        self.path.write_text(text)
        tomllib.loads(text)
        report = self.install_all_blocks()
        states = _states(self.path)
        self.assertEqual(states[user_key]["trusted_hash"], "sha256:userhash")
        self.assertTrue(report["all_ive_trusted"], report)
        before = self.path.read_bytes()
        self.install_all_blocks()
        self.assertEqual(self.path.read_bytes(), before)
        # Uninstall keeps codex's trust tables as well.
        hi._uninstall_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER)
        self.assertEqual(_states(self.path)[user_key]["trusted_hash"], "sha256:userhash")

    def test_toggling_myelin_does_not_shift_relay_or_gate(self):
        self.install_all_blocks()
        keys = {e["key"] for e in hi.codex_hook_trust_report(self.path)["hooks"]
                if e["owner"] in (hi._CODEX_COMMANDER_HOOK_OWNER, hi._CODEX_SAFETY_HOOK_OWNER)}
        hi._install_toml_hook_block(self.path, hi._CODEX_MYELIN_HOOK_OWNER, _myelin_groups())
        report = self.install_all_blocks()
        self.assertTrue(report["all_ive_trusted"], report)
        after = {e["key"] for e in report["hooks"]
                 if e["owner"] in (hi._CODEX_COMMANDER_HOOK_OWNER, hi._CODEX_SAFETY_HOOK_OWNER)}
        self.assertEqual(keys, after)
        hi._uninstall_toml_hook_block(self.path, hi._CODEX_MYELIN_HOOK_OWNER)
        self.assertTrue(hi.codex_hook_trust_report(self.path)["all_ive_trusted"])

    def test_changed_handler_updates_existing_state_in_place(self):
        self.install_all_blocks()
        groups = _gate_groups()
        groups["PreToolUse"][0]["hooks"][0]["timeout"] = 140
        report = hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, groups)
        self.assertTrue(report["all_ive_trusted"], report)
        text = self.path.read_text()
        header = hi._state_header(f"{self.key}:pre_tool_use:0:0")
        self.assertEqual(text.count(header), 1)
        self.assertEqual(
            _states(self.path)[f"{self.key}:pre_tool_use:0:0"]["trusted_hash"],
            hi.codex_hook_hash("PreToolUse", groups["PreToolUse"][0], groups["PreToolUse"][0]["hooks"][0]),
        )

    def test_disabled_ive_hook_stays_off_but_gets_a_fresh_hash(self):
        # Codex's /hooks browser and the desktop app write `enabled = false`.
        # IVE never flips it back; it only keeps the hash current so switching
        # the handler on in Codex needs no new review.
        self.install_all_blocks()
        key = f"{self.key}:stop:0:0"
        text = self.path.read_text().replace(
            hi._state_header(key) + "\n", hi._state_header(key) + "\nenabled = false\n"
        )
        self.path.write_text(text)
        before = self.path.read_bytes()
        report = hi.codex_hook_trust_report(self.path, fix=True)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(report["all_ive_trusted"])
        self.assertEqual((report["reason"], report["auto_trusted"]), ("disabled", 0))
        self.assertEqual([(e["event"], e["status"]) for e in report["ive_untrusted"]], [("Stop", "disabled")])
        self.assertIs(_states(self.path)[key]["enabled"], False)
        with patch.object(hi, "codex_cli_version", lambda *a, **k: (0, 164, 0)):
            notice = hi.codex_hooks_notice(report)
        self.assertIn("switched off in Codex (Stop)", notice)
        self.assertIn("/hooks", notice)
        self.assertIn("Space toggles a handler", notice)
        self.assertNotIn("enabled = true", self.path.read_text())
        # The handler changes: the hash is refreshed in place, enabled stays false.
        groups = _relay_groups()
        groups["Stop"][0]["hooks"][0]["timeout"] = 42
        report = hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, groups)
        self.assertEqual(report["reason"], "disabled")
        self.assertEqual(report["auto_trusted"], 1)
        state = _states(self.path)[key]
        self.assertIs(state["enabled"], False)
        self.assertEqual(state["trusted_hash"], hi.codex_hook_hash("Stop", groups["Stop"][0], groups["Stop"][0]["hooks"][0]))
        self.assertEqual(self.path.read_text().count(hi._state_header(key)), 1)
        # Switched on again in Codex: trusted without any further write.
        self.path.write_text(self.path.read_text().replace("enabled = false\n", "enabled = true\n"))
        before = self.path.read_bytes()
        report = hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, groups)
        self.assertTrue(report["all_ive_trusted"], report)
        self.assertEqual(self.path.read_bytes(), before)

    def test_report_only_disabled_hook_has_its_own_reason(self):
        self.install_all_blocks()
        key = f"{self.key}:session_start:0:0"
        self.path.write_text(self.path.read_text().replace(
            hi._state_header(key) + "\n", hi._state_header(key) + "\nenabled = false\n"
        ))
        report = hi.codex_hook_trust_report(self.path)
        self.assertEqual(report["reason"], "disabled")
        self.assertEqual(_states(self.path)[key]["enabled"], False)
        with patch.object(hi, "codex_cli_version", lambda *a, **k: None):
            self.assertIn("switched off in Codex (SessionStart)", hi.codex_hooks_notice(report))

    def test_codex_rewritten_hash_for_unchanged_handler_is_accepted(self):
        # A future codex may hash differently and rewrite trusted_hash after
        # the user trusts in /hooks. IVE must not fight it for a handler it
        # has not changed, but must still re-trust a handler it did change.
        self.install_all_blocks()
        key = f"{self.key}:session_start:0:0"
        text = self.path.read_text()
        old_hash = _states(self.path)[key]["trusted_hash"]
        text = text.replace(f'trusted_hash = "{old_hash}"', 'trusted_hash = "sha256:codex-next"')
        self.path.write_text(text)
        before = self.path.read_bytes()
        report = self.install_all_blocks()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(report["all_ive_trusted"], report)
        groups = _relay_groups()
        groups["SessionStart"][0]["hooks"][0]["timeout"] = 7
        report = hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, groups)
        self.assertTrue(report["all_ive_trusted"], report)
        self.assertEqual(
            _states(self.path)[key]["trusted_hash"],
            hi.codex_hook_hash("SessionStart", groups["SessionStart"][0], groups["SessionStart"][0]["hooks"][0]),
        )

    def test_auto_trust_off_reports_review_notice(self):
        with patch.dict(os.environ, {"IVE_CODEX_AUTO_TRUST_HOOKS": "0"}):
            report = self.install_all_blocks()
        self.assertFalse(report["all_ive_trusted"])
        self.assertEqual(_states(self.path), {})
        self.assertEqual(report["reason"], "auto_trust_off")
        with patch.object(hi, "codex_cli_version", lambda *a, **k: (0, 164, 0)):
            notice = hi.codex_hooks_notice(report)
        self.assertIn("/hooks", notice)
        self.assertIn("need review", notice)
        self.assertIn("IVE_CODEX_AUTO_TRUST_HOOKS", notice)

    def test_account_codex_home_behind_symlink_uses_canonical_key(self):
        real = self.dir / "real-account"
        (real / ".codex").mkdir(parents=True)
        link = self.dir / "account-link"
        link.symlink_to(real)
        path = link / ".codex" / "config.toml"
        hi._install_toml_hook_block(path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())
        states = _states(path)
        canonical = str((real / ".codex").resolve()) + "/config.toml"
        self.assertIn(f"{canonical}:session_start:0:0", states)

    def test_unindexable_layout_is_not_trusted(self):
        self.path.write_text(
            'model = "x"\n\n[hooks]\nStop = [{ matcher = "", hooks = [{ type = "command", command = "/u.sh" }] }]\n'
        )
        before = self.path.read_text()
        report = hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())
        self.assertFalse(report["all_ive_trusted"])
        self.assertEqual(report["reason"], "hook_block_conflict")
        self.assertEqual(self.path.read_text(), before)  # never write a config codex rejects
        with patch.object(hi, "codex_cli_version", lambda *a, **k: None):
            notice = hi.codex_hooks_notice(report)
        self.assertIn("declares hooks inline", notice)
        self.assertIn("[[hooks.<Event>]]", notice)
        self.assertTrue(report["steps"])

    def test_inline_user_hooks_in_other_events_do_not_block_trust(self):
        # Inline user hooks for an event IVE does not use: that event cannot
        # be indexed, but IVE's own positions are still exact.
        self.path.write_text('[hooks]\nInterrupt = [{ hooks = [{ type = "command", command = "/u.sh" }] }]\n')
        report = hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())
        tomllib.loads(self.path.read_text())
        self.assertTrue(report["all_ive_trusted"], report)
        self.assertFalse(any(e["event"] == "Interrupt" for e in report["hooks"]))


class CodexSafetyGateAttestationTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=_ROOT))
        self.codex_home = self.home / ".codex"
        self.codex_home.mkdir()
        self.path = self.codex_home / "config.toml"
        _HOOKS_DIR.mkdir(parents=True, exist_ok=True)
        self.patches = [
            patch.object(hi, "SAFETY_GATE_SCRIPT_PATH", GATE),
            patch.object(hi, "SAFETY_GATE_POST_SCRIPT_PATH", GATE_POST),
            patch.object(hi, "HOOKS_DIR", _HOOKS_DIR),
        ]
        for p in self.patches:
            p.start()
        hi.generate_safety_gate_script()
        self.env = {"HOME": str(self.home), "CODEX_HOME": str(self.codex_home)}

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_untrusted_gate_is_not_attested(self):
        with patch.dict(os.environ, {"IVE_CODEX_AUTO_TRUST_HOOKS": "0"}):
            hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, _gate_groups())
        evidence = hi.attest_runtime_safety_gate("codex", self.env)
        self.assertFalse(evidence["attested"])
        self.assertEqual(evidence["reason"], "codex_hook_untrusted")
        self.assertEqual(evidence["hook_trust"]["gate"][0]["status"], "untrusted")

    def test_trusted_gate_is_attested(self):
        hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, _gate_groups())
        evidence = hi.attest_runtime_safety_gate("codex", self.env)
        self.assertTrue(evidence["attested"], evidence)
        self.assertEqual(evidence["hook_trust"]["gate"][0]["status"], "trusted")



def _hook_cmd(path):
    return f"'{path}'"  # IVE quotes paths with spaces exactly like this


class Codex0164StateFileTests(unittest.TestCase):
    """Fixture shaped like the config.toml codex-cli 0.164.0 leaves behind after
    its /hooks browser or the desktop app touched IVE's hooks: a bare [hooks]
    header, [hooks.state], one record per handler with `trusted_hash` and
    `enabled`, a hooks.json record without `enabled`, and IVE's marker blocks
    after all of that. Hashes are computed, paths are fake."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_ROOT))
        self.codex_home = self.dir / ".codex"
        self.codex_home.mkdir()
        self.path = self.codex_home / "config.toml"
        self.key = str(self.codex_home.resolve()) + "/config.toml"
        hooks = self.dir / "Application Support" / "com.ive.desktop" / "hooks"
        self.gate = {
            "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": _hook_cmd(hooks / "safety_gate.sh"), "timeout": 135}]}],
            "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": _hook_cmd(hooks / "safety_gate_post.sh"), "timeout": 2}]}],
        }
        self.relay = {
            event: [{"matcher": "", "hooks": [{"type": "command", "command": _hook_cmd(hooks / "hook.sh")}]}]
            for event in hi.relay_hook_events(get_profile("codex"))
        }
        self.memory_dir = self.dir / "ive-hooks"
        self.patcher = patch.object(hi, "HOOKS_DIR", self.memory_dir)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def _hash(self, event, groups):
        return hi.codex_hook_hash(event, groups[event][0], groups[event][0]["hooks"][0])

    def _write_fixture(self):
        gate_index = {"PreToolUse": 0, "PostToolUse": 0}
        relay_index = {"PreToolUse": 1, "PostToolUse": 1}
        records = []
        for event, groups, index in (
            ("PreToolUse", self.gate, gate_index), ("PostToolUse", self.gate, gate_index),
            *((e, self.relay, relay_index) for e in self.relay),
        ):
            label = hi._CODEX_EVENT_LABELS[event]
            key = f"{self.key}:{label}:{index.get(event, 0)}:0"
            digest = "sha256:0000stale" if (event, groups is self.gate) == ("PreToolUse", True) else self._hash(event, groups)
            extra = 'trusted_content_hash = "sha256:keepme"\n' if event == "SessionStart" else ""
            records.append(f'[hooks.state."{key}"]\ntrusted_hash = "{digest}"\nenabled = false\n{extra}')
        records.append(f'[hooks.state."{self.key}:pre_tool_use:2:0"]\nenabled = false\ntrusted_hash = "sha256:userhash"\n')
        records.append(f'[hooks.state."{self.codex_home.resolve()}/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:ecfd1f1b"\n')
        user_block = '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/Users/someone/bin/audit.sh"\n'
        text = (
            'model = "gpt-6-astra"\n\n[features]\nhooks = true\n\n[hooks]\n' + "\n" * 6 + "[hooks.state]\n\n"
            + "\n".join(records) + "\n"
            + hi._render_toml_hook_block(hi._CODEX_SAFETY_HOOK_OWNER, self.gate) + "\n"
            + hi._render_toml_hook_block(hi._CODEX_COMMANDER_HOOK_OWNER, self.relay) + "\n"
            + user_block
        )
        tomllib.loads(text)
        self.path.write_text(text)
        return text

    def test_report_only_sees_trusted_but_disabled_handlers(self):
        self._write_fixture()
        report = hi.codex_hook_trust_report(self.path)
        self.assertEqual(report["ive_total"], 13)
        self.assertEqual(report["ive_trusted"], 0)
        self.assertEqual(report["reason"], "disabled")
        self.assertEqual({e["status"] for e in report["hooks"] if e["owner"]}, {"disabled"})
        stale = next(e for e in report["hooks"] if e["owner"] == hi._CODEX_SAFETY_HOOK_OWNER and e["event"] == "PreToolUse")
        self.assertFalse(stale["hash_ok"])
        self.assertTrue(all(e["hash_ok"] for e in report["hooks"] if e["owner"] and e is not stale))
        user = next(e for e in report["hooks"] if e["owner"] is None)
        self.assertEqual((user["status"], user["key"]), ("disabled", f"{self.key}:pre_tool_use:2:0"))

    def test_fix_refreshes_hashes_in_place_and_leaves_enabled_alone(self):
        before = self._write_fixture()
        report = hi.codex_hook_trust_report(self.path, fix=True)
        self.assertFalse(report["all_ive_trusted"])
        self.assertEqual((report["reason"], report["auto_trusted"]), ("disabled", 1))
        self.assertEqual(len(report["ive_untrusted"]), 13)
        self.assertTrue(all(e["status"] == "disabled" and e["hash_ok"] for e in report["ive_untrusted"]))
        after = self.path.read_text()
        tomllib.loads(after)
        states = _states(self.path)
        for entry in report["hooks"]:
            if entry["owner"] is None:
                continue
            self.assertIs(states[entry["key"]]["enabled"], False, entry["key"])
            self.assertEqual(states[entry["key"]]["trusted_hash"], entry["hash"])
            self.assertEqual(after.count(hi._state_header(entry["key"])), 1)
        self.assertEqual(states[f"{self.key}:session_start:0:0"]["trusted_content_hash"], "sha256:keepme")
        self.assertEqual(states[f"{self.key}:pre_tool_use:2:0"], {"enabled": False, "trusted_hash": "sha256:userhash"})
        self.assertEqual(states[f"{self.codex_home.resolve()}/hooks.json:session_start:0:0"], {"trusted_hash": "sha256:ecfd1f1b"})
        changed = [(a, b) for a, b in zip(before.splitlines(), after.splitlines()) if a != b]
        self.assertEqual(len(before.splitlines()), len(after.splitlines()))
        self.assertEqual(changed, [('trusted_hash = "sha256:0000stale"', f'trusted_hash = "{self._hash("PreToolUse", self.gate)}"')])
        self.assertIn("[hooks]\n", after)
        self.assertIn("[hooks.state]\n", after)
        memory = json.loads((self.memory_dir / hi._CODEX_TRUST_MEMORY_NAME).read_text())["handlers"]
        self.assertEqual(memory, {f"{self.key}:pre_tool_use:0:0": self._hash("PreToolUse", self.gate)})
        with patch.object(hi, "codex_cli_version", lambda *a, **k: (0, 164, 0)):
            notice = hi.codex_hooks_notice(report)
        self.assertTrue(notice.startswith("13 IVE Codex hook(s) are switched off in Codex ("), notice)
        self.assertIn("/hooks", notice)
        # Idempotent: nothing left to do, nothing rewritten.
        mtime = self.path.stat().st_mtime_ns
        again = hi.codex_hook_trust_report(self.path, fix=True)
        self.assertEqual((again["auto_trusted"], again["reason"]), (0, "disabled"))
        self.assertEqual(self.path.read_text(), after)
        self.assertEqual(self.path.stat().st_mtime_ns, mtime)
        # Switched on in Codex: every IVE handler is trusted, no write needed.
        self.path.write_text(after.replace("enabled = false", "enabled = true"))
        switched = self.path.read_bytes()
        report = hi.codex_hook_trust_report(self.path, fix=True)
        self.assertTrue(report["all_ive_trusted"], report)
        self.assertEqual(self.path.read_bytes(), switched)
        self.assertIsNone(hi.codex_hooks_notice(report))


class CodexNoticeTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_ROOT))
        self.path = self.dir / ".codex" / "config.toml"
        self.path.parent.mkdir()

    def test_unreadable_config_names_the_file_and_codex_doctor(self):
        self.path.write_text('[hooks\nbroken = ')
        report = hi.codex_hook_trust_report(self.path, fix=True)
        self.assertEqual(report["reason"], "config_unreadable")
        with patch.object(hi, "codex_cli_version", lambda *a, **k: (0, 164, 0)):
            notice = hi.codex_hooks_notice(report)
        self.assertIn(f"cannot read the Codex hooks in {self.path}", notice)
        self.assertIn("codex doctor", notice)
        self.assertTrue(report["steps"])

    def test_missing_ive_hooks_are_reported(self):
        self.path.write_text('model = "x"\n')
        report = hi.codex_hook_trust_report(self.path, fix=True)
        self.assertEqual(report["reason"], "no_ive_hooks")
        with patch.object(hi, "codex_cli_version", lambda *a, **k: None):
            self.assertIn("missing from", hi.codex_hooks_notice(report))

    def test_version_note_only_outside_verified_range(self):
        report = {"all_ive_trusted": False, "reason": "needs_review", "path": "/c.toml",
                  "ive_untrusted": [{"event": "Stop", "status": "untrusted"}]}
        with patch.object(hi, "codex_cli_version", lambda *a, **k: (0, 160, 0)):
            self.assertIn("older than the versions IVE verified", hi.codex_hooks_notice(report))
        with patch.object(hi, "codex_cli_version", lambda *a, **k: (0, 170, 1)):
            self.assertIn("newer than IVE verified", hi.codex_hooks_notice(report))
        with patch.object(hi, "codex_cli_version", lambda *a, **k: (0, 163, 0)):
            notice = hi.codex_hooks_notice(report)
        self.assertNotIn("verified", notice)
        self.assertTrue(notice.startswith("1 IVE Codex hook(s) need review, so "))
        self.assertIn("Run /hooks in Codex and trust the IVE hooks (/c.toml).", notice)

    def test_codex_cli_version_reads_binary_and_caches_per_mtime(self):
        fake = self.dir / "codex"
        fake.write_text('#!/bin/sh\necho "codex-cli 0.164.0"\n')
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        os.utime(fake, ns=(1_000_000_000_000_000_000, 1_000_000_000_000_000_000))
        self.assertEqual(hi.codex_cli_version(str(fake)), (0, 164, 0))
        fake.write_text('#!/bin/sh\necho "codex-cli 0.165.0"\n')
        os.utime(fake, ns=(1_000_000_000_000_000_000, 1_000_000_000_000_000_000))
        self.assertEqual(hi.codex_cli_version(str(fake)), (0, 164, 0))  # same mtime, cached
        os.utime(fake, ns=(1_000_000_001_000_000_000, 1_000_000_001_000_000_000))
        self.assertEqual(hi.codex_cli_version(str(fake)), (0, 165, 0))
        self.assertIsNone(hi.codex_cli_version(str(self.dir / "missing")))


class CodexEventRulesTests(unittest.TestCase):
    def test_matcher_ignored_for_the_same_events_as_codex_0164(self):
        handler = {"type": "command", "command": "/h.sh"}
        for event in ("PreModelRequest", "PostModelRequest", "UserPromptSubmit", "Stop", "Interrupt"):
            self.assertEqual(
                hi.codex_hook_hash(event, {"matcher": "^x"}, handler),
                hi.codex_hook_hash(event, {}, handler), event,
            )
        self.assertNotEqual(
            hi.codex_hook_hash("PreToolUse", {"matcher": "Bash"}, handler),
            hi.codex_hook_hash("PreToolUse", {}, handler),
        )
        self.assertEqual(hi._CODEX_EVENT_LABELS["PreModelRequest"], "pre_model_request")


if __name__ == "__main__":
    unittest.main()
