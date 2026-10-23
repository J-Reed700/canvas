"""High-energy beat-synced & audio-reactive shaders for Spotify Canvas (9:16 portrait).

Each effect signature:
    fn(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray
where:
    frame    : HxWx3 uint8 BGR
    t        : seconds within the canvas timeline
    beat_dur : seconds per beat (60.0 / bpm)

Optional per-frame real-time audio reactive scalars passed in `kw`:
    _sub       : 20-145 Hz sub-bass / kick envelope in [0, 1]
    _transient : percussive onset flux in [0, 1]
    _air       : 2.4-10 kHz high-hat / synth air in [0, 1]
    _rms       : overall loudness in [0, 1]
"""
from __future__ import annotations

import cv2
import numpy as np

# ---------------------------------------------------------------- caches & helpers

_VIGNETTE_CACHE: dict[tuple[int, int], np.ndarray] = {}
_BAYER_CACHE: dict[tuple[int, int], np.ndarray] = {}
_WARP_GRID_CACHE: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
_POLAR_GRID_CACHE: dict[tuple[int, int], tuple[np.ndarray, np.ndarray, np.ndarray, float, float]] = {}
_TILT_CACHE: dict[tuple[int, float, float], np.ndarray] = {}
_LED_GRID_CACHE: dict[tuple[int, int], np.ndarray] = {}
_RGB_STRIPE_CACHE: dict[int, np.ndarray] = {}
_HALFTONE_GRID_CACHE: dict[tuple[int, int], np.ndarray] = {}
_DUOTONE_LUT_CACHE: dict[str, np.ndarray] = {}
_CYBERPUNK_LUT_CACHE: dict[int, np.ndarray] = {}
_GOLDEN_LUT_CACHE: dict[int, np.ndarray] = {}
_EDGE_DIST_CACHE: dict[tuple[int, int], np.ndarray] = {}

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


def _zoom_in(frame: np.ndarray, cx: float, cy: float, factor: float) -> np.ndarray:
    """True zoom-in (crop inner region of size W/factor x H/factor and upscale to WxH).

    Never shrinks the frame or leaves smeared border artifacts.
    """
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


def _pulse(
    t: float,
    beat_dur: float,
    period_beats: float = 1.0,
    sharp: float = 3.2,
    kw: dict | None = None,
) -> float:
    """Smooth beat swell decaying gently, or driven by real audio sub-bass/transients."""
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
    if key not in _VIGNETTE_CACHE:
        y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
        x = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
        _VIGNETTE_CACHE[key] = np.sqrt(x * x + y * y)
    return _VIGNETTE_CACHE[key]


