"""Workspace git + demo routes are mode-guarded like the file preview.

Brief joiners must not read diffs/logs or start demo commands. Builds the
real route table with create_app() (no server start) in an isolated HOME.
The session_id tests run git against temporary repositories only.
"""
import asyncio
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

from aiohttp.test_utils import make_mocked_request  # noqa: E402

import db as database  # noqa: E402
import demo_runner  # noqa: E402
import server  # noqa: E402
from auth_context import AuthContext  # noqa: E402

GUARDED = {
    ("GET", "/api/workspaces/{id}/git/status"),
    ("GET", "/api/workspaces/{id}/git/diff"),
    ("GET", "/api/workspaces/{id}/git/log"),
    ("POST", "/api/workspaces/{id}/git/stage"),
    ("POST", "/api/workspaces/{id}/git/unstage"),
    ("POST", "/api/workspaces/{id}/demo/start"),
    ("POST", "/api/workspaces/{id}/demo/stop"),
    ("POST", "/api/workspaces/{id}/demo/pull-latest"),
}


def _ctx(mode):
    return AuthContext(
        actor_kind="joiner_session", actor_id="j1", mode=mode,
        brief_subscope=None, label="guest", expires_at=None,
    )


class GitRouteGuardTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = server.create_app()

    def _handlers(self):
        found = {}
        for route in self.app.router.routes():
            key = (route.method, route.resource.canonical)
            if key in GUARDED:
                found[key] = route.handler
        self.assertEqual(set(found), GUARDED)
        return found

    async def test_brief_joiner_is_blocked(self):
        import route_guards
        from unittest.mock import patch
        with patch.object(route_guards, "_emit_violation", lambda *a, **k: None):
            await self._assert_brief_blocked()

    async def _assert_brief_blocked(self):
        for (method, path), handler in self._handlers().items():
            req = make_mocked_request(method, path.replace("{id}", "ws1"), match_info={"id": "ws1"})
            req["auth"] = _ctx("brief")
            resp = await handler(req)
            self.assertEqual(resp.status, 403, f"{method} {path}")

    async def test_missing_auth_context_fails_closed(self):
        for (method, path), handler in self._handlers().items():
            req = make_mocked_request(method, path.replace("{id}", "ws1"), match_info={"id": "ws1"})
            resp = await handler(req)
            self.assertEqual(resp.status, 401, f"{method} {path}")


class GitSessionTargetTests(unittest.IsolatedAsyncioTestCase):
    """?session_id= points the git command at that session's worktree, with ownership checks."""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ive-git-session-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.repo = root / "repo"
        self.repo.mkdir()
        self.worktree = self.repo / ".claude" / "worktrees" / "feature"
        self.outside = root / "elsewhere"
        self.outside.mkdir()
        git = ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"]
        for args in [["-c", "init.templateDir=", "init"],
                     ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--allow-empty", "-m", "fixture"],
                     ["worktree", "add", "-b", "feature", str(self.worktree)]]:
            subprocess.run(git + args, cwd=self.repo, check=True, capture_output=True)
        (self.worktree / "only-in-worktree.txt").write_text("x\n")
        for key, value in [("DATA_DIR", root / "data"), ("DB_PATH", root / "data" / "state.db")]:
            p = patch.object(database, key, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','W',?)", (str(self.repo),))
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('other','O',?)", (str(self.outside),))
            await db.executemany("INSERT INTO sessions(id,workspace_id,name,worktree_path) VALUES(?,?,?,?)", [
                ("own", "ws", "own", str(self.worktree)),
                ("plain", "ws", "plain", None),
                ("foreign", "other", "foreign", str(self.worktree)),
                ("escaped", "ws", "escaped", str(self.outside)),
                ("gone", "ws", "gone", str(self.repo / ".claude" / "worktrees" / "deleted")),
            ])
            await db.commit()
        finally:
            await db.close()

    async def call(self, handler, path, session_id=None):
        query = f"?session_id={session_id}" if session_id else ""
        req = make_mocked_request("GET", f"/api/workspaces/ws/git/{path}{query}", match_info={"id": "ws"})
        resp = await handler(req)
        return resp.status, json.loads(resp.text)

    async def test_own_session_reads_its_worktree(self):
        status, body = await self.call(server.get_workspace_git_status, "status", "own")
        self.assertEqual(status, 200)
        self.assertEqual([f["path"] for f in body["untracked"]], ["only-in-worktree.txt"])
        for session_id in (None, "plain"):
            status, body = await self.call(server.get_workspace_git_status, "status", session_id)
            self.assertEqual(status, 200)
            self.assertNotIn("only-in-worktree.txt", [f["path"] for f in body["untracked"]])

    async def test_foreign_unknown_escaped_and_missing_worktrees_are_rejected(self):
        for session_id, expected in [("foreign", 404), ("nope", 404), ("escaped", 403), ("gone", 404)]:
            status, body = await self.call(server.get_workspace_git_status, "status", session_id)
            self.assertEqual(status, expected, session_id)
            self.assertIn("error", body)
        # Same answer for unknown and foreign: no probing for other workspaces' sessions.
        foreign = await self.call(server.get_workspace_git_status, "status", "foreign")
        self.assertEqual(foreign, await self.call(server.get_workspace_git_status, "status", "nope"))

    async def test_diff_and_log_take_the_same_parameter(self):
        for handler, path in [(server.get_workspace_git_diff, "diff"), (server.get_workspace_git_log, "log")]:
            self.assertEqual((await self.call(handler, path, "foreign"))[0], 404, path)
            self.assertEqual((await self.call(handler, path, "own"))[0], 200, path)


class DemoBranchTests(unittest.TestCase):
    def test_option_shaped_branch_never_reaches_git(self):
        calls = []

        async def fake_run(cwd, argv, *a, **k):
            calls.append(argv)
            return 0, "", ""

        orig = demo_runner._run_subprocess
        demo_runner._run_subprocess = fake_run
        try:
            with self.assertRaises(RuntimeError):
                asyncio.run(demo_runner._git_pull("/nonexistent", "--upload-pack=touch /tmp/x"))
        finally:
            demo_runner._run_subprocess = orig
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
