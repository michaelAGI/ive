"""macOS dead ends answer with a reason and a System Settings pane: Automation
(-1743) for the pop-out terminal and Files and Folders (EPERM) for project
folders. Fakes only; nothing here touches the real Desktop, osascript or apps."""
import errno
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import server

DENIED_TERMINAL = "execution error: Not authorized to send Apple events to Terminal. (-1743)\n"
CANCELLED = "execution error: User canceled. (-128)\n"


def eperm(path):
    return PermissionError(errno.EPERM, "Operation not permitted", path)


def refusing(original, denied_path):
    """A delegating replacement for an os call that refuses one path like TCC does."""
    def call(path, *args, **kwargs):
        if os.fspath(path) == denied_path:
            raise eperm(denied_path)
        return original(path, *args, **kwargs)
    return call


class FakeProcess:
    def __init__(self, returncode=0, stdout=b"", stderr=b""):
        self.returncode, self._out, self._err = returncode, stdout, stderr

    async def communicate(self):
        return self._out, self._err


def body_of(response):
    return json.loads(response.text)


class AutomationDeniedTests(unittest.TestCase):
    def test_minus_1743_names_the_app_osascript_could_not_reach(self):
        response = server._automation_denied(DENIED_TERMINAL)
        self.assertEqual(response.status, 409)
        self.assertEqual(body_of(response), {
            "error": "macOS has not allowed IVE to control Terminal.",
            "reason": "automation_denied",
            "settings_pane": "privacy_automation",
        })

    def test_known_target_wins_over_the_parsed_name(self):
        self.assertEqual(body_of(server._automation_denied(DENIED_TERMINAL, "iTerm"))["error"],
                         "macOS has not allowed IVE to control iTerm.")
        self.assertEqual(body_of(server._automation_denied("error (-1743)"))["error"],
                         "macOS has not allowed IVE to control another app.")

    def test_other_osascript_failures_are_not_a_refusal(self):
        self.assertIsNone(server._automation_denied(CANCELLED))
        self.assertIsNone(server._automation_denied("execution error: Terminal got an error: Connection is invalid. (-609)"))
        self.assertIsNone(server._automation_denied(""))

    def test_pop_out_targets_iterm_only_when_installed(self):
        home_iterm = os.path.expanduser("~/Applications/iTerm.app")
        for installed, expected in [((), "Terminal"), (("/Applications/iTerm.app",), "iTerm"), ((home_iterm,), "iTerm")]:
            with self.subTest(installed=installed), patch("os.path.isdir", lambda p: p in installed):
                self.assertEqual(server._popout_terminal_target(), expected)

    def test_scripts_address_exactly_one_app_and_quote_the_command(self):
        command = "cd '/tmp/My Project' && claude"
        terminal = server._popout_terminal_script("Terminal", command)
        iterm = server._popout_terminal_script("iTerm", command)
        self.assertIn('tell application "Terminal"', terminal)
        self.assertNotIn("iTerm", terminal)
        self.assertIn('tell application "iTerm"', iterm)
        self.assertNotIn('"Terminal"', iterm)
        for script in (terminal, iterm):
            self.assertIn(json.dumps(command), script)


class FilesFoldersLabelTests(unittest.TestCase):
    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        self.desktop = os.path.join(self.home, "Desktop")
        roots = ((self.desktop, "your Desktop folder"), ("/Volumes", "external volumes"))
        for context in (patch.object(server, "_TCC_FOLDER_ROOTS", roots), patch.object(sys, "platform", "darwin")):
            context.start()
            self.addCleanup(context.stop)

    def test_label_names_the_protected_root_or_the_volume(self):
        self.assertEqual(server._tcc_folder_label(os.path.join(self.desktop, "proj", "src")), "your Desktop folder")
        self.assertEqual(server._tcc_folder_label(self.desktop), "your Desktop folder")
        self.assertEqual(server._tcc_folder_label("/Volumes/Backup/code"), 'the volume "Backup"')
        self.assertEqual(server._tcc_folder_label("/Volumes"), "external volumes")
        self.assertIsNone(server._tcc_folder_label(os.path.join(self.home, "Desktop-old", "proj")))
        self.assertIsNone(server._tcc_folder_label(os.path.join(self.home, "Code", "proj")))

    def test_only_eperm_under_a_protected_root_on_a_mac_becomes_a_refusal(self):
        inside = os.path.join(self.desktop, "proj")
        response = server._tcc_denied_response(inside, eperm(inside))
        self.assertEqual(response.status, 403)
        self.assertEqual(body_of(response), {
            "error": "macOS has not allowed IVE to read your Desktop folder.",
            "reason": "files_folders_denied",
            "settings_pane": "privacy_files",
        })
        self.assertIsNone(server._tcc_denied_response(inside, PermissionError(errno.EACCES, "denied", inside)))
        self.assertIsNone(server._tcc_denied_response(inside, FileNotFoundError(errno.ENOENT, "missing", inside)))
        self.assertIsNone(server._tcc_denied_response(os.path.join(self.home, "Code"), eperm(inside)))
        with patch.object(sys, "platform", "linux"):
            self.assertIsNone(server._tcc_denied_response(inside, eperm(inside)))


