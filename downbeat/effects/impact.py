"""Impact, flash, and strobe shaders for Downbeat."""
from __future__ import annotations

import cv2
import numpy as np

from ._common import _pulse, _vignette_radius


def flash(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Warm exposure swell on downbeats."""
    period_beats = float(kw.get("period_beats", 4.0))
    sharp = min(float(kw.get("sharp", 2.5)), 2.5)
    p = _pulse(t, beat_dur, period_beats=period_beats, sharp=sharp, kw=kw)
    if p < 0.05:
        return frame
    max_boost = min(float(kw.get("amount", 22.0)), 22.0)
    boost = max_boost * p
    b_amt = int(round(boost * 0.65))
    g_amt = int(round(boost * 0.85))
    r_amt = int(round(boost))
    return cv2.add(frame, (b_amt, g_amt, r_amt, 0))


def strobe_shutter(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Rhythm gate with border and exposure pulse."""
    gate_phase = (t / max(beat_dur * 0.5, 0.05)) % 1.0
    boost = 0.0
    if gate_phase < 0.25:
        boost = min(10.0, 10.0 * (1.0 - gate_phase * 4.0))
    out = cv2.add(frame, (int(boost * 0.7), int(boost * 0.85), int(boost), 0))
    if boost > 4.0:
        b_val = int(boost * 4)
        out[:2, :] = cv2.add(out[:2, :], (b_val, b_val, b_val, 0))
        out[-2:, :] = cv2.add(out[-2:, :], (b_val, b_val, b_val, 0))
        out[:, :2] = cv2.add(out[:, :2], (b_val, b_val, b_val, 0))
        out[:, -2:] = cv2.add(out[:, -2:], (b_val, b_val, b_val, 0))
    return out


def bass_vignette_punch(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Border rim glow driven by sub-bass kicks."""
    p = _pulse(t, beat_dur, 1.0, sharp=4.2, kw=kw)
    if "_sub" in kw:
        p = max(p, float(kw["_sub"]))
    if p < 0.05:
        return frame
    h, w = frame.shape[:2]
    d = _vignette_radius(h, w)
    ring = np.clip((d - 0.72) / 0.35, 0.0, 1.0)[..., None]
    color_toggle = int(t / max(beat_dur, 0.05)) % 2
    rim_color = np.array([220, 255, 90], dtype=np.float32) if color_toggle == 0 else np.array([255, 80, 210], dtype=np.float32)
    intensity = min(0.65, float(kw.get("intensity", 0.55)) * p)
    glow = (ring * rim_color * intensity).astype(np.uint8)
    return cv2.add(frame, glow)


IMPACT_EFFECTS = {
    "flash": {"fn": flash, "label": "Warm Pulse", "category": "impact"},
    "strobe_shutter": {"fn": strobe_shutter, "label": "Strobe Shutter", "category": "impact"},
    "bass_vignette_punch": {"fn": bass_vignette_punch, "label": "Bass Rim Punch", "category": "impact"},
}
