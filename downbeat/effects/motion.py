"""Motion and camera distortion shaders for Downbeat."""
from __future__ import annotations

import cv2
import numpy as np

from ._common import _polar_grid, _pulse, _warp_grid, _zoom_in


def zoom_pulse(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Camera zoom and kick swell on beat hits."""
    cx = float(kw.get("cx", 0.5))
    cy = float(kw.get("cy", 0.5))
    period = float(kw.get("period", 4.0))
    kick_amp = min(float(kw.get("kick", 0.09)), 0.14)
    base = 1.04 + 0.03 * float(np.sin(2.0 * np.pi * t / period))
    sharp = min(float(kw.get("sharp", 3.0)), 3.2)
    kick = kick_amp * _pulse(t, beat_dur, 1.0, sharp=sharp, kw=kw)
    return _zoom_in(frame, cx, cy, base + kick)


def beat_bounce(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Camera shake and drift on the beat."""
    amp = min(float(kw.get("amp", 0.022)), 0.035)
    sharp = min(float(kw.get("sharp", 2.5)), 3.2)
    p = _pulse(t, beat_dur, 1.0, sharp=sharp, kw=kw)
    if p < 0.01:
        return frame
    beat_phase = 2.0 * np.pi * (t / max(beat_dur, 0.01))
    dx = amp * 0.5 * float(np.sin(beat_phase * 0.5)) * p
    dy = -amp * float(np.cos(beat_phase)) * p
    return _zoom_in(frame, 0.5 + dx, 0.5 + dy, 1.06 + 0.03 * p)


def liquid_warp(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Sine wave displacement driven by sub-bass and beat phase."""
    p = _pulse(t, beat_dur, 1.0, sharp=4.2, kw=kw)
    amp = float(kw.get("amp", 18.0)) * (0.35 + 0.85 * p)
    if amp < 1.0:
        return frame
    h, w = frame.shape[:2]
    gx, gy = _warp_grid(h, w)
    freq_y = float(kw.get("freq", 0.012))
    phase = t * 5.5
    dx = (amp * np.sin(gy * freq_y + phase)).astype(np.float32)
    dy = (amp * 0.45 * np.cos(gx * (freq_y * 1.3) - phase * 0.8)).astype(np.float32)
    return cv2.remap(
        frame,
        gx + dx,
        gy + dy,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )


def pendulum_sway(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Dutch-angle rotation swaying to the beat."""
    max_deg = float(kw.get("max_deg", 4.2))
    zoom = float(kw.get("zoom", 1.06))
    p = _pulse(t, beat_dur, 1.0, sharp=2.0, kw=kw)
    period = max(beat_dur * 2.0, 0.05)
    angle = max_deg * np.sin(2.0 * np.pi * t / period) * (0.8 + 0.3 * p)
    h, w = frame.shape[:2]
    center = (w * 0.5, h * 0.5)
    m = cv2.getRotationMatrix2D(center, float(angle), zoom)
    return cv2.warpAffine(frame, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def shockwave_ripple(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Concentric displacement ring expanding on beat hits."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.8, kw=kw)
    sub = float(kw.get("_sub", p))
    amp = float(kw.get("amp", 22.0)) * (0.35 + 0.85 * max(p, sub))
    if amp < 0.5:
        return frame
    h, w = frame.shape[:2]
    r_norm, theta, _, cx, cy = _polar_grid(h, w)
    phase = (t / max(beat_dur, 0.05)) % 1.0
    r_front = phase * 1.5
    env = np.exp(-((r_norm - r_front) / 0.18) ** 2) * (1.0 - phase * 0.7)
    dr = amp * np.sin((r_norm - r_front) * 26.0) * env
    gx, gy = _warp_grid(h, w)
    dx = (dr * np.cos(theta)).astype(np.float32)
    dy = (dr * np.sin(theta)).astype(np.float32)
    return cv2.remap(frame, gx + dx, gy + dy, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def slit_scan(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Wave displacement modulated by beat pulse."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.2, kw=kw)
    amp = float(kw.get("amp", 18.0)) * (0.35 + 0.75 * p)
    if amp < 0.6:
        return frame
    h, w = frame.shape[:2]
    gx, gy = _warp_grid(h, w)
    freq_y = float(kw.get("freq", 0.022))
    phase_t = t * 6.0
    dx = (amp * np.sin(gy * freq_y + phase_t)).astype(np.float32)
    dy = (amp * 0.45 * np.cos(gx * (freq_y * 1.2) - phase_t * 0.7)).astype(np.float32)
    return cv2.remap(frame, gx + dx, gy + dy, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def gravity_droop(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Vertical stretch warp driven by sub-bass."""
    p = _pulse(t, beat_dur, 1.0, sharp=4.0, kw=kw)
    if "_sub" in kw:
        p = max(p, float(kw["_sub"]))
    amp = float(kw.get("amp", 32.0)) * p
    if amp < 0.8:
        return frame
    h, w = frame.shape[:2]
    gx, gy = _warp_grid(h, w)
    gy_norm = gy / max(1.0, float(h))
    dy = (-amp * (gy_norm ** 2.2)).astype(np.float32)
    dx = (amp * 0.12 * np.sin(gy * 0.035)).astype(np.float32)
    return cv2.remap(frame, gx + dx, gy + dy, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def vortex_twirl(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Swirl twist around frame center decaying with radius."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    twist = float(kw.get("twist", 1.35)) * (0.25 + 0.85 * p)
    if abs(twist) < 0.05:
        return frame
    h, w = frame.shape[:2]
    r_norm, theta, r_px, cx, cy = _polar_grid(h, w)
    d_theta = twist * np.exp(-r_norm * 2.2)
    new_theta = theta + d_theta
    map_x = (cx + r_px * np.cos(new_theta)).astype(np.float32)
    map_y = (cy + r_px * np.sin(new_theta)).astype(np.float32)
    return cv2.remap(frame, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


MOTION_EFFECTS = {
    "zoom_pulse": {"fn": zoom_pulse, "label": "Zoom Pulse", "category": "motion"},
    "beat_bounce": {"fn": beat_bounce, "label": "Beat Shake", "category": "motion"},
    "liquid_warp": {"fn": liquid_warp, "label": "Liquid Warp", "category": "motion"},
    "pendulum_sway": {"fn": pendulum_sway, "label": "Pendulum Sway", "category": "motion"},
    "shockwave_ripple": {"fn": shockwave_ripple, "label": "Shockwave Ripple", "category": "motion"},
    "slit_scan": {"fn": slit_scan, "label": "Slit Scan", "category": "motion"},
    "gravity_droop": {"fn": gravity_droop, "label": "Gravity Droop", "category": "motion"},
    "vortex_twirl": {"fn": vortex_twirl, "label": "Vortex Twirl", "category": "motion"},
}