class FakeDb:
    def __init__(self, path):
        self.path = path

    async def execute(self, sql, params=()):
        row = {"path": self.path}
        class Cursor:
            async def fetchone(self):
                return row
        return Cursor()

    async def close(self):
        pass


class FolderHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        self.desktop = os.path.join(self.home, "Desktop")
        self.project = os.path.join(self.desktop, "proj")
        self.plain = os.path.join(self.home, "Code", "proj")
        for folder in (self.project, self.plain):
            os.makedirs(folder)
            open(os.path.join(folder, "README.md"), "w").close()
        roots = ((self.desktop, "your Desktop folder"),)
        for context in (
            patch.object(server, "_TCC_FOLDER_ROOTS", roots),
            patch.object(sys, "platform", "darwin"),
            patch.object(server, "_workspace_visible_to_auth", lambda *a, **k: True),
            patch.object(server, "get_auth", lambda request: None),
        ):
            context.start()
            self.addCleanup(context.stop)
        app = web.Application()
        app.router.add_get("/api/workspaces/{id}/files", server.list_workspace_files)
        app.router.add_post("/api/workspaces", server.create_workspace)
        app.router.add_post("/api/browse-folder", server.browse_folder)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    def workspace_at(self, path):
        context = patch.object(server, "get_db", AsyncMock(return_value=FakeDb(path)))
        context.start()
        self.addCleanup(context.stop)

    async def test_listing_a_refused_desktop_project_explains_instead_of_an_empty_tree(self):
        self.workspace_at(self.project)
        with patch("os.scandir", refusing(os.scandir, self.project)):
            response = await self.client.get("/api/workspaces/ws/files")
        self.assertEqual(response.status, 403)
        self.assertEqual(await response.json(), {
            "error": "macOS has not allowed IVE to read your Desktop folder.",
            "reason": "files_folders_denied",
            "settings_pane": "privacy_files",
        })

    async def test_a_refused_subfolder_is_not_reported_as_missing(self):
        self.workspace_at(self.project)
        sub = os.path.join(self.project, "src")
        os.makedirs(sub)
        with patch("os.stat", refusing(os.stat, sub)):
            response = await self.client.get("/api/workspaces/ws/files?path=src")
        self.assertEqual(response.status, 403)
        self.assertEqual((await response.json())["reason"], "files_folders_denied")

    async def test_listing_still_works_and_other_errors_keep_their_status(self):
        self.workspace_at(self.project)
        response = await self.client.get("/api/workspaces/ws/files")
        self.assertEqual(response.status, 200)
        self.assertEqual([item["name"] for item in (await response.json())["items"]], ["README.md"])
        self.workspace_at(self.plain)
        with patch("os.scandir", refusing(os.scandir, self.plain)):
            response = await self.client.get("/api/workspaces/ws/files")
        self.assertEqual(response.status, 500)
        self.assertNotIn("reason", await response.json())
        self.assertEqual((await self.client.get("/api/workspaces/ws/files?path=missing")).status, 404)

    async def test_connecting_a_refused_desktop_folder_names_the_setting(self):
        refused = os.path.join(self.desktop, "unseen")
        with patch("os.stat", refusing(os.stat, refused)):
            response = await self.client.post("/api/workspaces", json={"path": refused})
        self.assertEqual(response.status, 403)
        self.assertEqual((await response.json())["settings_pane"], "privacy_files")
        response = await self.client.post("/api/workspaces", json={"path": os.path.join(self.home, "Code", "nope")})
        self.assertEqual(response.status, 400)
        self.assertIn("directory not found", (await response.json())["error"])

    async def test_folder_picker_cancel_refusal_and_success(self):
        cases = [
            (FakeProcess(1, stderr=CANCELLED.encode()), 400, {"error": "cancelled"}),
            (FakeProcess(1, stderr=b""), 400, {"error": "cancelled"}),
            (FakeProcess(1, stderr=b"execution error: Not authorized to send Apple events to System Events. (-1743)"), 409,
             {"error": "macOS has not allowed IVE to control System Events.", "reason": "automation_denied",
              "settings_pane": "privacy_automation"}),
            (FakeProcess(0, stdout=f"{self.plain}/\n".encode()), 200, {"path": self.plain}),
        ]
        for process, status, expected in cases:
            with self.subTest(status=status), patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)):
                response = await self.client.post("/api/browse-folder")
                self.assertEqual(response.status, status)
                self.assertEqual(await response.json(), expected)
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=FakeProcess(1, stderr=b"execution error: boom (-2700)"))):
            response = await self.client.post("/api/browse-folder")
        self.assertEqual(response.status, 500)
        self.assertEqual((await response.json())["error"], "The folder picker could not be opened.")

    async def test_folder_picker_reports_a_refused_desktop_choice_right_away(self):
        process = FakeProcess(0, stdout=f"{self.project}\n".encode())
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)), \
                patch("os.scandir", refusing(os.scandir, self.project)):
            response = await self.client.post("/api/browse-folder")
        self.assertEqual(response.status, 403)
        self.assertEqual((await response.json())["reason"], "files_folders_denied")


if __name__ == "__main__":
    unittest.main()
