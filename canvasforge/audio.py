"""Real-time audio transient, sub-bass, and BPM analysis for Canvas Forge.

Decodes audio files via ffmpeg into mono float32 PCM and uses NumPy STFT and onset
flux to extract BPM, energy drops, and frame modulation curves.
"""
from __future__ import annotations

import dataclasses
import hashlib
import os
import re
import subprocess

import numpy as np

SR = 22050
ONSET_HOP = 256
BANDS = {
    "kick": (30.0, 120.0),
    "bass": (120.0, 320.0),
    "snare": (900.0, 3500.0),
    "hats": (6000.0, 11000.0),
}

BPM_FILENAME_REGEX = re.compile(
    r"(?:^|[_\-\s])(8[0-9]|9[0-9]|1[0-6][0-9])(?:[_\-\s]|bpm|\.wav|\.mp3)",
    re.IGNORECASE,
)


@dataclasses.dataclass
class AudioProfile:
    id: str
    path: str
    name: str
    duration: float
    detected_bpm: int
    best_start_sec: float
    waveform_peaks: list[float]  # 96 bars in [0, 1] for UI display

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "path": self.path,
            "duration": round(self.duration, 1),
            "detected_bpm": self.detected_bpm,
            "best_start_sec": round(self.best_start_sec, 1),
            "waveform_peaks": [round(x, 3) for x in self.waveform_peaks],
        }


@dataclasses.dataclass
class FrameAudioCurves:
    """30fps normalized modulation arrays (length = n_frames) in [0.0, 1.0]."""
    sub_bass: np.ndarray
    transient: np.ndarray
    high_air: np.ndarray
    rms: np.ndarray
    bpm: int
    start_sec: float


_PCM_CACHE: dict[str, np.ndarray] = {}
_PROFILE_CACHE: dict[str, AudioProfile] = {}


def _decode_pcm(path: str, max_seconds: float = 180.0) -> np.ndarray:
    """Decode audio file to 22050Hz mono float32 numpy array via ffmpeg."""
    path = os.path.abspath(os.path.expanduser(path))
    if path in _PCM_CACHE:
        return _PCM_CACHE[path]
    if not os.path.isfile(path):
        raise FileNotFoundError(path)

    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        path,
        "-t",
        str(max_seconds),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SR),
        "-f",
        "f32le",
        "pipe:1",
    ]
    raw = subprocess.check_output(cmd)
    y = np.frombuffer(raw, dtype=np.float32).copy()
    if y.size < SR:
        y = np.pad(y, (0, SR - y.size))
    if len(_PCM_CACHE) >= 16:
        _PCM_CACHE.pop(next(iter(_PCM_CACHE)))
    _PCM_CACHE[path] = y
    return y


def _bpm_from_name(name: str) -> int | None:
    """Extract BPM from filename if explicitly encoded (80-169 BPM)."""
    m = BPM_FILENAME_REGEX.search(name)
    return int(m.group(1)) if m else None


