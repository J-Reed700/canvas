"""Real-time audio transient, sub-bass, and BPM analysis for Canvas Forge.

Decodes any WAV/MP3/AIFF/FLAC track via ffmpeg into 22.05kHz mono float32 PCM,
then uses pure NumPy STFT & onset flux to extract:
  - Estimated BPM (via autocorrelation of onset strength envelope)
  - Best high-energy segment offset (where the drop / loudest groove hits)
  - 30fps per-frame modulation curves:
      * sub_bass[i]  : 20-140 Hz kick/sub energy in [0, 1]
      * transient[i] : sharp percussive onset spikes in [0, 1]
      * high_air[i]  : 2.5-10 kHz hats/synth air in [0, 1]
      * rms[i]       : overall loudness envelope in [0, 1]
  - 96-bin waveform peaks for the Studio UI visualizer
"""
from __future__ import annotations

import dataclasses
import hashlib
import os
import subprocess

import numpy as np

SR = 22050


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


def _normalize_curve(arr: np.ndarray, p_low: float = 10.0, p_high: float = 98.0) -> np.ndarray:
    if arr.size == 0:
        return arr
    lo = float(np.percentile(arr, p_low))
    hi = float(np.percentile(arr, p_high))
    if hi - lo < 1e-6:
        return np.zeros_like(arr, dtype=np.float32)
    return np.clip((arr - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)


def _smooth_envelope(arr: np.ndarray, attack: float = 0.45, release: float = 0.88) -> np.ndarray:
    """One-pole attack/release envelope follower + 3-point moving average.

    Prevents 30fps audio curves from jumping 0->1->0 in a single 33ms frame.
    """
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


def analyze_track(path: str) -> AudioProfile:
    """Probe and analyze an audio file for BPM, best drop window, and UI waveform."""
    path = os.path.abspath(os.path.expanduser(path))
    if path in _PROFILE_CACHE:
        return _PROFILE_CACHE[path]

    y = _decode_pcm(path)
    duration = float(y.size / SR)
    aid = hashlib.md5(path.encode("utf-8")).hexdigest()[:10]
    name = os.path.basename(path)

    # 1. Compute 96-bar waveform peaks for UI
    n_bars = 96
    chunk = max(1, y.size // n_bars)
    trimmed = y[: chunk * n_bars].reshape(n_bars, chunk)
    peaks = np.sqrt(np.mean(trimmed * trimmed, axis=1))
    peaks_norm = _normalize_curve(peaks, 5.0, 99.0)

    # 2. STFT at ~86 Hz frame rate (hop = 256 samples) for onset & BPM detection
    hop = 256
    n_fft = 1024
    n_hops = max(1, (y.size - n_fft) // hop)
    window = np.hanning(n_fft).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(y, n_fft)[::hop][:n_hops]
    spec = np.abs(np.fft.rfft(frames * window, axis=1))

    # Sub-bass & low-mid bins (roughly 30Hz - 220Hz)
    low_energy = spec[:, 1:12].mean(axis=1)
    onset_flux = np.maximum(0.0, np.diff(low_energy, prepend=low_energy[0]))

    # Autocorrelation over BPM range [84, 165]
    env = onset_flux - onset_flux.mean()
    ac = np.correlate(env, env, mode="full")[env.size - 1 :]
    fps_env = SR / hop
    best_bpm = 126
    best_score = -1.0
    for bpm in range(84, 166):
        lag = int(round(fps_env * 60.0 / bpm))
        if 0 < lag < ac.size:
            # Check fundamental lag + 2x lag harmonic
            score = float(ac[lag]) + 0.5 * float(ac[min(ac.size - 1, lag * 2)])
            # Slight prior toward common club/electronic tempo range 118-140
            if 116 <= bpm <= 142:
                score *= 1.08
            if score > best_score:
                best_score = score
                best_bpm = bpm

    # Check if filename explicitly encodes BPM (e.g., "_128_", "150", "84 bpm")
    import re
    m = re.search(r"(?:^|[_\-\s])(8[0-9]|9[0-9]|1[0-6][0-9])(?:[_\-\s]|bpm|\.wav|\.mp3)", name, re.IGNORECASE)
    if m:
        hint = int(m.group(1))
        if 80 <= hint <= 170:
            best_bpm = hint

    # 3. Find highest-energy 8-second window (the drop)
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
    """Extract 30fps sub-bass, transient, high-air, and RMS curves for `n_frames`."""
    prof = analyze_track(path)
    y = _decode_pcm(path)
    duration_sec = n_frames / fps
    if start_sec is None:
        start_sec = prof.best_start_sec

    start_sample = int(max(0.0, start_sec) * SR)
    need_samples = int(duration_sec * SR) + 2048
    if start_sample + need_samples > y.size:
        # Wrap around if track is shorter than canvas
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
    flux = np.maximum(0.0, np.diff(sub_arr, prepend=sub_arr[0]) * 1.4 + np.diff(rms_arr, prepend=rms_arr[0]))
    # Smooth sub_bass slightly with 2-frame decay so kicks have punchy body
    sub_smooth = sub_arr.copy()
    for i in range(1, n_frames):
        sub_smooth[i] = max(sub_arr[i], sub_smooth[i - 1] * 0.72)

    # Smooth envelopes with one-pole attack/release + 3-point moving average (flicker-safe)
    sub_smooth = _smooth_envelope(sub_smooth, attack=0.45, release=0.88)
    flux = _smooth_envelope(flux, attack=0.5, release=0.84)
    air_arr = _smooth_envelope(air_arr, attack=0.45, release=0.88)
    rms_arr = _smooth_envelope(rms_arr, attack=0.45, release=0.88)

    # Scale normalized curves to [0.0, 0.85] for smooth, non-flickering visual breathing
    return FrameAudioCurves(
        sub_bass=(_normalize_curve(sub_smooth, 12.0, 96.0) * 0.85).astype(np.float32),
        transient=(_normalize_curve(flux, 25.0, 97.0) * 0.85).astype(np.float32),
        high_air=(_normalize_curve(air_arr, 15.0, 96.0) * 0.85).astype(np.float32),
        rms=(_normalize_curve(rms_arr, 10.0, 97.0) * 0.85).astype(np.float32),
        bpm=prof.detected_bpm,
        start_sec=start_sec,
    )
