"""Real PTY round trip, deterministic local CLI fixture; no account or model."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import hooks
import server
from output_capture import OutputCaptureProcessor
from pty_manager import PTYManager
from test_input_contract_review import Request


CLI = r'''
import json, os, select, sys, time, tty
from datetime import datetime, timezone
tty.setraw(0)
path = sys.argv[1]
buf, active, number, until = b'', None, 0, 0
def record(kind, payload):
    with open(path, 'a') as f:
        f.write(json.dumps({'timestamp': datetime.now(timezone.utc).isoformat(), 'type': kind, 'payload': payload}) + '\n')
def screen(text):
    os.write(1, ('\x1b[2J\x1b[H' + text.replace('\n', '\r\n')).encode())
def ready(text=''):
    screen(text + '\n\n› Ask Codex to do anything\nGPT fixture · isolated\n? for shortcuts')
ready()
while True:
    if active and time.monotonic() >= until:
        record('response_item', {'type': 'message', 'role': 'assistant', 'phase': 'final_answer', 'content': [{'type': 'output_text', 'text': 'Reply ' + active}]})
        record('event_msg', {'type': 'task_complete', 'turn_id': active})
        ready('Reply ' + active + '\nWorked for 1s')
        active = None
    if not select.select([0], [], [], .01)[0]:
        continue
    for byte in os.read(0, 4096):
        if byte == 27:
            if active:
                record('event_msg', {'type': 'turn_aborted', 'turn_id': active})
                active = None
                ready('Interrupted')
            continue
        if byte == 127:
            buf = buf[:-1]
        elif byte in (10, 13):
            if not buf:
                continue
            number += 1
            active = str(number)
            record('event_msg', {'type': 'task_started', 'turn_id': active})
            record('response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': buf.decode()}]})
            buf = b''
            until = time.monotonic() + .6
            screen('› submitted\nWorking… esc to interrupt')
        else:
            buf += bytes([byte])
'''


class RealPTYSyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_then_terminal_reply_then_terminal_abort_share_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            sid = 'isolated-pty-sync'
            script, rollout = Path(tmp, 'fixture.py'), Path(tmp, 'rollout.jsonl')
            script.write_text(CLI)
            mgr, capture = PTYManager(), OutputCaptureProcessor()
            events = AsyncMock()
            hooks._get_state(sid)
            async def output(session_id, data):
                await capture.process(session_id, data)
                if b'esc to interrupt' in data:
                    await hooks._handle_prompt_submit(session_id, {})
            mgr.on_output(output)
            config = {'id': sid, 'cli_type': 'codex', 'native_session_id': 'fixture', 'workspace_path': tmp}
            async def until(check):
                async with asyncio.timeout(6):
                    while not check():
                        await asyncio.sleep(.02)
            def records():
                return [json.loads(line) for line in rollout.read_text().splitlines()] if rollout.exists() else []
            with patch.object(server, 'pty_mgr', mgr), \
                 patch.object(server, 'capture_proc', capture), \
                 patch.object(server, 'get_session_config', AsyncMock(return_value=config)), \
                 patch.object(server, '_cached_session_cli_type', AsyncMock(return_value='codex')), \
                 patch.object(server, '_get_native_transcript_path', return_value=rollout), \
                 patch.object(server, '_get_visible_session_for_request', AsyncMock(return_value=config)), \
                 patch.object(server, '_session_cli_type', AsyncMock(return_value='codex')), \
                 patch.object(server, 'get_auth', return_value=None), \
                 patch.object(server, '_terminal_control_violation', return_value=None), \
                 patch.object(hooks, '_broadcast', events):
                watcher = None
                try:
                    await mgr.start_session(sid, tmp, cmd_binary=sys.executable, cmd_args=[str(script), str(rollout)])
                    await until(lambda: 'Ask Codex' in capture.get_screen(sid))
                    watcher = asyncio.create_task(server._codex_turn_sync_loop())
                    # Actual REST input handler writes clear/text/Enter into the real PTY.
                    request = Request({'message': 'From chat', 'ready_timeout': 2})
                    request.match_info['id'] = sid
                    self.assertEqual((await server.send_session_input(request)).status, 200)
                    await until(lambda: any(r['payload'].get('type') == 'task_complete' for r in records()))
                    await until(lambda: hooks.get_session_logical_status(sid, True, 'running') == 'idle')
                    # Same process, native transcript and state through raw terminal input.
                    self.assertTrue(mgr.write(sid, b'From terminal\r'))
                    await until(lambda: sum(r['payload'].get('type') == 'task_complete' for r in records()) == 2)
                    await until(lambda: hooks.get_session_logical_status(sid, True, 'running') == 'idle')
                    self.assertIn('Reply 2', capture.get_screen(sid))
                    user_texts = [r['payload']['content'][0]['text'] for r in records() if r['payload'].get('role') == 'user']
                    self.assertEqual(user_texts, ['From chat', 'From terminal'])
                    self.assertEqual(hooks._hook_sessions[sid]['turns_completed'], 2)
                    self.assertTrue(mgr.write(sid, b'Cancel from terminal\r'))
                    await until(lambda: hooks._hook_sessions[sid]['state'] == 'working')
                    self.assertTrue(mgr.write(sid, b'\x1b'))
                    await until(lambda: hooks._hook_sessions[sid]['state'] == 'idle')
                    self.assertTrue(any(c.args[0].get('interrupted') for c in events.call_args_list))
                    self.assertEqual(hooks._hook_sessions[sid]['turns_completed'], 2)
                finally:
                    if watcher:
                        watcher.cancel()
                        try:
                            await watcher
                        except asyncio.CancelledError:
                            pass
                    await mgr.stop_all()
                    hooks.cleanup_session(sid)


if __name__ == '__main__':
    unittest.main()
