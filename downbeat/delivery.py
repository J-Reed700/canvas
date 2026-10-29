"""Delivery and verification for Spotify Canvas and companion export formats."""
from __future__ import annotations

import json
import math
import os
import struct
import subprocess
import tempfile
from typing import Any

from .media.encoder import ENCODE_TIMEOUT, Encoder, ffmpeg_path, ffprobe_path, mux_audio_preview

# Spotify for Artists "Canvas" upload requirements (support.spotify.com, 2026).
SPEC = {"min_seconds": 3.0, "max_seconds": 8.0, "aspect": 9 / 16, "min_height": 720, "listed_max_height": 1080}

# Apple's current motion-art guide: 2048×2732 tall or 3840×3840 square, 8–35 seconds,
# 23.976–30 fps, and no audio.  Exports render those native pixel sizes and repeat whole loops only
# when needed to reach eight seconds.
APPLE = {"min_seconds": 8.0, "safe_min_seconds": 8.0, "max_seconds": 35.0, "fps": (23.976, 24.0, 25.0, 29.97, 30.0)}
FORMATS = {
    "spotify": {"label": "Spotify Canvas"},
    "apple_tall": {"label": "Apple Music motion art · 3:4", "aspect": 3 / 4, "size": (2048, 2732)},
    "apple_square": {"label": "Apple Music motion art · 1:1", "aspect": 1.0, "size": (3840, 3840)},
    "youtube_16_9": {"label": "YouTube Visualizer · 16:9", "aspect": 16 / 9, "size": (1920, 1080)},
    "social_vertical": {"label": "Social Video · 9:16", "aspect": 9 / 16, "size": (1080, 1920)},
    "social_square": {"label": "Social Feed · 1:1", "aspect": 1.0, "size": (1080, 1080)},
    "cover_art": {"label": "Album Cover Art · 1:1", "aspect": 1.0, "size": (3000, 3000)},
}

BANNER_SPECS = {
    "spotify_header": {"label": "Spotify Artist Header", "size": (2660, 1140), "safe_zone": (2200, 600)},
    "youtube_banner": {"label": "YouTube Channel Banner", "size": (2560, 1440), "safe_zone": (1546, 423)},
    "soundcloud_header": {"label": "SoundCloud Profile Header", "size": (2480, 520), "safe_zone": (1800, 440)},
}

_ffmpeg = ffmpeg_path


def _run(cmd: list[str], *outputs: str, timeout: float = ENCODE_TIMEOUT) -> subprocess.CompletedProcess:
    """Run a bounded media subprocess and remove any partial declared outputs on failure."""
    try:
        return subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)
    except Exception:
        for path in outputs:
            if path and os.path.exists(path):
                os.remove(path)
        raise


def mux_annexb(h264_path: str, dest: str, fps: int) -> None:
    # Raw H.264 carries no reliable timestamps (the raw demuxer drifts after ~50 frames on
    # WebCodecs streams), so stamp every packet explicitly: frame N at N/fps, one frame long.
    # Safe because WebCodecs H.264 output has no B-frames (decode order == display order).
    stamps = f"setts=pts=N/({fps}*TB):dts=N/({fps}*TB):duration=1/({fps}*TB)"
    try:
        _run(
            [
                ffmpeg_path(), "-y", "-v", "error", "-f", "h264", "-r", str(fps), "-i", h264_path,
                "-c:v", "copy", "-bsf:v", stamps, "-an", "-movflags", "+faststart", dest,
            ],
            dest,
        )
    except Exception:
        if os.path.exists(dest):
            os.remove(dest)
        raise


