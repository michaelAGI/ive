import asyncio
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from unittest.mock import AsyncMock, MagicMock
from types import SimpleNamespace
from device_adapter import DeviceError, AppleDeviceAdapter, png_size
from device_hub import DeviceHub, action_command
from device_hub_routes import register, HUB
from device_tools import build_tools

D = "11111111-1111-1111-1111-111111111111"
E = "22222222-2222-2222-2222-222222222222"
PNG = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR" + struct.pack(">II", 100, 200)


class FakeAdapter:
    def __init__(self):
        self.devices = [dict(id="apple:" + D, provider_device_id=D, name="Test iPhone", model="iPhone", platform="iOS",
            os_version="27.0.1", kind="physical", connected=True, developer_mode="enabled", pairing="paired", transport="wired")]
        self.commands = []
        self.cancelled = []
        self.size = (100, 200)
        self.failure = None
        self.delay = None
        self.checks = dict(supported_mac=True, xcode_ready=True, helper_ready=True)
        self.inventory_calls = 0
        self.capture_calls = 0
    async def inventory(self):
        self.inventory_calls += 1
        return self.devices
    async def prerequisites(self): return dict(self.checks)
    async def observe(self, device, key):
        self.capture_calls += 1
        return PNG, *self.size
    async def act(self, device, command, key):
        self.commands.append((device, command))
        if self.delay: await self.delay.wait()
        if self.failure: raise self.failure
    async def prepare(self):
        if self.delay: await self.delay.wait()
        return dict(state="ready", message="Prepared")
    async def pair(self, device): return dict(state="needs_user", message="Trust the Mac")
    def cancel(self, key): self.cancelled.append(key)
    async def close(self): pass


class HubTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.adapter = FakeAdapter()
        self.now = 1000
        self.hub = DeviceHub(self.temp.name, self.adapter, lambda: self.now)
        self.addAsyncCleanup(self.hub.close)
    async def ready(self, session="agent"):
        await self.hub.assign(D, session)
        return await self.hub.observe(D, session)
    def command(self, frame, **extra):
        return dict(action="tap", arguments={"x": .2, "y": .3}, command_id="command-one", frame_id=frame["frame_id"], **extra)
    async def test_pairing_alone_never_grants_agent_access(self):
        with self.assertRaises(DeviceError): await self.hub.observe(D, "agent")
        self.assertEqual((await self.hub.status("agent"))["devices"], [])
    async def test_other_agent_cannot_observe_or_replace_assignment(self):
        await self.ready()
        with self.assertRaises(DeviceError): await self.hub.observe(D, "other")
        with self.assertRaises(DeviceError): await self.hub.assign(D, "other")
    async def test_real_frame_required_and_consumed_by_input(self):
        frame = await self.ready()
        value = await self.hub.act(D, "agent", self.command(frame))
        self.assertEqual(value["state"], "submitted")
        with self.assertRaises(DeviceError):
            await self.hub.act(D, "agent", {**self.command(frame), "command_id": "command-two"})
        self.assertEqual(len(self.adapter.commands), 1)
    async def test_preview_does_not_break_agents_inflight_observation(self):
        frame = await self.ready()
        preview = await self.hub.observe(D)
        self.assertNotEqual(frame["frame_id"], preview["frame_id"])
        await self.hub.act(D, "agent", self.command(frame))
        self.assertEqual(len(self.adapter.commands), 1)
    async def test_old_and_rotated_frames_never_send_touch(self):
        frame = await self.ready()
        self.now += 46
        with self.assertRaises(DeviceError): await self.hub.act(D, "agent", self.command(frame))
        frame = await self.hub.observe(D, "agent")
        self.adapter.size = (200, 100)
        with self.assertRaises(DeviceError): await self.hub.act(D, "agent", self.command(frame))
        self.assertFalse(self.adapter.commands)
    async def test_retransmitted_command_is_not_sent_twice(self):
        frame = await self.ready()
        first = await self.hub.act(D, "agent", self.command(frame))
        second = await self.hub.act(D, "agent", self.command(frame))
        self.assertEqual(first['state'], second['state'])
        self.assertEqual(first['command_id'], second['command_id'])
        self.assertTrue(second['replayed'])
        self.assertNotIn('frame_id', second)  # Never offer an old frame as fresh.
        self.assertEqual(len(self.adapter.commands), 1)
        with self.assertRaises(DeviceError):
            await self.hub.act(D, "agent", {**self.command(frame), "arguments": {"x": .8, "y": .3}})
    async def test_uncertain_failure_is_durable_and_not_replayed_after_restart(self):
        frame = await self.ready()
        self.adapter.failure = DeviceError("outcome_unknown", "Timed out")
        result = await self.hub.act(D, "agent", self.command(frame))
        self.assertEqual(result["state"], "outcome_unknown")
        other = DeviceHub(self.temp.name, self.adapter, lambda: self.now)
        await other.assign(D, "agent")
        replay = await other.act(D, "agent", self.command(frame))
        self.assertEqual(replay['state'], result['state'])
        self.assertEqual(replay['code'], result['code'])
        self.assertTrue(replay['replayed'])
        self.assertEqual(len(self.adapter.commands), 1)
        self.assertEqual(self.hub.journal.stat().st_mode & 0o777, 0o600)
    async def test_unreadable_history_cannot_silently_replay_input(self):
        self.hub.root.mkdir(parents=True)
        self.hub.journal.write_text('{broken')
        other = DeviceHub(self.temp.name, self.adapter, lambda: self.now)
        await other.assign(D, 'agent')
        frame = await other.observe(D, 'agent')
        with self.assertRaises(DeviceError) as caught:
            await other.act(D, 'agent', self.command(frame))
        self.assertEqual(caught.exception.code, 'history_unavailable')
        self.assertFalse(self.adapter.commands)
    async def test_stop_cancels_input_and_requires_fresh_assignment(self):
        frame = await self.ready()
        self.adapter.delay = asyncio.Event()
        pending = asyncio.create_task(self.hub.act(D, "agent", self.command(frame)))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.hub.revoke(D)
        self.adapter.delay.set()
        try:
            result = await pending
            self.assertEqual(result["state"], "outcome_unknown")
        except DeviceError as exc:
            self.assertEqual(exc.code, "control_stopped")
        with self.assertRaises(DeviceError): await self.hub.observe(D, "agent")
        self.assertIn(D, self.adapter.cancelled)
    async def test_disappeared_device_revokes_access(self):
        await self.ready()
        self.adapter.devices = []
        self.now += 3  # Connection inventory has a two-second bound.
        with self.assertRaises(DeviceError): await self.hub.observe(D, "agent")
        self.assertNotIn(D, self.hub.assignments)
    async def test_status_revokes_missing_devices_and_never_marks_old_ios_ready(self):
        await self.ready()
        self.adapter.devices[0]['os_version'] = '26.0'
        self.assertFalse((await self.hub.status(refresh=True))['devices'][0]['control_available'])
        self.adapter.devices = []
        await self.hub.status(refresh=True)
        self.assertFalse(self.hub.assignments)
    async def test_lease_expiring_during_capture_never_sends_input(self):
        frame = await self.ready()
        async def delayed_observation(*args):
            self.now += 3601
            return PNG, 100, 200
        self.adapter.observe = delayed_observation
        with self.assertRaises(DeviceError): await self.hub.act(D, 'agent', self.command(frame))
        self.assertFalse(self.adapter.commands)
    async def test_expired_assignment_cannot_control(self):
        frame = await self.ready()
        self.now += 3601
        with self.assertRaises(DeviceError): await self.hub.act(D, "agent", self.command(frame))
        self.assertFalse(self.adapter.commands)
    async def test_setup_is_user_granted_and_bound_to_one_device(self):
        with self.assertRaises(DeviceError): await self.hub.setup_action("agent", "prepare")
        self.hub.setup_grant("agent", D)
        with self.assertRaises(DeviceError): await self.hub.setup_action("other", "prepare")
        with self.assertRaises(DeviceError): await self.hub.setup_action("agent", "pair", E)
    async def test_setup_checks_screen_then_honors_user_control_choice(self):
        for control in (False, True):
            self.hub.setup_grant("agent", D, control)
            await self.hub.setup_action("agent", "verify", D)
            await self.hub.setup_task
            self.assertEqual(self.hub.setup["state"], "ready")
            self.assertEqual(D in self.hub.assignments, control)
    async def test_setup_stop_does_not_resume_or_regrant(self):
        self.adapter.delay = asyncio.Event()
        self.hub.setup_grant("agent", D, True)
        await self.hub.setup_action("agent", "prepare")
        await asyncio.sleep(0)
        self.hub.stop_setup()
        self.adapter.delay.set()
        await self.hub.setup_task
        self.assertIsNone(self.hub.setup)
        self.assertFalse(self.hub.assignments)
    async def test_preparing_mac_is_not_final_setup_success(self):
        self.hub.setup_grant('agent', D, True)
        await self.hub.setup_action('agent', 'prepare')
        await self.hub.setup_task
        self.assertEqual(self.hub.setup['state'], 'step_complete')
        self.assertFalse(self.hub.assignments)
    async def test_releasing_control_cannot_reuse_completed_setup_grant(self):
        self.hub.setup_grant('agent', D, True)
        await self.hub.setup_action('agent', 'verify', D)
        await self.hub.setup_task
        self.hub.revoke(D)
        with self.assertRaises(DeviceError): await self.hub.setup_action('agent', 'verify', D)
    async def test_setup_does_not_guess_between_two_connected_phones(self):
        self.adapter.devices.append({**self.adapter.devices[0], "provider_device_id": E})
        self.hub.setup_grant("agent")
        with self.assertRaises(DeviceError): await self.hub.setup_action("agent", "pair")
        with self.assertRaises(DeviceError): await self.hub.setup_action("agent", "pair", D)
    async def test_slow_preparation_cannot_dispatch_expired_frame(self):
        frame = await self.ready()
        async def delayed_observation(*args):
            self.now += 46
            return PNG, 100, 200
        self.adapter.observe = delayed_observation
        with self.assertRaises(DeviceError) as caught:
            await self.hub.act(D, 'agent', self.command(frame))
        self.assertEqual(caught.exception.code, 'fresh_frame_required')
        self.assertFalse(self.adapter.commands)

    async def test_actions_return_the_next_usable_frame_without_extra_observe_calls(self):
        frame = await self.ready()
        first = await self.hub.act(D, 'agent', self.command(frame))
        self.assertIn('image_base64', first)
        self.assertNotEqual(first['frame_id'], frame['frame_id'])
        second = await self.hub.act(D, 'agent', {**self.command(first), 'command_id': 'command-two'})
        self.assertNotEqual(first['frame_id'], second['frame_id'])
        self.assertEqual(len(self.adapter.commands), 2)
        self.assertEqual(self.adapter.inventory_calls, 1)
        self.assertEqual(self.adapter.capture_calls, 5)  # Initial + orientation/result for each tap.
        self.assertFalse(second['screen_changed'])  # The fixture image is unchanged.
        self.assertGreaterEqual(second['timings_ms']['total_ms'], 0)

    async def test_failed_post_action_capture_never_resubmits_input(self):
        frame = await self.ready()
        original = self.adapter.observe
        async def observe(*args):
            if self.adapter.capture_calls == 2:
                raise DeviceError('device_command_failed', 'Screenshot unavailable')
            return await original(*args)
        self.adapter.observe = observe
        result = await self.hub.act(D, 'agent', self.command(frame))
        self.assertEqual(result['state'], 'submitted')
        self.assertIn('observation_error', result)
        self.assertNotIn('frame_id', result)
        self.assertNotIn(D, self.hub.frames)
        self.assertIsNone(self.hub.inventory_cache)
        replay = await self.hub.act(D, 'agent', self.command(frame))
        self.assertTrue(replay['replayed'])
        self.assertEqual(len(self.adapter.commands), 1)

    async def test_stop_during_post_action_capture_discards_image(self):
        frame = await self.ready()
        original = self.adapter.observe
        async def observe(*args):
            if self.adapter.capture_calls == 2:
                self.hub.revoke(D)
            return await original(*args)
        self.adapter.observe = observe
        result = await self.hub.act(D, 'agent', self.command(frame))
        self.assertEqual(result['state'], 'outcome_unknown')
        self.assertNotIn('image_base64', result)
        self.assertFalse(self.hub.frames)
        self.assertEqual(len(self.adapter.commands), 1)

    async def test_opt_out_consumes_frame_and_requires_an_explicit_observation(self):
        frame = await self.ready()
        result = await self.hub.act(D, 'agent', self.command(frame, observe_after=False))
        self.assertNotIn('frame_id', result)
        self.assertNotIn(D, self.hub.frames)
        self.assertEqual(self.adapter.capture_calls, 2)

    async def test_capture_error_invalidates_discovery_before_any_later_input(self):
        await self.ready()
        self.adapter.observe = AsyncMock(side_effect=DeviceError('device_command_failed', 'Disconnected'))
        with self.assertRaises(DeviceError):
            await self.hub.observe(D, 'agent')
        self.adapter.devices = []
        with self.assertRaises(DeviceError):
            await self.hub.observe(D, 'agent')
        self.assertNotIn(D, self.hub.assignments)
        self.assertEqual(self.adapter.inventory_calls, 2)

    async def test_inventory_cache_is_bounded_and_does_not_cache_leases(self):
        await self.ready()
        rows = await self.hub.inventory()
        rows[0]['developer_mode'] = 'disabled'
        self.assertEqual((await self.hub.find(D))['developer_mode'], 'enabled')
        self.assertEqual(self.adapter.inventory_calls, 1)
        self.now += 3
        await self.hub.inventory()
        self.assertEqual(self.adapter.inventory_calls, 2)
        self.hub.revoke(D)
        with self.assertRaises(DeviceError):
            await self.hub.observe(D, 'agent')

    async def test_waiting_for_setup_does_not_cancel_or_repeat_the_job(self):
        self.adapter.delay = asyncio.Event()
        self.hub.setup_grant('agent', D)
        await self.hub.setup_action('agent', 'prepare')
        job = self.hub.setup_task
        waiting = await self.hub.setup_action('agent', 'check', wait_seconds=.001)
        self.assertEqual(waiting['setup']['state'], 'running')
        self.assertFalse(job.cancelled())
        self.adapter.delay.set()
        completed = await self.hub.setup_action('agent', 'check', wait_seconds=20)
        self.assertEqual(completed['setup']['state'], 'step_complete')
        self.assertIs(job, self.hub.setup_task)

    async def test_invalid_waits_cannot_start_setup(self):
        self.hub.setup_grant('agent', D)
        for wait in (-1, 21, True, '20', float('nan')):
            with self.subTest(wait=wait), self.assertRaises(DeviceError):
                await self.hub.setup_action('agent', 'check', wait_seconds=wait)
        self.assertIsNone(self.hub.setup_task)


class AdapterCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_prerequisites_are_shared_cached_and_invalidatable(self):
        with tempfile.TemporaryDirectory() as folder:
            now = [100]
            adapter = AppleDeviceAdapter(folder, clock=lambda: now[0])
            adapter._prerequisites = AsyncMock(return_value={'helper_ready': False})
            await asyncio.gather(adapter.prerequisites(), adapter.prerequisites())
            await adapter.prerequisites()
            self.assertEqual(adapter._prerequisites.await_count, 1)
            adapter.invalidate_prerequisites()
            adapter._prerequisites.return_value = {'helper_ready': True}
            now[0] = 101
            self.assertTrue((await adapter.prerequisites())['helper_ready'])
            now[0] = 132
            await adapter.prerequisites()
            self.assertEqual(adapter._prerequisites.await_count, 3)


class ValidationTests(unittest.TestCase):
    def test_mcp_timeout_covers_input_plus_following_capture(self):
        import worker_mcp_server as worker
        import mcp_server as commander
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{}'
        for module in (worker, commander):
            for path, timeout in [('/device-hub/act', 90), ('/device-hub/observe', 60), ('/sessions', 30)]:
                with self.subTest(module=module.__name__, path=path), patch('urllib.request.urlopen', return_value=response) as request:
                    module.api_call('POST', path, {})
                    self.assertEqual(request.call_args.kwargs['timeout'], timeout)

    def test_bad_coordinates_commands_and_text_rejected_before_execution(self):
        for action, args in [("tap", {"x": True, "y": 0}), ("tap", {"x": float("nan"), "y": 0}),
            ("tap", {"x": 1.1, "y": 0}), ("tap", {"x": ";rm -rf", "y": 0}), ("shell", {"command": "whoami"}),
            ("type_text", {"text": "x\x00y"}), ("key", {"key": "power"})]:
            with self.subTest(action=action, args=args), self.assertRaises(DeviceError): action_command(action, args)
        self.assertEqual(action_command("type_text", {"text": "hello; $(whoami)"}), ["text", "hello; $(whoami)"])
    def test_image_must_be_png_with_sane_dimensions(self):
        self.assertEqual(png_size(PNG), (100, 200))
        for data in [b"broken", PNG[:16] + struct.pack(">II", 999999, 20)]:
            with self.assertRaises(DeviceError): png_size(data)
    def test_mcp_emits_image_and_frame_metadata_together(self):
        tools = build_tools(lambda *args: {"image_base64": "aW1hZ2U=", "frame_id": "frame-123"})
        for tool in ('device_observe', 'device_act'):
            result = tools[tool]["handler"]({"device_id": D})
            self.assertEqual([x["type"] for x in result["_mcp_content"]], ["text", "image"])
            self.assertIn('frame-123', result["_mcp_content"][0]["text"])
    def test_mcp_preserves_errors_as_errors(self):
        tools = build_tools(lambda *args: {"error": "Not assigned", "status": 403})
        self.assertTrue(tools["device_act"]["handler"]({})["_mcp_error"])
    def test_worker_roles_and_commander_publish_the_same_device_contract(self):
        import worker_mcp_server as worker
        import mcp_server as commander
        worker_tools, sources = worker.compose_tool_registry('worker')
        for name in build_tools(lambda *args: {}):
            self.assertEqual(worker_tools[name]['inputSchema'], commander.TOOLS[name]['inputSchema'])
            self.assertEqual(sources[name], 'device-hub')
        for role in ('brainstormer', 'planner', 'architect', 'secure'):
            self.assertNotIn('device_act', worker.compose_tool_registry(role)[0])
    def test_real_mcp_dispatchers_preserve_image_content_and_error_status(self):
        import worker_mcp_server as worker
        import mcp_server as commander
        for payload, error in [({'frame_id': 'fresh', 'image_base64': 'aW1hZ2U='}, False), ({'error': 'Stopped'}, True)]:
            registry = build_tools(lambda *args: dict(payload))
            for module, dispatch in ((worker, worker.handle_request), (commander, commander.handle_jsonrpc)):
                with patch.object(module, 'TOOLS', registry):
                    result = dispatch({'id': 1, 'method': 'tools/call', 'params': {'name': 'device_observe', 'arguments': {'device_id': D}}})['result']
                self.assertEqual(result['isError'], error)
                self.assertEqual([item['type'] for item in result['content']], ['text'] if error else ['text', 'image'])
    def test_device_mutations_are_not_classified_as_read_only(self):
        from tool_semantics import classify_tool_call
        for name, operation in [('device_list', 'read'), ('device_observe', 'read'), ('device_act', 'execute'), ('device_setup', 'execute')]:
            self.assertEqual(classify_tool_call('mcp__worker-board__' + name, {}).operation, operation)


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.row = dict(id="agent", cli_type="claude", permission_mode="bypassPermissions")
        async def get_session(sid): return dict(self.row) if sid == "agent" else None
        @web.middleware
        async def auth(request, handler):
            if request.headers.get("Test-Owner") == "yes": request["auth"] = {"owner": True}
            return await handler(request)
        app = web.Application(middlewares=[auth])
        register(app, data_dir=self.temp.name, get_session=get_session, local_owner=lambda req, ctx: ctx.get("owner"))
        self.hub = app[HUB]
        self.hub.adapter = FakeAdapter()
        # Exercise the registered HTTP handlers without opening a local socket.
        # This also runs in environments that disallow binding test servers.
        async def post(path, json=None, headers=None):
            request = make_mocked_request("POST", path, headers=headers or {}, app=app)
            request._match_info = await app.router.resolve(request)
            request.json = AsyncMock(return_value=json)
            if (headers or {}).get("Test-Owner") == "yes": request["auth"] = {"owner": True}
            response = await request.match_info.handler(request)
            async def body():
                import json as codec
                return codec.loads(response.body)
            return SimpleNamespace(status=response.status, json=body)
        self.client = SimpleNamespace(post=post)
        self.addAsyncCleanup(self.hub.close)
        self.owner = {"Test-Owner": "yes"}
        self.agent = {"Test-Owner": "yes", "X-IVE-Session-Id": "agent", "X-IVE-Session-Type": "worker", "X-IVE-Session-Proof": "valid"}
    async def test_remote_and_agent_cannot_grant_themselves_access(self):
        for headers in [{}, self.agent]:
            r = await self.client.post('/api/device-hub/assign', json={"device_id": D, "session_id": "agent"}, headers=headers)
            self.assertEqual(r.status, 403)
        self.assertFalse(self.hub.assignments)
    async def test_legacy_or_forged_proof_cannot_observe(self):
        await self.hub.assign(D, "agent")
        for proof_state in ["legacy", "mismatch"]:
            with patch('device_hub_routes.session_proofs.check', return_value=proof_state):
                r = await self.client.post('/api/device-hub/observe', json={"device_id": D}, headers=self.agent)
                self.assertEqual(r.status, 403)
    async def test_real_route_owner_assign_agent_observe_then_stop(self):
        r = await self.client.post('/api/device-hub/assign', json={"device_id": D, "session_id": "agent"}, headers=self.owner)
        self.assertEqual(r.status, 200)
        with patch('device_hub_routes.session_proofs.check', return_value="ok"):
            r = await self.client.post('/api/device-hub/observe', json={"device_id": D}, headers=self.agent)
            self.assertEqual(r.status, 200)
            self.assertIn("frame_id", await r.json())
        await self.client.post('/api/device-hub/unassign', json={"device_id": D}, headers=self.owner)
        self.assertFalse(self.hub.assignments)
    async def test_changing_to_plan_mode_blocks_device_input(self):
        frame = await self.hub.assign(D, "agent")
        self.row["permission_mode"] = "plan"
        with patch('device_hub_routes.session_proofs.check', return_value="ok"):
            r = await self.client.post('/api/device-hub/act', json={"device_id": D}, headers=self.agent)
            self.assertEqual(r.status, 403)
        self.assertFalse(self.hub.adapter.commands)


if __name__ == '__main__': unittest.main()
