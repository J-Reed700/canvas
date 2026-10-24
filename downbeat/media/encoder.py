"""Bounded streaming H.264 and ProRes encoding via ffmpeg."""
from __future__ import annotations

import os
import select
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any

DEFAULT_FPS: float = 30.0
DEFAULT_W: int = 1080
DEFAULT_H: int = 1920

# Preserved aliases for backwards compatibility
CANVAS_FPS = DEFAULT_FPS
CANVAS_W = DEFAULT_W
CANVAS_H = DEFAULT_H

_HAS_VIDEOTOOLBOX: bool | None = None
_CAPABILITY_LOCK = threading.RLock()
_VIDEOTOOLBOX_USABLE: dict[tuple[int, int], tuple[bool, float]] = {}
_VIDEOTOOLBOX_CACHE_SIZE = 8
_VIDEOTOOLBOX_CACHE_SECONDS = 30.0
ENCODE_TIMEOUT = 300.0
WRITE_TIMEOUT = 60.0


def ffmpeg_path() -> str:
    """Return path to ffmpeg binary or raise RuntimeError if not found."""
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH")
    return exe


def ffprobe_path() -> str:
    """Return path to ffprobe binary or raise RuntimeError if not found."""
    exe = shutil.which("ffprobe")
    if not exe:
        raise RuntimeError("ffprobe not found on PATH")
    return exe


def has_videotoolbox() -> bool:
    """Check if ffmpeg supports Apple Silicon VideoToolbox H.264 hardware encoding."""
    with _CAPABILITY_LOCK:
        return _has_videotoolbox()


def _has_videotoolbox() -> bool:
    global _HAS_VIDEOTOOLBOX
    if _HAS_VIDEOTOOLBOX is not None:
        return _HAS_VIDEOTOOLBOX
    try:
        exe = ffmpeg_path()
    except RuntimeError:
        _HAS_VIDEOTOOLBOX = False
        return False
    try:
        out = subprocess.check_output([exe, "-encoders"], stderr=subprocess.DEVNULL, timeout=10).decode("utf-8", "ignore")
        _HAS_VIDEOTOOLBOX = "h264_videotoolbox" in out
    except Exception:
        _HAS_VIDEOTOOLBOX = False
    return _HAS_VIDEOTOOLBOX


_check_videotoolbox = has_videotoolbox


