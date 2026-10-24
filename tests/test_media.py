"""Media files: probing, thumbnails, stills, encoding and playback proxies."""
from __future__ import annotations

import os
import subprocess
import unittest
from unittest import mock

import cv2
import numpy as np

from downbeat.media import encoder, frames, proxy, source
from downbeat.media.proxy import ProxyManager
from downbeat.media.source import probe
from helpers import HAS_FFMPEG, TempDirCase, _ffprobe, _video


class TestSource(TempDirCase):
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

        bad = self.path("stills", "bad.png")
        with open(bad, "wb") as f:
            f.write(b"not a png")
        with self.assertRaises(RuntimeError):
            source.still_to_clip(bad)
        self.assertFalse(os.path.exists(self.path("stills", "bad.still.mp4")))


class TestEncoder(TempDirCase):
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


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
class TestProxyManager(TempDirCase):
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

    @unittest.skipUnless(os.name == "posix", "nice is a POSIX tool")
    def test_copies_are_encoded_at_low_priority(self) -> None:
        src = source.Source(self.path("any.mp4"), 64, 112, 30.0, 30, 1.0)
        open(src.path, "wb").close()
        ran = []

        class Done:
            def __init__(self, cmd, **_kw) -> None:
                ran.append(cmd)

            def wait(self) -> int:
                return 1

        with proxy.ProxyManager(os.path.join(self.tmp, "proxies-nice")) as pm, mock.patch.object(proxy.subprocess, "Popen", Done):
            pm.ensure(src, timeout=30)
        self.assertEqual(ran[0][:3], ["nice", "-n", "10"], "song analysis and thumbnails go first")

    def test_a_shut_down_manager_builds_nothing(self) -> None:
        src = source.probe(self.clip("proxy-closed.mp4", "64x112", 1.0))
        pm = proxy.ProxyManager(os.path.join(self.tmp, "proxies-closed"))
        pm.shutdown()
        self.assertIsNone(pm.ensure(src, timeout=30))
        self.assertEqual(pm.status(src), "error")


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestPlaybackProxy(TempDirCase):
    """Proxies the studio plays: constant 30 fps, short GOP."""

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



@unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
class TestExportFrames(TempDirCase):
    """Numbered frames of a playback copy for exports: frame n of a 30 fps file is the picture at n / 30 s."""

    def ramp(self, name: str, n: int = 40) -> str:
        """Frame k is flat grey at Y = 20 + 4k (studio range), losslessly coded."""
        dest = self.path(name)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x48:r=30", "-frames:v", str(n),
             "-vf", "geq=lum='20+4*N':cb=128:cr=128", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", dest],
            check=True,
        )
        return dest

    def test_frames_start_on_the_frame_asked_for_and_come_out_full_range(self) -> None:
        clip = self.ramp("ramp.mp4")
        info, body = frames.read_frames(clip, 10, 5)
        self.assertEqual(info, {"start": 10, "count": 5, "total": 40, "width": 64, "height": 48})
        size = 64 * 48 * 3 // 2
        self.assertEqual(len(body), 5 * size)
        for k in range(5):
            y = np.frombuffer(body[k * size : k * size + 64 * 48], np.uint8).astype(float)
            want = (20 + 4 * (10 + k) - 16) * 255 / 219
            self.assertAlmostEqual(y.mean(), want, delta=1.5, msg=f"frame {10 + k}")
            u = np.frombuffer(body[k * size + 64 * 48 : k * size + 64 * 48 + 16 * 24 * 2], np.uint8)
            self.assertLess(abs(u.astype(float).mean() - 128), 1.5, "grey stays grey")
        info, body = frames.read_frames(clip, 0, 1)
        self.assertEqual((info["start"], info["count"]), (0, 1))

    def test_asking_past_the_end_gets_the_last_frame(self) -> None:
        clip = self.ramp("short.mp4", 12)
        info, body = frames.read_frames(clip, 500, 30)
        self.assertEqual((info["start"], info["count"], info["total"]), (11, 1, 12))
        info, _ = frames.read_frames(clip, 8, 30)
        self.assertEqual((info["start"], info["count"]), (8, 4))

    def test_a_request_is_capped_by_count_and_by_size(self) -> None:
        clip = self.ramp("long.mp4", 90)
        self.assertEqual(frames.read_frames(clip, 0, 500)[0]["count"], frames.MAX_COUNT)
        with mock.patch.object(frames, "BATCH_BYTES", 64 * 48 * 3):
            self.assertEqual(frames.read_frames(clip, 0, 30)[0]["count"], 4, "never fewer than four")
        with mock.patch.object(frames, "BATCH_BYTES", 64 * 48 * 15):
            self.assertEqual(frames.read_frames(clip, 0, 30)[0]["count"], 10)

    def test_a_file_without_a_frame_count_in_its_header_is_counted(self) -> None:
        dest = self.path("ramp.mkv")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x48:r=30", "-frames:v", "20",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", dest],
            check=True,
        )
        self.assertEqual(frames.clip_info(dest), (64, 48, 20))

    def test_a_file_ffmpeg_cannot_read_is_a_clear_error(self) -> None:
        bad = self.path("bad.mp4")
        with open(bad, "wb") as f:
            f.write(b"not a video")
        with self.assertRaisesRegex(RuntimeError, r"^ffprobe could not read bad\.mp4: .+"):
            frames.clip_info(bad)
        clip = self.ramp("ok.mp4", 8)
        with mock.patch.object(frames, "ffmpeg_path", return_value="false"):
            with self.assertRaisesRegex(RuntimeError, r"ffmpeg could not decode frames 2-7: no frames came out"):
                frames.read_frames(clip, 2, 30)


if __name__ == "__main__":
    unittest.main()