def _normalize_curve(arr: np.ndarray, p_low: float = 10.0, p_high: float = 98.0, eps: float = 1e-6) -> np.ndarray:
    """Normalize array percentiles to [0.0, 1.0]."""
    if arr.size == 0:
        return arr.astype(np.float32) if arr.dtype != np.float32 else arr
    lo = float(np.percentile(arr, p_low))
    hi = float(np.percentile(arr, p_high))
    if hi - lo < eps:
        return np.zeros_like(arr, dtype=np.float32)
    return np.clip((arr - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)


def _flux(x: np.ndarray, axis: int = 0) -> np.ndarray:
    """Half-wave rectified first difference (positive spectral/envelope flux)."""
    return np.maximum(0.0, np.diff(x, axis=axis, prepend=np.take(x, [0], axis=axis)))


def _smooth_envelope(arr: np.ndarray, attack: float = 0.45, release: float = 0.88) -> np.ndarray:
    """One-pole attack/release envelope follower with 3-point moving average smoothing."""
    if arr.size == 0:
        return arr.astype(np.float32)
    out = np.zeros_like(arr, dtype=np.float32)
    env = float(arr[0])
    out[0] = env
    for i in range(1, arr.size):
        val = float(arr[i])
        if val > env:
            env = (1.0 - attack) * env + attack * val
        else:
            env = release * env + (1.0 - release) * val
        out[i] = env

    if out.size >= 3:
        kernel = np.ones(3, dtype=np.float32) / 3.0
        padded = np.pad(out, (1, 1), mode="edge")
        out = np.convolve(padded, kernel, mode="valid").astype(np.float32)
    return out


def _stft_mag(y: np.ndarray, hop: float, n_fft: int) -> np.ndarray:
    """Chunked STFT magnitude to limit peak memory on long tracks."""
    n = max(1, int(y.size // hop))
    padded = np.pad(y, (n_fft // 2, n_fft // 2))
    starts = np.round(np.arange(n) * hop).astype(np.int64)
    window = np.hanning(n_fft).astype(np.float32)
    view = np.lib.stride_tricks.sliding_window_view(padded, n_fft)
    out = np.empty((n, n_fft // 2 + 1), dtype=np.float32)
    for c in range(0, n, 1024):
        sl = starts[c : c + 1024]
        out[c : c + sl.size] = np.abs(np.fft.rfft(view[sl] * window, axis=1))
    return out


def _band(mag: np.ndarray, freqs: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Log-scaled energy in a specific frequency band [lo, hi)."""
    mask = (freqs >= lo) & (freqs < hi)
    return np.log1p(mag[:, mask].mean(axis=1) * 10.0)


def _onset_envelope(y: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """High-rate (approx 86 Hz) full-band and kick-band onset strength."""
    mag = _stft_mag(y, ONSET_HOP, 1024)
    freqs = np.fft.rfftfreq(1024, d=1.0 / SR)
    logmag = np.log1p(mag * 10.0)
    full = _flux(logmag, axis=0).mean(axis=1)
    kick = _flux(_band(mag, freqs, *BANDS["kick"]))
    return full.astype(np.float32), kick.astype(np.float32), SR / ONSET_HOP


def _fold(w: np.ndarray, t: np.ndarray, bpm: float) -> tuple[float, float]:
    """Fold onset strength onto one beat period: (peakiness score, phase in seconds)."""
    period = 60.0 / bpm
    bins = 96
    hist = np.bincount(((t % period) / period * bins).astype(np.int64) % bins, weights=w, minlength=bins)
    hist = hist + np.roll(hist, 1) + np.roll(hist, -1)
    k = int(np.argmax(hist))
    return float(hist[k]) / max(1e-9, float(hist.mean())), (k + 0.5) / bins * period


def _beat_envelope(y: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Kick-weighted onset strength envelope for tempo estimation."""
    onset, kick_onset, rate = _onset_envelope(y)
    kick_env = np.maximum(kick_onset, np.maximum(np.roll(kick_onset, 1), np.roll(kick_onset, -1)))
    mixed = 0.65 * kick_env / (np.percentile(kick_env, 99) + 1e-9) + 0.35 * onset / (np.percentile(onset, 99) + 1e-9)
    return mixed, kick_env, rate


def estimate_bpm(y: np.ndarray, lo: float = 70.0, hi: float = 180.0) -> float:
    """Estimate BPM by global beat-grid folding on kick-weighted onset strength."""
    mixed, _, rate = _beat_envelope(y)
    t = np.arange(mixed.size) / rate
    prior = lambda b: np.exp(-0.5 * np.log2(b / 128.0) ** 2)
    coarse = max(np.arange(lo, hi + 1e-9, 0.25), key=lambda b: _fold(mixed, t, b)[0] * prior(b))
    return float(max(np.arange(coarse - 0.3, coarse + 0.3 + 1e-9, 0.02), key=lambda b: _fold(mixed, t, b)[0]))


def analyze_track(path: str) -> AudioProfile:
    """Analyze audio track for tempo, drop window, and UI waveform peaks."""
    path = os.path.abspath(os.path.expanduser(path))
    if path in _PROFILE_CACHE:
        return _PROFILE_CACHE[path]

    y = _decode_pcm(path)
    duration = float(y.size / SR)
    aid = hashlib.md5(path.encode("utf-8")).hexdigest()[:10]
    name = os.path.basename(path)

    # Waveform peaks (96 bars) for UI visualizer
    n_bars = 96
    chunk = max(1, y.size // n_bars)
    trimmed = y[: chunk * n_bars].reshape(n_bars, chunk)
    peaks = np.sqrt(np.mean(trimmed * trimmed, axis=1))
    peaks_norm = _normalize_curve(peaks, 5.0, 99.0)

    # Tempo estimation via onset beat-grid folding
    best_bpm = int(round(estimate_bpm(y)))
    hop = 256
    n_fft = 1024
    n_hops = max(1, (y.size - n_fft) // hop)
    fps_env = SR / hop
    frames = np.lib.stride_tricks.sliding_window_view(y, n_fft)[::hop][:n_hops]
    low_energy = np.abs(np.fft.rfft(frames * np.hanning(n_fft).astype(np.float32), axis=1))[:, 1:12].mean(axis=1)

    hint = _bpm_from_name(name)
    if hint is not None:
        best_bpm = hint

    # Drop search: highest low-frequency energy 8-second window
    win_hops = min(n_hops, int(8.0 * fps_env))
    if n_hops > win_hops + 4:
        kernel = np.ones(win_hops, dtype=np.float32) / win_hops
        smooth_e = np.convolve(low_energy, kernel, mode="valid")
        best_idx = int(np.argmax(smooth_e))
        best_start_sec = float(best_idx / fps_env)
    else:
        best_start_sec = 0.0

    prof = AudioProfile(
        id=aid,
        path=path,
        name=name,
        duration=duration,
        detected_bpm=best_bpm,
        best_start_sec=best_start_sec,
        waveform_peaks=peaks_norm.tolist(),
    )
    _PROFILE_CACHE[path] = prof
    return prof


def extract_frame_curves(
    path: str,
    n_frames: int,
    fps: int = 30,
    start_sec: float | None = None,
) -> FrameAudioCurves:
    """Extract 30fps sub-bass, transient, high-air, and RMS curves for n_frames."""
    prof = analyze_track(path)
    y = _decode_pcm(path)
    duration_sec = n_frames / fps
    if start_sec is None:
        start_sec = prof.best_start_sec

    start_sample = int(max(0.0, start_sec) * SR)
    need_samples = int(duration_sec * SR) + 2048
    if start_sample + need_samples > y.size:
        reps = (need_samples // max(1, y.size)) + 2
        y_tiled = np.tile(y, reps)
        seg = y_tiled[start_sample : start_sample + need_samples]
    else:
        seg = y[start_sample : start_sample + need_samples]

    n_fft = 1024
    window = np.hanning(n_fft).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / SR)

    sub_mask = (freqs >= 25.0) & (freqs <= 145.0)
    air_mask = (freqs >= 2400.0) & (freqs <= 10000.0)

    sub_arr = np.zeros(n_frames, dtype=np.float32)
    air_arr = np.zeros(n_frames, dtype=np.float32)
    rms_arr = np.zeros(n_frames, dtype=np.float32)

    samples_per_frame = SR / fps
    for i in range(n_frames):
        center = int(i * samples_per_frame)
        chunk = seg[center : center + n_fft]
        if chunk.size < n_fft:
            chunk = np.pad(chunk, (0, n_fft - chunk.size))
        rms_arr[i] = float(np.sqrt(np.mean(chunk * chunk)))
        mag = np.abs(np.fft.rfft(chunk * window))
        sub_arr[i] = float(mag[sub_mask].mean()) if np.any(sub_mask) else 0.0
        air_arr[i] = float(mag[air_mask].mean()) if np.any(air_mask) else 0.0

    # Positive spectral flux for sharp percussive transients
    flux = _flux(sub_arr * 1.4 + rms_arr)

    # Smooth sub_bass slightly with 2-frame decay so kicks have punchy body
    sub_smooth = sub_arr.copy()
    for i in range(1, n_frames):
        sub_smooth[i] = max(sub_arr[i], sub_smooth[i - 1] * 0.72)

    # Smooth envelopes with one-pole attack/release + 3-point moving average
    sub_smooth = _smooth_envelope(sub_smooth, attack=0.45, release=0.88)
    flux = _smooth_envelope(flux, attack=0.5, release=0.84)
    air_arr = _smooth_envelope(air_arr, attack=0.45, release=0.88)
    rms_arr = _smooth_envelope(rms_arr, attack=0.45, release=0.88)

    # Scale normalized curves to [0.0, 0.85] for smooth visual breathing
    return FrameAudioCurves(
        sub_bass=(_normalize_curve(sub_smooth, 12.0, 96.0) * 0.85).astype(np.float32),
        transient=(_normalize_curve(flux, 25.0, 97.0) * 0.85).astype(np.float32),
        high_air=(_normalize_curve(air_arr, 15.0, 96.0) * 0.85).astype(np.float32),
        rms=(_normalize_curve(rms_arr, 10.0, 97.0) * 0.85).astype(np.float32),
        bpm=prof.detected_bpm,
        start_sec=start_sec,
    )
