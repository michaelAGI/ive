"""While a CLI menu is on screen, only a reviewed reply reaches the PTY."""
import ast
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from aiohttp import web
from test_input_contract_review import Request
from test_session_prompt_guard import MENU


class QuestionOpenTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.screen, self.writes, self.cli = MENU, [], 'claude'
        self.config = {'id': 'session', 'cli_type': 'claude'}
        self.ns = {
            're': re, 'web': web, '_terminal_streams': {'session': object()}, '_session_prompt_replies': {},
            'capture_proc': SimpleNamespace(get_screen=lambda _: self.screen),
            'pty_mgr': SimpleNamespace(is_alive=lambda _: True, write=self.write),
            '_asyncio': SimpleNamespace(sleep=AsyncMock()),
            '_get_visible_session_for_request': AsyncMock(side_effect=lambda *_: self.config),
            'get_auth': lambda _: None, '_terminal_control_violation': lambda *_: None,
            '_session_cli_type': AsyncMock(side_effect=lambda _: self.cli),
            '_is_auth_recovery_input': Mock(return_value=False), '_broadcast_auth_recovery': AsyncMock(),
            '_wait_for_cli_input_ready': AsyncMock(return_value=True),
            '_detect_cli_startup_blocker': lambda *_: None, '_startup_blocker_text': lambda _: '',
            '_session_prompt_answered': AsyncMock(),
        }
        names = {'_canonical_prompt_screen', '_session_permission_menu', '_is_incomplete_permission_screen',
                 '_send_guarded_session_prompt', 'send_session_input'}
        tree = ast.parse(Path(__file__).with_name('server.py').read_text())
        nodes = [n for n in tree.body if (isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and (n.name in names or n.name.startswith('_dialog_')))
                 or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id.startswith('_DIALOG_') for t in n.targets))]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'server.py', 'exec'), self.ns)
        self.send = self.ns['send_session_input']
        self.identity = self.ns['_session_permission_menu'](MENU)['identity']

    def write(self, _, data):
        self.writes.append(data)
        if data in (b'\x1b[B', b'\x1b[A'):
            menu = self.ns['_session_permission_menu'](self.screen)
            before = int(menu['selected'])
            after = before + (1 if data == b'\x1b[B' else -1)
            self.screen = self.screen.replace(f' ❯ {before}.', f'   {before}.').replace(f'   {after}.', f' ❯ {after}.')
        return True

    async def send_body(self, **body):
        return await self.send(Request({'ready_timeout': 0, **body}))

    async def test_plain_text_is_refused_while_a_menu_is_open(self):
        for message in ('hello', '2', 'yes', 'n', '/login', 'Plan looks good, proceed with implementation.'):
            with self.subTest(message=message):
                response = await self.send_body(message=message)
                self.assertEqual(response.status, 409)
                payload = json.loads(response.text)
                self.assertEqual(payload['code'], 'question_open')
                self.assertEqual(payload['session_id'], 'session')
                self.assertEqual(payload['menu']['identity'], self.identity)
                self.assertEqual(payload['menu']['selected'], '1')
                self.assertEqual(self.writes, [])
        self.ns['_is_auth_recovery_input'].assert_not_called()
        self.ns['_broadcast_auth_recovery'].assert_not_awaited()
        self.ns['_session_prompt_answered'].assert_not_awaited()

    async def test_bare_choice_without_identity_is_refused(self):
        response = await self.send_body(choice='2')
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.text)['code'], 'question_open')
        self.assertEqual(self.writes, [])

    async def test_codex_menu_is_guarded_too(self):
        self.cli = 'codex'
        response = await self.send_body(message='continue')
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.text)['code'], 'question_open')
        self.assertEqual(self.writes, [])

    async def test_choice_with_identity_takes_the_guarded_path(self):
        response = await self.send_body(choice='2', expected_identity=self.identity)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.writes, [b'\x1b[B', b'\r'])
        self.assertEqual(self.ns['_session_permission_menu'](self.screen)['selected'], '2')
        answered = self.ns['_session_prompt_answered']
        answered.assert_awaited_once()
        self.assertEqual(answered.await_args.args[0], 'session')
        self.assertEqual(answered.await_args.args[1]['identity'], self.identity)

    async def test_legacy_message_with_identity_walks_from_the_real_cursor(self):
        self.screen = MENU.replace(' ❯ 1.', '   1.').replace('   2.', ' ❯ 2.')
        response = await self.send_body(message='3', expected_identity=self.identity)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.writes, [b'\x1b[B', b'\r'])

    async def test_legacy_screen_reply_still_works(self):
        response = await self.send_body(message='1', expected_screen=MENU)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.writes, [b'\r'])
        self.ns['_session_prompt_answered'].assert_awaited_once()

    async def test_stale_identity_never_writes(self):
        response = await self.send_body(choice='1', expected_identity=self.identity.replace('test-task', 'other-task'))
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.text)['code'], 'stale_session_prompt')
        self.assertEqual(self.writes, [])
        self.ns['_session_prompt_answered'].assert_not_awaited()

    async def test_identity_without_a_menu_on_screen_is_stale(self):
        self.screen = 'Claude Code\n❯ '
        response = await self.send_body(choice='1', expected_identity=self.identity)
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.text)['code'], 'stale_session_prompt')
        self.assertEqual(self.writes, [])

    async def test_choice_outside_the_menu_is_invalid(self):
        for choice in ('4', 'yes', '1\n'):
            with self.subTest(choice=choice):
                response = await self.send_body(choice=choice, expected_identity=self.identity)
                self.assertEqual(response.status, 400)
                self.assertEqual(self.writes, [])

    async def test_double_click_is_refused_until_the_screen_changes(self):
        self.assertEqual((await self.send_body(choice='1', expected_identity=self.identity)).status, 200)
        self.assertEqual((await self.send_body(choice='1', expected_identity=self.identity)).status, 409)
        self.assertEqual(self.writes, [b'\r'])
        # The CLI asks the very same question again later: a new screen, a new answer.
        self.screen = 'Old transcript\n' + MENU
        self.assertEqual((await self.send_body(choice='1', expected_identity=self.identity)).status, 200)
        self.assertEqual(self.writes, [b'\r', b'\r'])

    async def test_letter_keys_walk_by_position(self):
        # A Codex-style menu: keys are letters, the walk steps by index in either direction.
        keys, state = ['y', 'a', 'n'], {'selected': 'y'}
        self.ns['_session_permission_menu'] = lambda screen: {
            'choices': tuple(keys), 'selected': state['selected'], 'identity': 'codex-run',
            'options': [{'key': k, 'label': k, 'selected': k == state['selected']} for k in keys],
        } if 'Would you like to run' in screen else None

        def write(_, data):
            self.writes.append(data)
            if data in (b'\x1b[B', b'\x1b[A'):
                state['selected'] = keys[keys.index(state['selected']) + (1 if data == b'\x1b[B' else -1)]
            return True
        self.ns['pty_mgr'].write = write
        self.screen = 'Would you like to run the following command?\n› y. Yes\n  a. Always\n  n. No'
        self.assertEqual((await self.send_body(choice='n', expected_identity='codex-run')).status, 200)
        self.assertEqual(self.writes, [b'\x1b[B', b'\x1b[B', b'\r'])
        self.assertEqual(state['selected'], 'n')
        self.writes.clear()
        self.screen += '\nredrawn'
        self.assertEqual((await self.send_body(choice='y', expected_identity='codex-run')).status, 200)
        self.assertEqual(self.writes, [b'\x1b[A', b'\x1b[A', b'\r'])

    async def test_raw_keystrokes_are_the_terminal_itself(self):
        response = await self.send_body(message='\x1b[B', raw=True)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.writes, [b'\x1b[B'])

    async def test_shell_and_gemini_are_untouched(self):
        self.config = {'id': 'session', 'cli_type': 'shell'}
        self.assertEqual((await self.send_body(message='ls')).status, 200)
        self.assertEqual(self.writes, [b'ls\r'])
        self.writes.clear()
        self.config, self.cli = {'id': 'session', 'cli_type': 'gemini'}, 'gemini'
        self.assertEqual((await self.send_body(message='hello')).status, 200)
        self.assertEqual(self.writes, [b'\x15', b'hello', b'\r'])

    async def test_without_a_menu_input_flows_as_before(self):
        self.screen = 'Claude Code\n❯ '
        self.assertEqual((await self.send_body(message='hello')).status, 200)
        self.assertEqual(self.writes[-2:], [b'hello', b'\r'])

    async def test_a_cut_off_dialog_is_an_open_question_too(self):
        # Header scrolled off: no menu, but the dialog's bottom is on screen. A
        # bare "2" would select and confirm; free text would answer "Yes".
        for screen in (MENU[MENU.index('task_id:'):], MENU[MENU.index(' ❯ 1.'):],
                       '› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel'):
            self.screen = screen
            self.assertIsNone(self.ns['_session_permission_menu'](screen))
            self.assertTrue(self.ns['_is_incomplete_permission_screen'](screen))
            for message in ('2', 'hello', 'yes', 'n'):
                with self.subTest(screen=screen[-40:], message=message):
                    response = await self.send_body(message=message)
                    self.assertEqual(response.status, 409)
                    payload = json.loads(response.text)
                    self.assertEqual((payload['code'], payload['incomplete'], payload['menu']), ('question_open', True, None))
                    self.assertEqual(self.writes, [])
            self.assertEqual((await self.send_body(choice='2')).status, 409)
            self.assertEqual(self.writes, [])
        self.ns['_is_auth_recovery_input'].assert_not_called()

    async def test_a_question_answered_moments_ago_takes_no_second_reply(self):
        import time
        import session_attention
        self.addCleanup(session_attention._answered.pop, 'session', None)
        session_attention._answered['session'] = (self.identity, time.time())
        # The CLI has not redrawn yet; a cursor move is not a new question.
        self.screen = MENU.replace(' ❯ 1.', '   1.').replace('   2.', ' ❯ 2.')
        response = await self.send_body(choice='1', expected_identity=self.identity)
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.text)['code'], 'stale_session_prompt')
        self.assertEqual(self.writes, [])
        self.ns['_session_prompt_answered'].assert_not_awaited()
        # The grace is over (or the dialog left and came back): a new answer.
        session_attention._answered['session'] = (self.identity, time.time() - 10)
        self.assertEqual((await self.send_body(choice='1', expected_identity=self.identity)).status, 200)
        self.assertEqual(self.writes, [b'\x1b[A', b'\r'])


if __name__ == '__main__':
    unittest.main()
