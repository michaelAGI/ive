"""Independent reviews: capture real prompt composition and isolated dispatch.

Sentinel claims must not reach first-pass prompts even when the worker reports
success in multiple transport fields. No providers or user projects are used.
"""
import asyncio
from contextlib import ExitStack
import json
import logging
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import db as database
import pipeline_engine as engine
from orchestrator import _build_node_prompt
from review_brief import build_review_brief, is_independent_review_session, bind_review_artifacts, ReviewScopeError
from test_worker_context_contract import load_functions


CLAIM = "WORKER_CLAIM_all_done_tests_green_no_review_needed"
PRIOR = "PREVIOUS_REVIEW_VERDICT_pass_everything"
INTENT = "Reject negative quantities and keep the discount boundary at 10 items."
CARD = {"id": "task", "title": "Quantity validation", "description": INTENT,
        "acceptance_criteria": "A quantity of -1 raises ValueError; 10 receives a discount.",
        "result_summary": CLAIM}


class IndependentPromptTests(unittest.TestCase):
    def assert_independent(self, prompt):
        self.assertIn("Independent review", prompt)
        self.assertNotIn(CLAIM, prompt)
        self.assertNotIn(PRIOR, prompt)
        self.assertIn("could not verify", prompt)
        self.assertIn("do not return PASS", prompt)

    def test_brief_omits_worker_claims_preserves_exact_task_and_criteria(self):
        prompt = build_review_brief("Inspect pricing.py and run its tests.", original_prompt=INTENT,
                                    board_card=CARD, handoff_notes=CLAIM)
        self.assert_independent(prompt)
        self.assertIn(INTENT, prompt)
        self.assertIn("quantity of -1", prompt)
        self.assertIn("Inspect pricing.py", prompt)
        self.assertNotIn("handoff.notes", prompt)
        self.assertIn("base64-utf8", prompt)

    def test_missing_or_malformed_context_never_removes_review_policy(self):
        for kwargs in ({}, {"handoff_notes": CLAIM}, {"board_card": object()},
                       {"original_prompt": INTENT, "max_intent_chars": "invalid"}):
            self.assert_independent(build_review_brief("Inspect actual files.", **kwargs))

    def test_headless_review_gets_paths_but_not_upstream_claims_or_verdicts(self):
        upstream = {"implement": {"verdict": "pass", "summary": CLAIM,
                                  "evidence": [CLAIM], "changed_files": ["pricing.py"]},
                    "review": {"verdict": "pass", "summary": PRIOR}}
        for role in ("tester", "code_reviewer", "reviewer"):
            prompt = _build_node_prompt({"role": role, "prompt": "Inspect actual files.",
                                         "original_prompt": INTENT}, upstream)
            self.assert_independent(prompt)
            self.assertIn("pricing.py", prompt)
        worker = _build_node_prompt({"role": "worker", "prompt": "Repair findings."}, upstream)
        self.assertIn(PRIOR, worker)  # repair work still gets actionable handoffs

    def test_plan_critic_receives_plan_artifact_without_planners_self_assessment(self):
        prompt = _build_node_prompt({"role": "plan_critic", "original_prompt": INTENT},
                    {"plan": {"plan_steps": ["Validate quantity before calculating price."],
                              "risks": ["Existing zero-quantity callers"], "summary": CLAIM}})
        self.assert_independent(prompt)
        self.assertIn("Validate quantity before calculating price", prompt)

    def test_queue_w2w_and_seam_briefs_omit_automatic_completion_summaries(self):
        ns = load_functions("server.py", {"_build_test_prompt", "_build_capability_handoff_prompt",
                             "_build_seam_check_description"},
                            _is_alloy_task=lambda _: False)
        prompts = [ns["_build_test_prompt"]({"id": "q", "title": "Pricing", "description": INTENT},
                        board_card=CARD, handoff_notes=CLAIM),
                   ns["_build_capability_handoff_prompt"](capability="testing",
                        capability_cfg={"label": "Testing"}, prompt=CLAIM,
                        reason=CLAIM, source_session={"id": "worker"}, task=CARD,
                        original_prompt=INTENT),
                   ns["_build_seam_check_description"]({**CARD, "seam_contract": "quantity is a nonnegative integer"},
                        [{"id": "slice", "title": "Pricing", "result_summary": CLAIM,
                          "_files_touched": ["pricing.py"]}])]
        for prompt in prompts:
            self.assert_independent(prompt)
        self.assertIn("pricing.py", prompts[-1])

    def test_review_identity_recognizes_normalized_capabilities(self):
        for config in ({"tags": '["independent_review"]'}, {"tags": ["capability_testing"]},
                       {"session_type": "test_worker"}):
            self.assertTrue(is_independent_review_session(config))
        for config in ({}, {"tags": "invalid json"}, {"tags": {"independent_review": True}}):
            self.assertFalse(is_independent_review_session(config))

    def test_implementation_stages_with_review_words_keep_their_role(self):
        for name in ("Fix tests", "Implement review UI", "Build test fixture"):
            self.assertFalse(engine._is_review_stage({"id": "work", "name": name, "session_type": "worker"}))
        self.assertFalse(engine._is_review_stage({"id": "review", "agent_config": {"role": "worker"}}))
        self.assertTrue(engine._is_review_stage({"id": "review", "session_type": "worker"}))

    def test_commander_created_tester_is_isolated_before_auto_start(self):
        api = Mock(return_value={"id": "review"})
        ns = load_functions("mcp_server.py", {"tool_create_session"}, api_call=api, json=json,
                            WORKSPACE_ID="ws", GIT_ATTRIBUTION_PROMPT="", MEMORY_REUSE_PROMPT="")
        ns["tool_create_session"]({"testing": True, "name": "Verify pricing"})
        first = api.call_args_list[0]
        self.assertEqual(first.args[:2], ("POST", "/sessions"))
        self.assertIn("independent_review", first.args[2]["tags"])
        tag_update = next(call for call in api.call_args_list if call.args[:2] == ("PUT", "/sessions/review"))
        self.assertIn("independent_review", tag_update.args[2]["tags"])


class IndependentDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ive-independent-review-")
        self.addCleanup(self.tmp.cleanup)
        for key, value in (("DATA_DIR", Path(self.tmp.name)), ("DB_PATH", Path(self.tmp.name)/"state.db")):
            p = patch.object(database, key, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        self.db = await database.get_db(); self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Pricing fixture',?)", (self.tmp.name,))
        await self.db.execute("INSERT INTO accounts(id,name) VALUES('review-account','Selected test account')")
        await self.db.execute("INSERT INTO sessions(id,workspace_id,name,cli_type) VALUES('worker','ws','Implementer','claude')")
        await self.db.execute("UPDATE sessions SET account_id='review-account' WHERE id='worker'")
        await self.db.execute("INSERT INTO tasks(id,workspace_id,title,description,acceptance_criteria,result_summary,assigned_session_id) VALUES('task','ws',?,?,?,?,'worker')",
                              (CARD['title'], INTENT, CARD['acceptance_criteria'], CLAIM))
        await self.db.execute("UPDATE sessions SET task_id='task' WHERE id='worker'")
        await self.db.execute("INSERT INTO messages(session_id,role,content) VALUES('worker','user',?)", (INTENT,))
        await self.db.commit()
        engine._state_lock = asyncio.Lock()
        engine._active_runs.clear(); engine._session_to_run.clear()
        self.manager = SimpleNamespace(is_alive=Mock(return_value=True), write=Mock(return_value=True))
        patches = ExitStack(); self.addCleanup(patches.close)
        for key, value in (("_pty_manager", self.manager), ("_pty_start_fn", AsyncMock()),
                           ("_input_ready_fn", AsyncMock(return_value=True)),
                           ("_broadcast_fn", AsyncMock()), ("bus", SimpleNamespace(emit=AsyncMock()))):
            patches.enter_context(patch.object(engine, key, value))

    async def asyncTearDown(self):
        jobs = list(engine._stage_jobs.values())
        if jobs:
            await asyncio.wait_for(asyncio.gather(*jobs, return_exceptions=True), 5)

    async def test_real_pipeline_dispatch_uses_fresh_session_and_omits_all_claim_channels(self):
        root = Path(self.tmp.name)
        def git(*args):
            return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
        git("init", "-q")
        (root/"pricing.py").write_text("MAIN_BRANCH_CONTENT\n")
        git("add", "pricing.py")
        git("-c", "user.name=IVE Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline")
        worktree = root/".claude"/"worktrees"/"implementation"
        git("worktree", "add", "-b", "implementation", str(worktree))
        (worktree/"pricing.py").write_text("ACTUAL_IMPLEMENTATION_TO_REVIEW\n")
        await self.db.execute("UPDATE sessions SET worktree=1,worktree_path=? WHERE id='worker'", (str(worktree),))
        await self.db.commit()
        definition = {"stages": [{"id": "implement", "name": "Implementation", "session_type": "worker"},
                                  {"id": "prior", "name": "Earlier reviewer", "session_type": "tester"}],
                      "transitions": [{"source": "prior", "target": "verify", "condition": "on_fail"}]}
        stage = {"id": "verify", "name": "Verify", "session_id": "worker", "session_type": "worker",
                 "context_from": ["implement", "prior"], "prompt_template": "Inspect pricing.py."}
        definition["stages"].append(stage)
        definition = await engine.create_definition({"workspace_id": "ws", "name": "Independent fixture", **definition})
        run = {"id": "run", "workspace_id": "ws", "pipeline_id": definition["id"], "task_id": "task",
               "status": "running", "current_stages": ["verify"], "variables": {},
               "stage_history": {"implement": {"status": "completed", "session_id": "worker",
                                  "output_summary": CLAIM, "result": {"summary": CLAIM, "changed_files": ["pricing.py"]}},
                                 "prior": {"status": "completed", "session_id": "worker", "output_summary": PRIOR},
                                 "verify": {"status": "running"}}}
        await self.db.execute("INSERT INTO pipeline_runs(id,pipeline_id,workspace_id,task_id,status,current_stages,stage_history,variables) VALUES(?,?,?,?,?,?,?,?)",
                              ("run", definition["id"], "ws", "task", "running", '["verify"]', json.dumps(run["stage_history"]), '{}'))
        await self.db.commit()
        await engine._execute_agent_stage("run", "verify", stage, run, definition)
        delivered = self.manager.write.call_args_list
        self.assertEqual(len(delivered), 2)
        review_id = delivered[0].args[0]
        self.assertNotEqual(review_id, "worker")
        prompt = delivered[0].args[1].decode()
        self.assertIn(INTENT, prompt)
        self.assertIn("pricing.py", prompt)
        self.assertNotIn(CLAIM, prompt); self.assertNotIn(PRIOR, prompt)
        self.assertIn("Independent review", prompt)
        self.assertIn("quantity of -1", prompt)
        review = dict(await (await self.db.execute("SELECT * FROM sessions WHERE id=?", (review_id,))).fetchone())
        self.assertIn("independent_review", review["tags"])
        self.assertIn("Independent review", review["system_prompt"])
        self.assertEqual(review["account_id"], "review-account")
        self.assertEqual(review["worktree"], 0)
        self.assertEqual(Path(review["worktree_path"]), worktree.resolve())
        config_ns = load_functions("server.py", {"get_session_config"}, get_db=database.get_db, asyncio=asyncio)
        config = await config_ns["get_session_config"](review_id)
        observed = subprocess.run(["cat", "pricing.py"], cwd=config["workspace_path"], check=True,
                                  capture_output=True, text=True).stdout
        self.assertEqual(observed, "ACTUAL_IMPLEMENTATION_TO_REVIEW\n")
        self.assertEqual(config["worktree"], 0)
        from cli_session import UnifiedSession
        self.assertNotIn("--worktree", UnifiedSession("claude", config).build_command())
        # The person's original result remains visible and is never overwritten.
        self.assertEqual((await (await self.db.execute("SELECT result_summary FROM tasks WHERE id='task'")).fetchone())[0], CLAIM)
        # Actual deletion route stops/removes only the reviewer, not the source
        # session or its checkout. No native process is started by this fixture.
        deletion = load_functions("server.py", {"delete_session"}, web=web, get_db=database.get_db,
                                  _resolve_caller=AsyncMock(return_value=None), _session_visible_to_request=lambda *args: True,
                                  _stop_session_expected=AsyncMock(), broadcast=AsyncMock(),
                                  bus=SimpleNamespace(emit=AsyncMock()), CommanderEvent=SimpleNamespace(SESSION_DELETED="deleted"))
        self.assertEqual((await deletion["delete_session"](SimpleNamespace(match_info={"id": review_id}))).status, 200)
        self.assertTrue((worktree/"pricing.py").is_file())
        self.assertIsNotNone(await (await self.db.execute("SELECT id FROM sessions WHERE id='worker'")).fetchone())

    async def test_missing_or_foreign_review_artifacts_fail_instead_of_using_main(self):
        await self.db.execute("INSERT INTO sessions(id,workspace_id,name,tags) VALUES('review','ws','Reviewer','[\"independent_review\"]')")
        await self.db.execute("UPDATE sessions SET worktree=1,worktree_path=? WHERE id='worker'", (str(Path(self.tmp.name)/"missing"),))
        await self.db.commit()
        with self.assertRaises(ReviewScopeError):
            await bind_review_artifacts(self.db, "review", "ws", "worker")
        with tempfile.TemporaryDirectory() as outside:
            await self.db.execute("UPDATE sessions SET worktree_path=? WHERE id='worker'", (outside,))
            with self.assertRaises(ReviewScopeError):
                await bind_review_artifacts(self.db, "review", "ws", "worker")
        await self.db.execute("UPDATE sessions SET worktree_path=NULL WHERE id='worker'")
        with self.assertRaises(ReviewScopeError):
            await bind_review_artifacts(self.db, "review", "ws", "worker")

    async def test_http_brief_ignores_posted_and_stored_worker_success_claims(self):
        ns = load_functions("server.py", {"compose_review_brief"}, web=web, get_db=database.get_db,
                            _get_readable_session_for_request=AsyncMock(return_value={"id": "worker", "workspace_id": "ws"}))
        app = web.Application(); app.router.add_post("/review/brief", ns["compose_review_brief"])
        client = TestClient(TestServer(app)); await client.start_server(); self.addAsyncCleanup(client.close)
        response = await client.post("/review/brief", json={"instructions": "Inspect pricing.py", "task_id": "task",
                                     "reviewed_session_id": "worker", "handoff_notes": CLAIM})
        self.assertEqual(response.status, 200)
        prompt = (await response.json())["brief"]
        self.assertNotIn(CLAIM, prompt)
        self.assertIn(INTENT, prompt)
        self.assertIn("quantity of -1", prompt)

    async def test_independent_launch_skips_ive_memory_provider_and_memory_tool_prefill(self):
        provider = AsyncMock(side_effect=AssertionError("review must not request peer memories"))
        ns = load_functions("server.py", {"_session_memory_prompt", "_memory_tool_guidance"},
                            extension_host=SimpleNamespace(available=lambda _: True), _myelin_session_memory=provider)
        for config in ({"tags": '["independent_review"]'}, {"tags": '["capability_testing"]'}):
            self.assertEqual(await ns["_session_memory_prompt"](config, "review", {}, 4000, False), ("", None))
            self.assertEqual(ns["_memory_tool_guidance"](config, False), "")
        provider.assert_not_awaited()

    async def test_task_lookup_hides_claims_for_reviewers_and_preserves_owner_ui(self):
        await self.db.execute("INSERT INTO sessions(id,workspace_id,name,tags) VALUES('review','ws','Reviewer','[\"independent_review\"]')")
        await self.db.commit()
        async def enrich(db, tasks):
            for task in tasks:
                task["latest_run_verify_summary"] = PRIOR
                task["result_text"] = CLAIM
            return tasks
        ns = load_functions("server.py", {"get_task", "list_tasks"}, web=web, get_db=database.get_db,
                            _enrich_task_rows=enrich, get_auth=lambda _: SimpleNamespace(is_owner=True))
        app = web.Application(); app.router.add_get("/tasks", ns["list_tasks"]); app.router.add_get("/tasks/{id}", ns["get_task"])
        client = TestClient(TestServer(app)); await client.start_server(); self.addAsyncCleanup(client.close)
        for route in ("/tasks/task", "/tasks?workspace=ws", "/tasks?workspace=ws&brief=1"):
            for caller in (None, "worker", "review"):
                response = await client.get(route, headers={"X-IVE-Session-Id": caller} if caller else {})
                text = await response.text()
                self.assertEqual(response.status, 200)
                self.assertIn(INTENT, text)
                if caller == "review":
                    self.assertNotIn(CLAIM, text); self.assertNotIn(PRIOR, text)
                    self.assertIn("quantity of -1", text)
                else:
                    self.assertIn(CLAIM, text)

    async def test_queue_fresh_session_preserves_provider_settings_without_history(self):
        factory = AsyncMock(return_value={"id": "fresh-review", "tags": '["capability_testing","independent_review"]'})
        ns = load_functions("server.py", {"_fresh_test_queue_worker"},
                            _session_tags_from_value=lambda _: ["tester_headed"],
                            _create_capability_worker=factory, CAPABILITY_HANDOFFS={"testing": {"label": "Testing"}},
                            broadcast=AsyncMock())
        review_id = await ns["_fresh_test_queue_worker"](self.db, "ws", "worker", "task")
        self.assertEqual(review_id, "fresh-review")
        args = factory.await_args.args
        self.assertEqual(args[4]["cli_type"], "claude")
        self.assertEqual(args[4]["reviewed_session_id"], "worker")
        self.assertIn("independent_review", args[-1])
        self.assertNotIn("system_prompt", args[4])


if __name__ == "__main__":
    unittest.main()
