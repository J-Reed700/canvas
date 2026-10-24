"""Optics, lens distortion, and bloom shaders for Downbeat."""
from __future__ import annotations

import cv2
import numpy as np

from ._common import _TILT_CACHE, _pulse, _warp_grid, _zoom_in


def prism_echo(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Additive ghost layer expanding on each beat."""
    p = _pulse(t, beat_dur, 1.0, sharp=2.5, kw=kw)
    base_strength = min(float(kw.get("strength", 0.22)), 0.25)
    strength = base_strength * (0.5 + 0.5 * p)
    expand = min(float(kw.get("expand", 0.10)), 0.12)
    zoom_amt = 1.08 + expand * (1.0 - p)
    ghost = _zoom_in(frame, 0.5, 0.5, zoom_amt)
    ghost_shifted = np.empty_like(ghost)
    ghost_shifted[..., 0] = np.roll(ghost[..., 0], 4, axis=1)
    ghost_shifted[..., 1] = ghost[..., 1]
    ghost_shifted[..., 2] = np.roll(ghost[..., 2], -4, axis=1)
    return cv2.addWeighted(frame, 1.0, ghost_shifted, strength, 0)


def neon_bloom(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Highlight bloom via blurred screen-blend."""
    p = _pulse(t, beat_dur, 1.0, sharp=2.5, kw=kw)
    base_intensity = min(float(kw.get("intensity", 0.35)), 0.38)
    intensity = base_intensity * (0.85 + 0.15 * p)
    h, w = frame.shape[:2]
    small = cv2.resize(frame, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    bright = np.clip((small.astype(np.int16) - int(kw.get("threshold", 110))) * 2, 0, 255).astype(np.uint8)
    blurred = cv2.GaussianBlur(bright, (25, 25), 0)
    glow = cv2.resize(blurred, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.addWeighted(frame, 1.0, glow, intensity, 0)


def crt_halation(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Warm red-orange aura bleed around bright highlights."""
    p = _pulse(t, beat_dur, 1.0, sharp=2.5, kw=kw)
    base_strength = min(float(kw.get("strength", 0.35)), 0.38)
    strength = base_strength * (0.85 + 0.15 * p)
    h, w = frame.shape[:2]
    small = cv2.resize(frame, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    luma = small.max(axis=2)
    mask = np.clip((luma.astype(np.int16) - 130) * 2.0, 0, 255).astype(np.uint8)
    blur = cv2.GaussianBlur(mask, (31, 31), 0)
    halo_small = np.zeros_like(small)
    halo_small[..., 2] = blur
    halo_small[..., 1] = (blur.astype(np.uint16) * 98 // 255).astype(np.uint8)
    halo_small[..., 0] = (blur.astype(np.uint16) * 32 // 255).astype(np.uint8)
    halo = cv2.resize(halo_small, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.addWeighted(frame, 1.0, halo, strength, 0)


def chroma_pulse(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """RGB chromatic aberration split."""
    max_shift = float(kw.get("max_shift", 18.0))
    p = _pulse(t, beat_dur, 1.0, sharp=5.0, kw=kw)
    shift = int(round(max_shift * (0.2 + 0.8 * p)))
    if shift <= 0:
        return frame
    base = _zoom_in(frame, 0.5, 0.5, 1.05)
    out = base.copy()
    out[..., 0] = np.roll(base[..., 0], shift, axis=1)
    out[..., 2] = np.roll(base[..., 2], -shift, axis=1)
    if shift > 4:
        out[..., 1] = np.roll(base[..., 1], shift // 3, axis=0)
    return out


def anamorphic_flare(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Horizontal anamorphic flares on bright highlights."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    strength = float(kw.get("strength", 0.52)) * (0.65 + 0.45 * p)
    h, w = frame.shape[:2]
    sw, sh = max(8, w // 4), max(8, h // 4)
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
    luma = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    thresh = int(kw.get("threshold", 160))
    bright = np.clip((luma.astype(np.int16) - thresh) * 3, 0, 255).astype(np.uint8)
    blurred = cv2.GaussianBlur(bright, (65, 3), 0)
    streak = np.empty((sh, sw, 3), dtype=np.uint8)
    streak[..., 0] = blurred
    streak[..., 1] = (blurred.astype(np.uint16) * 190 // 255).astype(np.uint8)
    streak[..., 2] = (blurred.astype(np.uint16) * 70 // 255).astype(np.uint8)
    streak_up = cv2.resize(streak, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.addWeighted(frame, 1.0, streak_up, strength, 0)


def star_glint(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Four-point star filter diffraction spikes on highlights."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.5, kw=kw)
    if "_transient" in kw:
        p = max(p, float(kw["_transient"]))
    strength = float(kw.get("strength", 0.45)) * (0.55 + 0.65 * p)
    h, w = frame.shape[:2]
    sw, sh = max(8, w // 4), max(8, h // 4)
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
    luma = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    thresh = int(kw.get("threshold", 180))
    bright = np.clip((luma.astype(np.int16) - thresh) * 4, 0, 255).astype(np.uint8)
    h_blur = cv2.GaussianBlur(bright, (45, 1), 0)
    v_blur = cv2.GaussianBlur(bright, (1, 45), 0)
    star = cv2.addWeighted(h_blur, 0.5, v_blur, 0.5, 0)
    star_bgr = np.empty((sh, sw, 3), dtype=np.uint8)
    star_bgr[..., 0] = (star.astype(np.uint16) * 220 // 255).astype(np.uint8)
    star_bgr[..., 1] = (star.astype(np.uint16) * 240 // 255).astype(np.uint8)
    star_bgr[..., 2] = star
    star_up = cv2.resize(star_bgr, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.addWeighted(frame, 1.0, star_up, strength, 0)


def tilt_shift(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Tilt-shift blur with horizontal focal band."""
    cy = float(kw.get("cy", 0.5))
    focus_h = float(kw.get("focus_height", 0.22))
    h, w = frame.shape[:2]
    sw, sh = max(8, w // 2), max(8, h // 2)
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
    blur_small = cv2.GaussianBlur(small, (25, 25), 0)
    blurred = cv2.resize(blur_small, (w, h), interpolation=cv2.INTER_LINEAR)
    key = (h, round(cy, 2), round(focus_h, 2))

    def build_mask() -> np.ndarray:
        y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None, None]
        cy_norm = cy * 2.0 - 1.0
        return np.clip((np.abs(y - cy_norm) - focus_h) / 0.38, 0.0, 1.0)

    mask = _TILT_CACHE.get_or_create(key, build_mask)
    out = frame.astype(np.float32) * (1.0 - mask) + blurred.astype(np.float32) * mask
    return np.clip(out, 0, 255).astype(np.uint8)


def fisheye_lens(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Barrel distortion wide-angle lens."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.2, kw=kw)
    k = float(kw.get("k", 0.32)) * (0.65 + 0.45 * p)
    h, w = frame.shape[:2]
    gx, gy = _warp_grid(h, w)
    cx, cy = w * 0.5, h * 0.5
    nx = (gx - cx) / max(cx, 1.0)
    ny = (gy - cy) / max(cy, 1.0)
    r2 = nx * nx + ny * ny
    factor = 1.0 + k * r2
    scale = 1.0 / (1.0 + k * 0.5)
    map_x = (cx + nx * factor * scale * cx).astype(np.float32)
    map_y = (cy + ny * factor * scale * cy).astype(np.float32)
    return cv2.remap(frame, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def radial_zoom_blur(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Multi-tap radial zoom blur triggered by transients."""
    p = _pulse(t, beat_dur, 1.0, sharp=4.5, kw=kw)
    if "_transient" in kw:
        p = max(p, float(kw["_transient"]))
    if p < 0.04:
        return frame
    zoom_factors = [
        1.0 + 0.02 * p,
        1.0 + 0.05 * p,
        1.0 + 0.09 * p,
        1.0 + 0.14 * p,
    ]
    accum = frame.astype(np.float32)
    for z in zoom_factors:
        zoomed = _zoom_in(frame, 0.5, 0.5, z)
        accum += zoomed.astype(np.float32)
    avg = accum / (1.0 + len(zoom_factors))
    mix = min(0.85, 0.75 * p)
    return cv2.addWeighted(frame, 1.0 - mix, avg.astype(np.uint8), mix, 0)


def double_vision(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Dual chromatic ghost separation expanding on beat hits."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    if p < 0.03:
        return frame
    offset = int(round(float(kw.get("offset", 22.0)) * (0.2 + 0.8 * p)))
    if offset <= 0:
        return frame
    ghost_r = np.roll(frame, offset, axis=1)
    ghost_l = np.roll(frame, -offset, axis=1)
    ghost_r = cv2.add(ghost_r, (25, 10, -10, 0))
    ghost_l = cv2.add(ghost_l, (-10, 5, 25, 0))
    blend = min(0.45, 0.38 * p)
    combined = cv2.addWeighted(ghost_r, 0.5, ghost_l, 0.5, 0)
    return cv2.addWeighted(frame, 1.0 - blend, combined, blend, 0)


OPTICS_EFFECTS = {
    "prism_echo": {"fn": prism_echo, "label": "Prism Echo", "category": "optics"},
    "neon_bloom": {"fn": neon_bloom, "label": "Neon Bloom", "category": "optics"},
    "crt_halation": {"fn": crt_halation, "label": "CRT Halation", "category": "optics"},
    "chroma_pulse": {"fn": chroma_pulse, "label": "Chroma Split", "category": "optics"},
    "anamorphic_flare": {"fn": anamorphic_flare, "label": "Anamorphic Flare", "category": "optics"},
    "star_glint": {"fn": star_glint, "label": "Star Glint", "category": "optics"},
    "tilt_shift": {"fn": tilt_shift, "label": "Tilt Shift", "category": "optics"},
    "fisheye_lens": {"fn": fisheye_lens, "label": "Fisheye Lens", "category": "optics"},
    "radial_zoom_blur": {"fn": radial_zoom_blur, "label": "Zoom Blur", "category": "optics"},
    "double_vision": {"fn": double_vision, "label": "Double Vision", "category": "optics"},
}
