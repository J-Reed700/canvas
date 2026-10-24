"""Shared caches, grids, and geometric helper functions for Downbeat shaders."""
from __future__ import annotations

import cv2
import numpy as np

from ..._cache import BoundedCache


def _bytes(value: object) -> int:
    if isinstance(value, np.ndarray):
        return value.nbytes
    if isinstance(value, (tuple, list)):
        return sum(_bytes(item) for item in value)
    return 0


# Editors can move between several delivery resolutions in one process.  These grids
# used to retain every size forever; each cache now coalesces concurrent construction
# and keeps a fixed number/weight of recent resolutions.
_VIGNETTE_CACHE = BoundedCache(4, max_bytes=64 << 20, weigh=_bytes)
_BAYER_CACHE = BoundedCache(4, max_bytes=64 << 20, weigh=_bytes)
_WARP_GRID_CACHE = BoundedCache(4, max_bytes=96 << 20, weigh=_bytes)
_POLAR_GRID_CACHE = BoundedCache(4, max_bytes=128 << 20, weigh=_bytes)
_TILT_CACHE = BoundedCache(16, max_bytes=16 << 20, weigh=_bytes)
_LED_GRID_CACHE = BoundedCache(4, max_bytes=64 << 20, weigh=_bytes)
_RGB_STRIPE_CACHE = BoundedCache(8, max_bytes=8 << 20, weigh=_bytes)
_HALFTONE_GRID_CACHE = BoundedCache(4, max_bytes=64 << 20, weigh=_bytes)
_DUOTONE_LUT_CACHE = BoundedCache(8, max_bytes=1 << 20, weigh=_bytes)
_CYBERPUNK_LUT_CACHE = BoundedCache(1, max_bytes=1 << 20, weigh=_bytes)
_GOLDEN_LUT_CACHE = BoundedCache(1, max_bytes=1 << 20, weigh=_bytes)
_EDGE_DIST_CACHE = BoundedCache(8, max_bytes=8 << 20, weigh=_bytes)

_BAYER_4X4 = (
    np.array(
        [
            [0, 8, 2, 10],
            [12, 4, 14, 6],
            [3, 11, 1, 9],
            [15, 7, 13, 5],
        ],
        dtype=np.float32,
    )
    / 16.0
    - 0.5
)


