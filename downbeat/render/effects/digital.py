"""Digital, glitch, and matrix effects for Downbeat."""
from __future__ import annotations

import cv2
import numpy as np

from ._common import _bayer_matrix, _led_grid, _pulse, _rgb_stripe


def bayer_dither(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """4x4 Bayer matrix dithering and bit-depth quantization."""
    p = _pulse(t, beat_dur, 2.0, sharp=4.5, kw=kw)
    levels = int(kw.get("levels", 6))
    spread = float(kw.get("spread", 36.0)) * (0.75 + 0.45 * p)
    mix = float(kw.get("mix", 0.65))
    h, w = frame.shape[:2]
    sh, sw = h // 2, w // 2
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA).astype(np.float32)
    bayer = _bayer_matrix(sh, sw)
    dithered = small + bayer * spread
    step = 255.0 / max(2, levels - 1)
    quant = np.round(np.clip(dithered, 0.0, 255.0) / step) * step
    up = cv2.resize(quant.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
    return cv2.addWeighted(frame, 1.0 - mix, up, mix, 0)


def edge_neon(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Sobel edge contours with neon tint."""
    p = _pulse(t, beat_dur, 1.0, sharp=5.0, kw=kw)
    air = float(kw.get("_air", p))
    strength = float(kw.get("strength", 0.65)) * (0.35 + 0.75 * max(p, air))
    if strength < 0.08:
        return frame
    h, w = frame.shape[:2]
    small = cv2.resize(frame, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_16S, 0, 1, ksize=3)
    mag = cv2.convertScaleAbs(cv2.addWeighted(np.abs(gx), 0.5, np.abs(gy), 0.5, 0))
    _, edges = cv2.threshold(mag, 55, 255, cv2.THRESH_TOZERO)
    neon = np.zeros_like(small)
    neon[..., 1] = (edges.astype(np.uint16) * 230 // 255).astype(np.uint8)  # G (mint)
    neon[..., 0] = edges  # B
    neon[..., 2] = np.roll(edges, 2, axis=1)  # R offset
    neon_up = cv2.resize(neon, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.addWeighted(frame, 1.0, neon_up, strength, 0)


def glitch(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Horizontal slice displacement on beat transients."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    if p < float(kw.get("trigger", 0.38)):
        return frame
    rng = np.random.default_rng(int(t * 7.5) * 104729 + 17)
    out = frame.copy()
    h, w = frame.shape[:2]
    n_slices = int(rng.integers(2, 6))
    for _ in range(n_slices):
        y0 = int(rng.integers(0, max(1, h - 40)))
        slice_h = int(rng.integers(12, 60))
        y1 = min(h, y0 + slice_h)
        dx = int(rng.integers(-28, 29))
        out[y0:y1] = np.roll(out[y0:y1], dx, axis=1)
    return out


def pixel_sort(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Luminance-thresholded vertical pixel smear."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.2, kw=kw)
    mix = float(kw.get("mix", 0.68)) * (0.55 + 0.45 * p)
    thresh = int(kw.get("threshold", 130))
    h, w = frame.shape[:2]
    sw, sh = max(8, w // 2), max(8, h // 2)
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
    luma = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    mask = luma > thresh
    out_small = small.copy()
    band_h = 32
    for y0 in range(0, sh, band_h):
        y1 = min(sh, y0 + band_h)
        sl_img = small[y0:y1]
        sl_mask = mask[y0:y1]
        if np.any(sl_mask):
            cum = np.maximum.accumulate(sl_img, axis=0)
            out_small[y0:y1] = np.where(sl_mask[..., None], cum, sl_img)
    up = cv2.resize(out_small, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.addWeighted(frame, 1.0 - mix, up, mix, 0)


def ascii_matrix(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Dot-matrix / LED grid overlay."""
    mix = float(kw.get("mix", 0.72))
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    h, w = frame.shape[:2]
    bs = 8
    bw, bh = max(1, w // bs), max(1, h // bs)
    small = cv2.resize(frame, (bw, bh), interpolation=cv2.INTER_AREA)
    blocks = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    led_mask = _led_grid(h, w)
    dot_frame = (blocks.astype(np.float32) * led_mask).astype(np.uint8)
    mint_tint = np.zeros_like(dot_frame)
    mint_tint[..., 0] = 50
    mint_tint[..., 1] = 120
    mint_tint[..., 2] = 20
    luma = cv2.cvtColor(dot_frame, cv2.COLOR_BGR2GRAY)[..., None] / 255.0
    tinted = cv2.add(dot_frame, (mint_tint * luma * (0.6 + 0.4 * p)).astype(np.uint8))
    return cv2.addWeighted(frame, 1.0 - mix, tinted, mix, 0)


def rgb_mosaic(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Block pixelation with RGB sub-pixel stripes."""
    block_size = int(kw.get("block_size", 12))
    p = _pulse(t, beat_dur, 1.0, sharp=3.5, kw=kw)
    bs = max(4, int(round(block_size * (0.6 + 0.8 * p))))
    h, w = frame.shape[:2]
    bw, bh = max(2, w // bs), max(2, h // bs)
    small = cv2.resize(frame, (bw, bh), interpolation=cv2.INTER_AREA)
    blocks = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    stripe = _rgb_stripe(w)
    striped = np.clip(blocks.astype(np.float32) * stripe, 0, 255).astype(np.uint8)
    mix = float(kw.get("mix", 0.75))
    return cv2.addWeighted(frame, 1.0 - mix, striped, mix, 0)


def vhs_tracking(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """VHS tape simulation with chroma bleed and tracking noise."""
    h, w = frame.shape[:2]
    ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
    y, cr, cb = cv2.split(ycrcb)
    sw = max(2, w // 4)
    cr_small = cv2.resize(cr, (sw, h), interpolation=cv2.INTER_AREA)
    cb_small = cv2.resize(cb, (sw, h), interpolation=cv2.INTER_AREA)
    cr_s = np.roll(cv2.resize(cr_small, (w, h), interpolation=cv2.INTER_LINEAR), 3, axis=1)
    cb_s = np.roll(cv2.resize(cb_small, (w, h), interpolation=cv2.INTER_LINEAR), 3, axis=1)
    out = cv2.cvtColor(cv2.merge([y, cr_s, cb_s]), cv2.COLOR_YCrCb2BGR)
    band_h = 28
    y_pos = int((t * 0.45) * h) % h
    y0, y1 = y_pos, min(h, y_pos + band_h)
    if y1 > y0:
        dx = int(14.0 * np.sin(t * 18.0))
        out[y0:y1] = np.roll(out[y0:y1], dx, axis=1)
        rng = np.random.default_rng(int(t * 30.0) * 10007 + y0)
        noise = rng.integers(-40, 41, (y1 - y0, w, 1), dtype=np.int16)
        out[y0:y1] = np.clip(out[y0:y1].astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return out


def datamosh_smear(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Macroblock displacement on beat transients."""
    p = _pulse(t, beat_dur, 1.0, sharp=4.0, kw=kw)
    if "_transient" in kw:
        p = max(p, float(kw["_transient"]))
    if p < 0.22:
        return frame
    h, w = frame.shape[:2]
    mb = 16
    out = frame.copy()
    rng = np.random.default_rng(int(t * 7.5) * 65537 + 19)
    nb_y, nb_x = h // mb, w // mb
    if nb_y < 1 or nb_x < 1:
        return frame
    num_displaced = int(nb_y * nb_x * (0.15 + 0.15 * p))
    for _ in range(num_displaced):
        by = int(rng.integers(0, nb_y))
        bx = int(rng.integers(0, nb_x))
        shift_x = int(rng.choice([-32, -16, 16, 32]))
        shift_y = int(rng.choice([-16, 0, 16]))
        src_by = np.clip(by + shift_y // mb, 0, nb_y - 1)
        src_bx = np.clip(bx + shift_x // mb, 0, nb_x - 1)
        y0, y1 = by * mb, (by + 1) * mb
        x0, x1 = bx * mb, (bx + 1) * mb
        sy0, sy1 = src_by * mb, (src_by + 1) * mb
        sx0, sx1 = src_bx * mb, (src_bx + 1) * mb
        block = frame[sy0:sy1, sx0:sx1]
        out[y0:y1, x0:x1] = (block // 32) * 32
    return out


DIGITAL_EFFECTS = {
    "bayer_dither": {"fn": bayer_dither, "label": "Bayer Dither", "category": "digital"},
    "edge_neon": {"fn": edge_neon, "label": "Cyber Contours", "category": "digital"},
    "glitch": {"fn": glitch, "label": "Slice Glitch", "category": "digital"},
    "pixel_sort": {"fn": pixel_sort, "label": "Pixel Sort", "category": "digital"},
    "ascii_matrix": {"fn": ascii_matrix, "label": "Cyber Matrix", "category": "digital"},
    "rgb_mosaic": {"fn": rgb_mosaic, "label": "RGB Mosaic", "category": "digital"},
    "vhs_tracking": {"fn": vhs_tracking, "label": "VHS Tracking", "category": "digital"},
    "datamosh_smear": {"fn": datamosh_smear, "label": "Datamosh Smear", "category": "digital"},
}
