"""The studio's HTTP server, run in-process against a temporary out/ folder and home directory."""
from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from unittest import mock

import cv2
import numpy as np

from downbeat.server import app as server_mod
from downbeat.server import state as state_mod

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _ffprobe(path: str) -> dict:
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]))


def _write_wav(path: str, seconds: float, bpm: float = 120.0, rate: int = 44100) -> str:
    """Stereo thumps on every beat: long enough to list in Downloads and to find a tempo in."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    n = np.arange(int(rate * 0.1))
    thump = np.sin(2 * np.pi * 60 * n / rate) * np.exp(-n / (rate * 0.03))
    y = np.zeros(int(rate * seconds), dtype=np.float32)
    for t in np.arange(0.1, seconds - 0.15, 60.0 / bpm):
        i = int(t * rate)
        y[i : i + thump.size] += thump
    pcm = (np.clip(y, -1, 1) * 30000).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.repeat(pcm, 2).tobytes())
    return path


def _lavfi_clip(path: str, size: str = "96x160", seconds: float = 2.0) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30", "-t", f"{seconds:g}",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path],
        check=True,
    )
    return path


class _ServerCase(unittest.TestCase):
    """Starts StudioHandler on a free port with OUT_DIR, STATE and $HOME pointed at a temp folder."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="db-server-")
        cls.home = os.path.join(cls.tmp, "home")
        cls.out = os.path.join(cls.tmp, "out")
        cls.downloads = os.path.join(cls.home, "Downloads")
        for d in (cls.out, cls.downloads):
            os.makedirs(d)
        cls.prepare()
        cls._patches = [
            mock.patch.dict(os.environ, {"HOME": cls.home}),
            mock.patch.object(state_mod, "OUT_DIR", cls.out),
            mock.patch.object(server_mod, "OUT_DIR", cls.out),
        ]
        for p in cls._patches:
            p.start()
        cls.state = state_mod.StudioState()  # after OUT_DIR is patched: its Library reads out/.library.json
        for p in (mock.patch.object(state_mod, "STATE", cls.state), mock.patch.object(server_mod, "STATE", cls.state)):
            p.start()
            cls._patches.append(p)
        cls.state.ensure_initialized()  # scan now, so files the tests write later aren't picked up as renders
        cls.httpd = server_mod.ReusableThreadingHTTPServer(("127.0.0.1", 0), server_mod.StudioHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def prepare(cls) -> None:
        """Put media in place before the state scans for it."""

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.state.shutdown()
        for p in reversed(cls._patches):
            p.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None,
                port: int | None = None) -> tuple[int, http.client.HTTPMessage, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", port or self.port, timeout=120)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            return resp.status, resp.headers, resp.read()
        finally:
            conn.close()

    def get_json(self, path: str) -> tuple[int, dict]:
        status, _, raw = self.request("GET", path)
        return status, json.loads(raw)

    def post_json(self, path: str, payload: dict | None = None, headers: dict | None = None) -> tuple[int, dict]:
        status, _, raw = self.request("POST", path, json.dumps(payload or {}).encode(), {"Content-Type": "application/json", **(headers or {})})
        return status, json.loads(raw)


class TestByteRanges(unittest.TestCase):
    def test_parses_open_closed_suffix_and_invalid_ranges(self) -> None:
        parse = server_mod._parse_byte_range
        self.assertEqual(parse(None, 1000), (0, 999, False))
        self.assertEqual(parse("items=0-10", 1000), (0, 999, False))
        self.assertEqual(parse("bytes=10-19", 1000), (10, 19, True))
        self.assertEqual(parse("bytes=990-", 1000), (990, 999, True))
        self.assertEqual(parse("bytes=500-5000", 1000), (500, 999, True), "the end is clamped to the file")
        self.assertEqual(parse("bytes=-100", 1000), (900, 999, True))
        self.assertEqual(parse("bytes=-5000", 1000), (0, 999, True))
        self.assertEqual(parse("bytes=0-1,5-6", 1000), (0, 1, True), "only the first range is served")
        for bad in ("bytes=-", "bytes=abc-", "bytes=20-10", "bytes=1000-", "bytes=-0"):
            self.assertEqual(parse(bad, 1000), (0, 999, False), bad)
        self.assertEqual(parse(None, 0), (0, 0, False))


class TestServerRouting(_ServerCase):
    """Routing and request checks; nothing here needs ffmpeg."""

    def test_only_answers_requests_addressed_to_this_machine(self) -> None:
        self.assertEqual(self.request("GET", "/api/status", headers={"Host": f"evil.example:{self.port}"})[0], 403)
        self.assertEqual(self.request("GET", "/api/status", headers={"Host": f"127.0.0.1:{self.port + 1}"})[0], 403)
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"LOCALHOST:{self.port}", f"[::1]:{self.port}"):
            self.assertEqual(self.request("GET", "/api/status", headers={"Host": host})[0], 200, host)

    def test_posts_from_other_sites_are_refused(self) -> None:
        body = json.dumps({"filename": "missing.mp4"}).encode()
        status, _, _ = self.request("POST", "/api/export/delete", body, {"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/api/export/delete", body, {"Origin": f"http://localhost:{self.port + 1}"})
        self.assertEqual(status, 403)
        for origin in (None, f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"):
            status, _, raw = self.request("POST", "/api/export/delete", body, {"Origin": origin} if origin else {})
            self.assertEqual((status, json.loads(raw)), (200, {"ok": True, "removed": []}), origin)
        # a cross-site GET is still answered: only the Host is checked for reads
        self.assertEqual(self.request("GET", "/api/status", headers={"Origin": "http://evil.example"})[0], 200)

    def test_status_answers_ok_and_unknown_routes_are_404(self) -> None:
        status, headers, raw = self.request("GET", "/api/status")
        self.assertEqual((status, json.loads(raw)), (200, {"ok": True}))
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/api/nope")[0], 404)
        self.assertEqual(self.request("POST", "/api/nope", b"{}")[0], 404)

    def test_serves_the_studio_page_and_its_files(self) -> None:
        for path in ("/", "/index.html"):
            status, headers, raw = self.request("GET", path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
            self.assertEqual(headers["Cache-Control"], "no-cache")
            self.assertIn(b"<html", raw.lower())
        status, headers, _ = self.request("GET", "/studio/styles.css")
        self.assertEqual((status, headers["Content-Type"]), (200, "text/css; charset=utf-8"))
        self.assertEqual(self.request("GET", "/studio/")[0], 200, "a folder serves its index.html")
        self.assertEqual(self.request("GET", "/studio/missing.js")[0], 404)

    def test_static_and_out_paths_cannot_leave_their_folders(self) -> None:
        for path in ("/studio/..%2F..%2Fserver.py", "/studio/%2E%2E/%2E%2E/state.py", "/out/..%2FREADME.md", "/out/..%2F..%2Fetc%2Fpasswd"):
            self.assertEqual(self.request("GET", path)[0], 403, path)

    def test_state_lists_an_empty_library(self) -> None:
        status, data = self.get_json("/api/state")
        self.assertEqual((status, sorted(data), data["clips"]), (200, ["clips", "renders", "tracks"], []))
        self.assertEqual(self.get_json("/api/state?only=clips"), (200, {"clips": []}))

    def test_unknown_ids_are_404(self) -> None:
        for path in ("/api/features/nope", "/api/proxy/nope", "/api/thumb/nope", "/api/track_audio/nope"):
            self.assertEqual(self.request("GET", path)[0], 404, path)
        self.assertEqual(self.get_json("/api/palette/nope"), (404, {"ok": False, "error": "unknown clip id"}))
        self.assertEqual(self.get_json("/api/autoframe/nope"), (404, {"ok": False}))

    def test_out_files_support_byte_ranges(self) -> None:
        blob = bytes(range(256)) * 4
        with open(os.path.join(self.out, "range test.bin"), "wb") as f:
            f.write(blob)
        status, headers, raw = self.request("GET", "/out/range%20test.bin")
        self.assertEqual((status, raw, headers["Accept-Ranges"]), (200, blob, "bytes"))
        self.assertNotIn("Content-Range", headers)

        status, headers, raw = self.request("GET", "/out/range%20test.bin", headers={"Range": "bytes=10-19"})
        self.assertEqual((status, raw, headers["Content-Range"]), (206, blob[10:20], "bytes 10-19/1024"))
        self.assertEqual(headers["Content-Length"], "10")

        status, headers, raw = self.request("GET", "/out/range%20test.bin", headers={"Range": "bytes=-100"})
        self.assertEqual((status, raw, headers["Content-Range"]), (206, blob[-100:], "bytes 924-1023/1024"))

        status, _, raw = self.request("GET", "/out/range%20test.bin", headers={"Range": "bytes=2000-"})
        self.assertEqual((status, raw), (200, blob), "an unsatisfiable range falls back to the whole file")
        self.assertEqual(self.request("GET", "/out/missing.mp4")[0], 404)

    @unittest.expectedFailure  # _serve_file sends Content-Length: 1 for an empty file, then no body
    def test_an_empty_file_is_served_with_no_body(self) -> None:
        open(os.path.join(self.out, "empty.mp4"), "wb").close()
        status, headers, raw = self.request("GET", "/out/empty.mp4")
        self.assertEqual((status, headers["Content-Length"], raw), (200, "0", b""))

    def test_deleting_a_missing_export_or_clip_is_not_an_error(self) -> None:
        self.assertEqual(self.post_json("/api/export/delete", {"filename": "gone.mp4"}), (200, {"ok": True, "removed": []}))
        self.assertEqual(self.post_json("/api/export/delete", {"filename": "../README.md"}), (200, {"ok": True, "removed": []}))
        self.assertEqual(self.post_json("/api/clip/remove", {"id": "gone"}), (200, {"ok": True, "deleted": False}))

    def test_deleting_an_export_removes_it_and_its_companions(self) -> None:
        stem = "canvas-test-120bpm-4.0s-720x1280-20261023-120000"
        for suffix in (".mp4", "-audio.mp4", "-promo-15s.mp4", "-teaser.gif"):
            with open(os.path.join(self.out, stem + suffix), "wb") as f:
                f.write(b"x")
        with self.state.lock:
            self.state._renders.insert(0, {"filename": stem + ".mp4"})
        status, data = self.post_json("/api/export/delete", {"filename": stem + ".mp4"})
        self.assertEqual(status, 200)
        self.assertEqual(sorted(data["removed"]), sorted(stem + s for s in (".mp4", "-audio.mp4", "-promo-15s.mp4", "-teaser.gif")))
        self.assertFalse(any(n.startswith(stem) for n in os.listdir(self.out)))
        self.assertNotIn(stem + ".mp4", [r["filename"] for r in self.get_json("/api/state")[1]["renders"]])

    def test_raw_export_calls_with_an_unknown_session_are_404(self) -> None:
        status, _, raw = self.request("POST", "/api/export/raw/frames?sid=nope", b"\0" * 16)
        self.assertEqual((status, json.loads(raw)), (404, {"ok": False, "error": "unknown session"}))
        self.assertEqual(self.post_json("/api/export/raw/end?sid=nope"), (404, {"ok": False, "error": "unknown session"}))
        self.assertEqual(self.post_json("/api/export/raw/abort?sid=nope"), (200, {"ok": True}))

    def test_companion_export_rejects_bad_requests(self) -> None:
        status, _, raw = self.request("POST", "/api/export/companion", b"{not json", {"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertIn("Invalid JSON body", json.loads(raw)["error"])
        self.assertEqual(self.post_json("/api/export/companion", {"filename": "missing.mp4", "kind": "cover"}),
                         (404, {"ok": False, "error": "source file not found"}))
        self.assertEqual(self.post_json("/api/export/companion", {"clip_id": "nope", "kind": "gif"})[0], 404)
        with open(os.path.join(self.out, "source.mp4"), "wb") as f:
            f.write(b"x")
        self.assertEqual(self.post_json("/api/export/companion", {"filename": "source.mp4", "kind": "poster"}),
                         (400, {"ok": False, "error": "unsupported kind: poster"}))

    def test_library_folders_can_be_added_listed_and_removed(self) -> None:
        missing = os.path.join(self.tmp, "no-such-folder")
        status, data = self.post_json("/api/library/folders", {"add": missing})
        self.assertEqual((status, data["ok"]), (400, False))
        self.assertIn("No folder at", data["error"])

        music = os.path.join(self.tmp, "Music")
        _write_wav(os.path.join(music, "Album", "track.wav"), 3.0)
        status, data = self.post_json("/api/library/folders", {"add": music})
        self.assertEqual(status, 200)
        self.assertEqual(data["folders"], [music])
        self.assertEqual([(t["name"], t["dir"], t["source"]) for t in data["tracks"]], [("track.wav", "Album", music)])
        self.assertIsInstance(data["can_pick"], bool)
        self.assertEqual(self.get_json("/api/tracks")[1]["folders"], [music])

        status, data = self.post_json("/api/library/folders", {"remove": music})
        self.assertEqual((status, data["folders"], data["tracks"]), (200, [], []))

    def test_library_suggests_the_music_folder_until_it_is_added(self) -> None:
        music = os.path.join(self.home, "Music")
        os.makedirs(music, exist_ok=True)
        self.addCleanup(shutil.rmtree, music, True)
        self.assertEqual(self.get_json("/api/tracks")[1]["suggestions"], [music])
        self.post_json("/api/library/folders", {"add": music})
        self.addCleanup(self.post_json, "/api/library/folders", {"remove": music})
        self.assertEqual(self.get_json("/api/tracks")[1]["suggestions"], [])

    @unittest.skipIf(sys.platform == "darwin", "on macOS this opens the folder chooser")
    def test_folder_chooser_needs_macos(self) -> None:
        status, data = self.post_json("/api/library/pick_folder")
        self.assertEqual((status, data["ok"]), (501, False))

    def test_reveal_only_looks_inside_out(self) -> None:
        status, data = self.post_json("/api/reveal", {"filename": "../../etc/missing-file.mp4"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": False, "path": os.path.join(os.path.abspath(self.out), "missing-file.mp4")})

    def test_reveal_opens_finder_on_macos_for_a_real_export(self) -> None:
        with open(os.path.join(self.out, "shown.mp4"), "wb") as f:
            f.write(b"x")
        with mock.patch.object(server_mod.sys, "platform", "darwin"), mock.patch.object(server_mod.subprocess, "Popen") as popen:
            self.assertEqual(self.post_json("/api/reveal", {"filename": "shown.mp4"}), (200, {"ok": True}))
        popen.assert_called_once_with(["open", "-R", os.path.join(os.path.abspath(self.out), "shown.mp4")])
        with mock.patch.object(server_mod.sys, "platform", "linux"), mock.patch.object(server_mod.subprocess, "Popen") as popen:
            self.assertFalse(self.post_json("/api/reveal", {"filename": "shown.mp4"})[1]["ok"])
        popen.assert_not_called()

    def test_folder_chooser_adds_the_picked_folder(self) -> None:
        picked = os.path.join(self.tmp, "Picked")
        os.makedirs(picked)
        with mock.patch.object(server_mod.sys, "platform", "darwin"), \
             mock.patch.object(server_mod, "pick_folder_dialog", side_effect=[picked, None]):
            status, data = self.post_json("/api/library/pick_folder")
            self.assertEqual((status, data["picked"], data["folders"]), (200, picked, [picked]))
            status, data = self.post_json("/api/library/pick_folder")
            self.assertEqual((status, data["picked"], data["folders"]), (200, None, [picked]), "cancelling adds nothing")
        self.post_json("/api/library/folders", {"remove": picked})

    def test_a_dead_encoder_aborts_its_export(self) -> None:
        class Session:
            aborted = False

            def write(self, data: bytes) -> int:
                raise BrokenPipeError("ffmpeg exited")

            def abort(self) -> None:
                Session.aborted = True

        with self.state.lock:
            self.state.raw_sessions["dead.mp4"] = (Session(), {})
        status, _, raw = self.request("POST", "/api/export/raw/frames?sid=dead.mp4", b"\0" * 64)
        self.assertEqual(status, 500)
        self.assertIn("encoder stopped", json.loads(raw)["error"])
        self.assertTrue(Session.aborted)
        self.assertNotIn("dead.mp4", self.state.raw_sessions)

    def test_dropped_connections_are_not_logged(self) -> None:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            for exc in (BrokenPipeError(), ConnectionResetError(), ConnectionAbortedError()):
                try:
                    raise exc
                except OSError:
                    self.httpd.handle_error(None, ("127.0.0.1", 1))
            self.assertEqual(err.getvalue(), "")
            try:
                raise ValueError("a real bug")
            except ValueError:
                self.httpd.handle_error(None, ("127.0.0.1", 1))
        self.assertIn("ValueError: a real bug", err.getvalue())

    def test_finds_a_running_server_by_its_status_route(self) -> None:
        self.assertTrue(server_mod._is_downbeat_running("127.0.0.1", self.port))
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free = s.getsockname()[1]
        self.assertFalse(server_mod._is_downbeat_running("127.0.0.1", free))

    def test_shutdown_aborts_open_exports_and_stops_the_server(self) -> None:
        other = state_mod.StudioState()
        other._initialized = True

        class Session:
            aborted = False

            def abort(self) -> None:
                Session.aborted = True

        other.raw_sessions["open.mp4"] = (Session(), {})
        httpd = server_mod.ReusableThreadingHTTPServer(("127.0.0.1", 0), server_mod.StudioHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.server_close)
        with mock.patch.object(server_mod, "STATE", other), mock.patch.object(state_mod, "STATE", other):
            status, _, raw = self.request("POST", "/api/shutdown", b"{}", port=httpd.server_address[1])
            thread.join(5)
        self.assertEqual((status, json.loads(raw)), (200, {"ok": True}))
        self.assertFalse(thread.is_alive())
        self.assertTrue(Session.aborted)
        self.assertEqual(other.raw_sessions, {})


class TestServeStudio(unittest.TestCase):
    """serve_studio(): reloading a running server, port fallback and shutdown."""

    def setUp(self) -> None:
        st = state_mod.StudioState()
        st._initialized = True
        for p in (mock.patch.object(state_mod, "STATE", st), mock.patch.object(server_mod, "STATE", st)):
            p.start()
            self.addCleanup(p.stop)
        self.out = io.StringIO()
        quiet = contextlib.redirect_stdout(self.out)
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def start(self, port: int, open_browser: bool = False) -> threading.Thread:
        thread = threading.Thread(target=server_mod.serve_studio, kwargs={"port": port, "open_browser": open_browser}, daemon=True)
        thread.start()
        for _ in range(100):
            if f":{port}" in self.out.getvalue() or "Could not" in self.out.getvalue():
                break
            threading.Event().wait(0.02)
        return thread

    def stop(self, port: int, thread: threading.Thread) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/api/shutdown", b"{}")
        conn.getresponse().read()
        conn.close()
        thread.join(5)
        self.assertFalse(thread.is_alive())

    def wait_running(self, port: int) -> None:
        for _ in range(100):
            if server_mod._is_downbeat_running("127.0.0.1", port):
                return
            threading.Event().wait(0.02)
        self.fail(f"nothing answered on {port}")

    def test_a_second_launch_replaces_the_running_server(self) -> None:
        # The running server stands in for an earlier launch; that process would exit and free the port.
        old = server_mod.ReusableThreadingHTTPServer(("127.0.0.1", 0), server_mod.StudioHandler)
        port = old.server_address[1]

        def serve() -> None:
            old.serve_forever()
            old.server_close()

        first = threading.Thread(target=serve, daemon=True)
        first.start()
        self.wait_running(port)
        second = self.start(port)
        first.join(5)
        self.assertFalse(first.is_alive(), "the first server was asked to shut down")
        self.assertIn(f"Found running Downbeat server at http://127.0.0.1:{port}", self.out.getvalue())
        # The old server can take up to its 0.5 s poll interval to stop, so the new one may land one port up.
        for _ in range(100):
            found = re.search(r"Downbeat Studio running at http://127\.0\.0\.1:(\d+)", self.out.getvalue())
            if found:
                break
            threading.Event().wait(0.02)
        new_port = int(found.group(1))
        self.assertIn(new_port, (port, port + 1))
        self.wait_running(new_port)
        self.stop(new_port, second)

    def test_a_busy_port_moves_to_the_next_one_and_opens_the_browser(self) -> None:
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            port = busy.getsockname()[1]
            with mock.patch.object(server_mod.webbrowser, "open") as browser:
                thread = self.start(port, open_browser=True)
                self.wait_running(port + 1)
                for _ in range(100):
                    if browser.called:
                        break
                    threading.Event().wait(0.02)
            browser.assert_called_once_with(f"http://127.0.0.1:{port + 1}")
            self.stop(port + 1, thread)
        self.assertIn(f"Downbeat Studio running at http://127.0.0.1:{port + 1}", self.out.getvalue())

    def test_no_free_port_is_an_error(self) -> None:
        with mock.patch.object(server_mod, "ReusableThreadingHTTPServer", side_effect=OSError("in use")), \
             mock.patch.object(server_mod, "_is_downbeat_running", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "Could not bind any port in range 9000..9014"):
                server_mod.serve_studio(port=9000, open_browser=False)

    def test_ctrl_c_closes_the_server(self) -> None:
        closed = []

        class Server:
            def __init__(self, addr: tuple, handler: type) -> None:
                self.addr = addr

            def serve_forever(self) -> None:
                raise KeyboardInterrupt

            def server_close(self) -> None:
                closed.append(self.addr)

        with mock.patch.object(server_mod, "ReusableThreadingHTTPServer", Server), \
             mock.patch.object(server_mod, "_is_downbeat_running", return_value=False):
            server_mod.serve_studio(port=9100, open_browser=False)
        self.assertEqual(closed, [("127.0.0.1", 9100)])
        self.assertIn("Shutting down Downbeat Studio.", self.out.getvalue())


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestServerMedia(_ServerCase):
    """Clips, songs, uploads and exports through the HTTP API."""

    @classmethod
    def prepare(cls) -> None:
        cls.clip_path = _lavfi_clip(os.path.join(cls.downloads, "1001_stock.mp4"))
        cls.song_path = _write_wav(os.path.join(cls.downloads, "beat.wav"), 4.0)

    def clip(self) -> dict:
        return next(c for c in self.get_json("/api/state")[1]["clips"] if c["name"] == "1001_stock.mp4")

    def track(self) -> dict:
        return next(t for t in self.get_json("/api/state")[1]["tracks"] if t["name"] == "beat.wav")

    def test_state_lists_clips_from_downloads_and_songs(self) -> None:
        clip = self.clip()
        self.assertEqual((clip["width"], clip["height"], clip["fps"], clip["duration"]), (96, 160, 30.0, 2.0))
        self.assertTrue(clip["is_stock"])
        self.assertFalse(clip["still"])
        self.assertIn(clip["proxy"], ("queued", "building", "ready"))
        self.assertEqual(self.track()["source"], "downloads")
        self.assertEqual(set(self.get_json("/api/state?only=clips")[1]), {"clips"})

    def test_proxy_is_built_on_request_and_served_with_ranges(self) -> None:
        cid = self.clip()["id"]
        status, headers, raw = self.request("GET", f"/api/proxy/{cid}")
        self.assertEqual((status, headers["Content-Type"]), (200, "video/mp4"))
        self.assertGreater(len(raw), 1000)
        status, headers, part = self.request("GET", f"/api/proxy/{cid}", headers={"Range": "bytes=0-99"})
        self.assertEqual((status, part), (206, raw[:100]))
        self.assertEqual(headers["Content-Range"], f"bytes 0-99/{len(raw)}")
        self.assertEqual(self.clip()["proxy"], "ready")
        with mock.patch.object(self.state.proxies, "ensure", return_value=None):
            self.assertEqual(self.request("GET", f"/api/proxy/{cid}")[0], 500)

    def test_thumbnails_are_jpegs_at_a_clamped_width(self) -> None:
        cid = self.clip()["id"]
        for asked, width in (("10", 32), ("64", 64), ("5000", 720)):
            status, headers, raw = self.request("GET", f"/api/thumb/{cid}?w={asked}&t=0.5")
            self.assertEqual((status, headers["Content-Type"]), (200, "image/jpeg"))
            img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            self.assertEqual(img.shape[1], width, asked)
        self.assertEqual(self.request("GET", f"/api/thumb/{cid}?w=wide")[0], 500)

    def test_palette_and_autoframe_are_computed_once_per_clip(self) -> None:
        cid = self.clip()["id"]
        status, pal = self.get_json(f"/api/palette/{cid}")
        self.assertEqual((status, pal["ok"]), (200, True))
        self.assertEqual(len(pal["colors"]), 5)
        status, hit = self.get_json(f"/api/autoframe/{cid}")
        self.assertEqual((status, hit["ok"]), (200, True))
        self.assertEqual(len(hit["focus"]), 2)
        self.assertIn(hit["method"], ("subject", "center"))
        with mock.patch.object(server_mod.framing, "extract_palette", side_effect=AssertionError("recomputed")), \
             mock.patch.object(server_mod.framing, "autoframe", side_effect=AssertionError("recomputed")):
            self.assertEqual(self.get_json(f"/api/palette/{cid}"), (200, pal))
            self.assertEqual(self.get_json(f"/api/autoframe/{cid}"), (200, hit))

    def test_palette_and_autoframe_report_analysis_errors(self) -> None:
        with self.state.lock:
            self.state.palettes.clear()
            self.state.framing.clear()
        cid = self.clip()["id"]
        with mock.patch.object(server_mod.framing, "extract_palette", side_effect=RuntimeError("decoder broke")), \
             mock.patch.object(server_mod.framing, "autoframe", side_effect=RuntimeError("decoder broke")):
            self.assertEqual(self.get_json(f"/api/palette/{cid}"), (500, {"ok": False, "error": "decoder broke"}))
            self.assertEqual(self.get_json(f"/api/autoframe/{cid}"), (500, {"ok": False, "error": "decoder broke"}))

    def test_features_use_the_tempo_override(self) -> None:
        tid = self.track()["id"]
        status, feats = self.get_json(f"/api/features/{tid}")
        self.assertEqual(status, 200)
        self.assertEqual(feats["id"], tid)
        self.assertAlmostEqual(feats["duration"], 4.0, places=2)
        status, fixed = self.get_json(f"/api/features/{tid}?bpm=100")
        self.assertEqual((status, fixed["bpm"], fixed["bpm_source"]), (200, 100.0, "manual"))
        status, data = self.get_json(f"/api/features/{tid}?bpm=fast")
        self.assertEqual(status, 500)
        self.assertIn("error", data)

    def test_song_audio_is_served_as_is_or_converted(self) -> None:
        tid = self.track()["id"]
        status, headers, raw = self.request("GET", f"/api/track_audio/{tid}")
        self.assertEqual(status, 200)
        self.assertIn("wav", headers["Content-Type"])
        with open(self.song_path, "rb") as f:
            self.assertEqual(raw, f.read())
        with mock.patch.object(server_mod, "playable_path", side_effect=RuntimeError("no decoder")):
            self.assertEqual(self.request("GET", f"/api/track_audio/{tid}")[0], 500)

    def test_uploads_add_videos_stills_and_songs(self) -> None:
        clip = _lavfi_clip(os.path.join(self.tmp, "src", "my clip.mp4"), seconds=1.0)
        with open(clip, "rb") as f:
            status, _, raw = self.request("POST", "/api/upload", f.read(), {"X-Filename": "my%20clip.mp4"})
        video = json.loads(raw)
        self.assertEqual((status, video["ok"], video["kind"], video["name"], video["still"]), (200, True, "video", "my clip.mp4", False))
        self.assertTrue(os.path.isfile(os.path.join(self.out, "uploads", "my clip.mp4")))
        self.assertIn(video["id"], [c["id"] for c in self.get_json("/api/state")[1]["clips"]])

        png = cv2.imencode(".png", np.full((90, 60, 3), 200, np.uint8))[1].tobytes()
        status, _, raw = self.request("POST", "/api/upload", png, {"X-Filename": "cover.png"})
        still = json.loads(raw)
        self.assertEqual((status, still["kind"], still["still"], still["name"]), (200, "video", True, "cover.still.mp4"))
        clips = {c["id"]: c for c in self.get_json("/api/state")[1]["clips"]}
        self.assertTrue(clips[still["id"]]["still"])

        song = _write_wav(os.path.join(self.tmp, "src", "short.wav"), 0.5)
        with open(song, "rb") as f:
            status, _, raw = self.request("POST", "/api/upload", f.read(), {"X-Filename": "short.wav"})
        audio = json.loads(raw)
        self.assertEqual((status, audio["kind"], audio["name"]), (200, "audio", "short.wav"))
        added = next(t for t in self.get_json("/api/state")[1]["tracks"] if t["id"] == audio["id"])
        self.assertEqual(added["source"], "added", "a song added on purpose is listed however short it is")

        # Removing an uploaded clip deletes its copy; a second remove is still fine.
        self.assertEqual(self.post_json("/api/clip/remove", {"id": still["id"]}), (200, {"ok": True, "deleted": True}))
        self.assertFalse(os.path.exists(os.path.join(self.out, "uploads", "cover.png")))
        self.assertEqual(self.post_json("/api/clip/remove", {"id": still["id"]}), (200, {"ok": True, "deleted": False}))

    def test_uploads_that_cannot_be_used_are_refused(self) -> None:
        status, _, raw = self.request("POST", "/api/upload", b"not a video", {"X-Filename": "..%2F..%2Fnotes.mp4"})
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(raw)["ok"])
        self.assertTrue(os.path.isfile(os.path.join(self.out, "uploads", "notes.mp4")), "the name is reduced to its last part")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "notes.mp4")))

        status, _, raw = self.request("POST", "/api/upload", b"RIFF", {"X-Filename": "segment-1.wav"})
        self.assertEqual(status, 400)
        self.assertIn("too short or not an audio file", json.loads(raw)["error"])

    def _annexb(self, size: str, frames: int) -> bytes:
        path = os.path.join(self.tmp, f"{size}-{frames}.h264")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30", "-frames:v", str(frames),
             "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-pix_fmt", "yuv420p", "-f", "h264", path],
            check=True,
        )
        with open(path, "rb") as f:
            return f.read()

    def test_streamed_h264_export_passes_the_canvas_checks(self) -> None:
        data = self._annexb("720x1280", 90)
        meta = {"look": "Stream Test", "bpm": 120, "duration": 3.0, "width": 720, "height": 1280, "fps": 30,
                "stream": "h264", "track_id": self.track()["id"], "audio_start": 0.5, "with_audio": True}
        status, begun = self.post_json("/api/export/raw/begin", meta)
        self.assertEqual((status, begun["ok"]), (200, True))
        sid = begun["sid"]
        self.assertTrue(sid.startswith("canvas-stream-test-120bpm-3.0s-720x1280-"))
        for piece in (data[:777], data[777 : len(data) // 2], data[len(data) // 2 :]):
            status, _, raw = self.request("POST", f"/api/export/raw/frames?sid={sid}", piece)
            self.assertEqual((status, json.loads(raw)["frames"]), (200, len(piece)))
        stats = {"seam_ratio": 0.6, "max_flashes_per_sec": 0}
        status, done = self.post_json(f"/api/export/raw/end?sid={sid}", {"stats": stats})
        self.assertEqual((status, done["ok"]), (200, True))
        render = done["render"]
        self.assertEqual(render["filename"], sid)
        self.assertEqual((render["resolution"], render["format"], render["look"], render["engine"]), ("720x1280", "spotify", "Stream Test", "gpu"))
        self.assertTrue(render["url"].startswith(f"/out/{sid}?t="))
        levels = {c["id"]: c["level"] for c in render["checks"]}
        for cid in ("length", "aspect", "height", "codec", "silent", "fps", "faststart", "seam", "flash"):
            self.assertEqual(levels[cid], "ok", cid)
        self.assertTrue(os.path.isfile(os.path.join(self.out, sid)))
        self.assertFalse(os.path.exists(os.path.join(self.out, sid[:-4] + ".h264")))
        audio = os.path.join(self.out, sid[:-4] + "-audio.mp4")
        self.assertEqual(render["audio_url"], f"/out/{os.path.basename(audio)}")
        self.assertEqual([s["codec_type"] for s in _ffprobe(audio)["streams"]], ["video", "audio"])
        self.assertEqual(self.get_json("/api/state")[1]["renders"][0]["filename"], sid)
        self.assertEqual(self.post_json(f"/api/export/raw/end?sid={sid}")[0], 404, "a finished session is gone")

        # A teaser and cover art from the finished render
        status, gif = self.post_json("/api/export/companion", {"filename": sid, "kind": "gif"})
        self.assertEqual((status, gif["filename"]), (200, sid[:-4] + "-teaser.gif"))
        self.assertTrue(os.path.isfile(os.path.join(self.out, gif["filename"])))
        status, cover = self.post_json("/api/export/companion", {"filename": sid, "kind": "cover", "at_sec": 1})
        self.assertEqual((status, cover["filename"]), (200, sid[:-4] + "-cover-3000x3000.jpg"))
        img = cv2.imread(os.path.join(self.out, cover["filename"]))
        self.assertEqual(img.shape[:2], (3000, 3000))
        self.assertEqual(len(self.post_json("/api/export/delete", {"filename": sid})[1]["removed"]), 4)

    def test_raw_rgba_export_counts_whole_frames(self) -> None:
        meta = {"look": "Raw", "bpm": 128, "duration": 1.0, "width": 64, "height": 112, "fps": 30}
        status, begun = self.post_json("/api/export/raw/begin", meta)
        self.assertEqual(status, 200)
        sid = begun["sid"]
        frame = 64 * 112 * 4
        frames = np.zeros((30, 112, 64, 4), np.uint8)
        frames[..., 1] = 255
        raw = frames.tobytes()
        status, _, out = self.request("POST", f"/api/export/raw/frames?sid={sid}", raw[: frame * 20 + 100])
        self.assertEqual((status, json.loads(out)["frames"]), (200, 20), "a partial frame at the end is dropped")
        status, _, out = self.request("POST", f"/api/export/raw/frames?sid={sid}", raw[frame * 20 :])
        self.assertEqual(json.loads(out)["frames"], 10)
        status, done = self.post_json(f"/api/export/raw/end?sid={sid}", {})
        self.assertEqual(status, 200)
        render = done["render"]
        self.assertEqual((render["resolution"], render["audio_url"]), ("64x112", None))
        levels = {c["id"]: c["level"] for c in render["checks"]}
        self.assertEqual((levels["codec"], levels["height"], levels["length"]), ("ok", "fail", "fail"))
        info = _ffprobe(os.path.join(self.out, sid))
        self.assertEqual(int(info["streams"][0]["nb_frames"]), 30)

    def test_aborting_an_export_removes_its_files(self) -> None:
        for meta in ({"look": "Gone", "bpm": 90, "duration": 2, "width": 64, "height": 112, "fps": 30},
                     {"look": "Gone Stream", "bpm": 90, "duration": 2, "width": 64, "height": 112, "fps": 30, "stream": "h264"}):
            sid = self.post_json("/api/export/raw/begin", meta)[1]["sid"]
            self.request("POST", f"/api/export/raw/frames?sid={sid}", b"\0" * (64 * 112 * 4))
            self.assertEqual(self.post_json(f"/api/export/raw/abort?sid={sid}"), (200, {"ok": True}))
            self.assertNotIn(sid, self.state.raw_sessions)
            leftovers = [n for n in os.listdir(self.out) if n.startswith(sid[:-4])]
            self.assertEqual(leftovers, [], meta["look"])

    def test_a_stream_that_cannot_be_muxed_reports_the_error(self) -> None:
        meta = {"look": "Broken", "bpm": 90, "duration": 2, "width": 64, "height": 112, "fps": 30, "stream": "h264"}
        sid = self.post_json("/api/export/raw/begin", meta)[1]["sid"]
        self.request("POST", f"/api/export/raw/frames?sid={sid}", b"definitely not h264")
        status, data = self.post_json(f"/api/export/raw/end?sid={sid}")
        self.assertEqual((status, data["ok"]), (500, False))
        self.assertFalse(os.path.exists(os.path.join(self.out, sid[:-4] + ".h264")))
        self.assertNotIn(sid, [r["filename"] for r in self.get_json("/api/state")[1]["renders"]])

    @unittest.expectedFailure  # ffmpeg creates the .mp4 before it fails, and nothing removes it; a restart lists it
    def test_a_failed_mux_leaves_no_empty_export_behind(self) -> None:
        meta = {"look": "Leftover", "bpm": 90, "duration": 2, "width": 64, "height": 112, "fps": 30, "stream": "h264"}
        sid = self.post_json("/api/export/raw/begin", meta)[1]["sid"]
        self.request("POST", f"/api/export/raw/frames?sid={sid}", b"definitely not h264")
        self.assertEqual(self.post_json(f"/api/export/raw/end?sid={sid}")[0], 500)
        self.assertFalse(os.path.exists(os.path.join(self.out, sid)))

    def test_single_request_export_muxes_and_records_the_render(self) -> None:
        data = self._annexb("64x112", 45)
        meta = {"look": "One Shot", "bpm": 100, "duration": 1.5, "width": 64, "height": 112, "fps": 30, "format": "social_square"}
        headers = {"X-Export-Meta": json.dumps(meta), "Content-Type": "application/octet-stream"}
        status, _, raw = self.request("POST", "/api/export", data, headers)
        render = json.loads(raw)["render"]
        self.assertEqual((status, render["format"]), (200, "social_square"))
        self.assertIn("-social-square-100bpm-1.5s-1080x1080-", render["filename"])
        self.assertEqual({c["id"]: c["level"] for c in render["checks"]}["size"], "warn", "64x112 is under 1080x1080")
        self.assertEqual([n for n in os.listdir(self.out) if n.endswith(".h264")], [])

        headers["X-Export-Meta"] = json.dumps({**meta, "look": "One Shot Junk"})
        status, _, raw = self.request("POST", "/api/export", b"junk", headers)
        self.assertEqual((status, json.loads(raw)["ok"]), (500, False))
        self.assertEqual([n for n in os.listdir(self.out) if n.endswith(".h264")], [])

    def test_banner_from_a_clip_uses_its_framing(self) -> None:
        cid = self.clip()["id"]
        with self.state.lock:
            self.state.framing[cid] = {"focus": [0.2, 0.8], "method": "subject"}
        status, data = self.post_json("/api/export/companion", {"clip_id": cid, "kind": "soundcloud_header", "at_sec": 0.5})
        self.assertEqual(status, 200)
        self.assertEqual((data["filename"], data["width"], data["height"]), ("1001_stock-soundcloud_header.jpg", 2480, 520))
        self.assertEqual(cv2.imread(os.path.join(self.out, data["filename"])).shape[:2], (520, 2480))
        with self.state.lock:
            self.state.framing.pop(cid)
        with mock.patch.object(server_mod.framing, "autoframe", side_effect=RuntimeError("no subject")):
            status, data = self.post_json("/api/export/companion", {"clip_id": cid, "kind": "youtube_banner"})
        self.assertEqual((status, data["width"], data["height"]), (200, 2560, 1440))
        with mock.patch.object(server_mod.delivery, "export_cover_art", side_effect=RuntimeError("disk full")):
            self.assertEqual(self.post_json("/api/export/companion", {"clip_id": cid, "kind": "cover"}),
                             (500, {"ok": False, "error": "disk full"}))


if __name__ == "__main__":
    unittest.main()
