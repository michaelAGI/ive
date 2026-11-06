"""Lifecycle events retain their order across asynchronous authorization IO."""
import asyncio
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import hooks
import server


class EventOrderTests(unittest.IsolatedAsyncioTestCase):
    async def test_delayed_interrupt_does_not_reset_the_next_turn(self):
        sid = 'interrupt-order-test'
        hooks._get_state(sid)['state'] = 'working'
        self.addCleanup(hooks.cleanup_session, sid)
        events = []
        async def broadcast(event):
            events.append(event)
            if event['type'] == 'prompt_state':
                await hooks._handle_prompt_submit(sid, {})
        with patch.object(hooks, '_broadcast', side_effect=broadcast):
            self.assertFalse(await hooks.mark_interrupted(sid))
        self.assertEqual([e['state'] for e in events if e['type'] == 'session_state'], ['working'])

    async def test_slow_scope_lookup_cannot_deliver_working_after_idle(self):
        entered, release = asyncio.Event(), asyncio.Event()
        sent = []
        calls = 0
        async def config(sid):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                await release.wait()
            return {"id": sid, "workspace_id": "w", "tags": "[]"}
        class Socket:
            _ive_auth_ctx = SimpleNamespace(is_owner=True)
            async def send_str(self, data):
                sent.append(json.loads(data))
        with patch.object(server, "get_session_config", side_effect=config), \
             patch.object(server, "ws_clients", {Socket()}), \
             patch.object(server, "_session_readable_to_auth", return_value=True):
            first = asyncio.create_task(server.broadcast({"type": "session_state", "session_id": "s", "state": "working"}))
            await entered.wait()
            second = asyncio.create_task(server.broadcast({"type": "session_state", "session_id": "s", "state": "idle"}))
            await asyncio.sleep(0.01)
            release.set()
            await asyncio.gather(first, second)
        self.assertEqual([e["state"] for e in sent], ["working", "idle"])

    async def test_slow_stop_contributor_cannot_reset_a_new_turn(self):
        sid = "stop-order-test"
        entered, release = asyncio.Event(), asyncio.Event()
        events = []
        async def contributor(_):
            entered.set()
            await release.wait()
        async def broadcast(event):
            events.append(event)
        hooks._get_state(sid)["state"] = "working"
        self.addCleanup(hooks.cleanup_session, sid)
        with patch.object(hooks, "_notify_session_settled", side_effect=contributor), \
             patch.object(hooks, "_broadcast", side_effect=broadcast):
            stop = asyncio.create_task(hooks._handle_stop(sid, {}))
            await entered.wait()
            await hooks._handle_prompt_submit(sid, {})
            release.set()
            await stop
        states = [e["state"] for e in events if e["type"] == "session_state"]
        self.assertEqual(states[-1], "working")
        self.assertEqual(hooks._hook_sessions[sid]["state"], "working")


if __name__ == "__main__":
    unittest.main()
