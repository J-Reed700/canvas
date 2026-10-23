"""H.264 writer via system ffmpeg (Apple Silicon VideoToolbox + libx264 fallback, yuv420p, 30fps, +faststart, silent)."""
from __future__ import annotations

import shutil
import subprocess
from typing import Any

DEFAULT_FPS: float = 30.0
DEFAULT_W: int = 1080
DEFAULT_H: int = 1920

# Preserved aliases for backwards compatibility
CANVAS_FPS = DEFAULT_FPS
CANVAS_W = DEFAULT_W
CANVAS_H = DEFAULT_H

_HAS_VIDEOTOOLBOX: bool | None = None


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
    global _HAS_VIDEOTOOLBOX
    if _HAS_VIDEOTOOLBOX is not None:
        return _HAS_VIDEOTOOLBOX
    try:
        exe = ffmpeg_path()
    except RuntimeError:
        _HAS_VIDEOTOOLBOX = False
        return False
    try:
        out = subprocess.check_output([exe, "-encoders"], stderr=subprocess.DEVNULL).decode("utf-8", "ignore")
        _HAS_VIDEOTOOLBOX = "h264_videotoolbox" in out
    except Exception:
        _HAS_VIDEOTOOLBOX = False
    return _HAS_VIDEOTOOLBOX


_check_videotoolbox = has_videotoolbox


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
    ):
        self.path = path
        self.fps = fps
        self.width = width
        self.height = height
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
            "-an",  # Strictly silent per Spotify Canvas spec
        ]

        codec_args = video_codec_args(use_hw=use_hw, width=width, crf=crf)

        tail_args = [
            *(["-vf", "vflip"] if vflip else []),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            path,
        ]
        self.proc = subprocess.Popen(base_cmd + codec_args + tail_args, stdin=subprocess.PIPE)

    def write(self, frame: Any) -> None:
        if self.proc.stdin:
            if isinstance(frame, (bytes, bytearray, memoryview)):
                self.proc.stdin.write(frame)
            elif hasattr(frame, "tobytes"):
                self.proc.stdin.write(frame.tobytes())
            else:
                self.proc.stdin.write(bytes(frame))

    def close(self) -> None:
        if self.proc.stdin and not self.proc.stdin.closed:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
        self.proc.wait()
        if self.proc.returncode != 0:
            raise RuntimeError(f"ffmpeg exited {self.proc.returncode}")

    def __enter__(self) -> Encoder:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is not None:
            if self.proc.stdin and not self.proc.stdin.closed:
                try:
                    self.proc.stdin.close()
                except Exception:
                    pass
            try:
                self.proc.kill()
                self.proc.wait()
            except Exception:
                pass
            return None
        self.close()


def mux_audio_preview(
    silent_mp4_path: str,
    audio_path: str,
    out_mp4_path: str,
    start_sec: float = 0.0,
    duration_sec: float = 8.0,
) -> None:
    """Create a companion MP4 with the synced audio slice muxed in for social/Reels/Studio auditioning."""
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
    subprocess.run(cmd, check=True)