def videotoolbox_usable(width: int = DEFAULT_W, height: int = DEFAULT_H) -> bool:
    """Return whether VideoToolbox can encode this frame size now.

    macOS can advertise ``h264_videotoolbox`` while the hardware session is unavailable (ffmpeg
    then exits with -12908), and support also depends on resolution. Probe one frame at the requested
    size before opening a streaming encoder so a long browser render never starts down a pipe that
    cannot consume its first frame.
    """
    key = (int(width), int(height))
    with _CAPABILITY_LOCK:
        def remember(usable: bool, checked_at: float) -> bool:
            _VIDEOTOOLBOX_USABLE[key] = (usable, checked_at)
            # Keep one process from growing the cache without bound if clients request arbitrary sizes.
            while len(_VIDEOTOOLBOX_USABLE) > _VIDEOTOOLBOX_CACHE_SIZE:
                oldest = min(_VIDEOTOOLBOX_USABLE, key=lambda size: _VIDEOTOOLBOX_USABLE[size][1])
                del _VIDEOTOOLBOX_USABLE[oldest]
            return usable

        # Hardware sessions can become busy or free up while the app stays open.  A short cache
        # avoids probing repeatedly within a batch without treating either state as permanent.
        now = time.monotonic()
        cached = _VIDEOTOOLBOX_USABLE.get(key)
        if cached is not None and now - cached[1] < _VIDEOTOOLBOX_CACHE_SECONDS:
            return cached[0]
        if not has_videotoolbox():
            return remember(False, now)
        try:
            result = subprocess.run(
                [
                    ffmpeg_path(), "-v", "error", "-f", "lavfi", "-i", f"color=black:size={key[0]}x{key[1]}:rate=1",
                    "-frames:v", "1", "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-f", "null", "-",
                ],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
            usable = result.returncode == 0
        except Exception:
            usable = False
        return remember(usable, time.monotonic())


def prores_codec_args(codec: str) -> list[str]:
    """Opaque ProRes from the studio's RGB frames; no claim of extra source precision or alpha."""
    if codec == "prores_422_hq":
        return ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-tag:v", "apch"]
    if codec == "prores_4444":
        return ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuv444p10le", "-tag:v", "ap4h"]
    raise ValueError(f"Unknown ProRes codec: {codec}")


def video_codec_args(
    use_hw: bool = True,
    bitrate: str | int | None = None,
    crf: int = 18,
    preset: str = "veryfast",
    allow_sw: bool = False,
    width: int | None = None,
) -> list[str]:
    """Return ffmpeg video codec arguments (VideoToolbox if available, else libx264)."""
    if use_hw and has_videotoolbox():
        if bitrate is None:
            bitrate_val = "14M" if (width is not None and width >= 1080) else "6M"
        else:
            bitrate_val = str(bitrate)
        codec_args = [
            "-c:v",
            "h264_videotoolbox",
            "-b:v",
            bitrate_val,
            "-profile:v",
            "high",
        ]
        if allow_sw:
            codec_args.extend(["-allow_sw", "1"])
        return codec_args

    return [
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
    ]


class Encoder:
    def __init__(
        self,
        path: str,
        fps: float = DEFAULT_FPS,
        width: int = DEFAULT_W,
        height: int = DEFAULT_H,
        crf: int = 18,
        use_hw: bool = True,
        pix_fmt: str = "bgr24",
        vflip: bool = False,
        codec: str = "h264",
        write_timeout: float = WRITE_TIMEOUT,
        close_timeout: float = ENCODE_TIMEOUT,
    ):
        self.path = path
        self.fps = fps
        self.width = width
        self.height = height
        self.codec = codec
        if codec not in ("h264", "prores_422_hq", "prores_4444"):
            raise ValueError(f"Unknown output codec: {codec}")
        if width <= 0 or height <= 0 or fps <= 0:
            raise ValueError("Frame dimensions and rate must be positive")
        if codec != "h264" and os.path.splitext(path)[1].lower() != ".mov":
            raise ValueError("ProRes requires a .mov destination")
        self.write_timeout = write_timeout
        self.close_timeout = close_timeout
        self._lock = threading.RLock()
        self._closed = False
        exe = ffmpeg_path()

        base_cmd = [
            exe,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            pix_fmt,
            "-s",
            f"{width}x{height}",
            "-r",
            str(fps),
            "-i",
            "-",
            "-an",  # Silent per Spotify spec
        ]

        # Do the real hardware probe before ffmpeg receives any of the caller's frames.  A listed but
        # busy VideoToolbox encoder is common on macOS; libx264 is the deterministic fallback.
        usable_hw = use_hw and videotoolbox_usable(width, height) if codec == "h264" else False
        codec_args = (video_codec_args(use_hw=usable_hw, allow_sw=usable_hw, width=width, crf=crf) + ["-pix_fmt", "yuv420p"]
                      if codec == "h264" else prores_codec_args(codec))
        filters = (["vflip"] if vflip else []) + ["scale=in_range=full:out_range=tv:out_color_matrix=bt709", "setsar=1"]

        tail_args = [
            "-vf", ",".join(filters),
            "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "bt709", "-color_range", "tv",
            "-movflags",
            "+faststart",
            path,
        ]
        # A disk-backed diagnostic stream cannot fill a stderr pipe and deadlock the encoder.
        self._stderr = tempfile.TemporaryFile()
        try:
            self.proc = subprocess.Popen(base_cmd + codec_args + tail_args, stdin=subprocess.PIPE,
                                         stdout=subprocess.DEVNULL, stderr=self._stderr, bufsize=0)
            # ``select`` on anonymous pipes is unavailable on Windows.  POSIX uses a nonblocking
            # pipe; Windows supervises its blocking write in a short-lived worker below.
            if os.name != "nt":
                os.set_blocking(self.proc.stdin.fileno(), False)
        except Exception:
            if hasattr(self, "proc"):
                self.proc.kill()
                self.proc.wait(timeout=10)
            self._stderr.close()
            raise

    def write(self, frame: Any) -> None:
        data = frame if isinstance(frame, (bytes, bytearray, memoryview)) else (frame.tobytes() if hasattr(frame, "tobytes") else bytes(frame))
        with self._lock:
            if self._closed or not self.proc.stdin or self.proc.stdin.closed:
                raise RuntimeError("Encoder is closed")
            if os.name == "nt":
                self._write_windows(data)
                return
            pending = memoryview(data).cast("B")
            fd = self.proc.stdin.fileno()
            deadline = time.monotonic() + self.write_timeout
            try:
                while pending:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("ffmpeg stopped accepting video frames")
                    if self.proc.poll() is not None:
                        raise RuntimeError(f"ffmpeg exited {self.proc.returncode}: {self._error_detail()}")
                    if not select.select([], [fd], [], min(remaining, 0.25))[1]:
                        continue
                    try:
                        written = os.write(fd, pending[:65536])
                    except BlockingIOError:
                        continue
                    pending = pending[written:]
            except Exception:
                self.abort()
                raise

    def _write_windows(self, data: Any) -> None:
        """Bound a Windows pipe write, where ``select`` only accepts sockets.

        Killing ffmpeg closes the read end and releases a blocked worker before ``abort`` closes the
        Python file object.  The worker is per write so no background queue can outlive the encoder.
        """
        done = threading.Event()
        error: list[BaseException] = []

        def write_all() -> None:
            try:
                pending = memoryview(data).cast("B")
                while pending:
                    written = self.proc.stdin.write(pending)
                    if not written:
                        raise BrokenPipeError("ffmpeg stopped accepting video frames")
                    pending = pending[written:]
            except BaseException as exc:
                error.append(exc)
            finally:
                done.set()

        worker = threading.Thread(target=write_all, name="downbeat-ffmpeg-write", daemon=True)
        worker.start()
        if not done.wait(self.write_timeout):
            if self.proc.poll() is None:
                self.proc.kill()
            worker.join(10)
            self.abort()
            raise TimeoutError("ffmpeg stopped accepting video frames")
        if error:
            self.abort()
            raise error[0]

    def _error_detail(self) -> str:
        self._stderr.seek(0, os.SEEK_END)
        self._stderr.seek(max(0, self._stderr.tell() - 8192))
        return self._stderr.read().decode("utf-8", "replace").strip()

    def abort(self) -> None:
        with self._lock:
            if self._closed:
                return
            try:
                if self.proc.poll() is None:
                    self.proc.kill()
                # Kill before closing stdin: a buffered close must never wait for a blocked child.
                if self.proc.stdin and not self.proc.stdin.closed:
                    self.proc.stdin.close()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
            except (BrokenPipeError, OSError):
                pass
            finally:
                self._closed = True
                self._stderr.close()
                if os.path.exists(self.path):
                    os.remove(self.path)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            try:
                if self.proc.stdin and not self.proc.stdin.closed:
                    self.proc.stdin.close()
                self.proc.wait(timeout=self.close_timeout)
                if self.proc.returncode != 0:
                    raise RuntimeError(f"ffmpeg exited {self.proc.returncode}: {self._error_detail()}")
            except Exception:
                self.abort()
                raise
            self._closed = True
            self._stderr.close()

    def __enter__(self) -> Encoder:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is not None:
            self.abort()
            return None
        self.close()


def mux_audio_preview(
    silent_mp4_path: str,
    audio_path: str,
    out_mp4_path: str,
    start_sec: float = 0.0,
    duration_sec: float = 8.0,
) -> None:
    """Mux synced audio into MP4 for preview."""
    exe = ffmpeg_path()
    cmd = [
        exe,
        "-y",
        "-loglevel",
        "error",
        "-i",
        silent_mp4_path,
        "-ss",
        f"{max(0.0, start_sec):.2f}",
        "-t",
        f"{duration_sec:.2f}",
        "-i",
        audio_path,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        out_mp4_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=ENCODE_TIMEOUT)
    except Exception:
        if os.path.exists(out_mp4_path):
            os.remove(out_mp4_path)
        raise
