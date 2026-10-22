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

# ---------------------------------------------------------------- helpers

_VIGNETTE_CACHE: dict[tuple[int, int], np.ndarray] = {}
_BAYER_CACHE: dict[tuple[int, int], np.ndarray] = {}
_WARP_GRID_CACHE: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}

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


# ---------------------------------------------------------------- effects

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
    # BGR: warm analog red-orange halation (Red=100%, Green=38%, Blue=12%)
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
    # Perform dither at 1/2 resolution for crisp pixel-art / rave flyer grit
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
    warped = cv2.remap(
        frame,
        gx + dx,
        gy + dy,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    return warped


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
    # Colorize edges with electric mint + violet gradient
    neon = np.zeros_like(small)
    neon[..., 1] = (edges.astype(np.uint16) * 230 // 255).astype(np.uint8)  # G (mint)
    neon[..., 0] = edges  # B
    neon[..., 2] = np.roll(edges, 2, axis=1)  # R offset for cyber fringe
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
    # 4-frame holds (7.5 Hz instead of 30 Hz) so slices hold smoothly for ~133ms
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


# registry: name -> metadata + callable
EFFECTS = {
    "zoom_pulse": {"fn": zoom_pulse, "label": "Zoom Pulse", "category": "motion"},
    "beat_bounce": {"fn": beat_bounce, "label": "Beat Shake", "category": "motion"},
    "liquid_warp": {"fn": liquid_warp, "label": "Liquid Warp", "category": "motion"},
    "mirror_quad": {"fn": mirror_quad, "label": "Kaleido Mirror", "category": "geometry"},
    "prism_echo": {"fn": prism_echo, "label": "Prism Echo", "category": "optics"},
    "neon_bloom": {"fn": neon_bloom, "label": "Neon Bloom", "category": "optics"},
    "crt_halation": {"fn": crt_halation, "label": "CRT Halation", "category": "optics"},
    "chroma_pulse": {"fn": chroma_pulse, "label": "Chroma Split", "category": "optics"},
    "bayer_dither": {"fn": bayer_dither, "label": "Bayer Dither", "category": "digital"},
    "edge_neon": {"fn": edge_neon, "label": "Cyber Contours", "category": "digital"},
    "glitch": {"fn": glitch, "label": "Slice Glitch", "category": "digital"},
    "solarize_pulse": {"fn": solarize_pulse, "label": "Acid Solarize", "category": "color"},
    "hue_cycle": {"fn": hue_cycle, "label": "Hue Drift", "category": "color"},
    "color_grade": {"fn": color_grade, "label": "Cinema Grade", "category": "color"},
    "vignette": {"fn": vignette, "label": "Vignette", "category": "texture"},
    "scanlines": {"fn": scanlines, "label": "CRT Scanlines", "category": "texture"},
    "grain": {"fn": grain, "label": "35mm Grain", "category": "texture"},
    "flash": {"fn": flash, "label": "Warm Pulse", "category": "impact"},
    "letterbox": {"fn": letterbox, "label": "Cinema Bars", "category": "texture"},
}
