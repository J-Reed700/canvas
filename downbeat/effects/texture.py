"""Texture, grain, and physical film artifact shaders for Downbeat."""
from __future__ import annotations

import cv2
import numpy as np

from ._common import _edge_dist, _halftone_grid, _pulse, _vignette_radius


def vignette(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Radial vignette breathing with the beat."""
    h, w = frame.shape[:2]
    d = _vignette_radius(h, w)
    strength = float(kw.get("strength", 0.55)) + 0.18 * _pulse(t, beat_dur, 2.0, sharp=3.0, kw=kw)
    mask = np.clip(1.0 - strength * np.maximum(0.0, d - 0.52) / 0.55, 0.12, 1.0)
    return (frame.astype(np.float32) * mask[..., None]).astype(np.uint8)


def scanlines(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """CRT scanlines with vertical roll."""
    gap = int(kw.get("gap", 4))
    darken = float(kw.get("darken", 0.74))
    offset = int(t * 24) % gap
    out = frame.copy()
    out[offset::gap, :] = (out[offset::gap, :].astype(np.float32) * darken).astype(np.uint8)
    return out


def grain(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Tiled 35mm film grain."""
    rng = np.random.default_rng(int(t * 30) * 7919 + 3)
    amt = int(kw.get("amount", 14))
    h, w = frame.shape[:2]
    nh, nw = h // 2, w // 2
    small_noise = rng.integers(-amt, amt + 1, (nh, nw, 1), dtype=np.int16)
    noise = np.repeat(np.repeat(small_noise, 2, axis=0), 2, axis=1)[:h, :w]
    return np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def letterbox(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Letterbox bars pulsed to the beat."""
    h = frame.shape[0]
    p = _pulse(t, beat_dur, 2.0, sharp=4.0, kw=kw)
    frac = float(kw.get("frac", 0.06)) + 0.015 * p
    bar = int(h * frac)
    if bar <= 0:
        return frame
    out = frame.copy()
    out[:bar] = 0
    out[-bar:] = 0
    return out


def film_burn(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Film light leak along frame edges."""
    p = _pulse(t, beat_dur, 2.0, sharp=3.0, kw=kw)
    h, w = frame.shape[:2]
    edge_d = _edge_dist(h, w)
    gy = np.arange(h, dtype=np.float32)[:, None]
    wave = np.sin(t * 2.2 + gy * 0.02)
    leak = np.clip(1.0 - edge_d * 2.5 + 0.35 * wave, 0.0, 1.0)[..., None]
    color = np.array([25, 115, 255], dtype=np.float32)
    strength = float(kw.get("strength", 0.65)) * (0.6 + 0.4 * p)
    glow = (leak * color * strength).astype(np.float32)
    f = frame.astype(np.float32)
    out = 255.0 - (255.0 - f) * (255.0 - glow) / 255.0
    return np.clip(out, 0, 255).astype(np.uint8)


def halftone_dots(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Halftone dot screen pattern."""
    h, w = frame.shape[:2]
    dot_grid = _halftone_grid(h, w)
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    dots = np.where(dot_grid < (1.0 - luma), 0, 255).astype(np.uint8)
    dots_3ch = cv2.merge([dots, dots, dots])
    mix = float(kw.get("mix", 0.65))
    return cv2.addWeighted(frame, 1.0 - mix, dots_3ch, mix, 0)


def frost_mist(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Diffusion mist filter with lifted blacks."""
    strength = float(kw.get("strength", 0.42))
    h, w = frame.shape[:2]
    sw, sh = max(8, w // 4), max(8, h // 4)
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
    blurred = cv2.GaussianBlur(small, (35, 35), 0)
    bloom = cv2.resize(blurred, (w, h), interpolation=cv2.INTER_LINEAR)
    milky = cv2.add(frame, (10, 10, 10, 0))
    return cv2.addWeighted(milky, 1.0 - strength * 0.5, bloom, strength, 0)


TEXTURE_EFFECTS = {
    "vignette": {"fn": vignette, "label": "Vignette", "category": "texture"},
    "scanlines": {"fn": scanlines, "label": "CRT Scanlines", "category": "texture"},
    "grain": {"fn": grain, "label": "35mm Grain", "category": "texture"},
    "letterbox": {"fn": letterbox, "label": "Cinema Bars", "category": "texture"},
    "film_burn": {"fn": film_burn, "label": "Film Burn", "category": "texture"},
    "halftone_dots": {"fn": halftone_dots, "label": "Halftone Dots", "category": "texture"},
    "frost_mist": {"fn": frost_mist, "label": "Frost Mist", "category": "texture"},
}