class _ExportSession:
    """Base class managing the export lifecycle, muxing, and verification."""

    def __init__(
        self,
        dest: str,
        fps: int = 30,
        audio_path: str | None = None,
        loop_start: float = 0.0,
        duration: float = 0.0,
        repeats: int = 1,
    ) -> None:
        self.dest = dest
        self.fps = fps
        self.tmp: str | None = dest[:-4] + ".h264"
        self.audio_path = audio_path
        self.loop_start = loop_start
        self.duration = duration
        self.repeats = repeats
        self.bytes_written = 0

    def write(self, data: bytes) -> int:
        raise NotImplementedError

    def finish(self) -> None:
        raise NotImplementedError

    def abort(self) -> None:
        raise NotImplementedError

    def _mux_and_verify(
        self,
        stats: dict | None = None,
        fmt: str = "spotify",
        promo_seconds: float = 0,
        with_audio: bool = True,
    ) -> dict:
        return deliver(
            self.dest,
            self.audio_path,
            self.loop_start,
            self.duration,
            stats,
            fmt=fmt,
            promo_seconds=promo_seconds,
            with_audio=with_audio,
        )

    def __enter__(self) -> _ExportSession:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is not None:
            self.abort()
        else:
            self.finish()


class RawSession(_ExportSession):
    """Fallback path: bottom-up RGBA frames from WebGL readPixels, encoded by ffmpeg."""

    def __init__(
        self,
        dest: str,
        width: int,
        height: int,
        fps: int,
        audio_path: str | None = None,
        loop_start: float = 0.0,
        duration: float = 0.0,
        repeats: int = 1,
        codec: str = "h264",
    ) -> None:
        super().__init__(
            dest=dest,
            fps=fps,
            audio_path=audio_path,
            loop_start=loop_start,
            duration=duration,
            repeats=repeats,
        )
        self.frame_bytes = width * height * 4
        self.frames = 0
        self.codec = codec
        self.encoder = Encoder(
            dest,
            fps=fps,
            width=width,
            height=height,
            crf=16,
            pix_fmt="rgba",
            vflip=True,
            codec=codec,
        )

    def write(self, data: bytes) -> int:
        n = len(data) // self.frame_bytes
        self.encoder.write(data[: n * self.frame_bytes])
        self.frames += n
        self.bytes_written += n * self.frame_bytes
        return n

    def finish(self) -> None:
        self.encoder.close()

    def abort(self) -> None:
        self.encoder.abort()


class ChunkSession(_ExportSession):
    """WebCodecs path: H.264 Annex B chunks appended to disk as the browser encodes them, then
    remuxed once at the end. Streaming keeps exports minutes long out of browser and server memory."""

    def __init__(
        self,
        dest: str,
        fps: int,
        audio_path: str | None = None,
        loop_start: float = 0.0,
        duration: float = 0.0,
        repeats: int = 1,
    ) -> None:
        super().__init__(
            dest=dest,
            fps=fps,
            audio_path=audio_path,
            loop_start=loop_start,
            duration=duration,
            repeats=repeats,
        )
        self.tmp = dest[:-4] + ".h264"
        self.file = open(self.tmp, "wb")
        self.closed = False

    def write(self, data: bytes) -> int:
        if self.closed:
            raise RuntimeError("Export session is closed")
        self.file.write(data)
        self.bytes_written += len(data)
        return len(data)

    def finish(self) -> None:
        if self.closed:
            return
        self.file.close()
        try:
            mux_annexb(self.tmp, self.dest, self.fps)
        finally:
            self.closed = True
            if os.path.exists(self.tmp):
                os.remove(self.tmp)

    def abort(self) -> None:
        if not self.file.closed:
            self.file.close()
        self.closed = True
        for path in (self.tmp, self.dest):
            if path and os.path.exists(path):
                os.remove(path)


def _atom_order(path: str) -> list[str]:
    order: list[str] = []
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        pos = 0
        while pos + 8 <= size and len(order) < 32:
            f.seek(pos)
            head = f.read(16)
            box_size, box_type = struct.unpack(">I4s", head[:8])
            if box_size == 1:
                box_size = struct.unpack(">Q", head[8:16])[0]
            elif box_size == 0:
                box_size = size - pos
            order.append(box_type.decode("latin-1"))
            if box_size < 8:
                break
            pos += box_size
    return order


