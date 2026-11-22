"""Claude model discovery and launch selection, without provider calls."""
import json
import os
import unittest
from unittest.mock import MagicMock, patch

from cli_profiles import CLAUDE_PROFILE
from cli_session import UnifiedSession
from model_discovery import discover_claude_models


class ClaudeModelTests(unittest.TestCase):
    def test_fable_survives_api_family_discovery_and_uses_native_alias(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'data': [
            {'id': 'claude-fable-5-2', 'display_name': 'Claude Fable 5.2'},
            {'id': 'claude-opus-5-5', 'display_name': 'Claude Opus 5.5'},
            {'id': 'claude-fable-5-1', 'display_name': 'Claude Fable 5.1'},
            {'id': 'claude-sonnet-5-5', 'display_name': 'Claude Sonnet 5.5'},
            {'id': 'claude-haiku-5-5', 'display_name': 'Claude Haiku 5.5'},
        ]}).encode()
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'fixture-only'}), \
                patch('model_discovery.urllib.request.urlopen', return_value=response):
            models = discover_claude_models()
        self.assertEqual([m['id'] for m in models], ['fable', 'opus', 'sonnet', 'haiku'])
        self.assertEqual(models[0]['full_id'], 'claude-fable-5-2')
        self.assertEqual(models[0]['description'], 'Claude Fable 5.2')

    def test_subscription_fallback_offers_fable_without_requesting_an_api_key(self):
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': ''}), \
                patch('model_discovery.urllib.request.urlopen') as request:
            self.assertIsNone(discover_claude_models())
            request.assert_not_called()
        self.assertIn('fable', [m['id'] for m in CLAUDE_PROFILE.available_models])

    def test_selected_fable_reaches_cli_unchanged_without_changing_defaults(self):
        for model in ('fable', 'claude-fable-5-2'):
            with self.subTest(model=model), patch.object(UnifiedSession, '_resolved_binary', return_value='claude'):
                command = UnifiedSession('claude', {'model': model}).build_command()
                self.assertEqual(command[command.index('--model') + 1], model)
        self.assertEqual(CLAUDE_PROFILE.default_model, 'sonnet')
        self.assertEqual(CLAUDE_PROFILE.default_commander_model, 'opus')
        self.assertNotIn('fable', CLAUDE_PROFILE.model_ladder)


if __name__ == '__main__':
    unittest.main()
