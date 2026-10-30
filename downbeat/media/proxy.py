"""Background generation of 30fps short-GOP proxy MP4s for the Studio preview."""
from __future__ import annotations

import hashlib
import itertools
import os
import queue
import shutil
import subprocess
import threading
import uuid
from typing import Any

from ..server.storage import remove_file, replace_file
from .encoder import ffmpeg_path, video_codec_args
from .source import Source

PROXY_VERSION = 1
MAX_SECONDS = 60
MAX_SIDE = 2560
FPS = 30
BUILD_TIMEOUT = 600


class ProxyManager:
    """Builds proxies on one worker thread. State is keyed by the proxy path, which hashes the
    source path + mtime + size, so a re-uploaded file with the same name is rebuilt."""

    def __init__(self, root: str) -> None:
        self.root = root
        self._status: dict[str, str] = {}
        self._events: dict[str, threading.Event] = {}
        self._priorities: dict[str, int] = {}
        self._lock = threading.Lock()
        self._queue: queue.PriorityQueue = queue.PriorityQueue()
        self._seq = itertools.count()
        self._proc: subprocess.Popen | None = None
        self._closed = False
        self._thread = threading.Thread(target=self._worker, daemon=True, name="downbeat-proxy")
        self._thread.start()

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
        with self._lock:
            if self._closed:
                return "error"
            return self._status.get(dest, "none")

    def request(self, src: Source, priority: int = 10) -> threading.Event:
        """Queue a proxy build (no-op if built or queued); returns an Event set when done."""
        dest = self.path_for(src)
        with self._lock:
            if self._closed:
                ev = threading.Event()
                ev.set()
                return ev
            ev = self._events.get(dest)
            if ev is None:
                # Completed jobs do not retain an Event forever in long-running studios.
                for old, done in list(self._events.items()):
                    if len(self._events) < 256:
                        break
                    if done.is_set():
                        self._events.pop(old, None)
                        self._status.pop(old, None)
                        self._priorities.pop(old, None)
                ev = threading.Event()
                self._events[dest] = ev
                if os.path.isfile(dest):
                    ev.set()
                else:
                    self._status[dest] = "queued"
                    self._priorities[dest] = priority
                    self._queue.put((priority, next(self._seq), dest, src))
            elif (not ev.is_set() and self._status.get(dest) == "queued"
                  and priority < self._priorities.get(dest, 10)):
                # bump: a duplicate high-priority entry is harmless, the worker skips finished ones
                self._priorities[dest] = priority
                self._queue.put((priority, next(self._seq), dest, src))
            return ev

    def ensure(self, src: Source, timeout: float = 600.0) -> str | None:
        self.request(src, priority=0).wait(timeout)
        path = self.path_for(src)
        return path if os.path.isfile(path) else None

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            proc = self._proc
            for dest, ev in self._events.items():
                if not ev.is_set():
                    self._status[dest] = "error"
                    ev.set()
            self._queue.put((float("-inf"), next(self._seq), None, None))
        if proc and (not hasattr(proc, "poll") or proc.poll() is None):
            try:
                proc.kill()
            except (AttributeError, ProcessLookupError):
                pass
        if threading.current_thread() is not self._thread:
            self._thread.join(timeout=5)

    def __enter__(self) -> ProxyManager:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.shutdown()

    def _worker(self) -> None:
        while True:
            _prio, _seq, dest, src = self._queue.get()
            with self._lock:
                if self._closed or dest is None:
                    return
                ev = self._events.get(dest)
                if ev is None or ev.is_set():
                    continue
                self._status[dest] = "building"
            try:
                self._build(src, dest)
                status = "ready"
            except Exception:
                status = "error"
            with self._lock:
                self._status[dest] = status
                ev.set()

    def _build(self, src: Source, dest: str) -> None:
        os.makedirs(self.root, exist_ok=True)
        tmp = f"{dest}.{uuid.uuid4().hex}.part.mp4"
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
        # Low priority, so song analysis and thumbnails don't wait behind a 4K encode.
        if os.name == "posix" and shutil.which("nice"):
            cmd = ["nice", "-n", "10", *cmd]
        proc = None
        try:
            with self._lock:
                if self._closed:
                    raise RuntimeError("proxy manager shut down")
                proc = self._proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                code = proc.wait(timeout=BUILD_TIMEOUT)
            except TypeError:
                # Simple process doubles used by callers predating timeout support.
                code = proc.wait()
            if code != 0:
                raise RuntimeError(f"ffmpeg exited {code}")
            with self._lock:
                if self._closed:
                    raise RuntimeError("proxy manager shut down")
                replace_file(tmp, dest)
        finally:
            try:
                if proc and (not hasattr(proc, "poll") or proc.poll() is None):
                    try:
                        proc.kill()
                    except (AttributeError, ProcessLookupError):
                        pass
                    try:
                        proc.wait(timeout=5)
                    except TypeError:
                        proc.wait()
            finally:
                with self._lock:
                    if self._proc is proc:
                        self._proc = None
                if os.path.exists(tmp):
                    remove_file(tmp)
