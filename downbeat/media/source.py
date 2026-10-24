"""Video source: probe, fast contiguous segment loading, and thumbnails."""
from __future__ import annotations

import dataclasses
import os
import subprocess

import cv2
import numpy as np

from . import file_id


@dataclasses.dataclass
class Source:
    path: str
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float

    @property
    def name(self) -> str:
        return os.path.basename(self.path)

    @property
    def id(self) -> str:
        return file_id(self.path)


IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif")
STILL_SECONDS = 12


def still_to_clip(path: str) -> str:
    """Render a still (album art, photo) as a 12 s H.264 clip next to it, so it can be cut,
    framed and animated like any other clip. Returns the clip path."""
    from .encoder import ffmpeg_path

    dest = os.path.splitext(path)[0] + ".still.mp4"
    if os.path.exists(dest) and os.path.getmtime(dest) >= os.path.getmtime(path):
        return dest
    # Even dimensions, long edge capped at 2160 px: plenty for a 1080x1920 crop with zoom room.
    scale = "scale='2*trunc(min(1,2160/max(iw,ih))*iw/2)':'2*trunc(min(1,2160/max(iw,ih))*ih/2)':flags=lanczos"
    cmd = [
        ffmpeg_path(), "-y", "-v", "error", "-xerror", "-loop", "1", "-i", path, "-t", str(STILL_SECONDS), "-r", "30",
        "-vf", f"{scale},format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14",
        "-tune", "stillimage", "-movflags", "+faststart", dest,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if res.returncode != 0 or not os.path.exists(dest) or os.path.getsize(dest) == 0:
        if os.path.exists(dest):
            os.remove(dest)
        raise RuntimeError(f"could not read image: {res.stderr.strip()[-200:] or 'ffmpeg failed'}")
    return dest


def video_to_mp4(path: str, timeout: float = 900) -> str:
    """Convert a video the library doesn't list (.avi, .mts, .wmv and so on) to an H.264 .mp4 next to it,
    and return the new path. Clips play muted, so the sound is left out. Interlaced camera footage is
    deinterlaced on the way."""
    from .encoder import ffmpeg_path

    base = os.path.splitext(path)[0]
    dest, n = base + ".mp4", 2
    while os.path.exists(dest):
        dest, n = f"{base}-{n}.mp4", n + 1
    tmp = dest + ".part"
    cmd = [
        ffmpeg_path(), "-y", "-v", "error", "-i", path, "-map", "0:v:0", "-an",
        "-vf", "yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-movflags", "+faststart", "-f", "mp4", tmp,
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        res = None
    if res is None or res.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        why = "converting it took too long" if res is None else res.stderr.strip().replace(path, os.path.basename(path))[-200:] or "ffmpeg failed"
        raise RuntimeError(f"could not read it as a video ({why})")
    os.replace(tmp, dest)
    return dest


def probe(path: str) -> Source:
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {path}")
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    finally:
        cap.release()
    return Source(
        path=path,
        width=width,
        height=height,
        fps=fps,
        frame_count=max(1, frame_count),
        duration=frame_count / fps if fps else 0.0,
    )


def fit_portrait(
    frame: np.ndarray,
    target_w: int,
    target_h: int,
    pan_x: float = 0.5,
    pan_y: float = 0.5,
) -> np.ndarray:
    """Cover-crop a frame to target_w x target_h with normalized pan (0..1)."""
    h, w = frame.shape[:2]
    target_ratio = target_w / target_h
    src_ratio = w / h
    pan_x = float(np.clip(pan_x, 0.0, 1.0))
    pan_y = float(np.clip(pan_y, 0.0, 1.0))
    if src_ratio > target_ratio:
        new_w = max(1, int(h * target_ratio))
        max_x = max(0, w - new_w)
        x0 = int(max_x * pan_x)
        frame = frame[:, x0 : x0 + new_w]
    elif src_ratio < target_ratio:
        new_h = max(1, int(w / target_ratio))
        max_y = max(0, h - new_h)
        y0 = int(max_y * pan_y)
        frame = frame[y0 : y0 + new_h, :]
    return cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_LINEAR)


class ClipSegmentCache:
    """Fast sequential frame cache for a Source window at target portrait resolution."""

    def __init__(self, max_size: int = 12) -> None:
        self.max_size = max_size
        self._cache: dict[tuple[str, int, int, int, int], list[np.ndarray]] = {}

    def clear(self) -> None:
        self._cache.clear()

    def load_segment(
        self,
        source: Source,
        start_frame: int,
        count: int,
        target_w: int,
        target_h: int,
        pan_speed: float = 0.15,
    ) -> list[np.ndarray]:
        key = (source.path, start_frame, count, target_w, target_h)
        if key in self._cache:
            return self._cache[key]

        cap = cv2.VideoCapture(source.path)
        if not cap.isOpened():
            raise RuntimeError(f"cannot open video: {source.path}")
        try:
            start_frame = max(0, min(start_frame, max(0, source.frame_count - 1)))
            if start_frame > 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

            frames: list[np.ndarray] = []
            for idx in range(count):
                ok, raw = cap.read()
                if not ok or raw is None:
                    # loop back to start of video if we hit EOF
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ok, raw = cap.read()
                    if not ok or raw is None:
                        break
                # Drift pan across landscape clips for 9:16 framing
                pan = 0.5 + 0.32 * float(np.sin(idx * 0.025 * (1.0 + pan_speed)))
                frames.append(fit_portrait(raw, target_w, target_h, pan_x=pan, pan_y=0.5))
        finally:
            cap.release()

        if not frames:
            raise RuntimeError(f"no frames decoded from {source.path}")

        if len(self._cache) >= self.max_size:
            oldest = next(iter(self._cache))
            del self._cache[oldest]
        self._cache[key] = frames
        return frames


GLOBAL_CACHE = ClipSegmentCache()


def extract_thumbnail_jpeg(path: str, width: int = 360, at_sec: float = 1.5) -> bytes:
    """Extract a frame `at_sec` into the clip (default ~1.5s) and encode as JPEG."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        target = min(max(0, total - 1), int(fps * max(0.0, at_sec)))
        if target > 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, target)
        ok, frame = cap.read()
    finally:
        cap.release()
    if not ok or frame is None:
        raise RuntimeError(f"failed to read thumbnail from {path}")
    h, w = frame.shape[:2]
    new_h = max(1, int(h * (width / w)))
    thumb = cv2.resize(frame, (width, new_h), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buf.tobytes()
