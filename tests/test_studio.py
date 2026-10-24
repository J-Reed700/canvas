from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
import wave

import cv2
import numpy as np

from downbeat import delivery, framing
from downbeat.features import _default_bars, track_features
from downbeat.proxy import ProxyManager
from downbeat.source import probe

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _ffprobe(path: str) -> dict:
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]))


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestStudioBackend(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="cf-studio-")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _click_track(self, bpm: float, seconds: float, offset: float) -> str:
        """Kick-like thumps every beat, accented on the downbeat, starting at `offset` seconds."""
        sr = 22050
        y = np.zeros(int(sr * seconds), dtype=np.float32)
        beat = 60.0 / bpm
        n = np.arange(int(sr * 0.12))
        thump = np.sin(2 * np.pi * 60 * n / sr) * np.exp(-n / (sr * 0.03))
        hat = np.random.default_rng(0).normal(0, 1, int(sr * 0.02)) * np.exp(-np.arange(int(sr * 0.02)) / (sr * 0.004))
        for k, t in enumerate(np.arange(offset, seconds - 0.2, beat)):
            i = int(t * sr)
            y[i : i + thump.size] += thump * (1.0 if k % 4 == 0 else 0.55)
            j = int((t + beat / 2) * sr)
            y[j : j + hat.size] += hat * 0.15
        path = os.path.join(self.tmp, f"click-{int(bpm * 100)}.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.clip(y, -1, 1) * 32000).astype(np.int16).tobytes())
        return path

    def test_beat_grid_locks_onto_tempo_and_phase(self) -> None:
        path = self._click_track(bpm=125.0, seconds=40.0, offset=0.37)
        f = track_features(path)
        self.assertAlmostEqual(f["bpm"], 125.0, delta=0.15)
        beats = np.array(f["beats"])
        expected = 0.37 + np.arange(beats.size) * 60.0 / 125.0
        self.assertLess(float(np.max(np.abs(beats[: len(expected)] - expected[: len(beats)]))), 0.03)
        # downbeats fall on the accented thumps (every 4th beat from the first)
        self.assertLess(abs(f["downbeats"][0] - 0.37), 0.03)
        self.assertEqual(f["loop_bars"], 4)
        self.assertAlmostEqual(f["loop_seconds"], 4 * 4 * 60 / f["bpm"], places=3)
        n = int(round(f["duration"] * 30))
        for name in ("kick", "snare", "hats", "bass", "energy", "bright", "vocals", "presence"):
            self.assertLessEqual(abs(len(f["curves"][name]) - n), 1)
            self.assertTrue(all(0.0 <= v <= 1.0 for v in f["curves"][name]))
        kick = np.array(f["curves"]["kick"])
        on_beat = kick[(beats[:-1] * 30).astype(int) + 1].mean()
        off_beat = kick[((beats[:-1] + 60 / 125 / 2) * 30).astype(int)].mean()
        self.assertGreater(on_beat, off_beat * 2, "kick envelope should peak on the beats")
        self.assertEqual(f["loops"][0]["label"], "Drop")

    def test_default_bars_fit_the_canvas_window(self) -> None:
        for bpm, bars in ((151, 4), (128, 4), (84, 2), (95, 2), (174, 4), (60, 2), (40, 1)):
            self.assertEqual(_default_bars(240.0 / bpm), bars, bpm)
            self.assertTrue(3.0 <= bars * 240.0 / bpm <= 8.0)

    def test_annexb_remux_has_exact_timing_and_passes_spec(self) -> None:
        h264 = os.path.join(self.tmp, "in.h264")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-frames:v", "191",
             "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-f", "h264", h264],
            check=True,
        )
        dest = os.path.join(self.tmp, "out.mp4")
        delivery.mux_annexb(h264, dest, 30)
        info = _ffprobe(dest)
        video = info["streams"][0]
        self.assertEqual(video["r_frame_rate"], "30/1")
        self.assertEqual(int(video["nb_frames"]), 191)
        self.assertAlmostEqual(float(info["format"]["duration"]), 191 / 30, places=2)
        checks = {c["id"]: c["level"] for c in delivery.verify(dest, {"seam_ratio": 0.8, "max_flashes_per_sec": 0})}
        for cid in ("length", "aspect", "codec", "silent", "fps", "faststart", "seam", "flash"):
            self.assertEqual(checks[cid], "ok", cid)
        self.assertEqual(checks["height"], "fail", "640 px is under Spotify's 720 px minimum")

    def test_verify_flags_off_spec_files(self) -> None:
        bad = os.path.join(self.tmp, "bad.mp4")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-f", "lavfi", "-i", "sine",
             "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", bad],
            check=True,
        )
        checks = {c["id"]: c["level"] for c in delivery.verify(bad, {"seam_ratio": 4.0, "max_flashes_per_sec": 6})}
        for cid in ("length", "aspect", "silent", "fps", "seam", "flash"):
            self.assertEqual(checks[cid], "fail", cid)

    def test_raw_rgba_session_flips_and_encodes(self) -> None:
        dest = os.path.join(self.tmp, "raw.mp4")
        session = delivery.RawSession(dest, 108, 192, 30)
        frame = np.zeros((192, 108, 4), dtype=np.uint8)
        frame[:96, :, 0] = 255  # WebGL rows are bottom-up: red bottom half in the readback...
        for _ in range(90):
            self.assertEqual(session.write(frame.tobytes()), 1)
        session.finish()
        png = os.path.join(self.tmp, "raw.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", dest, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", png], check=True)
        with open(png, "rb") as fh:
            img = np.frombuffer(fh.read(), dtype=np.uint8).reshape(192, 108, 3)
        self.assertGreater(img[150:, :, 0].mean(), 200, "...must end up at the bottom of the video")
        self.assertLess(img[:40, :, 0].mean(), 40)

    def test_proxy_is_constant_30fps_short_gop(self) -> None:
        clip = os.path.join(self.tmp, "clip.mp4")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "2",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", clip],
            check=True,
        )
        pm = ProxyManager(os.path.join(self.tmp, "proxies"))
        path = pm.ensure(probe(clip))
        self.assertIsNotNone(path)
        video = _ffprobe(path)["streams"][0]
        self.assertEqual(video["r_frame_rate"], "30/1")
        self.assertEqual((video["width"], video["height"]), (640, 360))
        self.assertEqual(int(video.get("has_b_frames", 0)), 0)
        self.assertEqual(pm.status(probe(clip)), "ready")

    def _sine_wav(self, seconds: float) -> str:
        path = os.path.join(self.tmp, f"tone-{seconds}.wav")
        sr = 22050
        y = (0.3 * np.sin(2 * np.pi * 220 * np.arange(int(sr * seconds)) / sr) * 32767).astype(np.int16)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(y.tobytes())
        return path

    def _silent_loop(self, name: str, size: str, seconds: float) -> str:
        path = os.path.join(self.tmp, name)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30", "-t", str(seconds),
             "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
            check=True,
        )
        return path

    def test_autoframe_finds_a_moving_subject_off_centre(self) -> None:
        clip = os.path.join(self.tmp, "subject.mp4")
        rng = np.random.default_rng(3)
        texture = rng.integers(60, 255, (240, 240, 3), dtype=np.uint8)
        enc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "1920x1080", "-r", "30", "-i", "-",
             "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", clip],
            stdin=subprocess.PIPE,
        )
        for i in range(90):  # a bright textured blob drifting around the right third of a dark frame
            frame = np.full((1080, 1920, 3), 12, dtype=np.uint8)
            x, y = 1450 + int(60 * np.sin(i / 7)), 420 + int(40 * np.cos(i / 9))
            frame[y:y + 240, x:x + 240] = np.roll(texture, i * 7, axis=1)
            enc.stdin.write(frame.tobytes())
        enc.stdin.close()
        enc.wait()
        res = framing.autoframe(clip)
        self.assertEqual(res["method"], "subject", res)
        self.assertGreater(res["focus"][0], 0.55, res)
        self.assertTrue(0.2 < res["focus"][1] < 0.8, res)

    def test_autoframe_keeps_the_centre_of_a_flat_clip(self) -> None:
        clip = os.path.join(self.tmp, "flat.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x202830:size=640x360:rate=30", "-t", "1",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], check=True)
        self.assertEqual(framing.autoframe(clip), {"focus": [0.5, 0.5], "method": "center"})

    def test_promo_repeats_the_loop_under_the_song(self) -> None:
        loop = self._silent_loop("promo-loop.mp4", "180x320", 2)
        dest = os.path.join(self.tmp, "promo.mp4")
        self.assertEqual(delivery.mux_promo(loop, self._sine_wav(10), dest, 1.0, 6), dest)
        info = _ffprobe(dest)
        self.assertAlmostEqual(float(info["format"]["duration"]), 6.0, delta=0.1)
        self.assertEqual(sorted(s["codec_type"] for s in info["streams"]), ["audio", "video"])
        # the song runs out 4 s after the start point: the promo stops with it
        short = os.path.join(self.tmp, "promo-short.mp4")
        delivery.mux_promo(loop, self._sine_wav(10), short, 6.0, 15)
        self.assertAlmostEqual(float(_ffprobe(short)["format"]["duration"]), 4.0, delta=0.1)

    def test_apple_formats_repeat_whole_loops_and_check_their_own_spec(self) -> None:
        dest = self._silent_loop("apple.mp4", "240x320", 4)
        result = delivery.deliver(dest, self._sine_wav(10), 0.0, 4.0, {"seam_ratio": 0.8, "max_flashes_per_sec": 0},
                                  fmt="apple_tall", promo_seconds=15)
        self.assertIsNone(result["audio_path"])
        self.assertIsNone(result["promo_path"])
        info = _ffprobe(dest)
        self.assertAlmostEqual(float(info["format"]["duration"]), 16.0, delta=0.05)  # 4 loops: first count >= 15 s
        self.assertEqual(int(info["streams"][0]["nb_frames"]), 480)
        checks = {c["id"]: (c["level"], c["label"]) for c in result["checks"]}
        self.assertEqual(checks["aspect"], ("ok", "Apple Music motion art · 3:4"))
        self.assertEqual(checks["size"][0], "warn")  # 240×320 is far below 2048×2732
        for cid in ("length", "codec", "silent", "fps", "seam", "flash"):
            self.assertEqual(checks[cid][0], "ok", cid)
        self.assertNotIn("tall", checks)
        square = {c["id"]: c["level"] for c in delivery.verify(dest, None, "apple_square")}
        self.assertEqual(square["aspect"], "fail")

    def test_extract_palette_returns_colors_roles_gradient_and_primary_hue(self) -> None:
        clip = os.path.join(self.tmp, "palette_test.mp4")
        enc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "320x320", "-r", "30", "-i", "-",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip],
            stdin=subprocess.PIPE,
        )
        # 5 distinct color regions: vibrant red, dark shadow, bright white, dominant blue, secondary green
        frame = np.full((320, 320, 3), 15, dtype=np.uint8)  # dark shadow
        frame[:100, :160] = [0, 0, 255]  # BGR vibrant red
        frame[:100, 160:] = [255, 255, 255]  # bright highlight
        frame[100:240, :] = [255, 120, 0]  # BGR dominant blue
        frame[240:, :] = [0, 200, 0]  # BGR green secondary
        for _ in range(30):
            enc.stdin.write(frame.tobytes())
        enc.stdin.close()
        enc.wait()

        pal = framing.extract_palette(clip, k=5)
        self.assertIn("colors", pal)
        self.assertIn("css_gradient", pal)
        self.assertIn("primary_hue", pal)
        colors = pal["colors"]
        self.assertEqual(len(colors), 5)
        for c in colors:
            self.assertTrue(c["hex"].startswith("#"))
            self.assertEqual(len(c["hex"]), 7)
            self.assertIn("role", c)
            self.assertIn("rgb", c)
            self.assertIn("luma", c)
            self.assertIn("saturation", c)
            self.assertIn("hue", c)
        roles = {c["role"] for c in colors}
        self.assertIn("Accent", roles)
        self.assertIn("Highlight", roles)
        self.assertIn("Shadow", roles)
        self.assertIn("Dominant", roles)
        self.assertIn("Secondary", roles)
        self.assertTrue(pal["css_gradient"].startswith("linear-gradient(180deg, #"))
        self.assertTrue(0.0 <= pal["primary_hue"] <= 1.0)

        still_path = os.path.join(self.tmp, "palette_still.png")
        cv2.imwrite(still_path, frame)
        pal_still = framing.extract_palette(still_path, k=5)
        self.assertEqual(len(pal_still["colors"]), 5)
        self.assertTrue(pal_still["css_gradient"].startswith("linear-gradient(180deg, #"))

    def test_state_export_dest_and_cover_url(self) -> None:
        from downbeat.state import StudioState, _export_dest
        st = StudioState()
        st._initialized = True
        self.assertEqual(st.palettes, {})

        meta_apple = {"format": "apple_tall", "duration": 4.0, "width": 1080, "height": 1920, "look": "neon", "bpm": 120}
        dest_apple = _export_dest(meta_apple)
        self.assertIn("-16.0s-", dest_apple)

        meta_yt = {"format": "youtube_16_9", "duration": 4.0, "width": 1920, "height": 1080, "look": "neon", "bpm": 120}
        dest_yt = _export_dest(meta_yt)
        self.assertIn("-4.0s-", dest_yt)

        meta_cover = {"format": "cover_art", "duration": 4.0, "width": 3000, "height": 3000, "look": "neon", "bpm": 120}
        dest_cover = _export_dest(meta_cover)
        self.assertIn("-4.0s-", dest_cover)

        entry = st.add_export(
            dest_apple,
            meta_apple,
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

    def test_export_names_round_trip_for_rediscovered_renders(self) -> None:
        from downbeat.state import _export_dest, parse_export_name
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

    @unittest.skipUnless(hasattr(delivery, "export_cover_art"), "delivery companion export functions not yet implemented")
    def test_delivery_companion_exports(self) -> None:
        clip = self._silent_loop("companion_src.mp4", "360x640", 3)
        cover_dest = os.path.join(self.tmp, "cover.jpg")
        delivery.export_cover_art(clip, cover_dest, size=3000, at_sec=1.0)
        self.assertTrue(os.path.isfile(cover_dest))
        self.assertGreater(os.path.getsize(cover_dest), 0)

        gif_dest = os.path.join(self.tmp, "teaser.gif")
        delivery.export_animated(clip, gif_dest, fmt="gif")
        self.assertTrue(os.path.isfile(gif_dest))
        self.assertGreater(os.path.getsize(gif_dest), 0)

        webp_dest = os.path.join(self.tmp, "teaser.webp")
        webp_res = delivery.export_animated(clip, webp_dest, fmt="webp")
        self.assertTrue(os.path.isfile(webp_res))
        self.assertGreater(os.path.getsize(webp_res), 0)

        for btype in ("spotify_header", "youtube_banner", "soundcloud_header"):
            banner_dest = os.path.join(self.tmp, f"{btype}.jpg")
            delivery.export_banner(clip, banner_dest, banner_type=btype, focus=(0.5, 0.5), at_sec=1.0)
            self.assertTrue(os.path.isfile(banner_dest))
            self.assertGreater(os.path.getsize(banner_dest), 0)


class TestLibraryCleanup(unittest.TestCase):
    def test_removing_a_clip_deletes_uploads_but_only_hides_other_files(self) -> None:
        from unittest import mock

        from downbeat import state as state_mod
        from downbeat.source import Source

        out = tempfile.mkdtemp(prefix="db-out-")
        dl = tempfile.mkdtemp(prefix="db-dl-")
        self.addCleanup(shutil.rmtree, out, True)
        self.addCleanup(shutil.rmtree, dl, True)
        os.makedirs(os.path.join(out, "uploads"))
        still = os.path.join(out, "uploads", "cover.still.mp4")
        image = os.path.join(out, "uploads", "cover.png")
        other_upload = os.path.join(out, "uploads", "cover-b.png")
        mine = os.path.join(dl, "1234_my-clip.mp4")
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

        with mock.patch.object(state_mod, "OUT_DIR", out), mock.patch.object(state_mod.os.path, "expanduser", return_value=dl):
            self.assertTrue(st.remove_clip(a.id))
            self.assertFalse(st.remove_clip(b.id))
            with self.assertRaises(KeyError):
                st.remove_clip(a.id)
            # the Downloads file is hidden, so a fresh start doesn't pick it up again
            fresh = state_mod.StudioState()
            with mock.patch.object(state_mod, "probe", side_effect=src):
                fresh._discover_initial_clips()

        self.assertEqual(sorted(os.listdir(os.path.join(out, "uploads"))), ["cover-b.png"])
        self.assertTrue(os.path.isfile(mine))
        self.assertEqual(os.listdir(proxy_dir), [])
        self.assertEqual(st._clips, {})
        self.assertEqual(fresh._clips, {})

    def test_delete_removes_the_export_and_its_companions_only(self) -> None:
        from unittest import mock

        from downbeat import state as state_mod

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
            removed = st.remove_export(f"../{stem}.mp4")
            with self.assertRaises(FileNotFoundError):
                st.remove_export(f"{stem}.mp4")
            with self.assertRaises(FileNotFoundError):
                st.remove_export("../README.md")

        self.assertEqual(sorted(removed), sorted([f"{stem}.mp4", *[stem + c for c in companions]]))
        self.assertEqual(sorted(os.listdir(out)), sorted(keep))
        self.assertEqual([r["filename"] for r in st._renders], ["other.mp4"])


@unittest.skipUnless(
    shutil.which("node") and (
        os.path.isfile(os.path.join(ROOT, "downbeat", "studio", "timeline.ts"))
        or os.path.isfile(os.path.join(ROOT, "downbeat", "studio", "timeline.js"))
    ),
    "node and studio TS/JS modules required for the studio tests",
)
class TestSongLibrary(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.out = os.path.join(self.tmp, "out")
        self.downloads = os.path.join(self.tmp, "Downloads")
        self.music = os.path.join(self.tmp, "Music")
        for d in (self.out, self.downloads, self.music):
            os.makedirs(d)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _wav(self, path: str, seconds: float) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(b"\0" * int(44100 * seconds) * 4)
        return path

    def test_lists_every_song_without_analysing_and_keeps_added_ones(self) -> None:
        from downbeat.audio import analyze_track
        from downbeat.library import Library

        for i in range(12):  # more than the old limit of 8
            self._wav(os.path.join(self.downloads, f"song-{i}.wav"), 3.0)
        self._wav(os.path.join(self.downloads, "ping.wav"), 0.2)  # an alert sound, too small
        self._wav(os.path.join(self.downloads, "nested", "deeper.wav"), 3.0)  # Downloads is top level only
        added = self._wav(os.path.join(self.out, "uploads", "short-loop.wav"), 0.2)  # added on purpose: kept
        lib = Library(self.out, downloads=self.downloads)

        tracks = lib.scan()
        names = sorted(t.name for t in tracks.values())
        self.assertEqual(len(names), 13)
        self.assertNotIn("ping.wav", names)
        self.assertNotIn("deeper.wav", names)
        song = next(t for t in tracks.values() if t.name == "song-3.wav")
        self.assertEqual(song.source, "downloads")
        # Same id the old analysis gave, so a saved session still finds its song.
        self.assertEqual(song.id, analyze_track(song.path).id)
        self.assertEqual(next(t for t in tracks.values() if t.path == added).source, "added")

    def test_music_folders_are_scanned_with_subfolders_and_remembered(self) -> None:
        from downbeat.library import Library

        self._wav(os.path.join(self.music, "Artist", "Album", "01 Intro.wav"), 3.0)
        self._wav(os.path.join(self.music, "Library.musiclibrary", "inside.wav"), 3.0)
        self._wav(os.path.join(self.music, ".hidden", "secret.wav"), 3.0)
        lib = Library(self.out, downloads=self.downloads)
        with self.assertRaises(FileNotFoundError):
            lib.add_folder(os.path.join(self.tmp, "missing"))
        lib.add_folder(self.music)

        again = Library(self.out, downloads=self.downloads)  # a restart reads out/.library.json
        self.assertEqual(again.folders(), [self.music])
        tracks = list(again.scan().values())
        self.assertEqual([(t.name, t.dir, t.source) for t in tracks], [("01 Intro.wav", os.path.join("Artist", "Album"), self.music)])

        again.remove_folder(self.music)
        self.assertEqual(Library(self.out, downloads=self.downloads).scan(), {})

    def test_formats_browsers_cannot_decode_are_converted_once(self) -> None:
        from downbeat.library import Library, playable_path

        wav = self._wav(os.path.join(self.downloads, "plain.wav"), 3.0)
        aiff = os.path.join(self.downloads, "studio.aiff")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, aiff], check=True)
        tracks = {t.name: t for t in Library(self.out, downloads=self.downloads).scan().values()}
        cache = os.path.join(self.out, ".audio-cache")

        self.assertEqual(playable_path(tracks["plain.wav"], cache), wav)
        converted = playable_path(tracks["studio.aiff"], cache)
        self.assertTrue(converted.endswith(".wav") and os.path.isfile(converted))
        with wave.open(converted) as w:
            self.assertAlmostEqual(w.getnframes() / w.getframerate(), 3.0, places=2)
        stamp = os.path.getmtime(converted)
        self.assertEqual(playable_path(tracks["studio.aiff"], cache), converted)
        self.assertGreaterEqual(os.path.getmtime(converted), stamp)


class TestStudioJavaScript(unittest.TestCase):
    def test_node_suite(self) -> None:
        res = subprocess.run(["node", "--test", os.path.join(ROOT, "tests")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stdout[-3000:] + res.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
