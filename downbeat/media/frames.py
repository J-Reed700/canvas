"""Exact numbered frames from a clip's playback copy, for exports.

Exports used to seek a hidden <video> element to each frame and copy whatever it showed. Browsers don't
promise that picture is the frame that was asked for: Safari often keeps showing the old one, so a clip
came out as a still. ffmpeg decodes the same file the same way in every browser, so exports ask here.

Frames go out as raw 8-bit 4:2:0 (a Y plane, then U, then V), BT.709 full range: no second lossy
encode, and the studio uploads the planes to the GPU and converts them in a shader.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading

from .encoder import ffmpeg_path, ffprobe_path
from .proxy import FPS

BATCH_BYTES = 96 << 20  # about 30 frames of a 1080×1920 clip per request
MAX_COUNT = 60

_info: dict[tuple[str, int], tuple[int, int, int]] = {}
_lock = threading.Lock()


def clip_info(path: str) -> tuple[int, int, int]:
    """(width, height, frame count) of a playback copy. Proxies are constant 30 fps, so frame n starts at
    n / 30 s, and their sides are even."""
    key = (path, os.stat(path).st_mtime_ns)
    with _lock:
        if key in _info:
            return _info[key]

    def probe(*args: str) -> dict:
        proc = subprocess.run([ffprobe_path(), "-v", "error", "-select_streams", "v:0", "-of", "json", *args, path],
                              capture_output=True, text=True)
        streams = json.loads(proc.stdout or "{}").get("streams") if proc.returncode == 0 else None
        if not streams:
            why = (proc.stderr or "").strip().splitlines()[-1:] or ["it has no video stream"]
            raise RuntimeError(f"ffprobe could not read {os.path.basename(path)}: {why[0]}")
        return streams[0]

    st = probe("-show_entries", "stream=width,height,nb_frames")
    n = str(st.get("nb_frames", ""))
    if not n.isdigit():
        # no frame count in the header: count the packets instead (slower, still no decoding)
        n = str(probe("-count_packets", "-show_entries", "stream=nb_read_packets").get("nb_read_packets", ""))
    total = int(n) if n.isdigit() else 0
    if total <= 0:
        raise RuntimeError(f"{os.path.basename(path)} has no video frames")
    info = (int(st["width"]) // 2 * 2, int(st["height"]) // 2 * 2, total)
    with _lock:
        _info[key] = info
    return info


def read_frames(path: str, start: int, count: int) -> tuple[dict, bytes]:
    """Decode up to `count` frames from frame `start`. A request past the end gets the last frame there is,
    never nothing. Returns ({start, count, total, width, height}, the frames back to back)."""
    w, h, total = clip_info(path)
    size = w * h * 3 // 2
    start = max(0, min(int(start), total - 1))
    count = max(1, min(int(count), MAX_COUNT, max(4, BATCH_BYTES // size), total - start))
    cmd = [ffmpeg_path(), "-v", "error", "-nostdin"]
    if start:
        # Half a frame early: the seek keeps frames at or after this time, so frame `start` is the first.
        cmd += ["-ss", f"{(start - 0.5) / FPS:.6f}"]
    cmd += [
        "-i", path, "-frames:v", str(count), "-an", "-sn", "-dn",
        "-vf", f"scale={w}:{h}:out_color_matrix=bt709:out_range=full,format=yuv420p",
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    got = len(proc.stdout) // size
    if proc.returncode != 0 or got == 0:
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no frames came out"]
        raise RuntimeError(f"ffmpeg could not decode frames {start}-{start + count - 1}: {detail[0]}")
    return {"start": start, "count": got, "total": total, "width": w, "height": h}, proc.stdout[: got * size]
