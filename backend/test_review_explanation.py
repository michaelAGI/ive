"""Scoped review explanation tests; no live model calls or application database."""
import asyncio
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import aiosqlite
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import review_explanation as review


class ContextTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory(prefix="ive-explanation-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        (self.repo / "file.txt").write_text("original\n")
        self.git("add", ".")
        self.git("-c", "user.name=IVE Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "initial")
        self.dbpath = self.root / "fixture.db"
        db = await self.connect()
        await db.executescript("""
            CREATE TABLE workspaces (id TEXT, name TEXT, path TEXT);
            CREATE TABLE sessions (id TEXT, workspace_id TEXT, name TEXT, cli_type TEXT,
                model TEXT, account_id TEXT, task_id TEXT, active_ticket_id TEXT, native_session_id TEXT);
            CREATE TABLE tasks (id TEXT, workspace_id TEXT, title TEXT, description TEXT,
                result_summary TEXT, status TEXT, assigned_session_id TEXT, commander_session_id TEXT);
            CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT);
        """)
        await db.execute("INSERT INTO workspaces VALUES ('w','Project',?)", (str(self.repo),))
        await db.execute("INSERT INTO sessions VALUES ('s','w','Fix it','claude','sonnet',NULL,'t',NULL,NULL)")
        await db.execute("INSERT INTO tasks VALUES ('t','w','Fix greeting','Use a friendly greeting','Changed greeting','review','s',NULL)")
        await db.execute("INSERT INTO tasks VALUES ('other','w','Unrelated','PRIVATE_OTHER_TASK',NULL,'backlog','another',NULL)")
        await db.execute("INSERT INTO messages VALUES (1,'s','user','Change the greeting.','2026-01-01')")
        await db.execute("INSERT INTO messages VALUES (2,'another','user','PRIVATE_OTHER_SESSION','2026-01-01')")
        await db.commit()
        await db.close()
        self.dbpatch = patch.object(review, "get_db", self.connect)
        self.dbpatch.start()
        self.addCleanup(self.dbpatch.stop)

    async def connect(self):
        db = await aiosqlite.connect(self.dbpath)
        db.row_factory = aiosqlite.Row
        return db

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True).stdout

    async def snapshot(self, **changes):
        return await review.collect_context(review.target({"reviewed_session_id": "s", **changes}))

    async def test_exact_scope_intent_and_no_invented_reason(self):
        (self.repo / "file.txt").write_text("staged greeting\n")
        self.git("add", "file.txt")
        (self.repo / "file.txt").write_text("working greeting\n")
        working = await self.snapshot(scope="working", selected_file="file.txt", task_id="t")
        staged = await self.snapshot(scope="staged", selected_file="file.txt")
        self.assertIn("+working greeting", working["diff"])
        self.assertIn("-staged greeting", working["diff"])
        self.assertNotIn("+working greeting", staged["diff"])
        self.assertIn("+staged greeting", staged["diff"])
        self.assertEqual(working["original_prompt"]["text"], "Change the greeting.")
        self.assertEqual(working["task"]["id"], "t")
        self.assertFalse(working["reason"]["recorded"])
        self.assertNotIn("PRIVATE_OTHER", json.dumps(working))
        self.assertNotEqual(working["revision"], staged["revision"])
        before = self.git("status", "--porcelain=v1")
        await self.snapshot()
        self.assertEqual(before, self.git("status", "--porcelain=v1"))

    async def test_rejects_unrelated_task_and_missing_session(self):
        with self.assertRaises(review.ReviewScopeError):
            await self.snapshot(task_id="other")
        with self.assertRaises(LookupError):
            await self.snapshot(reviewed_session_id="absent")

    async def test_revision_includes_changes_beyond_model_excerpt(self):
        (self.repo / "file.txt").write_text("x" * (review.MAX_DIFF + 100) + "first\n")
        first = await self.snapshot()
        (self.repo / "file.txt").write_text("x" * (review.MAX_DIFF + 100) + "second\n")
        second = await self.snapshot()
        self.assertTrue(first["truncated"])
        self.assertNotEqual(first["revision"], second["revision"])

    async def test_untracked_selection_is_literal_and_symlinks_fail_closed(self):
        (self.repo / "*.txt").write_text("selected only\n")
        (self.repo / "other.txt").write_text("UNSELECTED_SECRET\n")
        result = await self.snapshot(selected_file="*.txt")
        self.assertIn("selected only", result["diff"])
        self.assertNotIn("UNSELECTED_SECRET", json.dumps(result))
        (self.root / "secret").write_text("OUTSIDE_SECRET")
        (self.repo / "link.txt").symlink_to(self.root / "secret")
        with self.assertRaises(ValueError):
            await self.snapshot(selected_file="link.txt")
        for path in ("../secret", "/etc/passwd"):
            with self.assertRaises(ValueError):
                review.target({"reviewed_session_id": "s", "selected_file": path})


def snapshot(revision="a" * 64):
    return {"revision": revision, "session": {"id": "s"}, "reason": {"recorded": False},
            "diff": "+selected change", "scope": "working", "task": None}


def question(**changes):
    return {"request_id": str(uuid.uuid4()), "reviewed_session_id": "s", "scope": "working",
            "revision": "a" * 64, "cli_type": "claude", "question_kind": "purpose", **changes}


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owner = True
        @web.middleware
        async def auth(request, handler):
            request["auth"] = SimpleNamespace(is_owner=self.owner, mode="full", actor_kind="test", actor_id="test", label="Test")
            return await handler(request)
        app = web.Application(middlewares=[auth])
        review.register_review_explanation_routes(app)
        violations = patch("route_guards._emit_violation")
        violations.start()
        self.addCleanup(violations.stop)
        self.client = TestClient(TestServer(app))
        self.addAsyncCleanup(self.client.close)
        await self.client.start_server()

    async def finish(self, request_id):
        job = self.client.server.app[review.JOBS][request_id]
        await job["task"]
        response = await self.client.get(f"/api/review/explanation/requests/{request_id}")
        return await response.json()

    async def test_owner_guard_covers_every_route_without_collecting_context(self):
        self.owner = False
        with patch.object(review, "collect_context", new_callable=AsyncMock) as reader:
            for method, path in (("get", "/context?reviewed_session_id=s"), ("post", "/ask"),
                                 ("get", "/requests/test"), ("delete", "/requests/test")):
                response = await getattr(self.client, method)("/api/review/explanation" + path)
                self.assertEqual(response.status, 403)
            reader.assert_not_awaited()

    async def test_duplicate_request_runs_once_and_context_is_server_collected(self):
        gate = asyncio.Event()
        async def generate(data, prompt, env):
            self.assertIn("+selected change", prompt)
            self.assertNotIn("CLIENT_INJECTED_DIFF", prompt)
            self.assertEqual(data["project_paths"], [])
            self.assertTrue(data["_disable_customizations"])
            await gate.wait()
            return "A greeting change."
        with patch.object(review, "collect_context", new_callable=AsyncMock, return_value=snapshot()), \
             patch.object(review.sidechat, "cli_environment", new_callable=AsyncMock, return_value={}), \
             patch.object(review.sidechat, "run_cli", new_callable=AsyncMock, side_effect=generate) as runner:
            data = question(diff="CLIENT_INJECTED_DIFF", project_paths=["/private/secret"])
            one, two = await asyncio.gather(*[self.client.post("/api/review/explanation/ask", json=data) for _ in range(2)])
            self.assertIn(one.status, (200, 202))
            self.assertIn(two.status, (200, 202))
            gate.set()
            result = await self.finish(data["request_id"])
            self.assertEqual(result["status"], "completed")
            self.assertFalse(result["stale"])
            runner.assert_awaited_once()
            conflict = await self.client.post("/api/review/explanation/ask", json={**data, "question_kind": "separate_agent"})
            self.assertEqual(conflict.status, 409)

    async def test_stale_revision_never_calls_model(self):
        with patch.object(review, "collect_context", new_callable=AsyncMock, return_value=snapshot("b" * 64)), \
             patch.object(review.sidechat, "run_cli", new_callable=AsyncMock) as runner:
            data = question()
            await self.client.post("/api/review/explanation/ask", json=data)
            result = await self.finish(data["request_id"])
            self.assertEqual(result["status"], "failed")
            self.assertTrue(result["stale"])
            runner.assert_not_awaited()

    async def test_changes_while_answering_mark_answer_stale(self):
        with patch.object(review, "collect_context", new_callable=AsyncMock, side_effect=[snapshot(), snapshot("b" * 64)]), \
             patch.object(review.sidechat, "cli_environment", new_callable=AsyncMock, return_value={}), \
             patch.object(review.sidechat, "run_cli", new_callable=AsyncMock, return_value="Earlier revision explanation."):
            data = question(cli_type="codex")
            await self.client.post("/api/review/explanation/ask", json=data)
            result = await self.finish(data["request_id"])
            self.assertEqual(result["status"], "completed")
            self.assertTrue(result["stale"])
            self.assertEqual(result["cli_type"], "codex")

    async def test_cancellation_before_post_prevents_model_launch(self):
        data = question()
        with patch.object(review.sidechat, "run_cli", new_callable=AsyncMock) as runner:
            await self.client.delete(f"/api/review/explanation/requests/{data['request_id']}")
            response = await self.client.post("/api/review/explanation/ask", json=data)
            self.assertEqual((await response.json())["status"], "cancelled")
            runner.assert_not_awaited()

    async def test_running_cancellation_stops_independent_job(self):
        started = asyncio.Event()
        async def generate(*args):
            started.set()
            await asyncio.Event().wait()
        with patch.object(review, "collect_context", new_callable=AsyncMock, return_value=snapshot()), \
             patch.object(review.sidechat, "cli_environment", new_callable=AsyncMock, return_value={}), \
             patch.object(review.sidechat, "run_cli", new_callable=AsyncMock, side_effect=generate):
            data = question()
            await self.client.post("/api/review/explanation/ask", json=data)
            await started.wait()
            response = await self.client.delete(f"/api/review/explanation/requests/{data['request_id']}")
            self.assertEqual((await response.json())["status"], "cancelled")


class ExplanationProcessTests(unittest.TestCase):
    def test_explanation_process_has_no_tools_hooks_or_parent_session(self):
        command = review.sidechat.build_command("claude", "claude", "sonnet", disable_customizations=True)
        self.assertIn("--safe-mode", command)
        self.assertIn("--no-session-persistence", command)
        self.assertEqual(command[command.index("--tools") + 1], "")
        self.assertEqual(command[command.index("--mcp-config") + 1], '{"mcpServers":{}}')
        self.assertNotIn("--resume", command)
        self.assertNotIn("--bare", command)  # bare disables the OAuth login
        self.assertNotIn("--safe-mode", review.sidechat.build_command("claude", "claude", ""))
        codex = review.sidechat.build_command("codex", "codex", "", disable_customizations=True)
        self.assertIn("--ignore-user-config", codex)
        self.assertEqual(codex[codex.index("--sandbox") + 1], "read-only")
        self.assertIn("features.shell_tool=false", codex)
        self.assertIn("features.view_image=false", codex)
        self.assertIn("project_doc_max_bytes=0", codex)
        self.assertIn("skills.include_instructions=false", codex)
        self.assertIn("features.skip_host_skill_discovery=true", codex)
        self.assertIn("features.apps=false", codex)


if __name__ == "__main__":
    unittest.main()
