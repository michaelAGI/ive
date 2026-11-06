"""Backstop cards read as English, land in Backlog by default, and old 'review' defaults migrate once."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

import db as database
import board_doc_backstop as backstop
from board_doc_migration import MARKER, migrate_board_doc_new_column
from test_worker_context_contract import load_functions


class DigestSummaryTests(unittest.TestCase):
    def test_files_discoveries_and_decisions_read_as_sentences(self):
        text = backstop._digest_summary({
            "name": "Fix login",
            "files_touched": json.dumps([f"/repo/src/{n}" for n in ("a.js", "b.js", "c.js", "d.js", "e.js", "f.js", "g.js")]),
            "discoveries": json.dumps(["the form posts twice", "tokens expire early."]),
            "decisions": json.dumps([{"text": "debounce the submit handler"}]),
        })
        self.assertEqual(text.split("\n"), [
            "Session «Fix login» edited 7 files (a.js, b.js, c.js and 4 more), then went idle without reporting a result.",
            "Discoveries: The form posts twice. Tokens expire early.",
            "Decisions: Debounce the submit handler.",
        ])
        for raw in ("[", "{", '"'):
            self.assertNotIn(raw, text)

    def test_single_file_and_no_files(self):
        self.assertEqual(
            backstop._digest_summary({"name": "S", "files_touched": '["/x/y.py"]'}),
            "Session «S» edited 1 file (y.py), then went idle without reporting a result.")
        self.assertEqual(
            backstop._digest_summary({"id": "abcdef12-rest", "decisions": "[]"}),
            "Session «abcdef12» went idle without reporting a result.")

    def test_plain_text_digest_is_kept_as_a_sentence(self):
        text = backstop._digest_summary({"name": "S", "discoveries": "plain note without json"})
        self.assertEqual(text.split("\n")[1], "Discoveries: Plain note without json.")


class TempDbCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory(prefix="ive-backstop-")
        self.addCleanup(self.tmp.cleanup)
        for key, value in [("DATA_DIR", Path(self.tmp.name)), ("DB_PATH", Path(self.tmp.name) / "state.db")]:
            p = patch.object(database, key, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()


class BacklogDefaultTests(TempDbCase):
    async def test_fresh_schema_and_sweeper_default_to_backlog(self):
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('w1','W',?)", (self.tmp.name,))
            await db.execute(
                "INSERT INTO sessions(id,workspace_id,name,session_type,last_active_at) "
                "VALUES('s1','w1','Idle worker','worker',datetime('now','-3 hours'))")
            await db.commit()
            cur = await db.execute("SELECT board_doc_new_column, board_doc_existing_column FROM workspaces WHERE id='w1'")
            self.assertEqual(tuple(await cur.fetchone()), ("backlog", "review"))
        finally:
            await db.close()
        seen = AsyncMock()
        with patch.object(backstop, "_process_session", seen):
            await backstop._sweep_workspace({"id": "w1", "board_doc_new_column": None, "board_doc_existing_column": None})
        seen.assert_awaited_once()
        self.assertEqual(seen.await_args.args[2:], ("review", "backlog"))

    async def test_created_card_lands_in_backlog_with_english_description(self):
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('w1','W',?)", (self.tmp.name,))
            await db.execute("INSERT INTO sessions(id,workspace_id,name,session_type) VALUES('s1','w1','Refactor pass','worker')")
            await db.commit()
        finally:
            await db.close()
        await backstop._process_session(
            {"id": "s1", "name": "Refactor pass", "files_touched": json.dumps(["/r/a.py", "/r/b.py"])},
            "w1", "review", backstop.DEFAULT_NEW_COLUMN)
        db = await database.get_db()
        try:
            row = await (await db.execute("SELECT status, labels, description, assigned_session_id FROM tasks")).fetchone()
            session = await (await db.execute("SELECT board_action, board_action_note FROM sessions WHERE id='s1'")).fetchone()
        finally:
            await db.close()
        self.assertEqual((row["status"], row["labels"], row["assigned_session_id"]), ("backlog", "auto-triage", "s1"))
        self.assertEqual(row["description"],
                         "Session «Refactor pass» edited 2 files (a.py, b.py), then went idle without reporting a result.")
        self.assertEqual(tuple(session), ("created", "backstop"))

    async def test_existing_ticket_gets_a_plain_english_note(self):
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('w1','W',?)", (self.tmp.name,))
            await db.execute("INSERT INTO sessions(id,workspace_id,name,session_type) VALUES('s1','w1','Fix login','worker')")
            await db.execute("INSERT INTO tasks(id,workspace_id,title,status,result_summary) VALUES('t1','w1','Login','in_progress','Done so far.')")
            await db.commit()
        finally:
            await db.close()
        await backstop._process_session(
            {"id": "s1", "name": "Fix login", "task_id": "t1", "decisions": json.dumps(["use OAuth"])}, "w1", "review", "backlog")
        db = await database.get_db()
        try:
            row = await (await db.execute("SELECT status, result_summary FROM tasks WHERE id='t1'")).fetchone()
        finally:
            await db.close()
        self.assertEqual(row["status"], "review")
        self.assertEqual(row["result_summary"].split("\n"), [
            "Done so far.", "", "---", "Auto-documented after the session went idle:",
            "Session «Fix login» went idle without reporting a result.", "Decisions: Use OAuth.",
        ])

    def test_worker_mcp_defaults_match(self):
        ns = load_functions("worker_mcp_server.py", {"_ws_doc_settings"}, WORKSPACE_ID=None, api_call=lambda *a: None)
        self.assertEqual(ns["_ws_doc_settings"](), {"mode": "agent_with_backstop", "new_column": "backlog", "existing_column": "review"})


class MigrationTests(TempDbCase):
    async def test_review_rows_move_to_backlog_once(self):
        db = await database.get_db()
        try:
            cur = await db.execute("SELECT value FROM app_settings WHERE key = ?", (MARKER,))
            self.assertIsNotNone(await cur.fetchone(), "fresh init records the marker")
            # Simulate a database from before the default changed: marker absent, old rows.
            await db.execute("DELETE FROM app_settings WHERE key = ?", (MARKER,))
            for wid, col in [("w-old", "review"), ("w-upper", " Review "), ("w-custom", "todo"), ("w-null", None), ("w-new", "backlog")]:
                await db.execute("INSERT INTO workspaces(id,name,path,board_doc_new_column) VALUES(?,?,?,?)", (wid, wid, f"/tmp/{wid}", col))
            await db.commit()

            self.assertEqual(await migrate_board_doc_new_column(db), {"workspaces": 2})
            await db.commit()
            cur = await db.execute("SELECT id, board_doc_new_column FROM workspaces ORDER BY id")
            self.assertEqual({r[0]: r[1] for r in await cur.fetchall()},
                             {"w-old": "backlog", "w-upper": "backlog", "w-custom": "todo", "w-null": None, "w-new": "backlog"})
            cur = await db.execute("SELECT value FROM app_settings WHERE key = ?", (MARKER,))
            self.assertEqual((await cur.fetchone())[0], "workspaces=2")

            # A person picks Review again afterwards: neither a rerun nor a restart touches it.
            await db.execute("UPDATE workspaces SET board_doc_new_column = 'review' WHERE id = 'w-old'")
            await db.commit()
            self.assertIsNone(await migrate_board_doc_new_column(db))
        finally:
            await db.close()
        await database.init_db()
        db = await database.get_db()
        try:
            cur = await db.execute("SELECT board_doc_new_column FROM workspaces WHERE id = 'w-old'")
            self.assertEqual((await cur.fetchone())[0], "review")
        finally:
            await db.close()


if __name__ == "__main__":
    unittest.main()
