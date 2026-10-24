"""Color grading, palettes, and LUT shaders for Downbeat."""
from __future__ import annotations

import cv2
import numpy as np

from ._common import _cyberpunk_lut, _duotone_lut, _golden_lut, _pulse


def solarize_pulse(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Pastel tint shift on highlights."""
    period_beats = float(kw.get("period_beats", 4.0))
    p = _pulse(t, beat_dur, period_beats=period_beats, sharp=2.5, kw=kw)
    if p < 0.05:
        return frame
    blend = min(0.25, 0.25 * p)
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    mask = np.clip((luma.astype(np.float32) - 130.0) / 100.0, 0.0, 1.0)[..., None]
    tinted = frame.astype(np.float32).copy()
    tinted[..., 0] = np.clip(tinted[..., 0] * 1.12 + 12.0, 0, 255)  # B
    tinted[..., 1] = np.clip(tinted[..., 1] * 0.96, 0, 255)         # G
    tinted[..., 2] = np.clip(tinted[..., 2] * 1.10 + 16.0, 0, 255)  # R
    shifted = frame.astype(np.float32) * (1.0 - mask * blend) + tinted * (mask * blend)
    return np.clip(shifted, 0, 255).astype(np.uint8)


def hue_cycle(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """HSV hue rotation over the loop."""
    period = float(kw.get("period", 8.0))
    amount = float(kw.get("amount", 0.45))
    shift = int(((t / period) * 180.0 * amount) % 180)
    if shift == 0:
        return frame
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    hsv[..., 0] = (hsv[..., 0].astype(np.int16) + shift) % 180
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)


def color_grade(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Cinema contrast grade."""
    contrast = float(kw.get("contrast", 1.18))
    warm = float(kw.get("warm", 14.0))
    cool = float(kw.get("cool", -10.0))

    f = frame.astype(np.float32)
    f = (f - 118.0) * contrast + 122.0
    f[..., 0] += cool
    f[..., 2] += warm
    return np.clip(f, 0, 255).astype(np.uint8)


def duotone_acid(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Two-color gradient map based on luminance."""
    palette = str(kw.get("palette", "cyber")).lower()
    mix = float(kw.get("mix", 0.78))
    lut = _duotone_lut(palette)
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    duo = cv2.LUT(cv2.merge([luma, luma, luma]), lut)
    return cv2.addWeighted(frame, 1.0 - mix, duo, mix, 0)


def thermal_infrared(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Thermal false-color filter."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    mix = float(kw.get("mix", 0.82))
    cmap_type = cv2.COLORMAP_JET if kw.get("palette") == "jet" else cv2.COLORMAP_INFERNO
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    contrast_boost = 1.15 + 0.35 * p
    luma_stretched = np.clip((luma.astype(np.float32) - 30.0) * contrast_boost, 0.0, 255.0).astype(np.uint8)
    thermal = cv2.applyColorMap(luma_stretched, cmap_type)
    return cv2.addWeighted(frame, 1.0 - mix, thermal, mix, 0)


def bleach_bypass(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Bleach bypass silver-retention grade."""
    mix = float(kw.get("mix", 0.75))
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] *= 0.55
    desat = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)[..., None]
    low = (2.0 * luma * desat) / 255.0
    high = 255.0 - (2.0 * (255.0 - luma) * (255.0 - desat)) / 255.0
    overlay = np.where(luma < 128.0, low, high)
    out = (1.0 - mix) * frame.astype(np.float32) + mix * overlay
    return np.clip(out, 0, 255).astype(np.uint8)


def cyberpunk_grade(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Split-toning: violet shadows and cyan highlights."""
    mix = float(kw.get("mix", 0.78))
    lut = _cyberpunk_lut()
    graded = cv2.LUT(frame, lut)
    return cv2.addWeighted(frame, 1.0 - mix, graded, mix, 0)


def golden_hour(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Warm analog grade with amber highlights."""
    mix = float(kw.get("mix", 0.85))
    lut = _golden_lut()
    graded = cv2.LUT(frame, lut)
    return cv2.addWeighted(frame, 1.0 - mix, graded, mix, 0)


def sepia_noir(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Monochrome grade with warm sepia cast."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    contrast = float(kw.get("contrast", 1.25)) * (0.85 + 0.3 * p)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray_contrast = np.clip((gray - 128.0) * contrast + 128.0, 0.0, 255.0)
    b = gray_contrast * 0.70
    g = gray_contrast * 0.88
    r = gray_contrast * 1.05
    sepia = np.clip(cv2.merge([b, g, r]), 0, 255).astype(np.uint8)
    mix = float(kw.get("mix", 0.88))
    return cv2.addWeighted(frame, 1.0 - mix, sepia, mix, 0)


def posterize_pop(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Color quantization with saturation boost."""
    levels = max(3, min(8, int(kw.get("levels", 5))))
    mix = float(kw.get("mix", 0.85))
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.35, 0.0, 255.0)
    step = 255.0 / (levels - 1)
    hsv[..., 2] = np.round(hsv[..., 2] / step) * step
    hue_step = 180.0 / levels
    hsv[..., 0] = np.round(hsv[..., 0] / hue_step) * hue_step
    quant = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    return cv2.addWeighted(frame, 1.0 - mix, quant, mix, 0)


COLOR_EFFECTS = {
    "solarize_pulse": {"fn": solarize_pulse, "label": "Acid Solarize", "category": "color"},
    "hue_cycle": {"fn": hue_cycle, "label": "Hue Drift", "category": "color"},
    "color_grade": {"fn": color_grade, "label": "Cinema Grade", "category": "color"},
    "duotone_acid": {"fn": duotone_acid, "label": "Duotone Acid", "category": "color"},
    "thermal_infrared": {"fn": thermal_infrared, "label": "Thermal FLIR", "category": "color"},
    "bleach_bypass": {"fn": bleach_bypass, "label": "Bleach Bypass", "category": "color"},
    "cyberpunk_grade": {"fn": cyberpunk_grade, "label": "Cyberpunk Grade", "category": "color"},
    "golden_hour": {"fn": golden_hour, "label": "Golden Hour", "category": "color"},
    "sepia_noir": {"fn": sepia_noir, "label": "Sepia Noir", "category": "color"},
    "posterize_pop": {"fn": posterize_pop, "label": "Posterize Pop", "category": "color"},
}