def probe(path: str) -> dict:
    out = subprocess.check_output(
        [ffprobe_path(), "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        stderr=subprocess.STDOUT,
        timeout=30,
    )
    return json.loads(out)


def export_banner(
    source_path: str,
    dest: str,
    banner_type: str = "spotify_header",
    focus: tuple[float, float] = (0.5, 0.5),
    at_sec: float = 0.0,
) -> dict:
    spec = BANNER_SPECS.get(banner_type, BANNER_SPECS["spotify_header"])
    tw, th = spec["size"]
    fx, fy = focus
    fx = max(0.0, min(1.0, float(fx)))
    fy = max(0.0, min(1.0, float(fy)))
    pix_fmt = "yuvj444p" if dest.lower().endswith((".jpg", ".jpeg")) else "rgb24"
    vf = (
        f"scale={tw}:{th}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={tw}:{th}:'(iw-{tw})*{fx:.4f}':'(ih-{th})*{fy:.4f}',"
        f"format={pix_fmt}"
    )
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    cmd = [
        ffmpeg_path(), "-y", "-v", "error",
        "-ss", f"{max(0.0, at_sec):.3f}",
        "-i", source_path,
        "-frames:v", "1",
        "-vf", vf,
    ]
    if dest.lower().endswith((".jpg", ".jpeg")):
        cmd.extend(["-q:v", "2"])
    cmd.append(dest)
    _run(cmd, dest)
    return {
        "path": dest,
        "width": tw,
        "height": th,
        "safe_zone": list(spec["safe_zone"]),
        "label": spec["label"],
        "size_mb": round(os.path.getsize(dest) / (1024 * 1024), 2),
    }


def export_cover_art(source_path: str, dest: str, size: int = 3000, at_sec: float = 0.0) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    vf = f"scale={size}:{size}:force_original_aspect_ratio=increase:flags=lanczos,crop={size}:{size}"
    cmd = [
        ffmpeg_path(), "-y", "-v", "error",
        "-ss", f"{max(0.0, at_sec):.3f}",
        "-i", source_path,
        "-frames:v", "1",
        "-vf", vf,
    ]
    if dest.lower().endswith((".jpg", ".jpeg")):
        cmd.extend(["-q:v", "2"])
    cmd.append(dest)
    _run(cmd, dest)
    return dest


def export_animated(mp4_path: str, dest: str, fmt: str = "gif", fps: int = 18, width: int = 540, max_seconds: float = 10.0) -> str:
    """A teaser GIF or WebP from the start of a render; long renders are cut to `max_seconds`."""
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    if fmt == "webp":
        try:
            _run(
                [
                    ffmpeg_path(), "-y", "-v", "error", "-t", f"{max_seconds:g}", "-i", mp4_path,
                    "-vf", f"fps={fps},scale={width}:-1:flags=lanczos",
                    "-vcodec", "libwebp", "-loop", "0", "-an", dest,
                ],
                dest,
            )
            return dest
        except subprocess.CalledProcessError:
            # Try encoding animated WebP via Pillow fallback, or write GIF
            try:
                from PIL import Image

                tmp_gif = dest + ".tmp.gif"
                vf = f"fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3"
                _run(
                    [ffmpeg_path(), "-y", "-v", "error", "-t", f"{max_seconds:g}", "-i", mp4_path, "-vf", vf, "-loop", "0", "-an", tmp_gif],
                    tmp_gif,
                )
                frames = []
                with Image.open(tmp_gif) as im:
                    try:
                        while True:
                            frames.append(im.copy())
                            im.seek(len(frames))
                    except EOFError:
                        pass
                if frames:
                    frames[0].save(dest, save_all=True, append_images=frames[1:], loop=0, duration=int(1000 / fps))
                if os.path.exists(tmp_gif):
                    os.remove(tmp_gif)
                return dest
            except Exception:
                if "tmp_gif" in locals() and os.path.exists(tmp_gif):
                    os.remove(tmp_gif)
                vf = f"fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3"
                _run(
                    [ffmpeg_path(), "-y", "-v", "error", "-t", f"{max_seconds:g}", "-i", mp4_path, "-vf", vf, "-loop", "0", "-an", "-f", "gif", dest],
                    dest,
                )
                return dest

    vf = f"fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3"
    _run(
        [
            ffmpeg_path(), "-y", "-v", "error", "-t", f"{max_seconds:g}", "-i", mp4_path,
            "-vf", vf, "-loop", "0", "-an", dest,
        ],
        dest,
    )
    return dest


def verify(path: str, stats: dict | None = None, fmt: str = "spotify") -> list[dict]:
    """Check a rendered file against the spec of its format. Each check: id, label, level, detail."""
    info = probe(path)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    w, h = int(video.get("width", 0)), int(video.get("height", 0))
    duration = float(info.get("format", {}).get("duration", 0.0))
    num, _, den = str(video.get("r_frame_rate", "0/1")).partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    atoms = _atom_order(path)

    def check(cid: str, label: str, ok: bool, detail: str, warn: bool = False) -> dict:
        return {"id": cid, "label": label, "level": "ok" if ok else ("warn" if warn else "fail"), "detail": detail}

    codec_name = str(video.get("codec_name") or "")
    profile = str(video.get("profile") or "")
    pix_fmt = str(video.get("pix_fmt") or "")
    is_h264 = codec_name == "h264" and pix_fmt == "yuv420p"
    is_prores_hq = codec_name == "prores" and ("HQ" in profile.upper() or video.get("codec_tag_string") == "apch")
    is_prores_4444 = codec_name == "prores" and ("4444" in profile or video.get("codec_tag_string") in ("ap4h", "ap4x"))
    apple_format = fmt in ("apple_tall", "apple_square")
    if apple_format and is_prores_4444:
        codec_label = "Apple ProRes 4444 · opaque RGB source"
    elif apple_format and is_prores_hq:
        codec_label = "Apple ProRes 422 HQ"
    else:
        codec_label = "H.264 · yuv420p"
    codec = check(
        "codec",
        codec_label,
        is_h264 or (apple_format and (is_prores_hq or is_prores_4444)),
        f"{codec_name} {profile} · {pix_fmt}" + ("; renderer source is opaque 8-bit RGB" if is_prores_4444 else ""),
    )
    silent = check("silent", "No audio track", not audio, "silent" if not audio else f"{len(audio)} audio stream(s)")
    faststart = check("faststart", "Fast-start MP4", "moov" in atoms and "mdat" in atoms and atoms.index("moov") < atoms.index("mdat"),
                      " → ".join(a for a in atoms if a in ("ftyp", "moov", "mdat")))

    if fmt in ("apple_tall", "apple_square"):
        spec = FORMATS[fmt]
        sw, sh = spec["size"]
        rate = float(info.get("format", {}).get("bit_rate") or 0) / 1e6
        checks = [
            check("aspect", spec["label"], h > 0 and abs(w / h - spec["aspect"]) < 0.01, f"{w}×{h}"),
            check("size", f"{sw}×{sh}", w >= sw and h >= sh,
                  f"{w}×{h}" if w >= sw else f"{w}×{h}; Apple asks for {sw}×{sh}, so a distributor may reject or upscale it", warn=True),
            check("length", "Length 8–35 s", APPLE["min_seconds"] - 1e-3 <= duration <= APPLE["max_seconds"] + 1e-3,
                  f"{duration:.3f} s" + ("" if duration >= APPLE["safe_min_seconds"] - 1e-3 else "; some distributors ask for at least 15 s")),
            codec,
            silent,
            check("fps", "23.976–30 fps", any(abs(fps - f) < 0.01 for f in APPLE["fps"]), f"{fps:g} fps"),
            check("bitrate", "High bitrate", rate >= 25, f"{rate:.1f} Mbps" + ("" if rate >= 25 else "; distributors often list 45–100 Mbps"), warn=True),
        ]
        _motion_checks(checks, check, stats)
        return checks

    def _verify_fixed_size(format_name: str, standard_desc: str) -> list[dict]:
        spec = FORMATS[format_name]
        sw, sh = spec["size"]
        checks = [
            check("aspect", spec["label"], h > 0 and abs(w / h - spec["aspect"]) < 0.01, f"{w}×{h}"),
            check("size", f"{sw}×{sh}", w >= sw and h >= sh,
                  f"{w}×{h}" if w >= sw else f"{w}×{h}; {standard_desc} {sw}×{sh}", warn=True),
            codec,
            check("fps", "Constant 30 fps", abs(fps - 30.0) < 0.01, f"{fps:g} fps"),
            faststart,
        ]
        _motion_checks(checks, check, stats)
        return checks

    if fmt == "youtube_16_9":
        return _verify_fixed_size("youtube_16_9", "YouTube standard is")

    if fmt == "social_square":
        return _verify_fixed_size("social_square", "Social feed asks for")

    if fmt == "social_vertical":
        return _verify_fixed_size("social_vertical", "TikTok, Reels and Shorts ask for")

    if fmt == "cover_art":
        spec = FORMATS[fmt]
        ok_res = w >= 3000 and h >= 3000
        acceptable_res = w >= 1400 and h >= 1400
        res_detail = (
            f"{w}×{h}" if ok_res
            else (f"{w}×{h}; distributors recommend 3000×3000" if acceptable_res else f"{w}×{h}; below 1400×1400 minimum")
        )
        checks = [
            check("aspect", spec["label"], w > 0 and w == h, f"{w}×{h}"),
            check("resolution", "3000×3000 (min 1400×1400)", ok_res, res_detail, warn=acceptable_res),
            check("size", "3000×3000", ok_res, res_detail, warn=acceptable_res),
        ]
        _motion_checks(checks, check, stats)
        return checks

    checks = [
        check("length", "Length 3–8 s", SPEC["min_seconds"] - 1e-3 <= duration <= SPEC["max_seconds"] + 1e-3, f"{duration:.3f} s"),
        check("aspect", "9:16 vertical", h > 0 and abs(w / h - SPEC["aspect"]) < 0.01, f"{w}×{h}"),
        check("height", "At least 720 px tall", h >= SPEC["min_height"], f"{h} px"),
        codec,
        silent,
        check("fps", "Constant 30 fps", abs(fps - 30.0) < 0.01, f"{fps:g} fps"),
        faststart,
    ]
    if h > SPEC["listed_max_height"]:
        checks.append(check("tall", "Spotify lists 720–1080 px tall", False,
                            f"{h} px tall; {w}×{h} is a common Canvas size, but re-export at 608×1080 if an upload is rejected", warn=True))
    _motion_checks(checks, check, stats)
    return checks


def _motion_checks(checks: list[dict], check: Any, stats: dict | None) -> None:
    """Footage, seam and photosensitivity checks from the browser's per-frame render stats."""
    if stats:
        frame0 = stats.get("frame0_reference")
        if isinstance(frame0, dict) and frame0.get("level") in ("ok", "warn", "fail"):
            checks.append({"id": "frame0", "label": "Frame 0 matches reference", "level": frame0["level"],
                           "detail": str(frame0.get("detail") or "")[:800]})
        footage = stats.get("footage")
        if isinstance(footage, dict) and footage.get("level") in ("ok", "warn", "fail"):
            # The studio checked each cut's clip frames as it rendered (engine/footage.ts).
            checks.append({"id": "footage", "label": "Clips play, not stills", "level": footage["level"],
                           "detail": str(footage.get("detail") or "")[:800]})
        seam = stats.get("seam_ratio")
        if seam is not None:
            checks.append(check("seam", "Loop seam", seam <= 1.25,
                                f"seam step is {seam:.2f}× the loop's own 95th-percentile frame step", warn=seam <= 2.5))
        flashes = stats.get("max_flashes_per_sec")
        if flashes is not None:
            checks.append(check("flash", "Photosensitivity (≤ 3 flashes/s)", flashes <= 3,
                                f"max {flashes} full-frame flash(es) in any 1 s window"))


def _duration(path: str) -> float:
    return float(probe(path).get("format", {}).get("duration", 0.0))


def loop_repeats(loop: float, min_seconds: float, max_seconds: float) -> int:
    """The fewest whole repeats of a loop lasting >= min_seconds (fewer if that would pass max_seconds)."""
    if loop <= 0:
        return 1
    n = max(1, math.ceil(min_seconds / loop - 1e-6))
    while n > 1 and n * loop > max_seconds + 1e-6:
        n -= 1
    return n


def repeat_loop(path: str, min_seconds: float, max_seconds: float) -> int:
    """Rewrite `path` in place as loop_repeats() repeats of itself. Stream copy: no re-encode.
    Returns the repeat count."""
    loop = _duration(path)
    n = loop_repeats(loop, min_seconds, max_seconds)
    if n == 1:
        return 1
    root, ext = os.path.splitext(path)
    tmp = root + ".loop" + ext
    try:
        _run(
            [ffmpeg_path(), "-y", "-v", "error", "-stream_loop", str(n - 1), "-i", path, "-map", "0:v:0", "-c:v", "copy",
             "-an", "-t", f"{n * loop:.3f}", "-movflags", "+faststart", tmp],
            tmp,
        )
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return n


def upscale_to(path: str, width: int, height: int) -> bool:
    """Re-encode an existing H.264 companion in place at width x height. Returns True if resized."""
    st = next((x for x in probe(path).get("streams", []) if x.get("codec_type") == "video"), {})
    if int(st.get("width", 0)) >= width and int(st.get("height", 0)) >= height:
        return False
    root, ext = os.path.splitext(path)
    tmp = root + ".up" + ext
    try:
        _run(
            [ffmpeg_path(), "-y", "-v", "error", "-i", path, "-vf", f"scale={width}:{height}:flags=lanczos", "-c:v", "libx264",
             "-preset", "faster", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", tmp],
            tmp,
        )
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return True


def _promo_overlay(dest: str, width: int, height: int, title: str, out_now: bool) -> str:
    """Build a transparent, resolution-native lower-third with OpenCV (a required dependency)."""
    import cv2
    import numpy as np

    fd, path = tempfile.mkstemp(prefix=".downbeat-promo-", suffix=".png", dir=os.path.dirname(os.path.abspath(dest)))
    os.close(fd)
    try:
        overlay = np.zeros((height, width, 4), dtype=np.uint8)
        margin = max(18, round(min(width, height) * 0.05))
        card_h = max(120, round(height * 0.22))
        top = height - margin - card_h
        cv2.rectangle(overlay, (margin, top), (width - margin, height - margin), (10, 10, 14, 205), -1, cv2.LINE_AA)

        # OpenCV's built-in font is deliberately used so the overlay has no system-font dependency.
        clean = " ".join(str(title).split())[:120].encode("ascii", "replace").decode("ascii")
        label = "OUT NOW" if out_now else ""
        font = cv2.FONT_HERSHEY_DUPLEX
        max_text_w = width - 4 * margin
        scale = max(0.6, min(width, height) / 700)
        while clean and cv2.getTextSize(clean, font, scale, max(1, round(scale * 2)))[0][0] > max_text_w and scale > 0.35:
            scale *= 0.9
        thick = max(1, round(scale * 2))
        baseline = height - margin - max(24, round(card_h * 0.26))
        if clean:
            cv2.putText(overlay, clean, (2 * margin, baseline), font, scale, (255, 255, 255, 255), thick, cv2.LINE_AA)
        if label:
            small = max(0.45, scale * 0.52)
            cv2.putText(overlay, label, (2 * margin, top + max(30, round(card_h * 0.28))), font, small,
                        (110, 220, 255, 255), max(1, round(small * 2)), cv2.LINE_AA)
        # Encoded here and written by Python: cv2.imwrite can't open paths with non-ASCII characters on Windows.
        ok, png = cv2.imencode(".png", overlay)
        if not ok:
            raise RuntimeError("Could not create the social promo title card")
        with open(path, "wb") as f:
            f.write(png.tobytes())
        return path
    except Exception:
        if os.path.exists(path):
            os.remove(path)
        raise


def mux_promo(
    silent_path: str,
    track_path: str,
    dest: str,
    audio_start: float,
    seconds: float,
    promo_title: str = "",
    promo_out_now: bool = False,
) -> str | None:
    """A share-ready promo: the canvas loop repeated for `seconds` with the song playing on from
    `audio_start` (not the looped slice). Ends early if the song does. Returns dest, or None."""
    length = min(float(seconds), _duration(track_path) - max(0.0, audio_start))
    loop = _duration(silent_path)
    if length < 1.0 or loop <= 0:
        return None
    title = " ".join(str(promo_title or "").split())[:120]
    overlay = None
    try:
        cmd = [ffmpeg_path(), "-y", "-v", "error", "-stream_loop", str(max(0, math.ceil(length / loop) - 1)), "-i", silent_path,
               "-ss", f"{max(0.0, audio_start):.3f}", "-i", track_path]
        if title or promo_out_now:
            stream = next((x for x in probe(silent_path).get("streams", []) if x.get("codec_type") == "video"), {})
            overlay = _promo_overlay(dest, int(stream.get("width") or 1080), int(stream.get("height") or 1920), title, promo_out_now)
            cmd.extend(["-loop", "1", "-i", overlay, "-filter_complex", "[0:v][2:v]overlay=0:0:format=auto[v]",
                        "-map", "[v]", "-map", "1:a:0", "-c:v", "libx264", "-preset", "faster", "-crf", "18", "-pix_fmt", "yuv420p"])
        else:
            cmd.extend(["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"])
        cmd.extend(["-c:a", "aac", "-b:a", "288k", "-t", f"{length:.3f}", "-movflags", "+faststart", dest])
        _run(cmd, dest)
    finally:
        if overlay and os.path.exists(overlay):
            os.remove(overlay)
    return dest


def deliver(
    dest: str,
    track_path: str | None,
    audio_start: float,
    duration: float,
    stats: dict | None,
    fmt: str = "spotify",
    promo_seconds: float = 0,
    with_audio: bool = False,
    promo_title: str = "",
    promo_out_now: bool = False,
) -> dict:
    """Finish an export: Apple formats repeat the loop to their minimum length; Spotify, YouTube and
    social exports get the optional promo. Any format can also get a copy with the song under it, for
    demos (with_audio). Then verify. Returns a summary dict."""
    audio_dest = promo_dest = cover_dest = None
    track = track_path if track_path and os.path.isfile(track_path) else None
    if fmt in ("apple_tall", "apple_square"):
        # Apple masters arrive from the GPU at their final dimensions.  Never put a lossy H.264
        # resize between those pixels and a ProRes master.
        repeat_loop(dest, APPLE["safe_min_seconds"], APPLE["max_seconds"])
    elif fmt == "cover_art":
        cover_dest = export_cover_art(dest, dest[:-4] + "-cover-3000x3000.jpg", size=3000, at_sec=0.0)
    elif track and promo_seconds and promo_seconds > 0:
        promo_dest = mux_promo(dest, track, f"{dest[:-4]}-promo-{int(round(promo_seconds))}s.mp4", audio_start,
                               promo_seconds, promo_title=promo_title, promo_out_now=promo_out_now)
    if track and with_audio:
        root, ext = os.path.splitext(dest)
        # MP4 cannot carry a stream-copied ProRes master.  Keep an Apple MOV master in a MOV
        # companion so adding AAC audio never changes the video pixels or codec profile.
        audio_dest = root + "-audio" + (".mov" if ext.lower() == ".mov" else ".mp4")
        # An Apple loop was just repeated, so the song plays on under the whole file.
        mux_audio_preview(dest, track, audio_dest, start_sec=audio_start, duration_sec=max(duration, _duration(dest)))
    info = probe(dest)
    vs = next((x for x in info.get("streams", []) if x.get("codec_type") == "video"), {})
    target = cover_dest if cover_dest else dest
    return {
        "checks": verify(target, stats, fmt),
        "width": vs.get("width"),
        "height": vs.get("height"),
        "duration": round(float(info.get("format", {}).get("duration", duration)), 3),
        "audio_path": audio_dest,
        "promo_path": promo_dest,
        "cover_path": cover_dest,
        "size_mb": round(os.path.getsize(dest) / (1024 * 1024), 2),
    }
