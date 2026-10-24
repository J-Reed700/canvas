"""Delivery: muxing, spec checks, export sessions, loop repeats, promos and companion files."""
from __future__ import annotations

import os
import shutil
import struct
import subprocess
import sys
import unittest
from unittest import mock

import cv2
import numpy as np

from downbeat import delivery
from helpers import HAS_FFMPEG, HAS_PIL, TempDirCase, _ffprobe, _video


class TestDeliveryHelpers(TempDirCase):
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
class TestDelivery(TempDirCase):
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


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestExportPipeline(TempDirCase):
    """End to end: a stream from the browser becomes a checked file in each format."""

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

    def test_annexb_remux_cleans_up_dest_on_failure(self) -> None:
        bad_h264 = os.path.join(self.tmp, "corrupt.h264")
        with open(bad_h264, "wb") as f:
            f.write(b"not valid h264 data")
        dest = os.path.join(self.tmp, "corrupt.mp4")
        with self.assertRaises(subprocess.CalledProcessError):
            delivery.mux_annexb(bad_h264, dest, 30)
        self.assertFalse(os.path.exists(dest))

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

    def test_chunk_session_rebuilds_a_stream_sent_in_pieces(self) -> None:
        h264 = os.path.join(self.tmp, "chunks.h264")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-frames:v", "300",
             "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-f", "h264", h264],
            check=True,
        )
        with open(h264, "rb") as fh:
            data = fh.read()
        dest = os.path.join(self.tmp, "chunks.mp4")
        session = delivery.ChunkSession(dest, 30)
        cuts = [0, 1000, 1001, len(data) // 2, len(data)]  # uneven pieces, split mid-NAL on purpose
        for a, b in zip(cuts, cuts[1:]):
            self.assertEqual(session.write(data[a:b]), b - a)
        session.finish()
        self.assertFalse(os.path.exists(session.tmp))
        video = _ffprobe(dest)["streams"][0]
        self.assertEqual(int(video["nb_frames"]), 300)
        self.assertEqual(video["r_frame_rate"], "30/1")

        dropped = delivery.ChunkSession(os.path.join(self.tmp, "dropped.mp4"), 30)
        dropped.write(data[:5000])
        dropped.abort()
        self.assertFalse(os.path.exists(dropped.tmp) or os.path.exists(dropped.dest))

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


if __name__ == "__main__":
    unittest.main()
