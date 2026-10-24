"""The studio's state: export names, rediscovered renders, and removing clips and exports."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from downbeat.media import source
from downbeat.server import library
from downbeat.server import state as state_mod
from helpers import HAS_FFMPEG, TempDirCase


class TestStateHelpers(unittest.TestCase):
    def setUp(self) -> None:
        self.out = tempfile.mkdtemp(prefix="db-state-")
        self.addCleanup(shutil.rmtree, self.out, True)
        patcher = mock.patch.object(state_mod, "OUT_DIR", self.out)
        patcher.start()
        self.addCleanup(patcher.stop)

    def touch(self, name: str, age: float = 0.0, size: int = 1) -> str:
        path = os.path.join(self.out, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"x" * size)
        t = time.time() - age
        os.utime(path, (t, t))
        return path

    def test_uploaded_songs_register_without_rescanning_the_library(self) -> None:
        st = state_mod.StudioState().ensure_initialized()
        self.addCleanup(st.shutdown)
        path = self.touch("uploads/new.wav")
        with mock.patch.object(st.library, "scan", side_effect=AssertionError("unexpected whole-library scan")):
            added = st.add_track_path(path)
            self.assertEqual(st.snapshot()["tracks"], [added.to_dict()])
        self.assertEqual((added.source, added.dir), ("added", ""))
        for name in ("uploads/segment-1.wav", "uploads/empty.wav", "uploads/notes.txt"):
            bad = self.touch(name, size=0 if "empty" in name else 1)
            with self.assertRaises(ValueError):
                st.add_track_path(bad)

    def test_snapshot_is_stable_and_does_not_block_writes_while_serializing_proxies(self) -> None:
        st = state_mod.StudioState().ensure_initialized()
        self.addCleanup(st.shutdown)
        first = source.Source(self.touch("uploads/one.mp4"), 64, 112, 30.0, 30, 1.0)
        second = source.Source(self.touch("uploads/two.mp4"), 64, 112, 30.0, 30, 1.0)
        with st.lock:
            st._clips = {first.id: first}
        entered, release = threading.Event(), threading.Event()

        def status(src):
            entered.set()
            if not release.wait(3):
                raise TimeoutError("test did not release proxy status")
            return "ready"

        def write():
            with st.lock:
                st._clips[second.id] = second

        with mock.patch.object(st.proxies, "status", side_effect=status), ThreadPoolExecutor(2) as pool:
            reader = pool.submit(st.snapshot)
            self.assertTrue(entered.wait(2))
            try:
                pool.submit(write).result(timeout=2)
            finally:
                release.set()
            payload = reader.result(timeout=2)
            self.assertEqual([c["id"] for c in payload["clips"]], [first.id])
            self.assertEqual([c["id"] for c in st.snapshot(clips_only=True)["clips"]], [first.id, second.id])
        self.assertEqual(set(st.snapshot(clips_only=True)), {"clips"})

    def test_existing_renders_are_found_newest_first_with_their_companions(self) -> None:
        stem = "canvas-neon-tide-youtube-16-9-151bpm-6.4s-1920x1080-20261023-120000"
        self.touch(stem + ".mp4", age=10, size=2 * 1024 * 1024)
        self.touch(stem + "-audio.mp4", age=10)
        self.touch(stem + "-promo-15s.mp4", age=10)
        self.touch(stem + "-promo-30s.mp4", age=10)
        self.touch(stem + "-cover-3000x3000.jpg", age=10)
        self.touch("sample-canvas.mp4", age=5)
        self.touch("old.mp4", age=100)
        st = state_mod.StudioState()
        st._discover_existing_renders()
        self.assertEqual([r["filename"] for r in st._renders], ["sample-canvas.mp4", stem + ".mp4", "old.mp4"])
        tide = st._renders[1]
        self.assertEqual((tide["audio_url"], tide["promo_url"]), (f"/out/{stem}-audio.mp4", f"/out/{stem}-promo-30s.mp4"))
        self.assertEqual(tide["cover_url"], f"/out/{stem}-cover-3000x3000.jpg", "the cover JPG comes back after a restart")
        self.assertEqual((tide["format"], tide["look"], tide["resolution"], tide["size_mb"]), ("youtube_16_9", "Neon Tide", "1920x1080", 2.0))
        self.assertEqual((st._renders[0]["resolution"], st._renders[2]["resolution"]), ("1080x1920", "540x960"))
        self.assertIsNone(st._renders[2]["audio_url"])
        self.assertIsNone(st._renders[2]["cover_url"])

    def test_export_names_are_safe_and_carry_the_delivered_size(self) -> None:
        name = os.path.basename(state_mod._export_dest({"look": "Ünïcode & Co!!", "bpm": 127.6, "duration": 4.0, "format": "apple_square"}))
        self.assertTrue(name.startswith("canvas-n-code-co-apple-square-128bpm-8.0s-3840x3840-"), name)
        self.assertTrue(os.path.basename(state_mod._export_dest({"look": "!!!"})).startswith("canvas-canvas-0bpm-"))
        self.assertEqual(state_mod._export_format({"format": "tiktok"}), "spotify")
        self.assertEqual(state_mod._export_format({}), "spotify")
        self.assertEqual(state_mod._export_format({"format": "cover_art"}), "cover_art")

    def test_finish_export_clamps_the_promo_and_finds_the_song(self) -> None:
        st = state_mod.StudioState()
        st._initialized = True
        song = self.touch("song.wav")
        st._tracks = {"t1": library.Track("t1", song, "song.wav", "added", "", 0.0)}
        result = {"size_mb": 1.0, "checks": [], "width": 720, "height": 1280, "duration": 4.0}
        calls = []
        with mock.patch.object(state_mod, "STATE", st), \
             mock.patch.object(state_mod.delivery, "deliver", side_effect=lambda *a, **kw: calls.append((a, kw)) or result):
            for promo in ("abc", 120, -5, 12.5, None):
                entry = state_mod._finish_export(os.path.join(self.out, "x.mp4"), {"track_id": "t1", "promo_seconds": promo, "format": "odd"})
            state_mod._finish_export(os.path.join(self.out, "y.mp4"), {"track_id": "gone", "with_audio": False, "audio_start": 2})
        self.assertEqual([kw["promo_seconds"] for _, kw in calls[:5]], [0.0, 60.0, 0.0, 12.5, 0.0])
        self.assertEqual(calls[0][0][:4], (os.path.join(self.out, "x.mp4"), song, 0.0, 8.0))
        self.assertEqual(calls[0][1]["fmt"], "spotify")
        self.assertFalse(calls[0][1]["with_audio"], "no copy with the song unless the studio asks")
        self.assertEqual(calls[5][0][1:3], (None, 2.0))
        self.assertFalse(calls[5][1]["with_audio"])
        self.assertEqual(entry["resolution"], "720x1280")
        self.assertEqual([r["filename"] for r in st._renders], ["y.mp4", "x.mp4"], "a re-export replaces its old entry")

    def test_an_export_keeps_the_edit_it_was_made_from(self) -> None:
        st = state_mod.StudioState()
        st._initialized = True
        result = {"size_mb": 1.0, "checks": [], "width": 720, "height": 1280, "duration": 4.0}
        edit = {"selected": ["a"], "bars": 4}
        with mock.patch.object(state_mod, "STATE", st), mock.patch.object(state_mod.delivery, "deliver", return_value=result):
            with_edit = state_mod._finish_export(os.path.join(self.out, "a.mp4"), {"edit": edit})
            without = state_mod._finish_export(os.path.join(self.out, "b.mp4"), {})
            junk = state_mod._finish_export(os.path.join(self.out, "c.mp4"), {"edit": ["not", "an", "edit"]})
        self.assertEqual((with_edit["has_edit"], without["has_edit"], junk["has_edit"]), (True, False, False))
        self.assertNotIn("edit", with_edit, "the record doesn't carry the edit itself")
        self.assertEqual(st.projects.export_edit("a.mp4"), edit)
        self.assertEqual(sorted(os.listdir(os.path.join(self.out, "projects", "exports"))), ["a.json"])

        # found again after a restart
        self.touch("a.mp4")
        self.touch("b.mp4")
        again = state_mod.StudioState()
        again._discover_existing_renders()
        self.assertEqual({r["filename"]: r["has_edit"] for r in again._renders}, {"a.mp4": True, "b.mp4": False})

    def test_hidden_clip_list_tolerates_a_damaged_file(self) -> None:
        self.assertEqual(state_mod._hidden_clips(), set())
        with open(os.path.join(self.out, ".hidden-clips.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(state_mod._hidden_clips(), set())

    def test_adding_clips_and_songs(self) -> None:
        st = state_mod.StudioState()
        st._initialized = True
        requested = []

        class Proxies:
            def request(self, src: source.Source, priority: int = 10) -> None:
                requested.append((src.name, priority))

            def shutdown(self) -> None:
                requested.append(("shutdown", 0))

        st._proxies = Proxies()
        st.library = library.Library(self.out)
        fake = source.Source(os.path.join(self.out, "uploads", "a.mp4"), 64, 112, 30.0, 30, 1.0)
        with mock.patch.object(state_mod, "probe", return_value=fake):
            self.assertIs(st.add_clip_path(fake.path), fake)
        self.assertEqual((st.clips[fake.id], requested), (fake, [("a.mp4", 5)]))

        self.touch(os.path.join("uploads", "tune.mp3"))
        track = st.add_track_path(os.path.join(self.out, "uploads", "tune.mp3"))
        self.assertEqual((track.name, track.source), ("tune.mp3", "added"))
        with self.assertRaisesRegex(ValueError, "too short or not an audio file"):
            st.add_track_path(os.path.join(self.out, "uploads", "notes.txt"))
        st.shutdown()
        self.assertEqual(requested[-1], ("shutdown", 0))

    def test_raw_sessions_are_capped_and_only_idle_unlocked_sessions_expire(self) -> None:
        st = state_mod.StudioState()
        st._initialized = True
        aborted: list[str] = []

        class Session:
            def __init__(self, name: str) -> None:
                self.name = name

            def abort(self) -> None:
                aborted.append(self.name)

        entries = {}
        with mock.patch.object(state_mod.time, "monotonic", return_value=0.0):
            for name in ("stale", "active", "busy", "fresh"):
                session = Session(name)
                st.add_raw_session(name, session, {})
                entries[name] = st.raw_sessions[name]
            with self.assertRaisesRegex(RuntimeError, "at most 4 exports"):
                st.add_raw_session("too-many", Session("too-many"), {})

        with mock.patch.object(state_mod.time, "monotonic", return_value=95.0):
            self.assertTrue(st.touch_raw_session("active", entries["active"]))
            self.assertTrue(st.touch_raw_session("fresh", entries["fresh"]))

        held = threading.Event()
        release = threading.Event()
        busy_lock = st.raw_session_lock("busy")

        def hold_busy_session() -> None:
            with busy_lock:
                held.set()
                release.wait(2)

        worker = threading.Thread(target=hold_busy_session)
        worker.start()
        self.assertTrue(held.wait(1))
        self.assertEqual(st.expire_raw_sessions(10.0, now=100.0), ["stale"])
        self.assertEqual(aborted, ["stale"])
        self.assertIn("busy", st.raw_sessions, "maintenance skips a frame write already in flight")
        self.assertIn("active", st.raw_sessions, "a recently refreshed session stays open")

        release.set()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(st.expire_raw_sessions(10.0, now=100.0), ["busy"])
        self.assertEqual(aborted, ["stale", "busy"])

    def test_clips_are_the_videos_in_uploads_and_the_picked_folders(self) -> None:
        picked = os.path.join(self.out, "picked")
        for name in ("uploads/mine.mp4", "picked/a.mp4", "picked/broken.mp4", "picked/hidden.mp4",
                     "picked/canvas-neon-128bpm-7.5s-1080x1920-20261023-120000.mp4"):
            self.touch(name)
        with open(os.path.join(self.out, ".hidden-clips.json"), "w") as f:
            json.dump([os.path.join(picked, "hidden.mp4")], f)
        probed = []
        repaired = False

        def fake_probe(path: str) -> source.Source:
            probed.append(os.path.basename(path))
            if "broken" in path and not repaired:
                raise RuntimeError("cannot open video")
            return source.Source(path, 64, 112, 30.0, 30, 1.0)

        st = state_mod.StudioState()
        st._initialized = True
        st._proxies = mock.Mock()
        st.library = library.Library(self.out)
        with mock.patch.object(state_mod, "OUT_DIR", self.out), mock.patch.object(state_mod, "probe", side_effect=fake_probe):
            st.rescan()
            self.assertEqual(sorted(s.name for s in st.clips.values()), ["mine.mp4"], "nothing from a folder until it's picked")
            st.library.add_folder(picked)
            st.rescan()
            self.assertEqual(sorted(s.name for s in st.clips.values()), ["a.mp4", "mine.mp4"], "no hidden clips, exports or unreadable files")
            st.rescan()
            self.assertEqual(probed.count("broken.mp4"), 1, "an unchanged unreadable file is not retried")
            repaired = True
            self.touch("picked/broken.mp4", size=2)
            st.rescan()
            self.assertEqual(sorted(s.name for s in st.clips.values()), ["a.mp4", "broken.mp4", "mine.mp4"],
                             "a repaired file at the same path is probed again")
            st.library.remove_folder(picked)
            st.rescan()
        self.assertEqual(sorted(s.name for s in st.clips.values()), ["mine.mp4"])
        self.assertEqual((probed.count("a.mp4"), probed.count("broken.mp4")), (1, 2))
        st._proxies.request.assert_not_called()  # playback copies wait until a clip is put in the edit
        state_mod.StudioState().shutdown()  # nothing started yet


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestExportNames(TempDirCase):
    """Export file names carry the look, format, length and size, and can be read back."""

    def test_state_export_dest_and_cover_url(self) -> None:
        from downbeat.server.state import StudioState, _export_dest
        st = StudioState()
        st._initialized = True
        self.assertEqual(st.palettes, {})

        meta_apple = {"format": "apple_tall", "duration": 4.0, "width": 1080, "height": 1920, "look": "neon", "bpm": 120}
        dest_apple = _export_dest(meta_apple)
        self.assertIn("-8.0s-", dest_apple)

        meta_yt = {"format": "youtube_16_9", "duration": 4.0, "width": 1920, "height": 1080, "look": "neon", "bpm": 120}
        dest_yt = _export_dest(meta_yt)
        self.assertIn("-4.0s-", dest_yt)

        meta_cover = {"format": "cover_art", "duration": 4.0, "width": 1500, "height": 1500, "look": "neon", "bpm": 120}
        dest_cover = _export_dest(meta_cover)
        self.assertIn("-4.0s-1500x1500-", dest_cover, "the motion preview is named for the size it's rendered at")

        prores = _export_dest({**meta_apple, "codec": "prores_422_hq"})
        self.assertTrue(prores.endswith(".mov"))
        self.assertNotEqual(prores, _export_dest({**meta_apple, "codec": "prores_422_hq"}),
                            "concurrent exports never share a destination")

        entry = st.add_export(
            dest_apple,
            {**meta_apple, "codec": "prores_422_hq"},
            {
                "size_mb": 1.2,
                "width": 1080,
                "height": 1920,
                "duration": 16.0,
                "checks": [],
                "cover_path": os.path.join(self.tmp, "album-cover-3000x3000.jpg"),
            },
        )
        self.assertEqual(entry["cover_url"], "/out/album-cover-3000x3000.jpg")
        self.assertEqual(entry["output_codec"], "prores_422_hq")

    def test_export_names_round_trip_for_rediscovered_renders(self) -> None:
        from downbeat.server.state import _export_dest, parse_export_name
        meta = {"format": "youtube_16_9", "duration": 6.4, "width": 1920, "height": 1080, "look": "Neon Tide", "bpm": 151}
        info = parse_export_name(os.path.basename(_export_dest(meta)))
        self.assertEqual(info["format"], "youtube_16_9")
        self.assertEqual(info["resolution"], "1920x1080")
        self.assertEqual(info["look"], "Neon Tide")
        self.assertEqual((info["bpm"], info["duration"]), (151.0, 6.4))

        spotify = parse_export_name("canvas-liquid-chrome-150bpm-6.4s-720x1280-20261023-134856.mp4")
        self.assertNotIn("format", spotify)
        self.assertEqual((spotify["look"], spotify["resolution"]), ("Liquid Chrome", "720x1280"))
        # CLI renders carry no size, so their name is not mistaken for a look.
        self.assertEqual(parse_export_name("canvas-custom-s2026-130bpm-8s-master.mp4"), {"bpm": 130.0, "duration": 8.0})
        self.assertEqual(parse_export_name("my-clip.mp4"), {})


class TestLibraryCleanup(unittest.TestCase):
    def test_removing_a_clip_deletes_uploads_but_only_hides_other_files(self) -> None:
        from unittest import mock

        from downbeat.media.source import Source
        from downbeat.server import state as state_mod

        out = tempfile.mkdtemp(prefix="db-out-")
        picked = tempfile.mkdtemp(prefix="db-picked-")
        self.addCleanup(shutil.rmtree, out, True)
        self.addCleanup(shutil.rmtree, picked, True)
        os.makedirs(os.path.join(out, "uploads"))
        still = os.path.join(out, "uploads", "cover.still.mp4")
        image = os.path.join(out, "uploads", "cover.png")
        other_upload = os.path.join(out, "uploads", "cover-b.png")
        mine = os.path.join(picked, "1234_my-clip.mp4")
        for p in (still, image, other_upload, mine):
            open(p, "wb").close()
        proxy_dir = os.path.join(out, ".proxies")
        os.makedirs(proxy_dir)

        def src(path: str) -> Source:
            return Source(path=path, width=1920, height=1080, fps=30.0, frame_count=300, duration=10.0)

        class FakeProxies:
            def path_for(self, s: Source) -> str:
                return os.path.join(proxy_dir, os.path.basename(s.path) + ".proxy.mp4")

        st = state_mod.StudioState()
        st._initialized = True
        st._proxies = FakeProxies()
        a, b = src(still), src(mine)
        st._clips = {a.id: a, b.id: b}
        for s_ in (a, b):
            open(st._proxies.path_for(s_), "wb").close()

        with mock.patch.object(state_mod, "OUT_DIR", out):
            self.assertTrue(st.remove_clip(a.id))
            self.assertFalse(st.remove_clip(b.id))
            with self.assertRaises(KeyError):
                st.remove_clip(a.id)
            # the file in the picked folder is hidden, so a fresh start doesn't pick it up again
            fresh = state_mod.StudioState()
            fresh.library.add_folder(picked)
            with mock.patch.object(state_mod, "probe", side_effect=src):
                fresh._tracks, fresh._clips = fresh._scan()

        self.assertEqual(sorted(os.listdir(os.path.join(out, "uploads"))), ["cover-b.png"])
        self.assertTrue(os.path.isfile(mine))
        self.assertEqual(os.listdir(proxy_dir), [])
        self.assertEqual(st._clips, {})
        self.assertEqual(fresh._clips, {})

    def test_delete_removes_the_export_and_its_companions_only(self) -> None:
        from unittest import mock

        from downbeat.server import state as state_mod

        out = tempfile.mkdtemp(prefix="db-out-")
        self.addCleanup(shutil.rmtree, out, True)
        stem = "canvas-neon-128bpm-7.5s-1080x1920-20261023-120000"
        companions = ["-audio.mp4", "-promo-15s.mp4", "-cover-3000x3000.jpg", "-teaser.gif", "-spotify_header.jpg"]
        keep = [f"{stem}-2.mp4", "other.mp4", f"{stem}-notes.txt"]
        for name in [f"{stem}.mp4", *[stem + c for c in companions], *keep]:
            open(os.path.join(out, name), "wb").close()

        st = state_mod.StudioState()
        st._initialized = True  # don't scan ~/Downloads or start proxies
        st._renders = [{"filename": f"{stem}.mp4"}, {"filename": "other.mp4"}]
        with mock.patch.object(state_mod, "OUT_DIR", out):
            st.projects.save_export_edit(f"{stem}.mp4", {"bars": 4})
            st.projects.save_export_edit("other.mp4", {"bars": 2})
            removed = st.remove_export(f"../{stem}.mp4")
            # its edit goes with it, and other exports keep theirs
            self.assertEqual((st.projects.has_export_edit(f"{stem}.mp4"), st.projects.has_export_edit("other.mp4")), (False, True))
            shutil.rmtree(os.path.join(out, "projects"))
            with self.assertRaises(FileNotFoundError):
                st.remove_export(f"{stem}.mp4")
            with self.assertRaises(FileNotFoundError):
                st.remove_export("../README.md")

        self.assertEqual(sorted(removed), sorted([f"{stem}.mp4", *[stem + c for c in companions]]))
        self.assertEqual(sorted(os.listdir(out)), sorted(keep))
        self.assertEqual([r["filename"] for r in st._renders], ["other.mp4"])

    def test_delete_removes_a_mov_master_and_its_mov_companion(self) -> None:
        from downbeat.server import state as state_mod

        out = tempfile.mkdtemp(prefix="db-out-")
        self.addCleanup(shutil.rmtree, out, True)
        stem = "canvas-master-120bpm-8.0s-3840x3840-20261023-120000"
        for suffix in (".mov", "-audio.mov", "-cover-3000x3000.jpg"):
            with open(os.path.join(out, stem + suffix), "wb") as f:
                f.write(b"x")
        st = state_mod.StudioState()
        st._initialized = True
        with mock.patch.object(state_mod, "OUT_DIR", out):
            st._discover_existing_renders()
            self.assertEqual(st._renders[0]["audio_url"], f"/out/{stem}-audio.mov")
            st.projects.save_export_edit(stem + ".mov", {"bars": 2})
            removed = st.remove_export(stem + ".mov")
        self.assertEqual(sorted(removed), sorted([stem + ".mov", stem + "-audio.mov", stem + "-cover-3000x3000.jpg"]))
        self.assertEqual(os.listdir(out), ["projects"])


if __name__ == "__main__":
    unittest.main()
