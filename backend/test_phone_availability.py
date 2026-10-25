import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from phone_availability import (PhoneAvailability, PowerConflict, PowerRefusal, MAX_DURATION, SETTINGS_PANES,
                                _MESSAGES, _START_REFUSALS)


class Helper:
    def __init__(self):
        self.calls = []
        self.phase = "ready"
        self.start_token = "private-test-lease"
        self.refusal = None

    async def __call__(self, value):
        self.calls.append(value)
        action = value["action"]
        if action == "start" and self.refusal:
            return {"ok": False, "status": self.phase, "reason": self.refusal}
        if action == "start":
            self.phase = "active"
        if action == "stop":
            self.phase = "stopped"
        result = {"ok": True, "status": self.phase, "battery_percent": 70,
                  "lease_id": self.start_token, "internal": "not-for-browser"}
        return result


class AvailabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.helper = Helper()
        self.connected = True
        self.controller = PhoneAvailability(helper=Path('/unused-test-helper'), caller=self.helper, connected=lambda: self.connected)
        self.addAsyncCleanup(self.controller.close)

    async def test_granted_session_stays_private_and_restores_on_app_close(self):
        result = await self.controller.start(allow_battery=True)
        self.assertEqual(result['state'], 'active')
        self.assertNotIn('lease_id', result)
        self.assertNotIn('internal', result)
        self.assertEqual(self.helper.calls[-1]['duration_seconds'], MAX_DURATION)
        self.assertTrue(self.helper.calls[-1]['allow_battery'])
        await self.controller.close()
        self.assertEqual(self.helper.calls[-1]['action'], 'stop')
        self.assertEqual(self.helper.calls[-1]['lease_id'], 'private-test-lease')
        self.assertIsNone(self.controller.lease)

    async def test_no_power_changes_before_secure_connection(self):
        self.connected = False
        with self.assertRaises(PowerConflict) as failure:
            await self.controller.start(allow_battery=True)
        self.assertEqual(failure.exception.reason, 'phone_connection_required')
        self.assertEqual(self.helper.calls, [])

    async def test_os_approval_is_not_reported_as_active(self):
        self.helper.phase = 'needs_approval'
        result = await self.controller.start(allow_battery=True)
        self.assertEqual(result['state'], 'needs_approval')
        self.assertIsNone(self.controller.task)
        self.assertEqual([c['action'] for c in self.helper.calls], ['status'])

    async def test_missing_lease_is_a_failure_even_if_helper_claims_active(self):
        self.helper.start_token = None
        with self.assertRaises(PowerRefusal) as failure:
            await self.controller.start(allow_battery=True)
        self.assertEqual((failure.exception.reason, failure.exception.state), ('helper_outdated', 'blocked'))
        self.assertEqual((self.controller.last['state'], self.controller.last['reason']), ('blocked', 'helper_outdated'))
        self.assertIsNone(self.controller.task)

    async def test_helper_refusal_names_reason_state_and_settings_pane(self):
        self.helper.refusal = 'battery_not_allowed'
        with self.assertRaises(PowerRefusal) as failure:
            await self.controller.start(allow_battery=False)
        error = failure.exception
        self.assertEqual((error.reason, error.state, error.settings_pane), ('battery_not_allowed', 'ready', 'battery'))
        self.assertIn('Allow battery use', str(error))
        # The cached status shows the same refusal until the next helper read.
        self.assertEqual((self.controller.last['reason'], self.controller.last['settings_pane']), ('battery_not_allowed', 'battery'))
        self.assertEqual(self.controller.last['message'], str(error))
        self.assertIsNone(self.controller.lease)
        self.helper.refusal = 'sleep_already_disabled_elsewhere'
        with self.assertRaises(PowerRefusal) as failure:
            await self.controller.start(allow_battery=False)
        self.assertIsNone(failure.exception.settings_pane)
        self.assertIn('sudo pmset -a disablesleep 0', str(failure.exception))
        self.helper.refusal = 'something_new_from_the_helper'
        with self.assertRaises(PowerRefusal) as failure:
            await self.controller.start(allow_battery=False)
        self.assertEqual(failure.exception.reason, 'something_new_from_the_helper')
        self.assertIn('something new from the helper', str(failure.exception))

    async def test_refusal_texts_name_the_next_step_without_other_panels(self):
        for reason, text in {**_MESSAGES, **_START_REFUSALS}.items():
            with self.subTest(reason=reason):
                self.assertNotIn('Review permissions', text)
                self.assertNotIn('\u2014', text)
                self.assertRegex(text, r'(\.|disablesleep 0)$')
        # The same arrow path and parenthetical as the panels, so one screen never mixes two spellings.
        self.assertIn('System Settings → General → Login Items & Extensions → Allow in the Background → IVE (administrator)',
                      _START_REFUSALS['macos_helper_approval_required'])
        self.assertIn('(administrator)', _START_REFUSALS['macos_helper_not_registered'])
        for text in {**_MESSAGES, **_START_REFUSALS}.values():
            self.assertNotIn('Settings >', text)
        self.assertIn('MacBook with a built-in battery', _START_REFUSALS['battery_unavailable'])
        self.assertTrue(_START_REFUSALS['helper_outdated'].startswith('Update the IVE Mac app.'))
        self.assertIn('restart the Mac', _START_REFUSALS['helper_outdated'])
        # The ended-session text names the buttons that exist, not a generic Stop.
        self.assertIn('Turn off and restore', _MESSAGES['restore_failed'])
        self.assertIn('Restore normal sleep', _MESSAGES['restore_failed'])
        self.assertIn('sudo pmset -a disablesleep 0', _MESSAGES['restore_failed'])
        for reason in ('battery_cutoff', 'thermal_cutoff', 'heartbeat_expired', 'restore_failed',
                       'recovery_journal_unreadable', 'untrusted_process'):
            self.assertRegex(PowerRefusal(reason).args[0] + _MESSAGES.get(reason, ''), r'(try|turn|Quit|Keep|run|restart)')
        for reason in ('macos_helper_approval_required', 'macos_helper_not_registered', 'helper_outdated', 'helper_connection_failed'):
            self.assertEqual(SETTINGS_PANES[reason], 'login_items')
        self.assertEqual(SETTINGS_PANES['battery_not_allowed'], 'battery')
        for reason in ('sleep_already_disabled_elsewhere', 'battery_unavailable', 'already_running', 'mac_app_required'):
            self.assertIsNone(PowerRefusal(reason).settings_pane)
        self.assertIsInstance(PowerConflict('already_running'), ValueError)
        self.assertNotIsInstance(PowerConflict('already_running'), RuntimeError)
        self.assertNotIsInstance(PowerRefusal('helper_outdated'), ValueError)

    async def test_registration_states_carry_reason_message_and_pane(self):
        self.helper.phase = 'needs_approval'
        view = await self.controller.register()
        self.assertEqual([c['action'] for c in self.helper.calls], ['register'])
        self.assertEqual((view['state'], view['reason'], view['settings_pane']),
                         ('needs_approval', 'macos_helper_approval_required', 'login_items'))
        self.assertIn('Login Items & Extensions', view['message'])
        self.assertIsNone(self.controller.lease)
        self.helper.phase = 'not_registered'
        self.assertEqual((await self.controller.register())['reason'], 'macos_helper_not_registered')

    async def test_opening_login_items_never_overwrites_a_live_session_view(self):
        await self.controller.start(allow_battery=True)
        # The helper's registration reply reports the service, not the lease.
        self.controller.caller = AsyncMock(return_value={'ok': True, 'status': 'ready'})
        view = await self.controller.open_approval()
        self.assertEqual(self.controller.caller.await_args.args[0]['action'], 'open-settings')
        self.assertEqual((view['state'], self.controller.last['state'], self.controller.lease), ('active', 'active', 'private-test-lease'))
        self.controller.caller = self.helper
        await self.controller.stop()
        self.controller.caller = AsyncMock(return_value={'ok': True, 'status': 'needs_approval'})
        self.assertEqual((await self.controller.open_approval())['reason'], 'macos_helper_approval_required')

    async def test_without_mac_app_every_action_says_so(self):
        with patch('phone_availability.helper_path', return_value=None):
            controller = PhoneAvailability(connected=lambda: True)
        status = await controller.status()
        self.assertEqual((status['state'], status['reason']), ('unavailable', 'mac_app_required'))
        self.assertIn('IVE Mac app', status['message'])
        for call in (lambda: controller.start(allow_battery=True), controller.register, controller.open_approval):
            with self.subTest(call=call), self.assertRaises(PowerRefusal) as failure:
                await call()
            self.assertEqual(failure.exception.reason, 'mac_app_required')
        self.assertEqual((await controller.stop())['state'], 'unavailable')

    async def test_unreachable_helper_is_a_connection_failure_not_a_state(self):
        async def broken(payload):
            raise OSError('fixture: helper gone')
        self.controller.caller = broken
        with self.assertRaises(PowerRefusal) as failure:
            await self.controller.status()
        self.assertEqual((failure.exception.reason, failure.exception.settings_pane), ('helper_connection_failed', 'login_items'))
        self.assertEqual(self.controller.last['state'], 'unavailable')
        self.assertEqual(self.controller.last_check, float('-inf'))

    async def test_garbled_helper_output_is_a_connection_failure(self):
        controller = PhoneAvailability(helper=Path('/unused-test-helper'), connected=lambda: True)
        proc = SimpleNamespace(communicate=AsyncMock(return_value=(b'not json', b'')), returncode=0, kill=Mock(), wait=AsyncMock())
        with patch('phone_availability.asyncio.create_subprocess_exec', new=AsyncMock(return_value=proc)) as spawn:
            with self.assertRaises(PowerRefusal) as failure:
                await controller.start(allow_battery=True)
            self.assertEqual(failure.exception.reason, 'helper_connection_failed')
            self.assertEqual(spawn.await_args.args, ('/unused-test-helper',))
            proc.communicate.return_value = (b'["a list"]', b'')
            with self.assertRaises(PowerRefusal):
                await controller.register()
            proc.communicate.return_value = (b'{"ok": true, "status": "ready"}', b'')
            self.assertEqual((await controller.register())['state'], 'ready')
        controller.last_check = float('-inf')
        with patch('phone_availability.asyncio.create_subprocess_exec', new=AsyncMock(side_effect=OSError('fixture'))):
            with self.assertRaises(PowerRefusal) as failure:
                await controller.status()
            self.assertEqual(failure.exception.reason, 'helper_connection_failed')

    async def test_reading_status_does_not_register_or_start_helper(self):
        await self.controller.status()
        self.assertEqual([c['action'] for c in self.helper.calls], ['status'])

    async def test_duplicate_start_does_not_create_unmanaged_leases(self):
        await asyncio.gather(self.controller.start(allow_battery=True), self.controller.start(allow_battery=True))
        self.assertEqual(sum(c['action'] == 'start' for c in self.helper.calls), 1)

    async def delayed_status(self, result=None, error=None):
        """Hold one read while real controller lifecycle calls continue."""
        entered = asyncio.Event()
        release = asyncio.Event()
        captured = False

        async def caller(payload):
            nonlocal captured
            if payload['action'] == 'status' and not captured:
                captured = True
                entered.set()
                await release.wait()
                if error:
                    raise error
                return result
            return await self.helper(payload)

        self.controller.caller = caller
        self.controller.last_check = float('-inf')
        pending = asyncio.create_task(self.controller.status())

        async def finish_read():
            release.set()
            await asyncio.wait_for(pending, 1)

        self.addAsyncCleanup(finish_read)
        await asyncio.wait_for(entered.wait(), 1)
        return pending, release

    async def test_late_active_status_cannot_undo_acknowledged_stop(self):
        await self.controller.start(allow_battery=True)
        pending, release = await self.delayed_status(
            {'ok': True, 'status': 'active', 'lease_id': 'private-old-lease'})
        stopped = await asyncio.wait_for(self.controller.stop(), 1)
        self.assertFalse(pending.done(), 'Stop must not wait for the slow status read')
        self.assertEqual(stopped['state'], 'stopped')
        release.set()
        self.assertEqual(await pending, stopped)
        self.assertEqual(self.controller.last, stopped)
        self.assertIsNone(self.controller.lease)
        self.assertNotIn('lease_id', self.controller.last)

    async def test_late_ready_status_cannot_undo_acknowledged_start(self):
        pending, release = await self.delayed_status({'ok': True, 'status': 'ready'})
        started = await asyncio.wait_for(self.controller.start(allow_battery=True), 1)
        self.assertFalse(pending.done(), 'Start must not wait for the slow status read')
        self.assertEqual(started['state'], 'active')
        release.set()
        self.assertEqual(await pending, started)
        self.assertEqual(self.controller.last, started)
        self.assertEqual(self.controller.lease, 'private-test-lease')
        self.assertIsNotNone(self.controller.task)

    async def test_late_status_failure_cannot_replace_verified_restoration(self):
        await self.controller.start(allow_battery=True)
        pending, release = await self.delayed_status(error=RuntimeError('synthetic timeout'))
        stopped = await asyncio.wait_for(self.controller.stop(), 1)
        release.set()
        self.assertEqual(await pending, stopped)
        self.assertEqual(self.controller.last, stopped)
        self.assertNotIn('message', self.controller.last)


if __name__ == '__main__':
    unittest.main()
