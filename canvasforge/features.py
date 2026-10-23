"""Full-track audio features for the real-time GPU Studio.

Everything is computed once per track and shipped to the browser, so the live preview
and the exported loop are driven by exactly the same numbers (preview == export):

  curves (30 fps, 0..1) : kick, bass, snare, hats, energy, bright
  beat grid             : tempo-refined constant grid of beat + downbeat times
  loop suggestions      : bar-aligned windows ranked by energy (the drop first)
  peaks                 : waveform overview for the timeline
"""
from __future__ import annotations

import math
import os

import numpy as np

from .audio import SR, _decode_pcm, analyze_track

FPS = 30
HOP = SR / FPS  # 735 samples -> exactly one analysis frame per video frame
N_FFT = 2048
ONSET_HOP = 256  # ~86 Hz onset envelope for sub-frame beat phase precision
MAX_LOOP_SECONDS = 8.0
MIN_LOOP_SECONDS = 3.0

BANDS = {
    "kick": (30.0, 120.0),
    "bass": (120.0, 320.0),
    "snare": (900.0, 3500.0),
    "hats": (6000.0, 11000.0),
}

_CACHE: dict[str, dict] = {}


def _stft_mag(y: np.ndarray, hop: float, n_fft: int) -> np.ndarray:
    n = max(1, int(y.size // hop))
    padded = np.pad(y, (n_fft // 2, n_fft // 2))
    starts = np.round(np.arange(n) * hop).astype(np.int64)
    window = np.hanning(n_fft).astype(np.float32)
    view = np.lib.stride_tricks.sliding_window_view(padded, n_fft)
    out = np.empty((n, n_fft // 2 + 1), dtype=np.float32)
    for c in range(0, n, 1024):  # chunked to keep peak memory small on long tracks
        sl = starts[c : c + 1024]
        out[c : c + sl.size] = np.abs(np.fft.rfft(view[sl] * window, axis=1))
    return out


def _band(mag: np.ndarray, freqs: np.ndarray, lo: float, hi: float) -> np.ndarray:
    mask = (freqs >= lo) & (freqs < hi)
    return np.log1p(mag[:, mask].mean(axis=1) * 10.0)


def _norm(x: np.ndarray, lo_pct: float, hi_pct: float) -> np.ndarray:
    lo = float(np.percentile(x, lo_pct))
    hi = float(np.percentile(x, hi_pct))
    if hi - lo < 1e-9:
        return np.zeros_like(x, dtype=np.float32)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)


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


def _flux(x: np.ndarray) -> np.ndarray:
    return np.maximum(0.0, np.diff(x, prepend=x[:1]))


def _onset_envelope(y: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """High-rate (≈86 Hz) full-band and kick-band onset strength."""
    mag = _stft_mag(y, ONSET_HOP, 1024)
    freqs = np.fft.rfftfreq(1024, d=1.0 / SR)
    logmag = np.log1p(mag * 10.0)
    full = np.maximum(0.0, np.diff(logmag, axis=0, prepend=logmag[:1])).mean(axis=1)
    kick = _flux(_band(mag, freqs, *BANDS["kick"]))
    return full.astype(np.float32), kick.astype(np.float32), SR / ONSET_HOP


def _fold(w: np.ndarray, t: np.ndarray, bpm: float) -> tuple[float, float]:
    """Fold onset strength onto one beat period: (peakiness score, phase of the peak in seconds)."""
    period = 60.0 / bpm
    bins = 96
    hist = np.bincount(((t % period) / period * bins).astype(np.int64) % bins, weights=w, minlength=bins)
    hist = hist + np.roll(hist, 1) + np.roll(hist, -1)  # tolerate ±1 bin jitter
    k = int(np.argmax(hist))
    return float(hist[k]) / max(1e-9, float(hist.mean())), (k + 0.5) / bins * period


def _beat_envelope(y: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Kick-weighted onset strength, so broadband off-beat hats can't pull the grid half a beat off."""
    onset, kick_onset, rate = _onset_envelope(y)
    kick_env = np.maximum(kick_onset, np.maximum(np.roll(kick_onset, 1), np.roll(kick_onset, -1)))
    mixed = 0.65 * kick_env / (np.percentile(kick_env, 99) + 1e-9) + 0.35 * onset / (np.percentile(onset, 99) + 1e-9)
    return mixed, kick_env, rate


def estimate_bpm(y: np.ndarray, lo: float = 70.0, hi: float = 180.0) -> float:
    """Global tempo search: the BPM whose beat grid concentrates the most onset energy."""
    mixed, _, rate = _beat_envelope(y)
    t = np.arange(mixed.size) / rate
    # Half/double-tempo grids fold almost equally well; a gentle prior (σ = 1 octave around
    # 128 BPM) settles near-ties toward the conventional DJ tempo. The UI offers ½× / 2×.
    prior = lambda b: np.exp(-0.5 * np.log2(b / 128.0) ** 2)
    coarse = max(np.arange(lo, hi + 1e-9, 0.25), key=lambda b: _fold(mixed, t, b)[0] * prior(b))
    return float(max(np.arange(coarse - 0.3, coarse + 0.3 + 1e-9, 0.02), key=lambda b: _fold(mixed, t, b)[0]))


def track_features(path: str, bpm_override: float | None = None) -> dict:
    """Features for a track; `bpm_override` forces the tempo (the grid phase is still fitted)."""
    path = os.path.abspath(os.path.expanduser(path))
    key = f"{path}|{bpm_override or ''}"
    if key in _CACHE:
        return _CACHE[key]

    prof = analyze_track(path)
    y = _decode_pcm(path)
    duration = float(y.size / SR)

    # ---- 30 fps band curves (one STFT frame per video frame)
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
        "bass": _follow(_norm(bass_e, 10, 98), 0.03, 0.25),
        "energy": _follow(_norm(total, 5, 98), 0.08, 0.45),
        "bright": _follow(_norm(np.log(np.maximum(centroid, 1.0)), 5, 95), 0.15, 0.35),
    }

    # ---- beat grid: constant tempo (0.02 BPM resolution) + phase on the kick-weighted envelope
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

    # downbeat = the beat phase (mod 4) carrying the most kick energy
    kick_at = np.interp(beats, kt, kick_env)
    bar_phase = int(np.argmax([kick_at[k::4].sum() for k in range(4)])) if beats.size >= 8 else 0
    downbeats = beats[bar_phase::4]

    bar = period * 4
    loop_bars = _default_bars(bar)
    loop_len = loop_bars * bar if loop_bars else MAX_LOOP_SECONDS

    # ---- loop suggestions: strongest bar-aligned windows, separated by ≥ 8 bars
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

    # ---- waveform overview
    n_peaks = 1200
    chunk = max(1, y.size // n_peaks)
    trimmed = np.abs(y[: chunk * n_peaks]).reshape(-1, chunk)
    peaks = _norm(np.sqrt((trimmed * trimmed).mean(axis=1)), 2, 99.5)

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


def _default_bars(bar_seconds: float) -> int:
    """Largest power-of-two bar count that fits the 3–8 s Spotify Canvas window."""
    best = 0
    for bars in (1, 2, 4, 8, 16):
        if MIN_LOOP_SECONDS - 1e-6 <= bars * bar_seconds <= MAX_LOOP_SECONDS + 1e-6:
            best = bars
    return best


def _bpm_from_name(name: str) -> int | None:
    import re

    m = re.search(r"(?:^|[_\-\s])(8[0-9]|9[0-9]|1[0-6][0-9])(?:[_\-\s]|bpm|\.wav|\.mp3)", name, re.IGNORECASE)
    return int(m.group(1)) if m else None
