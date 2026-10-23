"""Tests for the GPU Studio backend: audio features, proxies, delivery (mux + verify)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
import wave

import numpy as np

from canvasforge import delivery, framing
from canvasforge.features import _default_bars, track_features
from canvasforge.proxy import ProxyManager
from canvasforge.source import probe

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
        for name in ("kick", "snare", "hats", "bass", "energy", "bright"):
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


@unittest.skipUnless(shutil.which("node"), "node required for the studio JS tests")
class TestStudioJavaScript(unittest.TestCase):
    def test_node_suite(self) -> None:
        res = subprocess.run(["node", "--test", os.path.join(ROOT, "tests")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stdout[-3000:] + res.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
