"""H.264 writer via system ffmpeg (Apple Silicon VideoToolbox + libx264 fallback, yuv420p, 30fps, +faststart, silent)."""
from __future__ import annotations

import shutil
import subprocess

from .compositor import CANVAS_FPS, CANVAS_H, CANVAS_W

_HAS_VIDEOTOOLBOX: bool | None = None


def _check_videotoolbox() -> bool:
    global _HAS_VIDEOTOOLBOX
    if _HAS_VIDEOTOOLBOX is not None:
        return _HAS_VIDEOTOOLBOX
    exe = shutil.which("ffmpeg")
    if not exe:
        _HAS_VIDEOTOOLBOX = False
        return False
    try:
        out = subprocess.check_output([exe, "-encoders"], stderr=subprocess.DEVNULL).decode("utf-8", "ignore")
        _HAS_VIDEOTOOLBOX = "h264_videotoolbox" in out
    except Exception:
        _HAS_VIDEOTOOLBOX = False
    return _HAS_VIDEOTOOLBOX


class Encoder:
    def __init__(
        self,
        path: str,
        fps: float = CANVAS_FPS,
        width: int = CANVAS_W,
        height: int = CANVAS_H,
        crf: int = 18,
        use_hw: bool = True,
    ):
        self.path = path
        self.fps = fps
        self.width = width
        self.height = height
        exe = shutil.which("ffmpeg")
        if not exe:
            raise RuntimeError("ffmpeg not found on PATH")

        base_cmd = [
            exe,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s",
            f"{width}x{height}",
            "-r",
            str(fps),
            "-i",
            "-",
            "-an",  # Strictly silent per Spotify Canvas spec
        ]

        if use_hw and _check_videotoolbox():
            bitrate = "14M" if width >= 1080 else "6M"
            codec_args = [
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                bitrate,
                "-profile:v",
                "high",
            ]
        else:
            codec_args = [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                str(crf),
            ]

        tail_args = [
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            path,
        ]
        self.proc = subprocess.Popen(base_cmd + codec_args + tail_args, stdin=subprocess.PIPE)

    def write(self, frame) -> None:
        if self.proc.stdin:
            self.proc.stdin.write(frame.tobytes())

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait()
        if self.proc.returncode != 0:
            raise RuntimeError(f"ffmpeg exited {self.proc.returncode}")


def mux_audio_preview(
    silent_mp4_path: str,
    audio_path: str,
    out_mp4_path: str,
    start_sec: float = 0.0,
    duration_sec: float = 8.0,
) -> None:
    """Create a companion MP4 with the synced audio slice muxed in for social/Reels/Studio auditioning."""
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH")
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
