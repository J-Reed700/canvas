"""Browser playback proxies for the GPU Studio.

Any ffmpeg-readable clip (4K, HEVC, ProRes, odd frame rates...) is normalised once into a
constant-30fps, short-GOP H.264 MP4. Short GOPs make frame-exact seeking cheap, which is what
lets the browser export render deterministically, frame by frame, at full speed.
"""
from __future__ import annotations

import hashlib
import itertools
import os
import queue
import subprocess
import threading
from typing import Any

from .encoder import ffmpeg_path, has_videotoolbox, video_codec_args
from .source import Source

PROXY_VERSION = 1
MAX_SECONDS = 60
MAX_SIDE = 2560
FPS = 30


class ProxyManager:
    """Builds proxies on one worker thread. State is keyed by the proxy path, which hashes the
    source path + mtime + size, so a re-uploaded file with the same name is rebuilt."""

    def __init__(self, root: str) -> None:
        self.root = root
        self._status: dict[str, str] = {}
        self._events: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._queue: queue.PriorityQueue = queue.PriorityQueue()
        self._seq = itertools.count()
        self._proc: subprocess.Popen | None = None
        self._closed = False
        threading.Thread(target=self._worker, daemon=True).start()

    def path_for(self, src: Source) -> str:
        st = os.stat(src.path)
        key = hashlib.md5(f"{src.path}|{st.st_mtime_ns}|{st.st_size}|v{PROXY_VERSION}".encode()).hexdigest()[:16]
        return os.path.join(self.root, f"{key}.mp4")

    def ready(self, src: Source) -> bool:
        return os.path.isfile(self.path_for(src))

    def status(self, src: Source) -> str:
        try:
            dest = self.path_for(src)
        except OSError:
            return "error"
        if os.path.isfile(dest):
            return "ready"
        return self._status.get(dest, "none")

    def request(self, src: Source, priority: int = 10) -> threading.Event:
        """Queue a proxy build (no-op if built or queued); returns an Event set when done."""
        dest = self.path_for(src)
        with self._lock:
            ev = self._events.get(dest)
            if ev is None:
                ev = threading.Event()
                self._events[dest] = ev
                if os.path.isfile(dest):
                    ev.set()
                else:
                    self._status[dest] = "queued"
                    self._queue.put((priority, next(self._seq), dest, src))
            elif not ev.is_set() and priority < 10:
                # bump: a duplicate high-priority entry is harmless, the worker skips finished ones
                self._queue.put((priority, next(self._seq), dest, src))
            return ev

    def ensure(self, src: Source, timeout: float = 600.0) -> str | None:
        self.request(src, priority=0).wait(timeout)
        path = self.path_for(src)
        return path if os.path.isfile(path) else None

    def shutdown(self) -> None:
        self._closed = True
        proc = self._proc
        if proc and proc.poll() is None:
            proc.kill()

    def __enter__(self) -> ProxyManager:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.shutdown()

    def _worker(self) -> None:
        while True:
            _prio, _seq, dest, src = self._queue.get()
            ev = self._events.get(dest)
            if ev is None or ev.is_set():
                continue
            self._status[dest] = "building"
            try:
                self._build(src, dest)
                self._status[dest] = "ready"
            except Exception:
                self._status[dest] = "error"
            ev.set()

    def _build(self, src: Source, dest: str) -> None:
        if self._closed:
            raise RuntimeError("proxy manager shut down")
        os.makedirs(self.root, exist_ok=True)
        tmp = f"{dest}.{os.getpid()}.part.mp4"  # unique per process: a restarted server can't clobber it
        exe = ffmpeg_path()
        vf = (
            f"fps={FPS},"
            f"scale='min({MAX_SIDE},iw)':'min({MAX_SIDE},ih)':force_original_aspect_ratio=decrease"
            ":force_divisible_by=2:flags=lanczos,format=yuv420p"
        )
        scale = min(1.0, MAX_SIDE / max(src.width, src.height, 1))
        pixels_per_sec = src.width * scale * src.height * scale * FPS
        bitrate = int(min(24e6, max(6e6, pixels_per_sec * 0.2)))
        codec = video_codec_args(use_hw=True, bitrate=bitrate, crf=17, allow_sw=True)
        cmd = [
            exe, "-y", "-v", "error", "-t", str(MAX_SECONDS), "-i", src.path,
            "-an", "-sn", "-dn", "-vf", vf, *codec, "-g", "8", "-bf", "0",
            "-movflags", "+faststart", tmp,
        ]
        self._proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        code = self._proc.wait()
        self._proc = None
        if code != 0:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise RuntimeError(f"ffmpeg exited {code}")
        os.replace(tmp, dest)