def zoom_in(
    frame: np.ndarray,
    *args: float,
    factor: float | None = None,
    cx: float = 0.5,
    cy: float = 0.5,
) -> np.ndarray:
    """Crop inner region and upscale to WxH. Supports (frame, cx, cy, factor) or (frame, factor)."""
    if len(args) == 3:
        cx, cy = float(args[0]), float(args[1])
        if factor is None:
            factor = float(args[2])
    elif len(args) == 1:
        if factor is None:
            factor = float(args[0])
    elif len(args) == 2:
        cx, cy = float(args[0]), float(args[1])

    if factor is None:
        factor = 1.0

    if factor <= 1.002:
        return frame
    h, w = frame.shape[:2]
    crop_w = max(16, min(w, int(round(w / factor))))
    crop_h = max(16, min(h, int(round(h / factor))))
    if crop_w >= w and crop_h >= h:
        return frame
    px = int(np.clip(cx, 0.15, 0.85) * w)
    py = int(np.clip(cy, 0.15, 0.85) * h)
    x0 = int(np.clip(px - crop_w // 2, 0, w - crop_w))
    y0 = int(np.clip(py - crop_h // 2, 0, h - crop_h))
    sub = frame[y0 : y0 + crop_h, x0 : x0 + crop_w]
    return cv2.resize(sub, (w, h), interpolation=cv2.INTER_LINEAR)


_zoom_in = zoom_in


def _pulse(
    t: float,
    beat_dur: float,
    period_beats: float = 1.0,
    sharp: float = 3.2,
    kw: dict | None = None,
) -> float:
    """Beat pulse envelope with audio-reactive drive."""
    sharp = min(float(sharp), 3.2)
    clock = 0.0
    if beat_dur > 0:
        phase = (t / beat_dur) % period_beats
        clock = float(np.exp(-sharp * phase))
    if kw is not None and "_sub" in kw:
        sub = float(kw.get("_sub", 0.0))
        trans = float(kw.get("_transient", 0.0))
        audio_drive = min(0.75, 0.55 * sub + 0.25 * trans)
        return 0.4 * clock + 0.6 * audio_drive
    return clock


def _vignette_radius(h: int, w: int) -> np.ndarray:
    key = (h, w)
    def create() -> np.ndarray:
        y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
        x = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
        return np.sqrt(x * x + y * y)
    return _VIGNETTE_CACHE.get_or_create(key, create)


def _bayer_matrix(h: int, w: int) -> np.ndarray:
    key = (h, w)
    def create() -> np.ndarray:
        reps_y = (h // 4) + 1
        reps_x = (w // 4) + 1
        tiled = np.tile(_BAYER_4X4, (reps_y, reps_x))[:h, :w]
        return tiled[:, :, None]
    return _BAYER_CACHE.get_or_create(key, create)


def coord_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    """Cached meshgrid coordinates for warping."""
    key = (h, w)
    def create() -> tuple[np.ndarray, np.ndarray]:
        x = np.arange(w, dtype=np.float32)[None, :]
        y = np.arange(h, dtype=np.float32)[:, None]
        return np.meshgrid(x, y)
    return _WARP_GRID_CACHE.get_or_create(key, create)


_warp_grid = coord_grid


def _polar_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float]:
    key = (h, w)
    def create() -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float]:
        gx, gy = _warp_grid(h, w)
        cx, cy = w * 0.5, h * 0.5
        rx = (gx - cx) / max(cx, 1.0)
        ry = (gy - cy) / max(cy, 1.0)
        r_norm = np.sqrt(rx * rx + ry * ry)
        theta = np.arctan2(gy - cy, gx - cx)
        r_px = np.sqrt((gx - cx) ** 2 + (gy - cy) ** 2)
        return r_norm, theta, r_px, cx, cy
    return _POLAR_GRID_CACHE.get_or_create(key, create)


def _led_grid(h: int, w: int) -> np.ndarray:
    key = (h, w)
    def create() -> np.ndarray:
        y, x = np.ogrid[:8, :8]
        dist = np.sqrt((x - 3.5) ** 2 + (y - 3.5) ** 2)
        dot = np.clip(1.0 - (dist - 1.8) / 1.8, 0.20, 1.0).astype(np.float32)
        reps_y = (h // 8) + 1
        reps_x = (w // 8) + 1
        return np.tile(dot, (reps_y, reps_x))[:h, :w, None]
    return _LED_GRID_CACHE.get_or_create(key, create)


def _rgb_stripe(w: int) -> np.ndarray:
    def create() -> np.ndarray:
        pattern = np.ones((1, w, 3), dtype=np.float32)
        cols = np.arange(w) % 3
        pattern[0, cols == 0] = [1.25, 0.82, 0.82]  # Blue pass
        pattern[0, cols == 1] = [0.82, 1.25, 0.82]  # Green pass
        pattern[0, cols == 2] = [0.82, 0.82, 1.25]  # Red pass
        return pattern
    return _RGB_STRIPE_CACHE.get_or_create(w, create)


def _halftone_grid(h: int, w: int) -> np.ndarray:
    key = (h, w)
    def create() -> np.ndarray:
        gx, gy = _warp_grid(h, w)
        freq = 0.52
        return ((np.sin(gx * freq) * np.sin(gy * freq) + 1.0) * 0.5).astype(np.float32)
    return _HALFTONE_GRID_CACHE.get_or_create(key, create)


def _edge_dist(h: int, w: int) -> np.ndarray:
    key = (h, w)
    def create() -> np.ndarray:
        x = np.arange(w, dtype=np.float32)[None, :]
        d_left = x / max(1.0, float(w))
        d_right = (w - 1.0 - x) / max(1.0, float(w))
        return np.minimum(d_left, d_right) * 2.0
    return _EDGE_DIST_CACHE.get_or_create(key, create)


def _duotone_lut(palette: str) -> np.ndarray:
    def create() -> np.ndarray:
        # BGR (dark, light)
        palettes = {
            "cyber": (np.array([160, 20, 110], dtype=np.float32), np.array([190, 255, 120], dtype=np.float32)),
            "infrared": (np.array([20, 10, 180], dtype=np.float32), np.array([30, 210, 255], dtype=np.float32)),
            "acid": (np.array([180, 50, 10], dtype=np.float32), np.array([40, 255, 160], dtype=np.float32)),
            "vapor": (np.array([140, 15, 90], dtype=np.float32), np.array([255, 235, 25], dtype=np.float32)),
        }
        c_dark, c_light = palettes.get(palette, palettes["cyber"])
        t = np.linspace(0.0, 1.0, 256, dtype=np.float32)[:, None]
        lut = (1.0 - t) * c_dark[None, :] + t * c_light[None, :]
        return lut.clip(0, 255).astype(np.uint8)[None, :, :]
    return _DUOTONE_LUT_CACHE.get_or_create(palette, create)


def _cyberpunk_lut() -> np.ndarray:
    def create() -> np.ndarray:
        x = np.linspace(0.0, 1.0, 256, dtype=np.float32)
        s = np.clip(1.0 - x * 2.0, 0.0, 1.0)
        h = np.clip(x * 2.0 - 1.0, 0.0, 1.0)
        i = np.arange(256, dtype=np.float32)
        b = np.clip(i + 34.0 * s + 32.0 * h, 0, 255)
        g = np.clip(i - 18.0 * s + 35.0 * h, 0, 255)
        r = np.clip(i + 36.0 * s - 28.0 * h, 0, 255)
        return np.stack([b, g, r], axis=1).astype(np.uint8)[None, :, :]
    return _CYBERPUNK_LUT_CACHE.get_or_create(0, create)


def _golden_lut() -> np.ndarray:
    def create() -> np.ndarray:
        x = np.linspace(0.0, 1.0, 256, dtype=np.float32)
        s = np.clip(1.0 - x * 2.0, 0.0, 1.0)
        h = np.clip(x * 2.0 - 1.0, 0.0, 1.0)
        mid = np.sin(x * np.pi)
        i = np.arange(256, dtype=np.float32)
        b = np.clip(i + 8.0 * s - 14.0 * mid - 18.0 * h, 0, 255)
        g = np.clip(i + 8.0 * mid + 6.0 * h, 0, 255)
        r = np.clip(i - 4.0 * s + 18.0 * mid + 20.0 * h, 0, 255)
        return np.stack([b, g, r], axis=1).astype(np.uint8)[None, :, :]
    return _GOLDEN_LUT_CACHE.get_or_create(0, create)
