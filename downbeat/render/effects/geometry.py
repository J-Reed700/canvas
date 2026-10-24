"""Geometry and kaleidoscope shaders for Downbeat."""
from __future__ import annotations

import cv2
import numpy as np

from ._common import _polar_grid, _pulse


def mirror_quad(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Symmetrical mirror or 4-way kaleidoscope."""
    mode = kw.get("mode", "quad")
    beat_toggle = bool(kw.get("beat_toggle", False))
    if beat_toggle:
        bar_idx = int((t / max(beat_dur, 0.01)) // 2)
        if bar_idx % 2 == 1:
            mode = "horiz" if mode == "quad" else "quad"

    h, w = frame.shape[:2]
    out = frame.copy()
    hw, hh = w // 2, h // 2
    out[:, w - hw :] = out[:, :hw][:, ::-1]
    if mode == "quad":
        out[h - hh :, :] = out[:hh, :][::-1, :]
    return out


def kaleido_hex(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Radial polar kaleidoscope symmetry."""
    slices = int(kw.get("slices", 6))
    rot_speed = float(kw.get("rot_speed", 0.45))
    p = _pulse(t, beat_dur, 1.0, sharp=4.0, kw=kw)
    h, w = frame.shape[:2]
    _, theta, r_px, cx, cy = _polar_grid(h, w)
    sector = 2.0 * np.pi / max(3, slices)
    rot = t * rot_speed + 0.25 * p
    theta_rot = np.mod(theta + rot, 2.0 * np.pi)
    rel = np.mod(theta_rot, sector)
    rel_folded = np.where(rel > sector * 0.5, sector - rel, rel)
    map_x = (cx + r_px * np.cos(rel_folded)).astype(np.float32)
    map_y = (cy + r_px * np.sin(rel_folded)).astype(np.float32)
    return cv2.remap(frame, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def grid_clone(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Tiled video grid with alternating tint shifts."""
    grid = int(kw.get("grid", 2))
    p = _pulse(t, beat_dur, 1.0, sharp=3.5, kw=kw)
    h, w = frame.shape[:2]
    tw, th = max(1, (w + grid - 1) // grid), max(1, (h + grid - 1) // grid)
    small = cv2.resize(frame, (tw, th), interpolation=cv2.INTER_LINEAR)
    tiled = np.tile(small, (grid, grid, 1))[:h, :w].copy()
    if p > 0.15:
        shift = int(round(35.0 * p))
        for r in range(grid):
            for c in range(grid):
                if (r + c) % 2 == 1:
                    y0, y1 = r * th, min(h, (r + 1) * th)
                    x0, x1 = c * tw, min(w, (c + 1) * tw)
                    tile = tiled[y0:y1, x0:x1].astype(np.int16)
                    tile[..., 0] = np.clip(tile[..., 0] + shift, 0, 255)
                    tile[..., 2] = np.clip(tile[..., 2] - shift // 2, 0, 255)
                    tiled[y0:y1, x0:x1] = tile.astype(np.uint8)
    return tiled


def fractal_tunnel(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Recursive picture-in-picture zoom tunnel."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    h, w = frame.shape[:2]
    out = frame.copy()
    scales = [0.68 + 0.05 * p, 0.44 + 0.04 * p]
    for scale in scales:
        sw, sh = int(w * scale), int(h * scale)
        if sw < 16 or sh < 16:
            continue
        small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_LINEAR)
        x0 = (w - sw) // 2
        y0 = (h - sh) // 2
        roi = out[y0 : y0 + sh, x0 : x0 + sw].astype(np.float32)
        s = small.astype(np.float32)
        blended = roi * 0.35 + s * 0.65
        out[y0 : y0 + sh, x0 : x0 + sw] = blended.astype(np.uint8)
        border_b = int(240 * (0.6 + 0.4 * p))
        border_g = int(220 * (0.6 + 0.4 * p))
        border_r = int(100 * (0.6 + 0.4 * p))
        cv2.rectangle(
            out,
            (x0, y0),
            (x0 + sw - 1, y0 + sh - 1),
            (border_b, border_g, border_r),
            thickness=2,
        )
    return out


def ribbon_split(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Horizontal ribbon bands sliding in opposing directions."""
    p = _pulse(t, beat_dur, 1.0, sharp=4.0, kw=kw)
    amp = float(kw.get("amp", 26.0)) * p
    if amp < 1.0:
        return frame
    bands = int(kw.get("bands", 10))
    h, w = frame.shape[:2]
    band_h = max(2, h // bands)
    out = frame.copy()
    shift = int(round(amp))
    for b in range(bands):
        y0 = b * band_h
        y1 = min(h, (b + 1) * band_h) if b < bands - 1 else h
        dx = shift if (b % 2 == 0) else -shift
        out[y0:y1] = np.roll(out[y0:y1], dx, axis=1)
    return out


def polar_tunnel(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Polar coordinate warp tunnel blended with base frame."""
    p = _pulse(t, beat_dur, 1.0, sharp=2.5, kw=kw)
    base_mix = float(kw.get("mix", 0.65))
    mix = min(0.85, max(0.2, base_mix * (0.8 + 0.3 * p)))
    h, w = frame.shape[:2]
    center = (w * 0.5, h * 0.5)
    max_radius = float(np.hypot(center[0], center[1]))
    polar = cv2.warpPolar(
        frame,
        (w, h),
        center,
        max_radius,
        cv2.WARP_POLAR_LINEAR,
    )
    return cv2.addWeighted(frame, 1.0 - mix, polar, mix, 0)


GEOMETRY_EFFECTS = {
    "mirror_quad": {"fn": mirror_quad, "label": "Kaleido Mirror", "category": "geometry"},
    "kaleido_hex": {"fn": kaleido_hex, "label": "Hex Kaleido", "category": "geometry"},
    "grid_clone": {"fn": grid_clone, "label": "Grid Clone", "category": "geometry"},
    "fractal_tunnel": {"fn": fractal_tunnel, "label": "Fractal Tunnel", "category": "geometry"},
    "ribbon_split": {"fn": ribbon_split, "label": "Ribbon Split", "category": "geometry"},
    "polar_tunnel": {"fn": polar_tunnel, "label": "Polar Tunnel", "category": "geometry"},
}
