"""Tests for the standalone desktop window launcher and frozen bundle paths."""
from __future__ import annotations

import os
import unittest
from unittest import mock

from downbeat import cli, desktop
from downbeat.media import encoder
from downbeat.server import state as state_mod
from helpers import TempDirCase


class TestDesktopLauncher(TempDirCase):
    def test_find_app_browser_checks_override_platform_and_path(self) -> None:
        fake_exe = self.path("chrome.exe")
        open(fake_exe, "wb").close()
        with mock.patch.dict(os.environ, {"DOWNBEAT_BROWSER": fake_exe}, clear=False):
            self.assertEqual(desktop.find_app_browser(), fake_exe)

        with mock.patch.dict(os.environ, {"DOWNBEAT_BROWSER": "", "CHROME_PATH": ""}, clear=False), \
             mock.patch.object(desktop.sys, "platform", "darwin"), \
             mock.patch.object(desktop.os.path, "isfile", side_effect=lambda p: "Google Chrome" in p):
            self.assertIn("Google Chrome", desktop.find_app_browser() or "")

        with mock.patch.dict(os.environ, {"DOWNBEAT_BROWSER": "", "CHROME_PATH": "", "PROGRAMFILES": self.tmp, "PROGRAMFILES(X86)": "", "LOCALAPPDATA": ""}, clear=False), \
             mock.patch.object(desktop.sys, "platform", "win32"):
            edge = os.path.join(self.tmp, "Microsoft", "Edge", "Application", "msedge.exe")
            os.makedirs(os.path.dirname(edge), exist_ok=True)
            open(edge, "wb").close()
            self.assertEqual(desktop.find_app_browser(), edge)

        with mock.patch.dict(os.environ, {"DOWNBEAT_BROWSER": "", "CHROME_PATH": "", "PROGRAMFILES": "", "PROGRAMFILES(X86)": "", "LOCALAPPDATA": ""}, clear=False), \
             mock.patch.object(desktop.sys, "platform", "linux"), \
             mock.patch.object(desktop.shutil, "which", side_effect=lambda name: "/usr/bin/chromium" if name == "chromium" else None):
            self.assertEqual(desktop.find_app_browser(), "/usr/bin/chromium")

        with mock.patch.dict(os.environ, {"DOWNBEAT_BROWSER": "", "CHROME_PATH": "", "PROGRAMFILES": "", "PROGRAMFILES(X86)": "", "LOCALAPPDATA": ""}, clear=False), \
             mock.patch.object(desktop.sys, "platform", "linux"), \
             mock.patch.object(desktop.shutil, "which", return_value=None):
            self.assertIsNone(desktop.find_app_browser())

    def test_launch_app_window_spawns_chromium_or_falls_back_to_webbrowser(self) -> None:
        profile = self.path("profile")
        with mock.patch.object(desktop, "find_app_browser", return_value="/bin/chrome"), \
             mock.patch.object(desktop.subprocess, "Popen") as popen:
            desktop.launch_app_window("http://127.0.0.1:8765", profile_dir=profile)
            args = popen.call_args.args[0]
            self.assertEqual(args[0], "/bin/chrome")
            self.assertIn("--app=http://127.0.0.1:8765", args)
            self.assertIn(f"--user-data-dir={profile}", args)

        with mock.patch.object(desktop, "find_app_browser", return_value=None), \
             mock.patch.object(desktop.webbrowser, "open") as wb:
            self.assertIsNone(desktop.launch_app_window("http://127.0.0.1:8765", profile_dir=profile))
            wb.assert_called_once_with("http://127.0.0.1:8765")

    def test_serve_desktop_reuses_running_server_or_runs_until_window_closes(self) -> None:
        proc = mock.Mock()
        with mock.patch.object(desktop.STATE, "ensure_initialized"), \
             mock.patch.object(desktop, "_is_downbeat_running", return_value=True), \
             mock.patch.object(desktop, "launch_app_window", return_value=proc):
            self.assertEqual(desktop.serve_desktop("127.0.0.1", 8765), 0)
            proc.wait.assert_called_once()

        server = mock.Mock()
        with mock.patch.object(desktop.STATE, "ensure_initialized"), \
             mock.patch.object(desktop.STATE, "begin_shutdown", return_value=[]), \
             mock.patch.object(desktop, "_is_downbeat_running", return_value=False), \
             mock.patch.object(desktop, "ReusableThreadingHTTPServer", side_effect=[OSError("busy"), server]), \
             mock.patch.object(desktop, "launch_app_window", return_value=proc), \
             mock.patch.object(desktop.time, "monotonic", side_effect=[0.0, 5.0]):
            self.assertEqual(desktop.serve_desktop("127.0.0.1", 8765), 0)
            server.shutdown.assert_called_once()
            server.server_close.assert_called_once()

        with mock.patch.object(desktop.STATE, "ensure_initialized"), \
             mock.patch.object(desktop, "_is_downbeat_running", return_value=False), \
             mock.patch.object(desktop, "ReusableThreadingHTTPServer", side_effect=OSError("busy")):
            with self.assertRaisesRegex(RuntimeError, "Could not bind any port"):
                desktop.serve_desktop("127.0.0.1", 8765)

    def test_cli_app_flag_and_frozen_bundle_paths(self) -> None:
        with mock.patch.object(desktop, "serve_desktop", return_value=0) as serve:
            self.assertEqual(cli.main(["--app", "--port", "8799"]), 0)
            serve.assert_called_once_with(port=8799)

        with mock.patch.object(state_mod.sys, "frozen", True, create=True), \
             mock.patch.object(state_mod.sys, "_MEIPASS", "/bundle", create=True), \
             mock.patch.dict(os.environ, {"DOWNBEAT_OUT_DIR": ""}, clear=False):
            pkg, _, out, _, dist = state_mod._default_paths()
            self.assertTrue(pkg.endswith("downbeat"))
            self.assertTrue(out.endswith("Downbeat"))
            self.assertTrue(dist.endswith("dist"))

        with mock.patch.dict(os.environ, {"DOWNBEAT_FFMPEG_DIR": self.tmp}, clear=False), \
             mock.patch.object(encoder.shutil, "which", side_effect=lambda name, path=None: "/bundled/ffmpeg" if path else None):
            self.assertEqual(encoder.ffmpeg_path(), "/bundled/ffmpeg")


if __name__ == "__main__":
    unittest.main()
