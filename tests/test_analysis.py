"""Analysis of the song and the footage: tempo, beat grid, envelopes, subject framing, palettes."""
from __future__ import annotations

import os
import subprocess
import unittest
from unittest import mock

import cv2
import numpy as np

from downbeat.analysis import audio, framing
from downbeat.analysis.features import _default_bars, track_features
from helpers import HAS_FFMPEG, TempDirCase


class TestAudioHelpers(unittest.TestCase):
    def test_tempo_in_a_file_name_is_read_between_80_and_169(self) -> None:
        cases = {"song_128bpm.wav": 128, "track-95.mp3": 95, "beat 80 bpm.wav": 80, "x-169.wav": 169,
                 "song 170bpm.wav": None, "loop_79.wav": None, "plain.wav": None, "v2-final.wav": None}
        for name, bpm in cases.items():
            self.assertEqual(audio._bpm_from_name(name), bpm, name)

    def test_curve_helpers_handle_empty_flat_and_normal_input(self) -> None:
        self.assertEqual(audio._normalize_curve(np.array([], np.float64)).dtype, np.float32)
        self.assertTrue(np.array_equal(audio._normalize_curve(np.full(10, 3.0)), np.zeros(10, np.float32)))
        ramp = audio._normalize_curve(np.arange(101, dtype=np.float64), 0, 100)
        self.assertEqual((float(ramp[0]), float(ramp[-1])), (0.0, 1.0))
        self.assertTrue(np.all(np.diff(ramp) >= 0))

        self.assertEqual(audio._smooth_envelope(np.array([])).size, 0)
        self.assertEqual(audio._smooth_envelope(np.array([0.5])).tolist(), [0.5])
        step = audio._smooth_envelope(np.r_[np.zeros(5), np.ones(20)])
        self.assertTrue(0.0 < step[6] < step[10] < 1.0, "a step rises over a few frames")
        self.assertTrue(np.all((step >= 0) & (step <= 1)))

        self.assertEqual(audio._flux(np.array([0.0, 1.0, 0.5, 2.0])).tolist(), [0.0, 1.0, 0.0, 1.5])
        rows = audio._flux(np.array([[1.0, 2.0], [0.0, 5.0]]), axis=0)
        self.assertEqual(rows.tolist(), [[0.0, 0.0], [0.0, 3.0]])


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
class TestAudioAnalysis(TempDirCase):
    def test_analysis_finds_the_tempo_and_caches_the_result(self) -> None:
        path = self.wav("ten.wav", 10.0, bpm=120.0)
        prof = audio.analyze_track(path)
        self.assertLessEqual(abs(prof.detected_bpm - 120), 1)
        self.assertAlmostEqual(prof.duration, 10.0, places=2)
        self.assertEqual(len(prof.waveform_peaks), 96)
        self.assertTrue(all(0.0 <= p <= 1.0 for p in prof.waveform_peaks))
        self.assertTrue(0.0 <= prof.best_start_sec <= 2.0)
        self.assertIs(audio.analyze_track(path), prof)
        d = prof.to_dict()
        self.assertEqual(sorted(d), ["best_start_sec", "detected_bpm", "duration", "id", "name", "path", "waveform_peaks"])
        self.assertEqual((d["name"], d["duration"]), ("ten.wav", 10.0))

    def test_a_tempo_in_the_name_wins_and_short_songs_start_at_zero(self) -> None:
        prof = audio.analyze_track(self.wav("short_140bpm.wav", 4.0, bpm=100.0))
        self.assertEqual((prof.detected_bpm, prof.best_start_sec), (140, 0.0))

    def test_short_files_are_padded_and_missing_ones_raise(self) -> None:
        y = audio._decode_pcm(self.wav("blip.wav", 0.2))
        self.assertEqual(y.size, audio.SR)
        with self.assertRaises(FileNotFoundError):
            audio._decode_pcm(self.path("missing.wav"))

    def test_frame_curves_wrap_past_the_end_of_the_song(self) -> None:
        path = self.wav("curves.wav", 6.0)
        curves = audio.extract_frame_curves(path, 60, start_sec=5.5)
        self.assertEqual(curves.start_sec, 5.5)
        for arr in (curves.sub_bass, curves.transient, curves.high_air, curves.rms):
            self.assertEqual((arr.shape, arr.dtype), ((60,), np.float32))
            self.assertTrue(np.all((arr >= 0.0) & (arr <= 0.85 + 1e-6)))
        self.assertEqual(audio.extract_frame_curves(path, 30).start_sec, audio.analyze_track(path).best_start_sec)

    def test_long_frame_analysis_bounds_fft_memory_and_preserves_circular_audio(self) -> None:
        path = self.wav("long-curves.wav", 6.0)
        audio.analyze_track(path)
        with mock.patch.object(np.fft, "rfft", wraps=np.fft.rfft) as fft:
            curves = audio.extract_frame_curves(path, 2500, start_sec=5.5)
        batches = [call.args[0].shape[0] for call in fft.call_args_list]
        self.assertEqual(sum(batches), 2500)
        self.assertLessEqual(max(batches), 1024, "FFT working memory is independent of export length")
        repeated = audio.extract_frame_curves(path, 2500, start_sec=17.5)
        for name in ("sub_bass", "transient", "high_air", "rms"):
            np.testing.assert_allclose(getattr(curves, name), getattr(repeated, name), atol=1e-6)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestBeatGridAndFraming(TempDirCase):
    """Beat grid and loop length from a click track; subject framing and palettes from clips."""

    def test_a_song_longer_than_three_minutes_is_analyzed_to_its_end_in_bounded_batches(self) -> None:
        path = self._click_track(bpm=125.0, seconds=200.0, offset=0.37)
        with mock.patch.object(np.fft, "rfft", wraps=np.fft.rfft) as fft:
            f = track_features(path)
        self.assertLessEqual(max(call.args[0].shape[0] for call in fft.call_args_list), audio.FFT_ROWS,
                             "FFT working memory doesn't grow with the song")
        self.assertAlmostEqual(f["duration"], 200.0, places=2)
        self.assertAlmostEqual(audio.analyze_track(path).duration, 200.0, places=2)
        self.assertAlmostEqual(f["bpm"], 125.0, delta=0.15)
        self.assertGreater(f["beats"][-1], 200.0 - 2 * 60 / 125, "the beat grid reaches the end of the song")
        self.assertLessEqual(abs(len(f["curves"]["kick"]) - 200 * 30), 1)

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

        # An image the video reader can't open is decoded directly, even from a folder whose name
        # cv2.imread can't open on Windows.
        accented = self.path("José 音楽", "cover.png")
        with open(accented, "wb") as f:
            f.write(cv2.imencode(".png", frame)[1].tobytes())
        with mock.patch.object(framing, "_sample_pairs", return_value=[]):
            pal_accented = framing.extract_palette(accented, k=5)
            pal_missing = framing.extract_palette(self.path("José 音楽", "missing.png"), k=5)
        self.assertAlmostEqual(pal_accented["primary_hue"], pal_still["primary_hue"], delta=0.05)
        self.assertNotAlmostEqual(pal_missing["primary_hue"], pal_still["primary_hue"], delta=0.05)


if __name__ == "__main__":
    unittest.main()