def _bayer_matrix(h: int, w: int) -> np.ndarray:
    key = (h, w)
    if key not in _BAYER_CACHE:
        reps_y = (h // 4) + 1
        reps_x = (w // 4) + 1
        tiled = np.tile(_BAYER_4X4, (reps_y, reps_x))[:h, :w]
        _BAYER_CACHE[key] = tiled[:, :, None]
    return _BAYER_CACHE[key]


def _warp_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    key = (h, w)
    if key not in _WARP_GRID_CACHE:
        x = np.arange(w, dtype=np.float32)[None, :]
        y = np.arange(h, dtype=np.float32)[:, None]
        gx, gy = np.meshgrid(x, y)
        _WARP_GRID_CACHE[key] = (gx, gy)
    return _WARP_GRID_CACHE[key]


def _polar_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float]:
    key = (h, w)
    if key not in _POLAR_GRID_CACHE:
        gx, gy = _warp_grid(h, w)
        cx, cy = w * 0.5, h * 0.5
        rx = (gx - cx) / max(cx, 1.0)
        ry = (gy - cy) / max(cy, 1.0)
        r_norm = np.sqrt(rx * rx + ry * ry)
        theta = np.arctan2(gy - cy, gx - cx)
        r_px = np.sqrt((gx - cx) ** 2 + (gy - cy) ** 2)
        _POLAR_GRID_CACHE[key] = (r_norm, theta, r_px, cx, cy)
    return _POLAR_GRID_CACHE[key]


def _led_grid(h: int, w: int) -> np.ndarray:
    key = (h, w)
    if key not in _LED_GRID_CACHE:
        y, x = np.ogrid[:8, :8]
        dist = np.sqrt((x - 3.5) ** 2 + (y - 3.5) ** 2)
        dot = np.clip(1.0 - (dist - 1.8) / 1.8, 0.20, 1.0).astype(np.float32)
        reps_y = (h // 8) + 1
        reps_x = (w // 8) + 1
        _LED_GRID_CACHE[key] = np.tile(dot, (reps_y, reps_x))[:h, :w, None]
    return _LED_GRID_CACHE[key]


def _rgb_stripe(w: int) -> np.ndarray:
    if w not in _RGB_STRIPE_CACHE:
        pattern = np.ones((1, w, 3), dtype=np.float32)
        cols = np.arange(w) % 3
        pattern[0, cols == 0] = [1.25, 0.82, 0.82]  # Blue pass
        pattern[0, cols == 1] = [0.82, 1.25, 0.82]  # Green pass
        pattern[0, cols == 2] = [0.82, 0.82, 1.25]  # Red pass
        _RGB_STRIPE_CACHE[w] = pattern
    return _RGB_STRIPE_CACHE[w]


def _halftone_grid(h: int, w: int) -> np.ndarray:
    key = (h, w)
    if key not in _HALFTONE_GRID_CACHE:
        gx, gy = _warp_grid(h, w)
        freq = 0.52
        _HALFTONE_GRID_CACHE[key] = ((np.sin(gx * freq) * np.sin(gy * freq) + 1.0) * 0.5).astype(np.float32)
    return _HALFTONE_GRID_CACHE[key]


def _edge_dist(h: int, w: int) -> np.ndarray:
    key = (h, w)
    if key not in _EDGE_DIST_CACHE:
        x = np.arange(w, dtype=np.float32)[None, :]
        d_left = x / max(1.0, float(w))
        d_right = (w - 1.0 - x) / max(1.0, float(w))
        _EDGE_DIST_CACHE[key] = np.minimum(d_left, d_right) * 2.0
    return _EDGE_DIST_CACHE[key]


def _duotone_lut(palette: str) -> np.ndarray:
    if palette not in _DUOTONE_LUT_CACHE:
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
        _DUOTONE_LUT_CACHE[palette] = lut.clip(0, 255).astype(np.uint8)[None, :, :]
    return _DUOTONE_LUT_CACHE[palette]


def _cyberpunk_lut() -> np.ndarray:
    if 0 not in _CYBERPUNK_LUT_CACHE:
        x = np.linspace(0.0, 1.0, 256, dtype=np.float32)
        s = np.clip(1.0 - x * 2.0, 0.0, 1.0)
        h = np.clip(x * 2.0 - 1.0, 0.0, 1.0)
        i = np.arange(256, dtype=np.float32)
        b = np.clip(i + 34.0 * s + 32.0 * h, 0, 255)
        g = np.clip(i - 18.0 * s + 35.0 * h, 0, 255)
        r = np.clip(i + 36.0 * s - 28.0 * h, 0, 255)
        _CYBERPUNK_LUT_CACHE[0] = np.stack([b, g, r], axis=1).astype(np.uint8)[None, :, :]
    return _CYBERPUNK_LUT_CACHE[0]


def _golden_lut() -> np.ndarray:
    if 0 not in _GOLDEN_LUT_CACHE:
        x = np.linspace(0.0, 1.0, 256, dtype=np.float32)
        s = np.clip(1.0 - x * 2.0, 0.0, 1.0)
        h = np.clip(x * 2.0 - 1.0, 0.0, 1.0)
        mid = np.sin(x * np.pi)
        i = np.arange(256, dtype=np.float32)
        b = np.clip(i + 8.0 * s - 14.0 * mid - 18.0 * h, 0, 255)
        g = np.clip(i + 8.0 * mid + 6.0 * h, 0, 255)
        r = np.clip(i - 4.0 * s + 18.0 * mid + 20.0 * h, 0, 255)
        _GOLDEN_LUT_CACHE[0] = np.stack([b, g, r], axis=1).astype(np.uint8)[None, :, :]
    return _GOLDEN_LUT_CACHE[0]


# ---------------------------------------------------------------- original 19 effects

def zoom_pulse(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Breathing camera zoom + smooth kick swell on beat or sub-bass hit."""
    cx = float(kw.get("cx", 0.5))
    cy = float(kw.get("cy", 0.5))
    period = float(kw.get("period", 4.0))
    kick_amp = min(float(kw.get("kick", 0.09)), 0.14)
    base = 1.04 + 0.03 * float(np.sin(2.0 * np.pi * t / period))
    sharp = min(float(kw.get("sharp", 3.0)), 3.2)
    kick = kick_amp * _pulse(t, beat_dur, 1.0, sharp=sharp, kw=kw)
    return _zoom_in(frame, cx, cy, base + kick)


def beat_bounce(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Smooth camera shake / drift on the beat using zoomed crop window."""
    amp = min(float(kw.get("amp", 0.022)), 0.035)
    sharp = min(float(kw.get("sharp", 2.5)), 3.2)
    p = _pulse(t, beat_dur, 1.0, sharp=sharp, kw=kw)
    if p < 0.01:
        return frame
    beat_phase = 2.0 * np.pi * (t / max(beat_dur, 0.01))
    dx = amp * 0.5 * float(np.sin(beat_phase * 0.5)) * p
    dy = -amp * float(np.cos(beat_phase)) * p
    return _zoom_in(frame, 0.5 + dx, 0.5 + dy, 1.06 + 0.03 * p)


def mirror_quad(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Symmetrical mirror / 4-way kaleidoscope geometry."""
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


def prism_echo(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Additive zoomed ghost layer that expands outward gently on each beat."""
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
    """Extract bright highlights, Gaussian-blur them, and screen-blend for glowing halation."""
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
    """2026 Analog Film & CRT Phosphor Halation: warm red-orange aura bleed around bright highlights."""
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


def bayer_dither(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """2026 Acid Graphics Ordered 4x4 Bayer Matrix Dithering & Bit-Depth Quantization."""
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


def liquid_warp(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """2026 Slit-Scan / UV Sine-Wave Displacement field driven by sub-bass & beat phase."""
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


def edge_neon(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """2026 Cyber-Sigil Glowing Sobel Contour Wireframes pulsed by high-hat air & kicks."""
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


def chroma_pulse(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Beat-synced radial / horizontal RGB split (chromatic aberration)."""
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


def glitch(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Digital slice displacement on beat transients (photosensitive-safe, no strobe inversions)."""
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


def color_grade(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """High-contrast cinema grade with steady, smooth tone curve."""
    contrast = float(kw.get("contrast", 1.18))
    warm = float(kw.get("warm", 14.0))
    cool = float(kw.get("cool", -10.0))

    f = frame.astype(np.float32)
    f = (f - 118.0) * contrast + 122.0
    f[..., 0] += cool
    f[..., 2] += warm
    return np.clip(f, 0, 255).astype(np.uint8)


def solarize_pulse(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Smooth psychedelic pastel tint shift on bright highlights (never inverts luminance)."""
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
    """True HSV hue rotation over the loop."""
    period = float(kw.get("period", 8.0))
    amount = float(kw.get("amount", 0.45))
    shift = int(((t / period) * 180.0 * amount) % 180)
    if shift == 0:
        return frame
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    hsv[..., 0] = (hsv[..., 0].astype(np.int16) + shift) % 180
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)


def vignette(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Smooth radial vignette that breathes with the beat."""
    h, w = frame.shape[:2]
    d = _vignette_radius(h, w)
    strength = float(kw.get("strength", 0.55)) + 0.18 * _pulse(t, beat_dur, 2.0, sharp=3.0, kw=kw)
    mask = np.clip(1.0 - strength * np.maximum(0.0, d - 0.52) / 0.55, 0.12, 1.0)
    return (frame.astype(np.float32) * mask[..., None]).astype(np.uint8)


def scanlines(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """CRT scanline texture with subtle vertical roll."""
    gap = int(kw.get("gap", 4))
    darken = float(kw.get("darken", 0.74))
    offset = int(t * 24) % gap
    out = frame.copy()
    out[offset::gap, :] = (out[offset::gap, :].astype(np.float32) * darken).astype(np.uint8)
    return out


def grain(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Fast tiled organic 35mm film grain."""
    rng = np.random.default_rng(int(t * 30) * 7919 + 3)
    amt = int(kw.get("amount", 14))
    h, w = frame.shape[:2]
    nh, nw = h // 2, w // 2
    small_noise = rng.integers(-amt, amt + 1, (nh, nw, 1), dtype=np.int16)
    noise = np.repeat(np.repeat(small_noise, 2, axis=0), 2, axis=1)[:h, :w]
    return np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def flash(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Photosensitive-safe warm exposure swell on downbeats."""
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


def letterbox(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Beat-breathing cinema letterbox bars."""
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


# ---------------------------------------------------------------- new effects: MOTION

def pendulum_sway(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Beat-locked Dutch-angle rotation swaying rhythmically with corner zoom compensation."""
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
    """Radial concentric sine-wave displacement ring expanding outward on beat/sub-bass hits."""
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
    """Horizontal and vertical time-wave slit-scan displacement modulated by beat pulse."""
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
    """Vertical stretch/melt warp driven by sub-bass pulse."""
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
    """Smooth swirl twist around frame center decaying exponentially with radius."""
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


# ---------------------------------------------------------------- new effects: GEOMETRY

def kaleido_hex(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """6-way / 8-way radial polar kaleidoscope symmetry folded around frame center."""
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
    """Beat-reactive tiled video wall with alternating tile tint shifts."""
    grid = int(kw.get("grid", 2))
    p = _pulse(t, beat_dur, 1.0, sharp=3.5, kw=kw)
    h, w = frame.shape[:2]
    tw, th = max(1, w // grid), max(1, h // grid)
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
    """Recursive picture-in-picture zoom tunnel with glowing screen borders."""
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
    """Alternating horizontal ribbon bands that slide in opposing directions on beat hits."""
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
    """Polar coordinate warp tunnel projection blended with base frame."""
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


# ---------------------------------------------------------------- new effects: OPTICS

def anamorphic_flare(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Horizontal cinema anamorphic blue/cyan lens flares on bright highlights."""
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
    """4-point optical cross star filter diffraction spikes on highlights."""
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
    """Miniature cinematic depth-of-field bokeh with sharp focal plane."""
    cy = float(kw.get("cy", 0.5))
    focus_h = float(kw.get("focus_height", 0.22))
    h, w = frame.shape[:2]
    sw, sh = max(8, w // 2), max(8, h // 2)
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
    blur_small = cv2.GaussianBlur(small, (25, 25), 0)
    blurred = cv2.resize(blur_small, (w, h), interpolation=cv2.INTER_LINEAR)
    key = (h, round(cy, 2), round(focus_h, 2))
    if key not in _TILT_CACHE:
        y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None, None]
        cy_norm = cy * 2.0 - 1.0
        mask = np.clip((np.abs(y - cy_norm) - focus_h) / 0.38, 0.0, 1.0)
        _TILT_CACHE[key] = mask
    mask = _TILT_CACHE[key]
    out = frame.astype(np.float32) * (1.0 - mask) + blurred.astype(np.float32) * mask
    return np.clip(out, 0, 255).astype(np.uint8)


def fisheye_lens(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Barrel distortion wide-angle lens pulsing on the beat."""
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
    """Multi-tap explosive radial zoom blur triggered by transients/kicks."""
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
    """Twin ghost image chromatic separation that expands on beat hits."""
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


# ---------------------------------------------------------------- new effects: DIGITAL

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
    """Cyber dot-matrix / LED grid synthesizer."""
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
    """Beat-reactive pixelation block mosaic with sub-pixel RGB stripes."""
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
    """Authentic VHS tape look with chroma horizontal bleed and rolling tracking jitter."""
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
    """Blocky 16x16 macroblock displacement on beat transients."""
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


# ---------------------------------------------------------------- new effects: COLOR

def duotone_acid(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """High-impact 2-color gradient map based on luminance."""
    palette = str(kw.get("palette", "cyber")).lower()
    mix = float(kw.get("mix", 0.78))
    lut = _duotone_lut(palette)
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    duo = cv2.LUT(cv2.merge([luma, luma, luma]), lut)
    return cv2.addWeighted(frame, 1.0 - mix, duo, mix, 0)


def thermal_infrared(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """FLIR false-color thermal vision filter with beat-synced contrast swell."""
    p = _pulse(t, beat_dur, 1.0, sharp=3.0, kw=kw)
    mix = float(kw.get("mix", 0.82))
    cmap_type = cv2.COLORMAP_JET if kw.get("palette") == "jet" else cv2.COLORMAP_INFERNO
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    contrast_boost = 1.15 + 0.35 * p
    luma_stretched = np.clip((luma.astype(np.float32) - 30.0) * contrast_boost, 0.0, 255.0).astype(np.uint8)
    thermal = cv2.applyColorMap(luma_stretched, cmap_type)
    return cv2.addWeighted(frame, 1.0 - mix, thermal, mix, 0)


def bleach_bypass(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """High-contrast gritty silver-retention cinema bleach-bypass grade."""
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
    """Neon split-toning: deep violet shadows and electric cyan highlights."""
    mix = float(kw.get("mix", 0.78))
    lut = _cyberpunk_lut()
    graded = cv2.LUT(frame, lut)
    return cv2.addWeighted(frame, 1.0 - mix, graded, mix, 0)


def golden_hour(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Warm Kodak Portra analog grade: lush amber highlights, velvet shadows."""
    mix = float(kw.get("mix", 0.85))
    lut = _golden_lut()
    graded = cv2.LUT(frame, lut)
    return cv2.addWeighted(frame, 1.0 - mix, graded, mix, 0)


def sepia_noir(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """High-contrast silver-gelatin monochrome with beat-reactive contrast swell."""
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
    """Bold pop-art color quantization with crisp saturation boost."""
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


# ---------------------------------------------------------------- new effects: TEXTURE

def film_burn(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Organic 16mm warm amber/ruby light leak along frame edges."""
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
    """Pop-art halftone dot screen pattern."""
    h, w = frame.shape[:2]
    dot_grid = _halftone_grid(h, w)
    luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    dots = np.where(dot_grid < (1.0 - luma), 0, 255).astype(np.uint8)
    dots_3ch = cv2.merge([dots, dots, dots])
    mix = float(kw.get("mix", 0.65))
    return cv2.addWeighted(frame, 1.0 - mix, dots_3ch, mix, 0)


def frost_mist(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Ethereal cinematic pro-mist diffusion filter with lifted pastel blacks."""
    strength = float(kw.get("strength", 0.42))
    h, w = frame.shape[:2]
    sw, sh = max(8, w // 4), max(8, h // 4)
    small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
    blurred = cv2.GaussianBlur(small, (35, 35), 0)
    bloom = cv2.resize(blurred, (w, h), interpolation=cv2.INTER_LINEAR)
    milky = cv2.add(frame, (10, 10, 10, 0))
    return cv2.addWeighted(milky, 1.0 - strength * 0.5, bloom, strength, 0)


# ---------------------------------------------------------------- new effects: IMPACT

def strobe_shutter(frame: np.ndarray, t: float, beat_dur: float, **kw) -> np.ndarray:
    """Rhythm gate effect that adds a crisp border/exposure pulse (photosensitive safe, max luma delta < 12)."""
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
    """Electric neon rim-light border glow that flares on sub-bass kicks."""
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


# ---------------------------------------------------------------- registry

EFFECTS = {
    # motion
    "zoom_pulse": {"fn": zoom_pulse, "label": "Zoom Pulse", "category": "motion"},
    "beat_bounce": {"fn": beat_bounce, "label": "Beat Shake", "category": "motion"},
    "liquid_warp": {"fn": liquid_warp, "label": "Liquid Warp", "category": "motion"},
    "pendulum_sway": {"fn": pendulum_sway, "label": "Pendulum Sway", "category": "motion"},
    "shockwave_ripple": {"fn": shockwave_ripple, "label": "Shockwave Ripple", "category": "motion"},
    "slit_scan": {"fn": slit_scan, "label": "Slit Scan", "category": "motion"},
    "gravity_droop": {"fn": gravity_droop, "label": "Gravity Droop", "category": "motion"},
    "vortex_twirl": {"fn": vortex_twirl, "label": "Vortex Twirl", "category": "motion"},
    # geometry
    "mirror_quad": {"fn": mirror_quad, "label": "Kaleido Mirror", "category": "geometry"},
    "kaleido_hex": {"fn": kaleido_hex, "label": "Hex Kaleido", "category": "geometry"},
    "grid_clone": {"fn": grid_clone, "label": "Grid Clone", "category": "geometry"},
    "fractal_tunnel": {"fn": fractal_tunnel, "label": "Fractal Tunnel", "category": "geometry"},
    "ribbon_split": {"fn": ribbon_split, "label": "Ribbon Split", "category": "geometry"},
    "polar_tunnel": {"fn": polar_tunnel, "label": "Polar Tunnel", "category": "geometry"},
    # optics
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
    # digital
    "bayer_dither": {"fn": bayer_dither, "label": "Bayer Dither", "category": "digital"},
    "edge_neon": {"fn": edge_neon, "label": "Cyber Contours", "category": "digital"},
    "glitch": {"fn": glitch, "label": "Slice Glitch", "category": "digital"},
    "pixel_sort": {"fn": pixel_sort, "label": "Pixel Sort", "category": "digital"},
    "ascii_matrix": {"fn": ascii_matrix, "label": "Cyber Matrix", "category": "digital"},
    "rgb_mosaic": {"fn": rgb_mosaic, "label": "RGB Mosaic", "category": "digital"},
    "vhs_tracking": {"fn": vhs_tracking, "label": "VHS Tracking", "category": "digital"},
    "datamosh_smear": {"fn": datamosh_smear, "label": "Datamosh Smear", "category": "digital"},
    # color
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
    # texture
    "vignette": {"fn": vignette, "label": "Vignette", "category": "texture"},
    "scanlines": {"fn": scanlines, "label": "CRT Scanlines", "category": "texture"},
    "grain": {"fn": grain, "label": "35mm Grain", "category": "texture"},
    "letterbox": {"fn": letterbox, "label": "Cinema Bars", "category": "texture"},
    "film_burn": {"fn": film_burn, "label": "Film Burn", "category": "texture"},
    "halftone_dots": {"fn": halftone_dots, "label": "Halftone Dots", "category": "texture"},
    "frost_mist": {"fn": frost_mist, "label": "Frost Mist", "category": "texture"},
    # impact
    "flash": {"fn": flash, "label": "Warm Pulse", "category": "impact"},
    "strobe_shutter": {"fn": strobe_shutter, "label": "Strobe Shutter", "category": "impact"},
    "bass_vignette_punch": {"fn": bass_vignette_punch, "label": "Bass Rim Punch", "category": "impact"},
}

