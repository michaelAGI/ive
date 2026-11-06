"""The task_update pipeline stage never overwrites a summary the worker reported."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

import db as database
import pipeline_engine as engine

WORKER_TEXT = "Added retries to the uploader and covered them with tests."


class TaskUpdateStageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory(prefix="ive-task-update-")
        self.addCleanup(self.tmp.cleanup)
        for key, value in [("DATA_DIR", Path(self.tmp.name)), ("DB_PATH", Path(self.tmp.name) / "state.db")]:
            p = patch.object(database, key, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','W',?)", (self.tmp.name,))
            await db.execute(
                "INSERT INTO tasks(id,workspace_id,title,status,result_summary) VALUES('reported','ws','A','testing',?)",
                (WORKER_TEXT,))
            await db.execute("INSERT INTO tasks(id,workspace_id,title,status) VALUES('silent','ws','B','testing')")
            await db.execute("INSERT INTO tasks(id,workspace_id,title,status,result_summary) VALUES('blank','ws','C','testing','   ')")
            await db.execute("INSERT INTO tasks(id,workspace_id,title,status,result_summary) VALUES('stale','ws','D','todo',?)",
                             (engine.TASK_UPDATE_READY_TEXT,))
            await db.commit()
        finally:
            await db.close()
        self.status, self.complete = AsyncMock(), AsyncMock()
        for name, mock in [("_update_stage_status", self.status), ("_complete_stage", self.complete)]:
            p = patch.object(engine, name, mock); p.start(); self.addCleanup(p.stop)
        self.stage = {"id": "done", "type": "task_update", "prompt_template": engine.TASK_UPDATE_REVIEW_TEXT,
                      "config": {"status": "review", "pipeline_stage": "review"}}

    async def row(self, task_id):
        db = await database.get_db()
        try:
            task = dict(await (await db.execute(
                "SELECT status, pipeline_stage, result_summary FROM tasks WHERE id = ?", (task_id,))).fetchone())
            events = [tuple(r) for r in await (await db.execute(
                "SELECT event_type, actor, message FROM task_events WHERE task_id = ?", (task_id,))).fetchall()]
        finally:
            await db.close()
        return task, events

    async def test_worker_summary_survives_and_stage_text_lands_in_events(self):
        await engine._execute_task_update_stage("run", "done", self.stage, {"task_id": "reported", "variables": {}})
        task, events = await self.row("reported")
        self.assertEqual(task["result_summary"], WORKER_TEXT)
        self.assertEqual((task["status"], task["pipeline_stage"]), ("review", "review"))
        self.assertEqual(events, [("pipeline_stage_changed", "pipeline", engine.TASK_UPDATE_REVIEW_TEXT)])
        self.status.assert_awaited_once()
        self.assertEqual(self.status.await_args.kwargs["output_summary"],
                         f"__pipeline_result:pass:{engine.TASK_UPDATE_REVIEW_TEXT}")
        self.complete.assert_awaited_once_with("run", "done")

    async def test_empty_or_blank_summary_takes_the_stage_text(self):
        for task_id in ("silent", "blank"):
            await engine._execute_task_update_stage("run", "done", self.stage, {"task_id": task_id, "variables": {}})
            task, events = await self.row(task_id)
            self.assertEqual(task["result_summary"], engine.TASK_UPDATE_REVIEW_TEXT, task_id)
            self.assertEqual(len(events), 1, task_id)

    async def test_older_stage_text_is_replaced_by_the_new_stage_text(self):
        # A card dragged back to To Do keeps "ready for review" until the next
        # stage (here: blocked) writes over it; a worker report would stay.
        blocked = {"id": "blocked", "type": "task_update", "prompt_template": engine.TASK_UPDATE_BLOCKED_TEXT,
                   "config": {"status": "blocked", "pipeline_stage": "blocked"}}
        await engine._execute_task_update_stage("run", "blocked", blocked, {"task_id": "stale", "variables": {}})
        task, events = await self.row("stale")
        self.assertEqual((task["status"], task["result_summary"]), ("blocked", engine.TASK_UPDATE_BLOCKED_TEXT))
        self.assertEqual(events, [("pipeline_stage_changed", "pipeline", engine.TASK_UPDATE_BLOCKED_TEXT)])
        await engine._execute_task_update_stage("run", "blocked", blocked, {"task_id": "reported", "variables": {}})
        self.assertEqual((await self.row("reported"))[0]["result_summary"], WORKER_TEXT)

    def test_boilerplate_detector_and_worker_text(self):
        for text in engine.TASK_UPDATE_BOILERPLATE:
            self.assertTrue(engine.is_task_update_boilerplate(text), text)
            self.assertTrue(engine.is_task_update_boilerplate(f"__pipeline_result:pass:{text}"), text)
        self.assertTrue(engine.is_task_update_boilerplate("  pipeline completed successfully "))
        self.assertTrue(engine.is_task_update_boilerplate(""))
        self.assertTrue(engine.is_task_update_boilerplate(None))
        self.assertFalse(engine.is_task_update_boilerplate("Verification passed on Safari too; see the trace."))
        self.assertFalse(engine.is_task_update_boilerplate(WORKER_TEXT))
        backstop_note = ("Auto-documented after the session went idle:\n"
                         "Session «X» edited 1 file (a.js), then went idle without reporting a result.")
        self.assertEqual(engine.worker_result_text(f"{engine.TASK_UPDATE_REVIEW_TEXT}\n\n---\n{backstop_note}"), backstop_note)
        self.assertEqual(engine.worker_result_text(engine.TASK_UPDATE_DONE_TEXT), "")
        self.assertEqual(engine.worker_result_text(f"{WORKER_TEXT}\n\n---\n{engine.TASK_UPDATE_DONE_TEXT}"), WORKER_TEXT)
        self.assertEqual(engine.worker_result_text(None), "")


if __name__ == "__main__":
    unittest.main()
