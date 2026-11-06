"""GET /api/tasks and /api/tasks/{id} carry the review fields the Task Board shows.

Temporary SQLite only; no CLI, no PTY (pty_mgr.is_alive is patched).
"""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

from aiohttp.test_utils import make_mocked_request  # noqa: E402

import db as database  # noqa: E402
import server  # noqa: E402

CONTRACT_FIELDS = (
    "assigned_session_name", "assigned_session_status", "assigned_session_alive",
    "worktree_path", "branch_label", "files_changed", "files_changed_count",
    "verification", "origin", "latest_run_id", "latest_run_summary",
    "latest_run_verify_summary", "result_text",
)
BOILERPLATE = "Verification passed. Review the implementation and verification reports before accepting."


class _CountingConnection:
    """Counts statements so the page cost can be shown to be flat in the task count."""

    def __init__(self, conn):
        self._conn = conn
        self.calls = 0

    async def execute(self, *args, **kwargs):
        self.calls += 1
        return await self._conn.execute(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._conn, name)


class ListTasksReviewFieldsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ive-review-fields-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.repo = root / "repo"
        self.worktree = self.repo / ".claude" / "worktrees" / "login"
        self.worktree.mkdir(parents=True)
        for target, value in [("DATA_DIR", root / "data"), ("DB_PATH", root / "data" / "state.db")]:
            p = patch.object(database, target, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        p = patch.object(server.pty_mgr, "is_alive", lambda sid: sid == "guided-sess"); p.start(); self.addCleanup(p.stop)
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','W',?)", (str(self.repo),))
            await db.executemany(
                "INSERT INTO sessions(id,workspace_id,name,status,session_type,worktree_path,branch_label,"
                "board_action,board_action_note) VALUES(?,?,?,?,?,?,?,?,?)",
                [
                    ("guided-sess", "ws", "Login worker", "running", "worker", str(self.worktree), "A", None, None),
                    ("agent-sess", "ws", "Flaky test fixer", "idle", "worker", None, None, None, None),
                    ("backstop-sess", "ws", "Refactor pass", "stopped", "worker", None, None, "created", "backstop"),
                ],
            )
            guided_files = [
                str(self.worktree / "src" / "Login.jsx"), str(self.repo / "src" / "api.js"),
                "/elsewhere/notes.md", str(self.worktree / "src" / "Login.jsx"),
            ]
            await db.executemany(
                "INSERT INTO session_digests(id,session_id,workspace_id,task_summary,current_focus,files_touched) "
                "VALUES(?,?,?,?,?,?)",
                [
                    ("d1", "guided-sess", "ws", "Built the login form", "", json.dumps(guided_files)),
                    ("d2", "agent-sess", "ws", "", "Awaiting the fixture",
                     json.dumps([str(self.repo / "tests" / "test_x.py")])),
                    ("d3", "backstop-sess", "ws", "Renamed helpers across the API layer", "",
                     json.dumps([str(self.repo / f"src/m{i}.py") for i in range(7)])),
                ],
            )
            await db.executemany(
                "INSERT INTO tasks(id,workspace_id,title,status,labels,result_summary,assigned_session_id,description) "
                "VALUES(?,?,?,?,?,?,?,?)",
                [
                    ("guided", "ws", "Login form", "review", "ive-guided", BOILERPLATE, "guided-sess", "Build it"),
                    ("agent", "ws", "Flaky test", "review", None,
                     "Fixed the flaky test by awaiting the fixture.", "agent-sess", None),
                    ("backstop", "ws", "[auto-triage] Refactor pass", "backlog", "auto-triage", None,
                     "backstop-sess", "Session «Refactor pass» edited 7 files"),
                    ("plain", "ws", "Write docs", "todo", None, None, None, None),
                    # A user card later assigned to the backstop's session is still a user card.
                    ("plain-on-backstop", "ws", "Hand-written card", "todo", None, None, "backstop-sess", None),
                    # The backstop marker in the summary marks the card even without the label.
                    ("marked", "ws", "Idle session", "backlog", None,
                     "Auto-documented after the session went idle:\nSession «X» edited 1 file (a.js).", None, None),
                ],
            )
            old_history = {
                "implement": {"status": "completed", "output_summary": "__pipeline_result:pass:First attempt", "completed_at": 1.0},
                "verify": {"status": "completed", "output_summary": "__pipeline_result:fail:2 tests failed", "completed_at": 2.0},
            }
            new_history = {
                "implement": {"status": "completed", "output_summary": "__pipeline_result:pass:Implemented the login form with tests", "completed_at": 3.0},
                "verify": {"status": "completed", "output_summary": "__pipeline_result:pass:All 12 tests pass", "completed_at": 4.0},
                "done": {"status": "completed", "output_summary": "__pipeline_result:pass:" + BOILERPLATE, "completed_at": 5.0},
            }
            await db.executemany(
                "INSERT INTO pipeline_runs(id,workspace_id,task_id,status,stage_history,created_at) VALUES(?,?,?,?,?,?)",
                [("run-old", "ws", "guided", "completed", json.dumps(old_history), "2026-10-20 10:00:00"),
                 ("run-new", "ws", "guided", "completed", json.dumps(new_history), "2026-10-21 10:00:00")],
            )
            await db.execute(
                "INSERT INTO test_queue(id,workspace_id,task_id,title,status) VALUES('q1','ws','agent','Flaky test','running')")
            await db.execute(
                "INSERT INTO task_events(task_id,event_type,actor,new_value,message) "
                "VALUES('agent','status_changed','worker:agent-se','review','worker reported')")
            await db.commit()
        finally:
            await db.close()

    async def list(self, query="workspace_id=ws"):
        resp = await server.list_tasks(make_mocked_request("GET", f"/api/tasks?{query}"))
        self.assertEqual(resp.status, 200)
        return {t["id"]: t for t in json.loads(resp.text)}

    async def test_every_task_carries_every_contract_field(self):
        tasks = await self.list()
        self.assertEqual(set(tasks), {"guided", "agent", "backstop", "plain", "plain-on-backstop", "marked"})
        for task in tasks.values():
            for field in CONTRACT_FIELDS:
                self.assertIn(field, task, f"{task['id']} lacks {field}")
            self.assertIn("title", task)
            self.assertIn("result_summary", task)

    async def test_guided_task_with_passing_run(self):
        t = (await self.list())["guided"]
        self.assertEqual(t["origin"], "guided")
        self.assertEqual(t["assigned_session_name"], "Login worker")
        self.assertEqual(t["assigned_session_status"], "running")
        self.assertIs(t["assigned_session_alive"], True)
        self.assertEqual(t["worktree_path"], str(self.worktree))
        self.assertEqual(t["branch_label"], "A")
        self.assertEqual(t["files_changed"], ["src/Login.jsx", "src/api.js", "/elsewhere/notes.md"])
        self.assertEqual(t["files_changed_count"], 3)
        self.assertEqual(t["verification"], "passed")
        self.assertEqual(t["latest_run_id"], "run-new")
        self.assertEqual(t["latest_run_summary"], "Implemented the login form with tests")
        self.assertEqual(t["latest_run_verify_summary"], "All 12 tests pass")
        self.assertEqual(t["result_summary"], BOILERPLATE)
        self.assertEqual(t["result_text"], "Implemented the login form with tests")

    async def test_agent_reported_task(self):
        t = (await self.list())["agent"]
        self.assertEqual(t["origin"], "agent")
        self.assertEqual(t["result_text"], "Fixed the flaky test by awaiting the fixture.")
        self.assertEqual(t["verification"], "running")
        self.assertIsNone(t["latest_run_id"])
        self.assertIsNone(t["latest_run_summary"])
        self.assertIsNone(t["latest_run_verify_summary"])
        self.assertIsNone(t["worktree_path"])
        self.assertIsNone(t["branch_label"])
        self.assertIs(t["assigned_session_alive"], False)
        self.assertEqual(t["assigned_session_status"], "idle")
        self.assertEqual((t["files_changed"], t["files_changed_count"]), (["tests/test_x.py"], 1))

    async def test_backstop_card(self):
        t = (await self.list())["backstop"]
        self.assertEqual(t["origin"], "backstop")
        self.assertEqual(t["verification"], "none")
        self.assertEqual(t["files_changed_count"], 7)
        self.assertEqual(t["files_changed"][0], "src/m0.py")
        self.assertEqual(t["result_text"], "Renamed helpers across the API layer")
        self.assertEqual(t["assigned_session_name"], "Refactor pass")

    async def test_origin_follows_the_task_not_the_session(self):
        tasks = await self.list()
        self.assertEqual(tasks["plain-on-backstop"]["origin"], "user")
        self.assertEqual(tasks["plain-on-backstop"]["assigned_session_name"], "Refactor pass")
        self.assertEqual(tasks["marked"]["origin"], "backstop")

    def test_stage_verdict_needs_the_marker(self):
        completed = lambda text: {"status": "completed", "output_summary": text}
        self.assertEqual(server._stage_verdict(completed("No failures found; all green.")), "none")
        self.assertEqual(server._stage_verdict(completed("All tests pass")), "none")
        self.assertEqual(server._stage_verdict(completed("")), "none")
        self.assertEqual(server._stage_verdict(completed("__pipeline_result:pass:ok")), "passed")
        self.assertEqual(server._stage_verdict(completed("__pipeline_result:fail:2 failed")), "failed")
        self.assertEqual(server._stage_verdict({"status": "running"}), "running")
        self.assertEqual(server._stage_verdict({"status": "failed"}), "failed")
        self.assertEqual(server._stage_verdict(None), "none")

    async def test_brief_listing_skips_the_review_fields(self):
        resp = await server.list_tasks(make_mocked_request("GET", "/api/tasks?workspace_id=ws&brief=1"))
        rows = json.loads(resp.text)
        self.assertEqual(len(rows), 6)
        for row in rows:
            self.assertNotIn("origin", row)
            self.assertIn("title", row)

    async def test_plain_user_task(self):
        t = (await self.list())["plain"]
        self.assertEqual(t["origin"], "user")
        self.assertIsNone(t["assigned_session_name"])
        self.assertIsNone(t["assigned_session_status"])
        self.assertIsNone(t["assigned_session_alive"])
        self.assertEqual((t["files_changed"], t["files_changed_count"], t["result_text"]), ([], 0, ""))
        self.assertEqual(t["verification"], "none")

    async def test_filters_still_apply(self):
        tasks = await self.list("workspace_id=ws&status=review")
        self.assertEqual(set(tasks), {"guided", "agent"})
        tasks = await self.list("workspace_id=ws&assigned_session=agent-sess")
        self.assertEqual(set(tasks), {"agent"})

    async def test_get_task_matches_list(self):
        listed = (await self.list())["guided"]
        req = make_mocked_request("GET", "/api/tasks/guided", match_info={"id": "guided"})
        resp = await server.get_task(req)
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.text), listed)
        req = make_mocked_request("GET", "/api/tasks/nope", match_info={"id": "nope"})
        self.assertEqual((await server.get_task(req)).status, 404)

    async def test_files_are_capped_and_queries_do_not_grow_with_tasks(self):
        db = await database.get_db()
        try:
            many = json.dumps([str(self.repo / f"src/f{i}.py") for i in range(80)])
            await db.execute("UPDATE session_digests SET files_touched = ? WHERE session_id = 'agent-sess'", (many,))
            await db.executemany(
                "INSERT INTO tasks(id,workspace_id,title,status,assigned_session_id) VALUES(?,?,?,?,?)",
                [(f"extra-{i}", "ws", f"Extra {i}", "backlog", "agent-sess") for i in range(40)],
            )
            await db.commit()
        finally:
            await db.close()
        t = (await self.list())["agent"]
        self.assertEqual((len(t["files_changed"]), t["files_changed_count"]), (50, 80))

        counts = []
        for query in ("workspace_id=ws&status=review", "workspace_id=ws"):
            real = await database.get_db()
            counting = _CountingConnection(real)
            with patch.object(server, "get_db", return_value=counting):
                tasks = await self.list(query)
            counts.append(counting.calls)
            self.assertGreater(len(tasks), 0)
        self.assertEqual(counts[0], counts[1], "statement count must not depend on the task count")


if __name__ == "__main__":
    unittest.main()
