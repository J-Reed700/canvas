"""Full-track audio features for the real-time GPU Studio.

Computes 30fps frequency band modulation curves, beat grids, downbeats, loop
suggestions, and waveform peaks for Studio preview and video export.
"""
from __future__ import annotations

import math
import os

import numpy as np

from .audio import (
    BANDS,
    ONSET_HOP,
    SR,
    _band,
    _beat_envelope,
    _bpm_from_name,
    _decode_pcm,
    _flux,
    _fold,
    _normalize_curve,
    _stft_mag,
    analyze_track,
    estimate_bpm,
)

FPS = 30
HOP = SR / FPS
N_FFT = 2048
MAX_LOOP_SECONDS = 8.0
MIN_LOOP_SECONDS = 3.0

_CACHE: dict[str, dict] = {}
_norm = _normalize_curve


def _follow(x: np.ndarray, attack_s: float, release_s: float) -> np.ndarray:
    """Attack/release envelope follower at FPS (attack_s <= 0 means instant attack)."""
    a = 1.0 if attack_s <= 0 else 1.0 - math.exp(-1.0 / (attack_s * FPS))
    r = math.exp(-1.0 / (release_s * FPS))
    out = np.empty_like(x, dtype=np.float32)
    env = 0.0
    for i, v in enumerate(x.tolist()):
        env = env + a * (v - env) if v > env else env * r + v * (1.0 - r)
        out[i] = env
    return out


def _default_bars(bar_seconds: float) -> int:
    """Largest power-of-two bar count that fits the 3-8s Spotify Canvas window."""
    best = 0
    for bars in (1, 2, 4, 8, 16):
        if MIN_LOOP_SECONDS - 1e-6 <= bars * bar_seconds <= MAX_LOOP_SECONDS + 1e-6:
            best = bars
    return best


def track_features(path: str, bpm_override: float | None = None) -> dict:
    """Compute full-track audio features (beat grid, loop suggestions, 30fps band curves)."""
    path = os.path.abspath(os.path.expanduser(path))
    key = f"{path}|{bpm_override or ''}"
    if key in _CACHE:
        return _CACHE[key]

    prof = analyze_track(path)
    y = _decode_pcm(path)
    duration = float(y.size / SR)

    # 30 fps band curves (one STFT frame per video frame)
    mag = _stft_mag(y, HOP, N_FFT)
    freqs = np.fft.rfftfreq(N_FFT, d=1.0 / SR)
    n = mag.shape[0]

    kick_e = _band(mag, freqs, *BANDS["kick"])
    bass_e = _band(mag, freqs, *BANDS["bass"])
    snare_e = _band(mag, freqs, *BANDS["snare"])
    hats_e = _band(mag, freqs, *BANDS["hats"])
    total = np.log1p(np.sqrt((mag * mag).mean(axis=1)) * 10.0)
    centroid = (mag * freqs[None, :]).sum(axis=1) / np.maximum(1e-9, mag.sum(axis=1))

    def hit(energy: np.ndarray, release: float) -> np.ndarray:
        f = _flux(energy)
        peak = float(np.percentile(f, 99.0)) or 1.0
        return np.clip(_follow(np.clip(f / peak, 0.0, 1.0), 0.0, release), 0.0, 1.0)

    curves = {
        "kick": hit(kick_e, 0.20),
        "snare": hit(snare_e, 0.16),
        "hats": hit(hats_e, 0.09),
        "bass": _follow(_normalize_curve(bass_e, 10, 98), 0.03, 0.25),
        "energy": _follow(_normalize_curve(total, 5, 98), 0.08, 0.45),
        "bright": _follow(_normalize_curve(np.log(np.maximum(centroid, 1.0)), 5, 95), 0.15, 0.35),
    }

    # Beat grid: constant tempo (0.02 BPM resolution) and phase on kick-weighted envelope
    mixed, kick_env, rate = _beat_envelope(y)
    t_env = np.arange(mixed.size) / rate
    named_bpm = _bpm_from_name(prof.name)
    if bpm_override:
        bpm = float(min(220.0, max(40.0, bpm_override)))
    else:
        bpm = float(named_bpm) if named_bpm else estimate_bpm(y)
    phase = _fold(mixed, t_env, bpm)[1]
    period = 60.0 / bpm
    kt = t_env

    def kick_sum(ph: float) -> float:
        return float(np.interp(np.arange(ph, duration, period), kt, kick_env).sum())

    if kick_sum((phase + period / 2) % period) > 1.15 * kick_sum(phase):
        phase = (phase + period / 2) % period
    beats = np.arange(phase, duration, period)

    # Downbeats: beat phase (mod 4) carrying the most kick energy
    kick_at = np.interp(beats, kt, kick_env)
    bar_phase = int(np.argmax([kick_at[k::4].sum() for k in range(4)])) if beats.size >= 8 else 0
    downbeats = beats[bar_phase::4]

    bar = period * 4
    loop_bars = _default_bars(bar)
    loop_len = loop_bars * bar if loop_bars else MAX_LOOP_SECONDS

    # Loop suggestions: strongest bar-aligned windows, separated by >= 8 bars
    score_curve = 0.6 * curves["energy"] + 0.4 * curves["kick"]
    cands = []
    for d in downbeats:
        a, b = int(d * FPS), int((d + loop_len) * FPS)
        if b <= n:
            cands.append((float(score_curve[a:b].mean()), float(d)))
    cands.sort(reverse=True)
    loops: list[dict] = []
    for s, d in cands:
        if all(abs(d - l["start"]) >= 8 * bar for l in loops):
            loops.append({"start": round(d, 4), "score": round(s, 3)})
        if len(loops) == 3:
            break
    for i, l in enumerate(loops):
        l["label"] = "Drop" if i == 0 else f"Peak {i + 1}"
    if downbeats.size:
        loops.append({"start": round(float(downbeats[0]), 4), "score": 0.0, "label": "Intro"})

    # Waveform overview
    n_peaks = 1200
    chunk = max(1, y.size // n_peaks)
    trimmed = np.abs(y[: chunk * n_peaks]).reshape(-1, chunk)
    peaks = _normalize_curve(np.sqrt((trimmed * trimmed).mean(axis=1)), 2, 99.5)

    feats = {
        "id": prof.id,
        "name": prof.name,
        "duration": round(duration, 3),
        "fps": FPS,
        "bpm": round(bpm, 3),
        "beats": [round(float(b), 4) for b in beats],
        "downbeats": [round(float(b), 4) for b in downbeats],
        "loop_bars": loop_bars,
        "loop_seconds": round(loop_len, 4),
        "loops": loops,
        "curves": {k: [round(float(v), 3) for v in arr] for k, arr in curves.items()},
        "peaks": [round(float(p), 3) for p in peaks],
    }
    feats["bpm_source"] = "manual" if bpm_override else ("filename" if named_bpm else "detected")
    _CACHE[key] = feats
    return feats
