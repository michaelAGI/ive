"""Schema/command-boundary checks; never connect to a real device."""
import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

from device_hub_discovery import (
    DiscoveryError, FEATURES, diagnostic_report, discover_devices, normalize_inventory,
)


def inventory(*rows):
    return {"info": {"outcome": "success"}, "result": {"devices": list(rows)}}


def device(**changes):
    return {
        "identifier": "fixture-device",
        "properties": {
            "hardware": {"reality": "physical", "marketingName": "iPhone", "platform": "iOS",
                         "serialNumber": "not-for-reports", "udid": "not-for-reports"},
            "state": {"name": "Private device name", "developerModeStatus": {"enabled": {"mode": 1}}},
            "software": {"osVersionNumber": {"stringValue": "27.0.1"}},
            "connection": {"state": "connected", "pairingState": "paired", "transportType": "localNetwork",
                           "screenViewingURL": {"relative": "devices://device/open?id=fixture-device"}},
        },
        "capabilities": [{"featureIdentifier": feature} for feature in FEATURES.values()],
        **changes,
    }


class DiscoveryTests(unittest.TestCase):
    def test_modern_record_and_capabilities_never_grant_control(self):
        result = normalize_inventory(inventory(device()))[0]
        self.assertEqual((result["connection"], result["developer_mode"], result["os_version"]),
                         ("connected", "enabled", "27.0.1"))
        self.assertTrue(all(result["advertised_capabilities"].values()))
        self.assertEqual(result["ive_control"]["executable_actions"], [])
        self.assertFalse(result["ive_control"]["ready"])

    def test_legacy_record(self):
        result = normalize_inventory(inventory({
            "identifier": "legacy", "hardwareProperties": {"reality": "physical"},
            "deviceProperties": {"name": "Phone", "developerModeStatus": "enabled", "osVersionNumber": "18.5"},
            "connectionProperties": {"tunnelState": "connected", "pairingState": "paired"},
        }))[0]
        self.assertEqual((result["kind"], result["os_version"], result["developer_mode"]),
                         ("physical", "18.5", "enabled"))
        self.assertTrue(result["connected"])
        self.assertFalse(any(result["advertised_capabilities"].values()))

    def test_new_fields_override_stale_legacy_values(self):
        row = device(connectionProperties={"tunnelState": "connected"},
                     deviceProperties={"developerModeStatus": "enabled"})
        row["properties"]["connection"]["state"] = "unavailable"
        row["properties"]["state"]["developerModeStatus"] = {"disabled": {}}
        result = normalize_inventory(inventory(row))[0]
        self.assertFalse(result["connected"])
        self.assertEqual(result["developer_mode"], "disabled")

    def test_simulated_and_unknown_reality_are_not_physical(self):
        for reality, expected in [("simulated", "simulated"), (None, "unknown"), ("new_kind", "unknown")]:
            with self.subTest(reality=reality):
                row = device()
                row["properties"]["hardware"]["reality"] = reality
                self.assertEqual(normalize_inventory(inventory(row))[0]["kind"], expected)

    def test_paired_does_not_mean_connected(self):
        row = device()
        row["properties"]["connection"].pop("state")
        result = normalize_inventory(inventory(row))[0]
        self.assertEqual(result["pairing"], "paired")
        self.assertFalse(result["connected"])

    def test_unknown_and_conflicting_developer_mode(self):
        for value in [None, True, {}, "maybe", {"enabled": {}, "disabled": {}}]:
            with self.subTest(value=value):
                row = device()
                row["properties"]["state"]["developerModeStatus"] = value
                self.assertEqual(normalize_inventory(inventory(row))[0]["developer_mode"], "unknown")

    def test_links_must_match_device_and_known_scheme(self):
        for url in ["https://example.com", "devices://device/open?id=another", "devices://device/open?id=fixture-device&evil=1",
                    "devices://device/open?id=fixture-device#evil", "devices://device/open?id=fixture-device&id=another",
                    "devices://device/open?id=fixture-device&extra=", "devices://device/open?id=fixture-device&extra"]:
            with self.subTest(url=url):
                row = device()
                row["properties"]["connection"]["screenViewingURL"] = url
                self.assertIsNone(normalize_inventory(inventory(row))[0]["screen_viewing_url"])
        self.assertIsNotNone(normalize_inventory(inventory(device()))[0]["screen_viewing_url"])

    def test_incompatible_or_failed_inventory_is_not_empty_success(self):
        for payload in [None, [], {}, {"result": {}}, inventory(None), inventory({}),
                        inventory(device(), device()), inventory(device(capabilities=None)),
                        {"info": {"outcome": "failure"}, "result": {"devices": []}}]:
            with self.subTest(payload=payload), self.assertRaises(DiscoveryError):
                normalize_inventory(payload)
        self.assertEqual(normalize_inventory(inventory()), [])

    def test_diagnostics_omit_personal_identifiers_by_default(self):
        rows = normalize_inventory(inventory(device()))
        text = json.dumps(diagnostic_report(rows))
        for private in ["fixture-device", "Private device name", "not-for-reports", "devices://"]:
            self.assertNotIn(private, text)
        self.assertIn("Private device name", json.dumps(diagnostic_report(rows, include_identifiers=True)))
        self.assertIn("name", rows[0])  # report did not mutate the inventory

    def test_discovery_uses_only_fixed_read_command_and_cleans_temporary_file(self):
        paths = []
        def runner(argv, **kwargs):
            self.assertEqual(argv[:4], ["/usr/bin/xcrun", "devicectl", "list", "devices"])
            self.assertNotIn("shell", kwargs)
            self.assertEqual(kwargs["timeout"], 13)
            path = Path(argv[argv.index("--json-output") + 1])
            paths.append(path)
            path.write_text(json.dumps(inventory(device())))
            return SimpleNamespace(returncode=0)
        result = discover_devices(runner=runner, platform="darwin")
        self.assertEqual(len(result), 1)
        self.assertFalse(paths[0].exists())

    def test_failures_never_echo_raw_device_logs(self):
        def failure(*args, **kwargs):
            return SimpleNamespace(returncode=1, stderr="private-device-log")
        with self.assertRaisesRegex(DiscoveryError, "discovery failed") as error:
            discover_devices(runner=failure, platform="darwin")
        self.assertNotIn("private-device-log", str(error.exception))
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("private-command", 10)
        with self.assertRaisesRegex(DiscoveryError, "timed out"):
            discover_devices(runner=timeout, platform="darwin")
        with self.assertRaisesRegex(DiscoveryError, "macOS"):
            discover_devices(runner=failure, platform="linux")

    def test_missing_and_invalid_json_fail(self):
        def no_output(*args, **kwargs):
            return SimpleNamespace(returncode=0)
        with self.assertRaisesRegex(DiscoveryError, "unreadable"):
            discover_devices(runner=no_output, platform="darwin")
        def bad_output(argv, **kwargs):
            Path(argv[-1]).write_text("not-json")
            return SimpleNamespace(returncode=0)
        with self.assertRaisesRegex(DiscoveryError, "unreadable"):
            discover_devices(runner=bad_output, platform="darwin")

    def test_timeout_validation(self):
        for value in [True, 0, 31, 3.5, "10"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                discover_devices(platform="darwin", timeout=value)


if __name__ == "__main__":
    unittest.main()
