"""Unit tests for the backend helpers: sources, encoding, audio analysis, delivery, state, proxies and the song library."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import wave
from unittest import mock

import cv2
import numpy as np

from downbeat import audio, delivery, encoder, library, proxy, source
from downbeat import state as state_mod
from downbeat.effects.geometry import grid_clone

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
HAS_PIL = importlib.util.find_spec("PIL") is not None


def _ffprobe(path: str) -> dict:
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]))


def _video(info: dict) -> dict:
    return next(s for s in info["streams"] if s["codec_type"] == "video")


class _TempDir(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="db-units-")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def path(self, *parts: str) -> str:
        p = os.path.join(self.tmp, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def clip(self, name: str, size: str = "96x160", seconds: float = 2.0, rate: int = 30, extra: list[str] | None = None) -> str:
        dest = self.path(name)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}", "-t", f"{seconds:g}",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", *(extra or []), dest],
            check=True,
        )
        return dest

    def wav(self, name: str, seconds: float, bpm: float = 120.0, rate: int = 22050) -> str:
        """Mono thumps on every beat, accented every fourth."""
        dest = self.path(name)
        n = np.arange(int(rate * 0.12))
        thump = np.sin(2 * np.pi * 60 * n / rate) * np.exp(-n / (rate * 0.03))
        y = np.zeros(int(rate * seconds), dtype=np.float32)
        for k, t in enumerate(np.arange(0.25, seconds - 0.2, 60.0 / bpm)):
            i = int(t * rate)
            y[i : i + thump.size] += thump * (1.0 if k % 4 == 0 else 0.55)
        with wave.open(dest, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes((np.clip(y, -1, 1) * 32000).astype(np.int16).tobytes())
        return dest


class TestSource(_TempDir):
    def test_source_names_and_ids_come_from_the_path(self) -> None:
        a = source.Source("/x/clip one.mp4", 10, 20, 30.0, 60, 2.0)
        self.assertEqual(a.name, "clip one.mp4")
        self.assertEqual(a.id, source.Source("/x/clip one.mp4", 1, 1, 1.0, 1, 1.0).id)
        self.assertNotEqual(a.id, source.Source("/y/clip one.mp4", 10, 20, 30.0, 60, 2.0).id)
        self.assertEqual(len(a.id), 10)

    def test_fit_portrait_cover_crops_along_the_pan(self) -> None:
        wide = np.zeros((100, 400, 3), np.uint8)
        wide[:, 200:] = 255
        self.assertEqual(source.fit_portrait(wide, 90, 160).shape, (160, 90, 3))
        self.assertLess(source.fit_portrait(wide, 90, 160, pan_x=0.0).mean(), 5)
        self.assertGreater(source.fit_portrait(wide, 90, 160, pan_x=1.0).mean(), 250)
        self.assertGreater(source.fit_portrait(wide, 90, 160, pan_x=7.0).mean(), 250, "pan is clamped to 0..1")

        tall = np.zeros((800, 100, 3), np.uint8)
        tall[400:] = 255
        self.assertLess(source.fit_portrait(tall, 90, 160, pan_y=0.0).mean(), 5)
        self.assertGreater(source.fit_portrait(tall, 90, 160, pan_y=1.0).mean(), 250)
        exact = np.full((160, 90, 3), 77, np.uint8)
        self.assertTrue(np.array_equal(source.fit_portrait(exact, 90, 160), exact))

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_probe_reads_size_rate_and_length(self) -> None:
        clip = self.clip("probe.mp4", "96x160", 2.0, 25)
        src = source.probe(clip)
        self.assertEqual((src.width, src.height, src.frame_count), (96, 160, 50))
        self.assertAlmostEqual(src.fps, 25.0, places=2)
        self.assertAlmostEqual(src.duration, 2.0, places=2)
        with self.assertRaises(FileNotFoundError):
            source.probe(self.path("missing.mp4"))
        junk = self.path("junk.mp4")
        with open(junk, "wb") as f:
            f.write(b"not a video")
        with self.assertRaises(RuntimeError):
            source.probe(junk)

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_segment_cache_loops_clamps_and_evicts(self) -> None:
        src = source.probe(self.clip("segments.mp4", "160x96", 1.0))
        cache = source.ClipSegmentCache(max_size=2)
        first = cache.load_segment(src, 0, 10, 54, 96)
        self.assertEqual((len(first), first[0].shape), (10, (96, 54, 3)))
        self.assertIs(cache.load_segment(src, 0, 10, 54, 96), first, "a repeat request comes from the cache")
        self.assertEqual(len(cache.load_segment(src, 20, 25, 54, 96)), 25, "running off the end wraps to the start")
        self.assertEqual(len(cache.load_segment(src, 999, 3, 54, 96)), 3, "a start past the end is clamped")
        self.assertEqual(len(cache._cache), 2)
        self.assertNotIn((src.path, 0, 10, 54, 96), cache._cache, "the oldest segment was evicted")
        cache.clear()
        self.assertEqual(cache._cache, {})
        with self.assertRaises(RuntimeError):
            cache.load_segment(source.Source(self.path("nope.mp4"), 1, 1, 30.0, 1, 1.0), 0, 1, 54, 96)

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_thumbnails_are_scaled_jpegs(self) -> None:
        clip = self.clip("thumb.mp4", "96x160", 1.0)
        for at in (0.0, 0.5, 60.0):
            img = cv2.imdecode(np.frombuffer(source.extract_thumbnail_jpeg(clip, width=48, at_sec=at), np.uint8), cv2.IMREAD_COLOR)
            self.assertEqual(img.shape, (80, 48, 3), at)
        with self.assertRaises(RuntimeError):
            source.extract_thumbnail_jpeg(self.path("nope.mp4"))

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_stills_become_twelve_second_clips_once(self) -> None:
        png = self.path("stills", "art.png")
        cv2.imwrite(png, np.full((91, 61, 3), 120, np.uint8))
        clip = source.still_to_clip(png)
        self.assertEqual(clip, self.path("stills", "art.still.mp4"))
        video = _video(_ffprobe(clip))
        self.assertEqual((video["width"], video["height"], video["r_frame_rate"]), (60, 90, "30/1"), "sizes are rounded down to even")
        self.assertAlmostEqual(float(video["duration"]), source.STILL_SECONDS, places=1)
        stamp = os.path.getmtime(clip)
        with mock.patch.object(source.subprocess, "run", side_effect=AssertionError("encoded again")):
            self.assertEqual(source.still_to_clip(png), clip)
        self.assertEqual(os.path.getmtime(clip), stamp)


class TestEncoder(_TempDir):
    def test_missing_ffmpeg_is_a_clear_error(self) -> None:
        with mock.patch.object(encoder.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "ffmpeg not found"):
                encoder.ffmpeg_path()
            with self.assertRaisesRegex(RuntimeError, "ffprobe not found"):
                encoder.ffprobe_path()
            with mock.patch.object(encoder, "_HAS_VIDEOTOOLBOX", None):
                self.assertFalse(encoder.has_videotoolbox())

    def test_videotoolbox_check_is_cached_and_survives_errors(self) -> None:
        with mock.patch.object(encoder, "_HAS_VIDEOTOOLBOX", True), \
             mock.patch.object(encoder.subprocess, "check_output", side_effect=AssertionError("asked again")):
            self.assertTrue(encoder.has_videotoolbox())
        with mock.patch.object(encoder, "_HAS_VIDEOTOOLBOX", None), \
             mock.patch.object(encoder.shutil, "which", return_value="/bin/ffmpeg"), \
             mock.patch.object(encoder.subprocess, "check_output", side_effect=OSError("boom")):
            self.assertFalse(encoder.has_videotoolbox())
        with mock.patch.object(encoder, "_HAS_VIDEOTOOLBOX", None), \
             mock.patch.object(encoder.shutil, "which", return_value="/bin/ffmpeg"), \
             mock.patch.object(encoder.subprocess, "check_output", return_value=b" V....D h264_videotoolbox  VideoToolbox"):
            self.assertTrue(encoder.has_videotoolbox())

    def test_codec_args_pick_hardware_or_x264(self) -> None:
        with mock.patch.object(encoder, "has_videotoolbox", return_value=True):
            self.assertEqual(encoder.video_codec_args(), ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-profile:v", "high"])
            self.assertEqual(encoder.video_codec_args(width=1080)[3], "14M")
            self.assertEqual(encoder.video_codec_args(bitrate=5_000_000, allow_sw=True),
                             ["-c:v", "h264_videotoolbox", "-b:v", "5000000", "-profile:v", "high", "-allow_sw", "1"])
            self.assertEqual(encoder.video_codec_args(use_hw=False, crf=20, preset="slow"),
                             ["-c:v", "libx264", "-preset", "slow", "-crf", "20"])
        with mock.patch.object(encoder, "has_videotoolbox", return_value=False):
            self.assertEqual(encoder.video_codec_args()[:2], ["-c:v", "libx264"])

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_encoder_accepts_bytes_arrays_and_lists(self) -> None:
        dest = self.path("enc.mp4")
        frame = np.zeros((16, 16, 3), np.uint8)
        with encoder.Encoder(dest, fps=30, width=16, height=16, use_hw=False) as enc:
            for _ in range(5):
                enc.write(frame)
                enc.write(frame.tobytes())
                enc.write(memoryview(frame.tobytes()))
                enc.write(frame.ravel().tolist())
        video = _video(_ffprobe(dest))
        self.assertEqual((video["width"], video["height"], int(video["nb_frames"])), (16, 16, 20))

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_encoder_failures_raise_and_errors_inside_with_kill_it(self) -> None:
        enc = encoder.Encoder(os.path.join(self.tmp, "missing-dir", "out.mp4"), width=16, height=16, use_hw=False)
        with self.assertRaisesRegex(RuntimeError, "ffmpeg exited"):
            enc.close()
        with self.assertRaises(ValueError):
            with encoder.Encoder(self.path("killed.mp4"), width=16, height=16, use_hw=False) as enc:
                raise ValueError("stop")
        self.assertIsNotNone(enc.proc.returncode)

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_audio_preview_muxes_the_song_slice(self) -> None:
        clip = self.clip("preview-src.mp4", "64x112", 2.0)
        song = self.wav("preview.wav", 5.0)
        dest = self.path("preview.mp4")
        encoder.mux_audio_preview(clip, song, dest, start_sec=1.0, duration_sec=2.0)
        info = _ffprobe(dest)
        self.assertEqual(sorted(s["codec_type"] for s in info["streams"]), ["audio", "video"])
        self.assertAlmostEqual(float(info["format"]["duration"]), 2.0, delta=0.1)


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
class TestAudioAnalysis(_TempDir):
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


class TestDeliveryHelpers(_TempDir):
    def test_loop_repeats_reach_the_minimum_without_passing_the_maximum(self) -> None:
        cases = [((4.0, 15, 35), 4), ((8.0, 15, 35), 2), ((6.4, 15, 35), 3), ((20.0, 15, 35), 1),
                 ((12.0, 15, 20), 1), ((0.0, 15, 35), 1), ((-2.0, 15, 35), 1), ((5.0, 15, 35), 3)]
        for args, n in cases:
            self.assertEqual(delivery.loop_repeats(*args), n, args)

    def test_atom_order_reads_32_and_64_bit_box_sizes(self) -> None:
        path = self.path("atoms.mp4")
        with open(path, "wb") as f:
            f.write(struct.pack(">I4s", 16, b"ftyp") + b"\0" * 8)
            f.write(struct.pack(">I4sQ", 1, b"free", 24) + b"\0" * 8)
            f.write(struct.pack(">I4s", 0, b"mdat") + b"\0" * 20)
        self.assertEqual(delivery._atom_order(path), ["ftyp", "free", "mdat"])
        with open(path, "wb") as f:
            f.write(struct.pack(">I4s", 4, b"moov") + b"\0" * 12)
        self.assertEqual(delivery._atom_order(path), ["moov"], "a box smaller than its header stops the walk")

    def test_motion_checks_grade_the_seam_and_flashes(self) -> None:
        def check(cid: str, label: str, ok: bool, detail: str, warn: bool = False) -> dict:
            return {"id": cid, "level": "ok" if ok else ("warn" if warn else "fail")}

        def levels(stats: dict | None) -> dict:
            out: list[dict] = []
            delivery._motion_checks(out, check, stats)
            return {c["id"]: c["level"] for c in out}

        self.assertEqual(levels(None), {})
        self.assertEqual(levels({}), {})
        self.assertEqual(levels({"seam_ratio": 1.0, "max_flashes_per_sec": 3}), {"seam": "ok", "flash": "ok"})
        self.assertEqual(levels({"seam_ratio": 2.0, "max_flashes_per_sec": 4}), {"seam": "warn", "flash": "fail"})
        self.assertEqual(levels({"seam_ratio": 3.0}), {"seam": "fail"})

    def test_raw_session_closes_on_with(self) -> None:
        if not HAS_FFMPEG:
            self.skipTest("ffmpeg required")
        dest = self.path("with.mp4")
        with delivery.RawSession(dest, 32, 32, 30) as session:
            self.assertEqual(session.write(b"\0" * (32 * 32 * 4 * 3 + 7)), 3)
        self.assertEqual(session.frames, 3)
        self.assertEqual(int(_video(_ffprobe(dest))["nb_frames"]), 3)

    @unittest.expectedFailure  # RawSession.abort kills ffmpeg but leaves its stdin pipe open (ResourceWarning, BrokenPipeError on exit)
    def test_aborting_a_raw_session_closes_the_encoder_pipe(self) -> None:
        if not HAS_FFMPEG:
            raise AssertionError("ffmpeg required")
        session = delivery.RawSession(self.path("aborted.mp4"), 32, 32, 30)
        session.write(b"\0" * (32 * 32 * 4))
        session.abort()
        self.assertFalse(os.path.exists(session.dest))
        try:
            self.assertTrue(session.encoder.proc.stdin.closed)
        finally:
            try:
                session.encoder.proc.stdin.close()
            except BrokenPipeError:
                pass


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestDelivery(_TempDir):
    def levels(self, path: str, fmt: str, stats: dict | None = None) -> dict:
        return {c["id"]: c["level"] for c in delivery.verify(path, stats, fmt)}

    def copy(self, src: str, name: str) -> str:
        dest = self.path(name)
        shutil.copy(src, dest)
        return dest

    def test_verify_checks_each_format_against_its_own_spec(self) -> None:
        wide = self.clip("wide.mp4", "64x36", 1.0, extra=["-movflags", "+faststart"])
        self.assertEqual(self.levels(wide, "youtube_16_9"), {"aspect": "ok", "size": "warn", "codec": "ok", "fps": "ok", "faststart": "ok"})
        square = self.clip("square.mp4", "64x64", 1.0)
        self.assertEqual(self.levels(square, "social_square", {"seam_ratio": 1.0}),
                         {"aspect": "ok", "size": "warn", "codec": "ok", "fps": "ok", "faststart": "fail", "seam": "ok"})
        tall = self.clip("apple.mp4", "48x64", 1.0, rate=24)
        apple = self.levels(tall, "apple_tall")
        self.assertEqual((apple["aspect"], apple["size"], apple["length"], apple["fps"], apple["bitrate"], apple["silent"]),
                         ("ok", "warn", "fail", "ok", "warn", "ok"))
        self.assertEqual(self.levels(square, "apple_square")["aspect"], "ok")
        big = self.clip("canvas.mp4", "720x1280", 3.0, extra=["-movflags", "+faststart"])
        canvas = self.levels(big, "spotify")
        self.assertEqual(canvas["tall"], "warn", "1280 px is over Spotify's listed 1080")
        self.assertEqual([canvas[k] for k in ("length", "aspect", "height", "codec", "silent", "fps", "faststart")], ["ok"] * 7)

    def test_cover_art_checks_the_image_size(self) -> None:
        for size, level in ((3000, "ok"), (1500, "warn"), (1000, "fail")):
            jpg = self.path(f"cover-{size}.jpg")
            cv2.imwrite(jpg, np.full((size, size, 3), 90, np.uint8))
            self.assertEqual(self.levels(jpg, "cover_art"), {"aspect": "ok", "resolution": level, "size": level}, size)
        wide = self.path("cover-wide.jpg")
        cv2.imwrite(wide, np.full((1500, 1600, 3), 90, np.uint8))
        self.assertEqual(self.levels(wide, "cover_art")["aspect"], "fail")

    def test_repeat_loop_and_upscale_rewrite_in_place(self) -> None:
        loop = self.copy(self.clip("loop-src.mp4", "64x112", 2.0), "loop.mp4")
        self.assertEqual(delivery.repeat_loop(loop, 5.0, 35.0), 3)
        self.assertAlmostEqual(delivery._duration(loop), 6.0, delta=0.1)
        self.assertFalse(os.path.exists(loop[:-4] + ".loop.mp4"))
        stamp = os.path.getmtime(loop)
        self.assertEqual(delivery.repeat_loop(loop, 5.0, 35.0), 1, "already long enough")
        self.assertEqual(os.path.getmtime(loop), stamp)

        self.assertTrue(delivery.upscale_to(loop, 128, 224))
        video = _video(_ffprobe(loop))
        self.assertEqual((video["width"], video["height"]), (128, 224))
        self.assertFalse(delivery.upscale_to(loop, 128, 224))

    def test_promo_plays_the_song_on_under_the_repeated_loop(self) -> None:
        loop = self.clip("promo-loop.mp4", "64x112", 1.0)
        song = self.wav("promo.wav", 4.0)
        dest = delivery.mux_promo(loop, song, self.path("promo.mp4"), 0.5, 3.0)
        info = _ffprobe(dest)
        self.assertEqual(sorted(s["codec_type"] for s in info["streams"]), ["audio", "video"])
        self.assertAlmostEqual(float(info["format"]["duration"]), 3.0, delta=0.1)
        self.assertIsNone(delivery.mux_promo(loop, song, self.path("promo-late.mp4"), 3.5, 30.0), "under a second of song left")

    def test_deliver_adds_companions_per_format(self) -> None:
        src = self.clip("deliver-src.mp4", "64x112", 2.0, extra=["-movflags", "+faststart"])
        song = self.wav("deliver.wav", 5.0)

        spotify = self.copy(src, "spot.mp4")
        res = delivery.deliver(spotify, song, 0.5, 2.0, None, fmt="spotify", promo_seconds=3)
        self.assertEqual((res["audio_path"], res["promo_path"]), (spotify[:-4] + "-audio.mp4", spotify[:-4] + "-promo-3s.mp4"))
        self.assertTrue(os.path.isfile(res["audio_path"]) and os.path.isfile(res["promo_path"]))
        self.assertEqual((res["width"], res["height"]), (64, 112))
        self.assertAlmostEqual(res["duration"], 2.0, places=2)

        yt = self.copy(src, "yt.mp4")
        res = delivery.deliver(yt, song, 0.0, 2.0, None, fmt="youtube_16_9", with_audio=False)
        self.assertIsNone(res["audio_path"])
        self.assertEqual(res["promo_path"], yt[:-4] + "-promo-30s.mp4", "a short YouTube loop gets a promo with the song")
        long_yt = self.copy(src, "yt-long.mp4")
        self.assertIsNone(delivery.deliver(long_yt, song, 0.0, 31.0, None, fmt="youtube_16_9")["promo_path"])

        silent = self.copy(src, "nosong.mp4")
        res = delivery.deliver(silent, self.path("missing.wav"), 0.0, 2.0, None)
        self.assertEqual((res["audio_path"], res["promo_path"], res["cover_path"]), (None, None, None))

        apple = self.copy(src, "apple-tall.mp4")
        res = delivery.deliver(apple, song, 0.0, 2.0, None, fmt="apple_tall")
        self.assertAlmostEqual(res["duration"], 16.0, delta=0.1)
        self.assertIsNone(res["audio_path"], "Apple motion art is silent")

        square = self.copy(src, "apple-square.mp4")
        with mock.patch.object(delivery, "upscale_to") as up, mock.patch.object(delivery, "repeat_loop") as rep:
            delivery.deliver(square, None, 0.0, 2.0, None, fmt="apple_square")
        up.assert_called_once_with(square, 3840, 3840)
        rep.assert_called_once_with(square, delivery.APPLE["safe_min_seconds"], delivery.APPLE["max_seconds"])

        cover = self.copy(src, "cover.mp4")
        res = delivery.deliver(cover, song, 0.0, 2.0, None, fmt="cover_art")
        self.assertEqual(res["cover_path"], cover[:-4] + "-cover-3000x3000.jpg")
        self.assertEqual({c["id"]: c["level"] for c in res["checks"]}, {"aspect": "ok", "resolution": "ok", "size": "ok"})

    def test_banners_and_covers_crop_to_their_size(self) -> None:
        src = self.clip("banner-src.mp4", "96x160", 1.0)
        png = self.path("banner.png")
        res = delivery.export_banner(src, png, banner_type="youtube_banner", focus=(-3.0, 9.0))
        self.assertEqual((res["width"], res["height"], res["safe_zone"]), (2560, 1440, [1546, 423]))
        self.assertEqual(cv2.imread(png).shape[:2], (1440, 2560))
        unknown = delivery.export_banner(src, self.path("banner-default.jpg"), banner_type="myspace")
        self.assertEqual(unknown["label"], "Spotify Artist Header")
        cover = delivery.export_cover_art(src, self.path("art", "cover.png"), size=200)
        self.assertEqual(cv2.imread(cover).shape[:2], (200, 200))

    def test_teasers_stop_at_max_seconds(self) -> None:
        src = self.clip("teaser-src.mp4", "64x112", 3.0)
        gif = delivery.export_animated(src, self.path("teaser.gif"), fps=10, width=32, max_seconds=1.0)
        cap = cv2.VideoCapture(gif)
        frames = 0
        while cap.read()[0]:
            frames += 1
        cap.release()
        self.assertEqual(frames, 10)

    def _no_libwebp(self):
        real = subprocess.run

        def run(cmd, *a, **kw):
            if "libwebp" in cmd:
                raise subprocess.CalledProcessError(1, cmd)
            return real(cmd, *a, **kw)

        return mock.patch.object(delivery.subprocess, "run", side_effect=run)

    @unittest.skipUnless(HAS_PIL, "Pillow required")
    def test_webp_teaser_falls_back_to_pillow_without_libwebp(self) -> None:
        src = self.clip("webp-src.mp4", "64x112", 1.0)
        with self._no_libwebp():
            dest = delivery.export_animated(src, self.path("teaser.webp"), fmt="webp", fps=6, width=32)
        with open(dest, "rb") as f:
            head = f.read(12)
        self.assertEqual((head[:4], head[8:12]), (b"RIFF", b"WEBP"))
        self.assertFalse(os.path.exists(dest + ".tmp.gif"))

    def test_webp_teaser_falls_back_to_gif_without_pillow(self) -> None:
        src = self.clip("webp-gif-src.mp4", "64x112", 1.0)
        with self._no_libwebp(), mock.patch.dict(sys.modules, {"PIL": None}):
            dest = delivery.export_animated(src, self.path("fallback.webp"), fmt="webp", fps=6, width=32)
        with open(dest, "rb") as f:
            self.assertEqual(f.read(4), b"GIF8")


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

    def test_existing_renders_are_found_newest_first_with_their_companions(self) -> None:
        stem = "canvas-neon-tide-youtube-16-9-151bpm-6.4s-1920x1080-20261023-120000"
        self.touch(stem + ".mp4", age=10, size=2 * 1024 * 1024)
        self.touch(stem + "-audio.mp4", age=10)
        self.touch(stem + "-promo-15s.mp4", age=10)
        self.touch(stem + "-promo-30s.mp4", age=10)
        self.touch("sample-canvas.mp4", age=5)
        self.touch("old.mp4", age=100)
        st = state_mod.StudioState()
        st._discover_existing_renders()
        self.assertEqual([r["filename"] for r in st._renders], ["sample-canvas.mp4", stem + ".mp4", "old.mp4"])
        tide = st._renders[1]
        self.assertEqual((tide["audio_url"], tide["promo_url"]), (f"/out/{stem}-audio.mp4", f"/out/{stem}-promo-30s.mp4"))
        self.assertEqual((tide["format"], tide["look"], tide["resolution"], tide["size_mb"]), ("youtube_16_9", "Neon Tide", "1920x1080", 2.0))
        self.assertEqual((st._renders[0]["resolution"], st._renders[2]["resolution"]), ("1080x1920", "540x960"))
        self.assertIsNone(st._renders[2]["audio_url"])

    def test_export_names_are_safe_and_carry_the_delivered_size(self) -> None:
        name = os.path.basename(state_mod._export_dest({"look": "Ünïcode & Co!!", "bpm": 127.6, "duration": 4.0, "format": "apple_square"}))
        self.assertTrue(name.startswith("canvas-n-code-co-apple-square-128bpm-16.0s-3840x3840-"), name)
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
        self.assertEqual(calls[5][0][1:3], (None, 2.0))
        self.assertFalse(calls[5][1]["with_audio"])
        self.assertEqual(entry["resolution"], "720x1280")
        self.assertEqual([r["filename"] for r in st._renders], ["y.mp4", "x.mp4"], "a re-export replaces its old entry")

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
        st.library = library.Library(self.out, downloads=os.path.join(self.out, "Downloads"))
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
        state_mod.StudioState().shutdown()  # nothing started yet


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
class TestProxyManager(_TempDir):
    def test_status_follows_the_file(self) -> None:
        clip = self.clip("proxy-src.mp4", "64x112", 1.0)
        src = source.probe(clip)
        with proxy.ProxyManager(os.path.join(self.tmp, "proxies")) as pm:
            self.assertEqual(pm.status(src), "none")
            self.assertEqual(pm.status(source.Source(self.path("gone.mp4"), 1, 1, 30.0, 1, 1.0)), "error")
            os.makedirs(pm.root, exist_ok=True)
            open(pm.path_for(src), "wb").close()
            self.assertEqual((pm.status(src), pm.ready(src)), ("ready", True))
            ev = pm.request(src)
            self.assertTrue(ev.is_set(), "an existing proxy needs no build")
            self.assertIs(pm.request(src, priority=0), ev)
            self.assertEqual(pm.ensure(src), pm.path_for(src))

    def test_a_clip_ffmpeg_cannot_read_ends_in_error(self) -> None:
        junk = self.path("junk-src.mp4")
        with open(junk, "wb") as f:
            f.write(b"not a video")
        src = source.Source(junk, 64, 112, 30.0, 30, 1.0)
        with proxy.ProxyManager(os.path.join(self.tmp, "proxies-junk")) as pm:
            self.assertIsNone(pm.ensure(src, timeout=60))
            self.assertEqual(pm.status(src), "error")
            self.assertEqual([n for n in os.listdir(pm.root) if n.endswith(".part.mp4")], [])

    def test_a_shut_down_manager_builds_nothing(self) -> None:
        src = source.probe(self.clip("proxy-closed.mp4", "64x112", 1.0))
        pm = proxy.ProxyManager(os.path.join(self.tmp, "proxies-closed"))
        pm.shutdown()
        self.assertIsNone(pm.ensure(src, timeout=30))
        self.assertEqual(pm.status(src), "error")


class TestLibraryHelpers(unittest.TestCase):
    def test_audio_names_skip_hidden_and_segment_files(self) -> None:
        for name, ok in (("Song.MP3", True), ("a.flac", True), ("x.opus", True), (".hidden.wav", False),
                         ("segment-3.wav", False), ("notes.txt", False), ("clip.mp4", False)):
            self.assertEqual(library.is_audio_name(name), ok, name)

    def test_scanning_a_missing_folder_finds_nothing(self) -> None:
        self.assertEqual(library.scan_folder("/no/such/folder", "x", recursive=True), [])

    def test_track_dicts_round_the_mtime(self) -> None:
        t = library.Track("id", "/m/a.wav", "a.wav", "downloads", "", 1700000000.9)
        self.assertEqual(t.to_dict()["mtime"], 1700000000)

    def test_folder_chooser_returns_the_path_or_none(self) -> None:
        done = subprocess.CompletedProcess
        with mock.patch.object(library.subprocess, "run", return_value=done([], 0, "/Users/me/Music/\n", "")) as run:
            self.assertEqual(library.pick_folder_dialog(), "/Users/me/Music/")
        self.assertEqual(run.call_args.args[0][0], "osascript")
        with mock.patch.object(library.subprocess, "run", return_value=done([], 1, "", "User canceled")):
            self.assertIsNone(library.pick_folder_dialog())
        with mock.patch.object(library.subprocess, "run", return_value=done([], 0, "  \n", "")):
            self.assertIsNone(library.pick_folder_dialog())

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_conversion_cache_keeps_only_the_newest(self) -> None:
        tmp = tempfile.mkdtemp(prefix="db-lib-")
        self.addCleanup(shutil.rmtree, tmp, True)
        tracks = []
        for i in range(2):
            src = os.path.join(tmp, f"song-{i}.aif")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", src], check=True)
            tracks.append(library._track(src, "downloads", tmp, 0.0))
        cache = os.path.join(tmp, "cache")
        first = library.playable_path(tracks[0], cache, keep=1)
        os.utime(first, (time.time() - 60, time.time() - 60))
        second = library.playable_path(tracks[1], cache, keep=1)
        self.assertEqual(os.listdir(cache), [os.path.basename(second)])


class TestEffects(unittest.TestCase):
    @unittest.expectedFailure  # grid_clone returns h // grid * grid rows: 128 tall with a 3x3 grid gives 126
    def test_grid_clone_keeps_the_frame_size_when_the_grid_does_not_divide_it(self) -> None:
        frame = np.zeros((128, 72, 3), np.uint8)
        self.assertEqual(grid_clone(frame, t=0.0, beat_dur=0.5, grid=3).shape, frame.shape)

    def test_grid_clone_keeps_the_frame_size_at_canvas_sizes(self) -> None:
        for h, w in ((1920, 1080), (192, 108)):
            for grid in (2, 3):
                frame = np.zeros((h, w, 3), np.uint8)
                self.assertEqual(grid_clone(frame, t=0.25, beat_dur=0.5, grid=grid).shape, frame.shape, (h, w, grid))


if __name__ == "__main__":
    unittest.main()
