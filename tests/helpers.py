"""Shared test fixtures: tool checks, ffprobe, and a temp folder with small generated media."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import wave

import numpy as np

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
HAS_PIL = importlib.util.find_spec("PIL") is not None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _ffprobe(path: str) -> dict:
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]))


def _video(info: dict) -> dict:
    return next(s for s in info["streams"] if s["codec_type"] == "video")


class TempDirCase(unittest.TestCase):
    """A temp folder per test class, and small media files written into it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="db-test-")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def path(self, *parts: str) -> str:
        p = os.path.join(self.tmp, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def clip(self, name: str, size: str = "96x160", seconds: float = 2.0, rate: int = 30, extra: list[str] | None = None) -> str:
        dest = self.path(name)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}", "-t", f"{seconds:g}",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", *(extra or []), dest],
            check=True,
        )
        return dest

    def wav(self, name: str, seconds: float, bpm: float = 120.0, rate: int = 22050) -> str:
        """Mono thumps on every beat, accented every fourth."""
        dest = self.path(name)
        n = np.arange(int(rate * 0.12))
        thump = np.sin(2 * np.pi * 60 * n / rate) * np.exp(-n / (rate * 0.03))
        y = np.zeros(int(rate * seconds), dtype=np.float32)
        for k, t in enumerate(np.arange(0.25, seconds - 0.2, 60.0 / bpm)):
            i = int(t * rate)
            y[i : i + thump.size] += thump * (1.0 if k % 4 == 0 else 0.55)
        with wave.open(dest, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes((np.clip(y, -1, 1) * 32000).astype(np.int16).tobytes())
        return dest

    def _click_track(self, bpm: float, seconds: float, offset: float) -> str:
        """Kick-like thumps every beat, accented on the downbeat, starting at `offset` seconds."""
        sr = 22050
        y = np.zeros(int(sr * seconds), dtype=np.float32)
        beat = 60.0 / bpm
        n = np.arange(int(sr * 0.12))
        thump = np.sin(2 * np.pi * 60 * n / sr) * np.exp(-n / (sr * 0.03))
        hat = np.random.default_rng(0).normal(0, 1, int(sr * 0.02)) * np.exp(-np.arange(int(sr * 0.02)) / (sr * 0.004))
        for k, t in enumerate(np.arange(offset, seconds - 0.2, beat)):
            i = int(t * sr)
            y[i : i + thump.size] += thump * (1.0 if k % 4 == 0 else 0.55)
            j = int((t + beat / 2) * sr)
            y[j : j + hat.size] += hat * 0.15
        path = os.path.join(self.tmp, f"click-{int(bpm * 100)}.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.clip(y, -1, 1) * 32000).astype(np.int16).tobytes())
        return path

    def _sine_wav(self, seconds: float) -> str:
        path = os.path.join(self.tmp, f"tone-{seconds}.wav")
        sr = 22050
        y = (0.3 * np.sin(2 * np.pi * 220 * np.arange(int(sr * seconds)) / sr) * 32767).astype(np.int16)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(y.tobytes())
        return path

    def _silent_loop(self, name: str, size: str, seconds: float) -> str:
        path = os.path.join(self.tmp, name)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30", "-t", str(seconds),
             "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
            check=True,
        )
        return path
