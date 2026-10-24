"""Exact numbered frames from a clip's playback copy, for exports.

Exports used to seek a hidden <video> element to each frame and copy whatever it showed. Browsers don't
promise that picture is the frame that was asked for: Safari often keeps showing the old one, so a clip
came out as a still. ffmpeg decodes the same file the same way in every browser, so exports ask here.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import threading

from .encoder import ffmpeg_path, ffprobe_path
from .proxy import FPS

MAX_COUNT = 60  # two seconds of footage per request

_counts: dict[tuple[str, int], int] = {}
_lock = threading.Lock()


def frame_count(path: str) -> int:
    """How many frames the playback copy holds. Proxies are constant 30 fps, so frame n starts at n / 30 s."""
    key = (path, os.stat(path).st_mtime_ns)
    with _lock:
        if key in _counts:
            return _counts[key]
    out = subprocess.run(
        [ffprobe_path(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames",
         "-of", "default=nw=1:nk=1", path],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if not out.isdigit():
        # no frame count in the header: count the packets instead (slower, still no decoding)
        out = subprocess.run(
            [ffprobe_path(), "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
             "stream=nb_read_packets", "-of", "default=nw=1:nk=1", path],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    n = int(out) if out.isdigit() else 0
    if n <= 0:
        raise RuntimeError(f"{os.path.basename(path)} has no video frames")
    with _lock:
        _counts[key] = n
    return n


def read_frames(path: str, start: int, count: int) -> tuple[int, int, list[bytes]]:
    """Decode `count` frames from frame `start` as JPEGs. Returns (total frames, first frame sent, JPEGs).
    A request past the end gets the last frames there are, never nothing."""
    total = frame_count(path)
    start = max(0, min(int(start), total - 1))
    count = max(1, min(int(count), MAX_COUNT, total - start))
    with tempfile.TemporaryDirectory(prefix="downbeat-frames-") as tmp:
        cmd = [ffmpeg_path(), "-v", "error", "-nostdin"]
        if start:
            # Half a frame early: the seek keeps frames at or after this time, so frame `start` is the first.
            cmd += ["-ss", f"{(start - 0.5) / FPS:.6f}"]
        cmd += [
            "-i", path, "-frames:v", str(count), "-an", "-sn", "-dn",
            # JPEG viewers read colour as BT.601 full range, whatever the clip was tagged with
            "-vf", "scale=out_color_matrix=bt601:out_range=full,format=yuvj420p",
            "-c:v", "mjpeg", "-q:v", "2", "-start_number", "0", os.path.join(tmp, "%04d.jpg"),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        names = sorted(n for n in os.listdir(tmp) if n.endswith(".jpg"))
        if proc.returncode != 0 or not names:
            detail = (proc.stderr or "").strip().splitlines()[-1:] or ["no frames came out"]
            raise RuntimeError(f"ffmpeg could not decode frames {start}-{start + count - 1}: {detail[0]}")
        frames = []
        for name in names:
            with open(os.path.join(tmp, name), "rb") as f:
                frames.append(f.read())
    return total, start, frames


def pack(frames: list[bytes]) -> bytes:
    """Each JPEG with its length in front (4 bytes, big-endian), back to back."""
    return b"".join(len(b).to_bytes(4, "big") + b for b in frames)
