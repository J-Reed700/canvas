"""Video transition blenders for timeline compositing."""
from __future__ import annotations

from collections.abc import Callable

import cv2
import numpy as np

from .effects import coord_grid, zoom_in

ALL_TRANSITIONS = [
    "datamosh",
    "luma",
    "flash",
    "whip",
    "whip_horiz",
    "glitch",
    "zoom_punch",
    "spin_vortex",
    "prism_split",
    "pixelate",
    "iris_wipe",
    "burn_luma",
    "shutter_slice",
    "kaleido_twist",
]


def _transition_datamosh(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    # Farneback flow at 1/4 scale for datamosh smear
    h, w = frame_a.shape[:2]
    sh, sw = max(16, h // 4), max(16, w // 4)
    ga = cv2.cvtColor(cv2.resize(frame_a, (sw, sh)), cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(cv2.resize(frame_b, (sw, sh)), cv2.COLOR_BGR2GRAY)
    flow_small = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 2, 13, 2, 5, 1.1, 0)
    flow = cv2.resize(flow_small, (w, h), interpolation=cv2.INTER_LINEAR)
    gx, gy = coord_grid(h, w)
    surge = 4.2 * (1.0 - abs(alpha - 0.5) * 1.6)
    warped_a = cv2.remap(
        frame_a,
        gx - flow[..., 0] * surge * alpha,
        gy - flow[..., 1] * surge * alpha,
        interpolation=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_REPLICATE,
    )
    bh, bw = max(1, h // 24), max(1, w // 24)
    rng = np.random.default_rng(int(alpha * 500) + 99)
    block_mask = (rng.random((bh, bw, 1)) < (alpha ** 1.2)).astype(np.uint8)
    mask_full = cv2.resize(block_mask, (w, h), interpolation=cv2.INTER_NEAREST)
    return np.where(mask_full[..., None] > 0, frame_b, warped_a)


def _transition_whip(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    h, w = frame_a.shape[:2]
    offset = int(round((1.0 - alpha) * h))
    stacked = np.vstack([frame_b, frame_a])
    out = stacked[offset : offset + h, :]
    blur_k = int(round(45 * (1.0 - abs(alpha - 0.5) * 2.0))) | 1
    if blur_k >= 3:
        out = cv2.GaussianBlur(out, (1, blur_k), 0)
    return out


def _transition_whip_horiz(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    h, w = frame_a.shape[:2]
    offset = int(round((1.0 - alpha) * w))
    stacked = np.hstack([frame_b, frame_a])
    out = stacked[:, offset : offset + w]
    blur_k = int(round(45 * (1.0 - abs(alpha - 0.5) * 2.0))) | 1
    if blur_k >= 3:
        out = cv2.GaussianBlur(out, (blur_k, 1), 0)
    return out


def _transition_luma(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    luma = frame_b.mean(axis=2, keepdims=True) / 255.0
    mask = np.clip((luma - (1.0 - alpha * 1.45)) * 3.2, 0.0, 1.0).astype(np.float32)
    return (frame_a.astype(np.float32) * (1.0 - mask) + frame_b.astype(np.float32) * mask).astype(np.uint8)


def _transition_glitch(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    h, w = frame_a.shape[:2]
    smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
    base = cv2.addWeighted(frame_a, 1.0 - smooth_alpha, frame_b, smooth_alpha, 0)
    out = base.copy()
    # Fixed seed prevents 30Hz flicker
    rng = np.random.default_rng(41)
    mid_surge = float(max(0.0, 1.0 - abs(alpha - 0.5) * 2.0))
    for _ in range(8):
        y0 = int(rng.integers(0, max(1, h - 80)))
        y1 = min(h, y0 + int(rng.integers(25, 110)))
        max_dx = int(rng.integers(-90, 91))
        dx = int(round(max_dx * mid_surge))
        if dx != 0:
            out[y0:y1] = np.roll(out[y0:y1], dx, axis=1)
    return out


def _transition_zoom_punch(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    za = zoom_in(frame_a, 1.0 + 0.85 * alpha)
    zb = zoom_in(frame_b, 1.45 - 0.45 * alpha)
    smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
    return cv2.addWeighted(za, 1.0 - smooth_alpha, zb, smooth_alpha, 0)


def _transition_spin_vortex(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    h, w = frame_a.shape[:2]
    center = (w / 2.0, h / 2.0)
    scale = 1.0 + 0.35 * float(np.sin(alpha * np.pi))
    M_a = cv2.getRotationMatrix2D(center, float(alpha * 180.0), scale)
    rot_a = cv2.warpAffine(frame_a, M_a, (w, h), borderMode=cv2.BORDER_REFLECT_101)
    M_b = cv2.getRotationMatrix2D(center, float((alpha - 1.0) * 180.0), scale)
    rot_b = cv2.warpAffine(frame_b, M_b, (w, h), borderMode=cv2.BORDER_REFLECT_101)
    smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
    return cv2.addWeighted(rot_a, 1.0 - smooth_alpha, rot_b, smooth_alpha, 0)


def _transition_prism_split(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    alpha_b = float(np.clip(alpha * 1.4, 0.0, 1.0))
    alpha_g = float(alpha)
    alpha_r = float(np.clip((alpha - 0.25) * 1.35, 0.0, 1.0))
    roll_shift = int(round(float(np.sin(alpha * np.pi)) * 28.0))

    b_ch = (frame_a[..., 0].astype(np.float32) * (1.0 - alpha_b) + frame_b[..., 0].astype(np.float32) * alpha_b).astype(np.uint8)
    g_ch = (frame_a[..., 1].astype(np.float32) * (1.0 - alpha_g) + frame_b[..., 1].astype(np.float32) * alpha_g).astype(np.uint8)
    r_ch = (frame_a[..., 2].astype(np.float32) * (1.0 - alpha_r) + frame_b[..., 2].astype(np.float32) * alpha_r).astype(np.uint8)

    if roll_shift != 0:
        b_ch = np.roll(b_ch, roll_shift, axis=1)
        r_ch = np.roll(r_ch, -roll_shift, axis=1)
    return cv2.merge([b_ch, g_ch, r_ch])


def _transition_pixelate(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    h, w = frame_a.shape[:2]
    block = max(1, int(round(42.0 * float(np.sin(alpha * np.pi)))))
    smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
    if block <= 1:
        return cv2.addWeighted(frame_a, 1.0 - smooth_alpha, frame_b, smooth_alpha, 0)
    sw = max(1, w // block)
    sh = max(1, h // block)
    pix_a = cv2.resize(cv2.resize(frame_a, (sw, sh), interpolation=cv2.INTER_LINEAR), (w, h), interpolation=cv2.INTER_NEAREST)
    pix_b = cv2.resize(cv2.resize(frame_b, (sw, sh), interpolation=cv2.INTER_LINEAR), (w, h), interpolation=cv2.INTER_NEAREST)
    return cv2.addWeighted(pix_a, 1.0 - smooth_alpha, pix_b, smooth_alpha, 0)


def _transition_iris_wipe(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    h, w = frame_a.shape[:2]
    y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    x = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    d = np.sqrt(x * x + y * y)
    mask = np.clip((alpha * 1.45 - d) * 4.0, 0.0, 1.0)[..., None]
    return (frame_a.astype(np.float32) * (1.0 - mask) + frame_b.astype(np.float32) * mask).astype(np.uint8)


def _transition_burn_luma(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    luma = frame_b.mean(axis=2, keepdims=True) / 255.0
    mask = np.clip((luma - (1.0 - alpha * 1.45)) * 3.2, 0.0, 1.0).astype(np.float32)
    base = frame_a.astype(np.float32) * (1.0 - mask) + frame_b.astype(np.float32) * mask
    base_luma = base.mean(axis=2, keepdims=True) / 255.0
    mid_bell = float(np.sin(alpha * np.pi))
    mid_mask = 4.0 * base_luma * np.maximum(0.0, 1.0 - base_luma)
    glow_boost = 32.0 * mid_bell * mid_mask
    base[..., 0] += glow_boost[..., 0] * 0.15
    base[..., 1] += glow_boost[..., 0] * 0.45
    base[..., 2] += glow_boost[..., 0] * 1.00
    return np.clip(base, 0, 255).astype(np.uint8)


def _transition_shutter_slice(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    h, w = frame_a.shape[:2]
    out = frame_a.copy()
    num_bands = 10
    band_h = h // num_bands
    for k in range(num_bands):
        y0 = k * band_h
        y1 = (k + 1) * band_h if k < num_bands - 1 else h
        phase_alpha = float(np.clip((alpha - (k / num_bands) * 0.35) / 0.65, 0.0, 1.0))
        cutoff = int(round(phase_alpha * w))
        if cutoff > 0:
            out[y0:y1, :cutoff] = frame_b[y0:y1, :cutoff]
    return out


def _transition_kaleido_twist(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
    base = cv2.addWeighted(frame_a, 1.0 - smooth_alpha, frame_b, smooth_alpha, 0)
    mid = float(np.sin(alpha * np.pi))
    if mid < 0.02:
        return base
    zoomed = zoom_in(base, 1.0 + 0.25 * mid)
    h, w = zoomed.shape[:2]
    hw, hh = w // 2, h // 2
    kframe = zoomed.copy()
    kframe[:, w - hw :] = kframe[:, :hw][:, ::-1]
    kframe[h - hh :, :] = kframe[:hh, :][::-1, :]
    blend_amt = min(0.85, 0.85 * mid)
    return cv2.addWeighted(base, 1.0 - blend_amt, kframe, blend_amt, 0)


def _transition_dissolve(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
    base = cv2.addWeighted(frame_a, 1.0 - smooth_alpha, frame_b, smooth_alpha, 0)
    mid_bell = max(0.0, 1.0 - abs(alpha - 0.5) * 2.0)
    cushion = int(round(10 * (mid_bell ** 2)))
    if cushion > 0:
        base = cv2.add(base, (int(round(cushion * 0.6)), int(round(cushion * 0.8)), cushion, 0))
    return base


def _transition_flash(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    return _transition_dissolve(frame_a, frame_b, alpha)


TRANSITION_HANDLERS: dict[str, Callable[[np.ndarray, np.ndarray, float], np.ndarray]] = {
    "datamosh": _transition_datamosh,
    "whip": _transition_whip,
    "whip_horiz": _transition_whip_horiz,
    "luma": _transition_luma,
    "glitch": _transition_glitch,
    "zoom_punch": _transition_zoom_punch,
    "spin_vortex": _transition_spin_vortex,
    "prism_split": _transition_prism_split,
    "pixelate": _transition_pixelate,
    "iris_wipe": _transition_iris_wipe,
    "burn_luma": _transition_burn_luma,
    "shutter_slice": _transition_shutter_slice,
    "kaleido_twist": _transition_kaleido_twist,
    "flash": _transition_flash,
    "dissolve": _transition_dissolve,
}


def _blend_transition(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
    mode: str,
) -> np.ndarray:
    """Blend outgoing clip `frame_a` -> incoming clip `frame_b` over alpha in [0, 1].

    Supports 14 distinct transitions + dissolve alias:
      - datamosh, whip, whip_horiz, luma, glitch, zoom_punch, spin_vortex,
        prism_split, pixelate, iris_wipe, burn_luma, shutter_slice,
        kaleido_twist, flash / dissolve.
    """
    alpha = float(np.clip(alpha, 0.0, 1.0))
    handler = TRANSITION_HANDLERS.get(mode, _transition_dissolve)
    return handler(frame_a, frame_b, alpha)
