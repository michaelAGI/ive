"""POST /api/tasks/{id}/iterate carries the review note to the next worker.

Also: the note is typed and capped, and iterate/update answer with the same
enriched row GET /api/tasks returns (the board merges it over its copy).
"""
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

import db as database  # noqa: E402
import server  # noqa: E402


class IterateTaskNoteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ive-iterate-")
        self.addCleanup(self.tmp.cleanup)
        for key, value in [("DATA_DIR", Path(self.tmp.name)), ("DB_PATH", Path(self.tmp.name) / "state.db")]:
            p = patch.object(database, key, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','W',?)", (self.tmp.name,))
            await db.execute("INSERT INTO sessions(id,workspace_id,name) VALUES('s1','ws','Worker')")
            await db.execute(
                "INSERT INTO tasks(id,workspace_id,title,status,description,result_summary,assigned_session_id) "
                "VALUES('t1','ws','Login','review','Build the login form.','Done, see PR.','s1')")
            await db.commit()
        finally:
            await db.close()
        self.broadcast = AsyncMock()
        for name, value in [("broadcast", self.broadcast), ("bus", SimpleNamespace(emit=AsyncMock()))]:
            p = patch.object(server, name, value); p.start(); self.addCleanup(p.stop)

    async def iterate(self, body):
        request = SimpleNamespace(match_info={"id": "t1"}, json=AsyncMock(return_value=body))
        resp = await server.iterate_task(request)
        return resp.status, json.loads(resp.text)

    async def test_note_is_appended_to_description_and_snapshot(self):
        status, task = await self.iterate({"note": "The error state is missing."})
        self.assertEqual(status, 200)
        self.assertEqual(task["description"], "Build the login form.\n\nReview note: The error state is missing.")
        self.assertEqual((task["status"], task["iteration"], task["assigned_session_id"], task["last_agent_session_id"]),
                         ("todo", 2, None, "s1"))
        self.assertIsNone(task["result_summary"])
        history = json.loads(task["iteration_history"])
        self.assertEqual(history[-1]["review_note"], "The error state is missing.")
        self.assertEqual(history[-1]["result_summary"], "Done, see PR.")
        self.assertEqual(history[-1]["description"], "Build the login form.")
        self.assertEqual(history[-1]["agent_session_name"], "Worker")
        self.broadcast.assert_awaited_once()
        db = await database.get_db()
        try:
            event = await (await db.execute(
                "SELECT message FROM task_events WHERE task_id='t1' AND event_type='iteration_requested'")).fetchone()
        finally:
            await db.close()
        self.assertEqual(event["message"], "Iteration 2 requested: The error state is missing.")

    async def test_legacy_revision_notes_behave_the_same(self):
        status, task = await self.iterate({"revision_notes": "Add tests", "description": "Build the login form, with tests."})
        self.assertEqual(status, 200)
        self.assertEqual(task["description"], "Build the login form, with tests.\n\nReview note: Add tests")

    async def test_without_note_description_is_unchanged(self):
        status, task = await self.iterate({})
        self.assertEqual((status, task["description"]), (200, "Build the login form."))
        self.assertNotIn("review_note", json.loads(task["iteration_history"])[-1])

    async def test_note_must_be_a_string(self):
        for body in ({"note": {"text": "x"}}, {"note": ["a"]}, {"revision_notes": 12}, ["note"]):
            status, payload = await self.iterate(body)
            self.assertEqual(status, 400, body)
            self.assertIn("error", payload)
        db = await database.get_db()
        try:
            row = await (await db.execute("SELECT status, iteration FROM tasks WHERE id='t1'")).fetchone()
        finally:
            await db.close()
        self.assertEqual(tuple(row), ("review", 1))

    async def test_note_is_capped_at_4000_characters(self):
        status, task = await self.iterate({"note": "x" * 200_000})
        self.assertEqual(status, 200)
        self.assertEqual(task["description"], "Build the login form.\n\nReview note: " + "x" * 4000)
        self.assertEqual(len(json.loads(task["iteration_history"])[-1]["review_note"]), 4000)

    async def test_iterate_and_update_answer_with_the_enriched_row(self):
        status, task = await self.iterate({"note": "Add the error state."})
        self.assertEqual(status, 200)
        for field in ("origin", "verification", "result_text", "files_changed", "assigned_session_name"):
            self.assertIn(field, task)
        self.assertEqual((task["origin"], task["verification"], task["result_text"]), ("user", "none", ""))
        request = SimpleNamespace(match_info={"id": "t1"}, headers={}, get=lambda key, default=None: default,
                                  json=AsyncMock(return_value={"status": "review", "result_summary": "Error state added."}))
        resp = await server.update_task(request)
        self.assertEqual(resp.status, 200)
        updated = json.loads(resp.text)
        self.assertEqual((updated["status"], updated["result_text"], updated["origin"]), ("review", "Error state added.", "user"))
        self.assertEqual(self.broadcast.await_args.args[0]["task"]["result_text"], "Error state added.")


if __name__ == "__main__":
    unittest.main()
