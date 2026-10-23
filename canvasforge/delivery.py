"""Spotify Canvas delivery: mux GPU-encoded video into MP4, add an audio companion, verify.

The Studio encodes frames in the browser with WebCodecs (hardware H.264, Annex B). Here
ffmpeg only remuxes it (-c:v copy), so there is no second lossy encode. Browsers without an
H.264 VideoEncoder stream raw RGBA frames into a RawSession instead.
"""
from __future__ import annotations

import json
import os
import struct
import subprocess
from typing import Any

from .encoder import Encoder, ffmpeg_path, ffprobe_path, mux_audio_preview

# Spotify for Artists "Canvas" upload requirements (support.spotify.com, 2026).
SPEC = {"min_seconds": 3.0, "max_seconds": 8.0, "aspect": 9 / 16, "min_height": 720, "listed_max_height": 1080}

_ffmpeg = ffmpeg_path


def mux_annexb(h264_path: str, dest: str, fps: int) -> None:
    # Raw H.264 carries no reliable timestamps (the raw demuxer drifts after ~50 frames on
    # WebCodecs streams), so stamp every packet explicitly: frame N at N/fps, one frame long.
    # Safe because WebCodecs H.264 output has no B-frames (decode order == display order).
    stamps = f"setts=pts=N/({fps}*TB):dts=N/({fps}*TB):duration=1/({fps}*TB)"
    subprocess.run(
        [
            ffmpeg_path(), "-y", "-v", "error", "-f", "h264", "-r", str(fps), "-i", h264_path,
            "-c:v", "copy", "-bsf:v", stamps, "-an", "-movflags", "+faststart", dest,
        ],
        check=True,
        capture_output=True,
    )


class RawSession:
    """Fallback path: bottom-up RGBA frames from WebGL readPixels, encoded by ffmpeg."""

    def __init__(self, dest: str, width: int, height: int, fps: int) -> None:
        self.dest = dest
        self.frame_bytes = width * height * 4
        self.frames = 0
        self.encoder = Encoder(dest, fps=fps, width=width, height=height, crf=16, pix_fmt="rgba", vflip=True)

    def write(self, data: bytes) -> int:
        n = len(data) // self.frame_bytes
        self.encoder.write(data[: n * self.frame_bytes])
        self.frames += n
        return n

    def finish(self) -> None:
        self.encoder.close()

    def __enter__(self) -> RawSession:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.finish()


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
        [ffprobe_path(), "-v", "error", "-show_streams", "-show_format", "-of", "json", path]
    )
    return json.loads(out)


def verify(path: str, stats: dict | None = None) -> list[dict]:
    """Check a rendered file against the Canvas spec. Each check: id, label, level, detail."""
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

    checks = [
        check("length", "Length 3–8 s", SPEC["min_seconds"] - 1e-3 <= duration <= SPEC["max_seconds"] + 1e-3, f"{duration:.3f} s"),
        check("aspect", "9:16 vertical", h > 0 and abs(w / h - SPEC["aspect"]) < 0.01, f"{w}×{h}"),
        check("height", "At least 720 px tall", h >= SPEC["min_height"], f"{h} px"),
        check("codec", "H.264 · yuv420p", video.get("codec_name") == "h264" and video.get("pix_fmt") == "yuv420p",
              f"{video.get('codec_name')} {video.get('profile', '')} · {video.get('pix_fmt')}"),
        check("silent", "No audio track", not audio, "silent" if not audio else f"{len(audio)} audio stream(s)"),
        check("fps", "Constant 30 fps", abs(fps - 30.0) < 0.01, f"{fps:g} fps"),
        check("faststart", "Fast-start MP4", "moov" in atoms and "mdat" in atoms and atoms.index("moov") < atoms.index("mdat"),
              " → ".join(a for a in atoms if a in ("ftyp", "moov", "mdat"))),
    ]
    if h > SPEC["listed_max_height"]:
        checks.append(check("tall", "Spotify lists 720–1080 px tall", False,
                            f"{h} px tall; {w}×{h} is a common Canvas size, but re-export at 608×1080 if an upload is rejected", warn=True))
    if stats:
        seam = stats.get("seam_ratio")
        if seam is not None:
            checks.append(check("seam", "Seamless loop", seam <= 1.25,
                                f"seam step is {seam:.2f}× the loop's own 95th-percentile frame step", warn=seam <= 2.5))
        flashes = stats.get("max_flashes_per_sec")
        if flashes is not None:
            checks.append(check("flash", "Photosensitivity (≤ 3 flashes/s)", flashes <= 3,
                                f"max {flashes} full-frame flash(es) in any 1 s window"))
    return checks


def deliver(dest: str, track_path: str | None, audio_start: float, duration: float, stats: dict | None) -> dict:
    """Create the optional with-audio companion and run verification. Returns a summary dict."""
    audio_dest = None
    if track_path and os.path.isfile(track_path):
        audio_dest = dest[:-4] + "-audio.mp4"
        mux_audio_preview(dest, track_path, audio_dest, start_sec=audio_start, duration_sec=duration)
    return {
        "checks": verify(dest, stats),
        "audio_path": audio_dest,
        "size_mb": round(os.path.getsize(dest) / (1024 * 1024), 2),
    }
