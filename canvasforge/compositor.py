"""Multi-clip beat-synced & audio-reactive timeline compositor for Spotify Canvas (1080x1920 @ 30fps).

Strictly enforces Spotify Canvas duration limits (3.0s - 8.0s, default 8.0s = 240 frames)
and supports 3 loop topologies (`crossfade`, `rebound`, `hard`) + 5 transition modes
including Optical Flow Datamoshing (`datamosh`).
"""
from __future__ import annotations

import dataclasses
import os
import random
from typing import Callable

import cv2
import numpy as np

from .audio import FrameAudioCurves, extract_frame_curves
from .recipe import PRESETS, Recipe, build_effect_stack, evolve_effect_names
from .source import GLOBAL_CACHE, Source

CANVAS_FPS = 30
CANVAS_SECONDS = 8.0  # Official Spotify Canvas max duration (3.0s - 8.0s)
CANVAS_W, CANVAS_H = 1080, 1920

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

_FLOW_GRID_CACHE: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}


def _zoom_in(frame: np.ndarray, factor: float, cx: float = 0.5, cy: float = 0.5) -> np.ndarray:
    """True zoom-in crop + upscale without border smearing."""
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


def _flow_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    key = (h, w)
    if key not in _FLOW_GRID_CACHE:
        x = np.arange(w, dtype=np.float32)[None, :]
        y = np.arange(h, dtype=np.float32)[:, None]
        _FLOW_GRID_CACHE[key] = np.meshgrid(x, y)
    return _FLOW_GRID_CACHE[key]


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

    if mode == "datamosh":
        # Optical Flow Datamosh: compute Farneback motion vectors at 1/4 scale and smear pixels
        h, w = frame_a.shape[:2]
        sh, sw = max(16, h // 4), max(16, w // 4)
        ga = cv2.cvtColor(cv2.resize(frame_a, (sw, sh)), cv2.COLOR_BGR2GRAY)
        gb = cv2.cvtColor(cv2.resize(frame_b, (sw, sh)), cv2.COLOR_BGR2GRAY)
        flow_small = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 2, 13, 2, 5, 1.1, 0)
        flow = cv2.resize(flow_small, (w, h), interpolation=cv2.INTER_LINEAR)
        gx, gy = _flow_grid(h, w)
        # Exaggerate motion smear at the midpoint of the cut (I-frame drop effect)
        surge = 4.2 * (1.0 - abs(alpha - 0.5) * 1.6)
        warped_a = cv2.remap(
            frame_a,
            gx - flow[..., 0] * surge * alpha,
            gy - flow[..., 1] * surge * alpha,
            interpolation=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_REPLICATE,
        )
        # Blocky macroblock emergence of incoming clip B
        bh, bw = max(1, h // 24), max(1, w // 24)
        rng = np.random.default_rng(int(alpha * 500) + 99)
        block_mask = (rng.random((bh, bw, 1)) < (alpha ** 1.2)).astype(np.uint8)
        mask_full = cv2.resize(block_mask, (w, h), interpolation=cv2.INTER_NEAREST)
        return np.where(mask_full[..., None] > 0, frame_b, warped_a)

    if mode == "whip":
        h, w = frame_a.shape[:2]
        offset = int(round((1.0 - alpha) * h))
        stacked = np.vstack([frame_b, frame_a])
        out = stacked[offset : offset + h, :]
        blur_k = int(round(45 * (1.0 - abs(alpha - 0.5) * 2.0))) | 1
        if blur_k >= 3:
            out = cv2.GaussianBlur(out, (1, blur_k), 0)
        return out

    if mode == "whip_horiz":
        h, w = frame_a.shape[:2]
        offset = int(round((1.0 - alpha) * w))
        stacked = np.hstack([frame_b, frame_a])
        out = stacked[:, offset : offset + w]
        blur_k = int(round(45 * (1.0 - abs(alpha - 0.5) * 2.0))) | 1
        if blur_k >= 3:
            out = cv2.GaussianBlur(out, (blur_k, 1), 0)
        return out

    if mode == "luma":
        luma = frame_b.mean(axis=2, keepdims=True) / 255.0
        mask = np.clip((luma - (1.0 - alpha * 1.45)) * 3.2, 0.0, 1.0).astype(np.float32)
        return (frame_a.astype(np.float32) * (1.0 - mask) + frame_b.astype(np.float32) * mask).astype(np.uint8)

    if mode == "glitch":
        h, w = frame_a.shape[:2]
        smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
        base = cv2.addWeighted(frame_a, 1.0 - smooth_alpha, frame_b, smooth_alpha, 0)
        out = base.copy()
        # Stable RNG seed prevents 30Hz flicker / strobe jumps
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

    if mode == "zoom_punch":
        za = _zoom_in(frame_a, 1.0 + 0.85 * alpha)
        zb = _zoom_in(frame_b, 1.45 - 0.45 * alpha)
        smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
        return cv2.addWeighted(za, 1.0 - smooth_alpha, zb, smooth_alpha, 0)

    if mode == "spin_vortex":
        h, w = frame_a.shape[:2]
        center = (w / 2.0, h / 2.0)
        scale = 1.0 + 0.35 * float(np.sin(alpha * np.pi))
        M_a = cv2.getRotationMatrix2D(center, float(alpha * 180.0), scale)
        rot_a = cv2.warpAffine(frame_a, M_a, (w, h), borderMode=cv2.BORDER_REFLECT_101)
        M_b = cv2.getRotationMatrix2D(center, float((alpha - 1.0) * 180.0), scale)
        rot_b = cv2.warpAffine(frame_b, M_b, (w, h), borderMode=cv2.BORDER_REFLECT_101)
        smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
        return cv2.addWeighted(rot_a, 1.0 - smooth_alpha, rot_b, smooth_alpha, 0)

    if mode == "prism_split":
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

    if mode == "pixelate":
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

    if mode == "iris_wipe":
        h, w = frame_a.shape[:2]
        y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
        x = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
        d = np.sqrt(x * x + y * y)
        mask = np.clip((alpha * 1.45 - d) * 4.0, 0.0, 1.0)[..., None]
        return (frame_a.astype(np.float32) * (1.0 - mask) + frame_b.astype(np.float32) * mask).astype(np.uint8)

    if mode == "burn_luma":
        luma = frame_b.mean(axis=2, keepdims=True) / 255.0
        mask = np.clip((luma - (1.0 - alpha * 1.45)) * 3.2, 0.0, 1.0).astype(np.float32)
        base = frame_a.astype(np.float32) * (1.0 - mask) + frame_b.astype(np.float32) * mask
        # Warm analog film-burn glow concentrated on mid-luminance regions
        base_luma = base.mean(axis=2, keepdims=True) / 255.0
        mid_bell = float(np.sin(alpha * np.pi))
        mid_mask = 4.0 * base_luma * np.maximum(0.0, 1.0 - base_luma)
        glow_boost = 32.0 * mid_bell * mid_mask
        base[..., 0] += glow_boost[..., 0] * 0.15  # Blue
        base[..., 1] += glow_boost[..., 0] * 0.45  # Green
        base[..., 2] += glow_boost[..., 0] * 1.00  # Red
        return np.clip(base, 0, 255).astype(np.uint8)

    if mode == "shutter_slice":
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

    if mode == "kaleido_twist":
        smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
        base = cv2.addWeighted(frame_a, 1.0 - smooth_alpha, frame_b, smooth_alpha, 0)
        mid = float(np.sin(alpha * np.pi))
        if mid < 0.02:
            return base
        zoomed = _zoom_in(base, 1.0 + 0.25 * mid)
        h, w = zoomed.shape[:2]
        hw, hh = w // 2, h // 2
        kframe = zoomed.copy()
        kframe[:, w - hw :] = kframe[:, :hw][:, ::-1]
        kframe[h - hh :, :] = kframe[:hh, :][::-1, :]
        blend_amt = min(0.85, 0.85 * mid)
        return cv2.addWeighted(base, 1.0 - blend_amt, kframe, blend_amt, 0)

    # Default: "flash" (and alias "dissolve"): buttery-smooth S-curve cross-dissolve with zero white flash
    smooth_alpha = float(alpha * alpha * (3.0 - 2.0 * alpha))
    base = cv2.addWeighted(frame_a, 1.0 - smooth_alpha, frame_b, smooth_alpha, 0)
    mid_bell = max(0.0, 1.0 - abs(alpha - 0.5) * 2.0)
    cushion = int(round(10 * (mid_bell ** 2)))
    if cushion > 0:
        base = cv2.add(base, (int(round(cushion * 0.6)), int(round(cushion * 0.8)), cushion, 0))
    return base


@dataclasses.dataclass
class SegmentSlice:
    source: Source
    frames: list[np.ndarray]
    start_canvas_frame: int
    end_canvas_frame: int
    speed: float
    direction: str = "forward"
    transition: str = "luma"
    trans_frames: int = 12
    effects: list[tuple[str, Callable, dict]] | None = None
    effect_names: list[str] = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class RenderPlan:
    sources: list[Source]
    recipe: Recipe
    segments: list[SegmentSlice]
    n_frames: int
    beat_dur: float  # seconds per beat (60.0 / bpm)
    width: int = CANVAS_W
    height: int = CANVAS_H
    audio_curves: FrameAudioCurves | None = None
    _last_frame: np.ndarray | None = dataclasses.field(default=None, init=False, repr=False)
    _last_luma: float = dataclasses.field(default=-1.0, init=False, repr=False)
    _last_frame_idx: int = dataclasses.field(default=-1, init=False, repr=False)

    @property
    def duration(self) -> float:
        return self.n_frames / CANVAS_FPS

    def reset_limiter(self) -> None:
        """Reset stateful temporal smoothing cache."""
        self._last_frame = None
        self._last_luma = -1.0
        self._last_frame_idx = -1

    def limit_luminance_slew(self, frame: np.ndarray, i: int, max_delta: float = 18.0) -> np.ndarray:
        """Photosensitive luminance slew limiter: prevents frame-to-frame luminance jumps > 18 units."""
        if i == 0:
            self.reset_limiter()

        b, g, r, _ = cv2.mean(frame)
        curr_luma = float(0.114 * b + 0.587 * g + 0.299 * r)

        if self._last_frame is not None and self._last_frame_idx == i - 1 and self._last_luma >= 0:
            delta = curr_luma - self._last_luma
            if abs(delta) > max_delta:
                blend_alpha = float(max_delta / abs(delta))
                frame = cv2.addWeighted(frame, blend_alpha, self._last_frame, 1.0 - blend_alpha, 0)
                curr_luma = self._last_luma + (max_delta if delta > 0 else -max_delta)

        self._last_frame = frame
        self._last_luma = curr_luma
        self._last_frame_idx = i
        return frame

    def _apply_effects(
        self,
        frame: np.ndarray,
        effects: list[tuple[str, Callable, dict]],
        t: float,
        audio_kw: dict[str, float],
    ) -> np.ndarray:
        for _name, fn, kw in effects:
            if audio_kw:
                frame = fn(frame, t, self.beat_dur, **{**kw, **audio_kw})
            else:
                frame = fn(frame, t, self.beat_dur, **kw)
        return frame

    def _rendered_segment_frame(
        self,
        seg: SegmentSlice,
        local_i: int,
        t: float,
        audio_kw: dict[str, float],
    ) -> np.ndarray:
        raw = seg.frames[min(len(seg.frames) - 1, int(local_i * seg.speed) % len(seg.frames))]
        effs = seg.effects if seg.effects is not None else self.recipe.effects
        return self._apply_effects(raw, effs, t, audio_kw)

    def _raw_frame_at(self, i: int) -> np.ndarray:
        """Return the base portrait frame at canvas frame `i`, including loop topology & cut transitions."""
        i = i % self.n_frames
        loop_mode = getattr(self.recipe, "loop_mode", "crossfade")

        # Ping-Pong Rebound loop: second half plays the first half in reverse for a mathematically zero-seam loop
        if loop_mode == "rebound":
            half = self.n_frames // 2
            eff_i = i if i < half else max(0, (self.n_frames - 1) - i)
        else:
            eff_i = i

        seg_idx = 0
        for idx, seg in enumerate(self.segments):
            if seg.start_canvas_frame <= eff_i < seg.end_canvas_frame:
                seg_idx = idx
                break

        seg = self.segments[seg_idx]
        local_i = max(0, eff_i - seg.start_canvas_frame)
        frame_curr = seg.frames[min(len(seg.frames) - 1, int(local_i * seg.speed) % len(seg.frames))]

        # Check if we are in a transition window near the start of a cut
        seg_trans_frames = getattr(seg, "trans_frames", 12)
        trans_frames = min(seg_trans_frames, max(4, (seg.end_canvas_frame - seg.start_canvas_frame) // 2))
        if len(self.segments) > 1 and local_i < trans_frames and eff_i >= trans_frames:
            prev_seg = self.segments[(seg_idx - 1) % len(self.segments)]
            prev_local = (prev_seg.end_canvas_frame - prev_seg.start_canvas_frame) + local_i
            frame_prev = prev_seg.frames[min(len(prev_seg.frames) - 1, int(prev_local * prev_seg.speed) % len(prev_seg.frames))]
            alpha = (local_i + 1) / (trans_frames + 1)
            seg_transition = getattr(seg, "transition", self.recipe.transition)
            return _blend_transition(frame_prev, frame_curr, alpha, seg_transition)

        # Seamless loop crossfade in the final 10 frames back to frame 0 (when loop_mode == "crossfade")
        if loop_mode == "crossfade":
            loop_tail = 10
            if i >= self.n_frames - loop_tail:
                first_seg = self.segments[0]
                tail_offset = i - (self.n_frames - loop_tail)
                alpha = (tail_offset + 1) / (loop_tail + 1)
                frame_zero = first_seg.frames[tail_offset % len(first_seg.frames)]
                return cv2.addWeighted(frame_curr, 1.0 - alpha, frame_zero, alpha, 0)

        # Morph loop: seamless transition blend back into clip 0
        if loop_mode == "morph":
            loop_tail = min(14, max(6, getattr(self.recipe, "trans_frames", 12)))
            if i >= self.n_frames - loop_tail:
                first_seg = self.segments[0]
                tail_offset = i - (self.n_frames - loop_tail)
                alpha = (tail_offset + 1) / (loop_tail + 1)
                frame_zero = first_seg.frames[tail_offset % len(first_seg.frames)]
                seam_trans = getattr(first_seg, "transition", self.recipe.transition)
                return _blend_transition(frame_curr, frame_zero, alpha, seam_trans)

        return frame_curr

    def render(self, i: int) -> np.ndarray:
        """Render canvas frame `i` with full beat-synced & audio-reactive effect stack."""
        t = i / CANVAS_FPS
        audio_kw: dict[str, float] = {}
        if self.audio_curves is not None and 0 <= i < self.n_frames:
            audio_kw = {
                "_sub": float(self.audio_curves.sub_bass[i]),
                "_transient": float(self.audio_curves.transient[i]),
                "_air": float(self.audio_curves.high_air[i]),
                "_rms": float(self.audio_curves.rms[i]),
            }

        has_per_seg_fx = any(getattr(s, "effects", None) is not None for s in self.segments)
        if not has_per_seg_fx:
            frame = self._raw_frame_at(i)
            frame = self._apply_effects(frame, self.recipe.effects, t, audio_kw)
            return self.limit_luminance_slew(frame, i)

        i_mod = i % self.n_frames
        loop_mode = getattr(self.recipe, "loop_mode", "crossfade")

        if loop_mode == "rebound":
            half = self.n_frames // 2
            eff_i = i_mod if i_mod < half else max(0, (self.n_frames - 1) - i_mod)
        else:
            eff_i = i_mod

        seg_idx = 0
        for idx, s in enumerate(self.segments):
            if s.start_canvas_frame <= eff_i < s.end_canvas_frame:
                seg_idx = idx
                break

        seg = self.segments[seg_idx]
        local_i = max(0, eff_i - seg.start_canvas_frame)
        frame_curr = self._rendered_segment_frame(seg, local_i, t, audio_kw)

        seg_trans_frames = getattr(seg, "trans_frames", 12)
        trans_frames = min(seg_trans_frames, max(4, (seg.end_canvas_frame - seg.start_canvas_frame) // 2))

        if len(self.segments) > 1 and local_i < trans_frames and eff_i >= trans_frames:
            prev_seg = self.segments[(seg_idx - 1) % len(self.segments)]
            prev_local = (prev_seg.end_canvas_frame - prev_seg.start_canvas_frame) + local_i
            frame_prev = self._rendered_segment_frame(prev_seg, prev_local, t, audio_kw)
            alpha = (local_i + 1) / (trans_frames + 1)
            seg_transition = getattr(seg, "transition", self.recipe.transition)
            frame = _blend_transition(frame_prev, frame_curr, alpha, seg_transition)
        elif loop_mode == "crossfade" and i_mod >= self.n_frames - 10:
            loop_tail = 10
            first_seg = self.segments[0]
            tail_offset = i_mod - (self.n_frames - loop_tail)
            alpha = (tail_offset + 1) / (loop_tail + 1)
            frame_zero = self._rendered_segment_frame(first_seg, tail_offset, t, audio_kw)
            frame = cv2.addWeighted(frame_curr, 1.0 - alpha, frame_zero, alpha, 0)
        elif loop_mode == "morph" and i_mod >= self.n_frames - min(14, max(6, getattr(self.recipe, "trans_frames", 12))):
            loop_tail = min(14, max(6, getattr(self.recipe, "trans_frames", 12)))
            first_seg = self.segments[0]
            tail_offset = i_mod - (self.n_frames - loop_tail)
            alpha = (tail_offset + 1) / (loop_tail + 1)
            frame_zero = self._rendered_segment_frame(first_seg, tail_offset, t, audio_kw)
            seam_trans = getattr(first_seg, "transition", self.recipe.transition)
            frame = _blend_transition(frame_curr, frame_zero, alpha, seam_trans)
        else:
            frame = frame_curr

        return self.limit_luminance_slew(frame, i)


def _weights_to_bounds(n_frames: int, weights: list[float], min_len: int = 12) -> list[tuple[int, int]]:
    n = len(weights)
    if n <= 1:
        return [(0, n_frames)]
    min_len = max(1, min(min_len, n_frames // n))
    excess = max(0, n_frames - n * min_len)
    total_w = sum(max(0.001, float(w)) for w in weights)
    shares = [max(0.001, float(w)) / total_w for w in weights]
    lengths = [min_len + int(round(s * excess)) for s in shares]
    diff = n_frames - sum(lengths)
    while diff != 0:
        if diff > 0:
            idx = max(range(n), key=lambda k: lengths[k])
            lengths[idx] += 1
            diff -= 1
        else:
            candidates = [k for k in range(n) if lengths[k] > min_len]
            if not candidates:
                candidates = list(range(n))
            idx = max(candidates, key=lambda k: lengths[k])
            lengths[idx] -= 1
            diff += 1
    bounds: list[tuple[int, int]] = []
    c = 0
    for l in lengths:
        bounds.append((c, c + l))
        c += l
    bounds[-1] = (bounds[-1][0], n_frames)
    return bounds


def _compute_segment_bounds(
    n_frames: int,
    cut_frames: int,
    n_clips: int,
    cut_mode: str,
    ensure_all: bool,
    audio_curves: FrameAudioCurves | None,
    rng: random.Random,
) -> list[tuple[int, int]]:
    n_frames = max(1, n_frames)
    n_clips = max(1, n_clips)

    if cut_mode == "fit_all":
        n_segs = max(1, n_clips)
        return [
            (int(round(k * n_frames / n_segs)), int(round((k + 1) * n_frames / n_segs)))
            for k in range(n_segs)
        ]

    if cut_mode == "fit_all_2x":
        n_segs = max(2, n_clips * 2)
        return [
            (int(round(k * n_frames / n_segs)), int(round((k + 1) * n_frames / n_segs)))
            for k in range(n_segs)
        ]

    if cut_mode == "build_up":
        n_segs = max(n_clips if ensure_all else 2, max(4, int(round(n_frames / max(1, cut_frames)))))
        weights = [1.65 * (0.45 ** (k / max(1, n_segs - 1))) for k in range(n_segs)]
        return _weights_to_bounds(n_frames, weights, min_len=12)

    if cut_mode == "syncopated":
        base = max(4.0, cut_frames / 1.333)
        if ensure_all and n_clips > 1 and (n_frames / (base * 1.333)) < n_clips:
            base = max(4.0, (n_frames / n_clips) / 1.333)
        pat = [1.5, 1.5, 1.0]
        lengths: list[int] = []
        remaining = n_frames
        idx = 0
        while remaining > 0:
            step = max(8, int(round(base * pat[idx % len(pat)])))
            if remaining - step < 8:
                step = remaining
            lengths.append(step)
            remaining -= step
            idx += 1
        if ensure_all and len(lengths) < n_clips:
            while len(lengths) < n_clips:
                idx_max = max(range(len(lengths)), key=lambda k: lengths[k])
                if lengths[idx_max] <= 16:
                    break
                h1 = lengths[idx_max] // 2
                h2 = lengths[idx_max] - h1
                lengths[idx_max] = h1
                lengths.insert(idx_max + 1, h2)
        bounds: list[tuple[int, int]] = []
        c = 0
        for l in lengths:
            bounds.append((c, c + l))
            c += l
        bounds[-1] = (bounds[-1][0], n_frames)
        return bounds

    if cut_mode == "transient" and audio_curves is not None:
        min_dist = max(15, cut_frames // 2)
        transient_arr = np.asarray(audio_curves.transient, dtype=np.float32)
        cand_indices = []
        for f in range(1, len(transient_arr) - 1):
            if transient_arr[f] > transient_arr[f - 1] and transient_arr[f] >= transient_arr[f + 1]:
                cand_indices.append((float(transient_arr[f]), f))
        cand_indices.sort(key=lambda x: x[0], reverse=True)
        picked_peaks: list[int] = []
        for _val, f in cand_indices:
            if min_dist <= f <= n_frames - min_dist:
                if all(abs(f - p) >= min_dist for p in picked_peaks):
                    picked_peaks.append(f)
        picked_peaks.sort()
        cuts = [0] + picked_peaks + [n_frames]
        bounds = [(cuts[k], cuts[k + 1]) for k in range(len(cuts) - 1)]
        if ensure_all and len(bounds) < n_clips:
            lengths = [end - start for start, end in bounds]
            while len(lengths) < n_clips:
                idx_max = max(range(len(lengths)), key=lambda k: lengths[k])
                if lengths[idx_max] <= 16:
                    break
                h1 = lengths[idx_max] // 2
                h2 = lengths[idx_max] - h1
                lengths[idx_max] = h1
                lengths.insert(idx_max + 1, h2)
            bounds = []
            c = 0
            for l in lengths:
                bounds.append((c, c + l))
                c += l
            bounds[-1] = (bounds[-1][0], n_frames)
        return bounds

    if cut_mode == "chaos":
        scale = 1.0
        if ensure_all and n_clips > 1 and (n_frames // max(1, cut_frames)) < n_clips:
            scale = min(1.0, (n_frames / n_clips) / max(1, cut_frames))
        lengths = []
        remaining = n_frames
        while remaining > 0:
            l = max(10, int(round(rng.choice([0.6, 0.8, 1.0, 1.3, 1.6]) * cut_frames * scale)))
            if remaining - l < 10:
                l = remaining
            lengths.append(l)
            remaining -= l
        if ensure_all and len(lengths) < n_clips:
            while len(lengths) < n_clips:
                idx_max = max(range(len(lengths)), key=lambda k: lengths[k])
                if lengths[idx_max] <= 16:
                    break
                h1 = lengths[idx_max] // 2
                h2 = lengths[idx_max] - h1
                lengths[idx_max] = h1
                lengths.insert(idx_max + 1, h2)
        bounds = []
        c = 0
        for l in lengths:
            bounds.append((c, c + l))
            c += l
        bounds[-1] = (bounds[-1][0], n_frames)
        return bounds

    # Default: "steady"
    if ensure_all and n_clips > 1 and (n_frames // max(1, cut_frames)) < n_clips:
        over = min(1.0, max(0.0, (cut_frames * n_clips / max(1, n_frames) - 1.0) * 0.55))
        weights = [1.0 + over * (1.0 - 1.6 * (k / max(1, n_clips - 1))) for k in range(n_clips)]
        min_seg = max(18, n_frames // (n_clips * 2))
        return _weights_to_bounds(n_frames, weights, min_len=min_seg)

    bounds = []
    cursor = 0
    while cursor < n_frames:
        end = min(n_frames, cursor + cut_frames)
        if n_frames - end < 12:
            end = n_frames
        bounds.append((cursor, end))
        cursor = end
    return bounds


def build_plan(
    sources: Source | list[Source],
    recipe: Recipe,
    speed: float = 1.0,
    width: int = CANVAS_W,
    height: int = CANVAS_H,
    duration: float | None = None,
    audio_path: str | None = None,
    audio_start_sec: float | None = None,
    shuffle_order: bool = True,
    clip_direction: str | None = None,
    cut_mode: str | None = None,
    ensure_all_clips: bool | None = None,
    transitions: list[str] | None = None,
    transition_mode: str | None = None,
    trans_frames: int | None = None,
    filter_mode: str | None = None,
    clip_effects: dict[str, list[str]] | None = None,
) -> RenderPlan:
    if isinstance(sources, Source):
        source_list = [sources]
    else:
        source_list = list(sources)
    if not source_list:
        raise ValueError("At least one video Source is required")

    dur = float(duration if duration is not None else getattr(recipe, "duration", CANVAS_SECONDS))
    dur = max(3.0, min(24.0, dur))
    n_frames = int(round(dur * CANVAS_FPS))

    audio_curves: FrameAudioCurves | None = None
    if audio_path and isinstance(audio_path, str):
        try:
            audio_curves = extract_frame_curves(
                audio_path,
                n_frames=n_frames,
                fps=CANVAS_FPS,
                start_sec=audio_start_sec,
            )
        except Exception:
            audio_curves = None

    beat_dur = 60.0 / recipe.bpm
    rng = random.Random(recipe.seed + 991)

    # Shuffle clip order per render so montages don't always start with clip #1.
    # Skipped when the caller (e.g. the Studio UI) supplies an explicit order.
    if shuffle_order and len(source_list) > 1:
        rng.shuffle(source_list)

    # Effective playback direction
    effective_direction = (
        clip_direction
        if clip_direction is not None
        else getattr(recipe, "clip_direction", "forward") or "forward"
    )

    eff_cut_mode = cut_mode or getattr(recipe, "cut_mode", "steady") or "steady"
    eff_ensure_all = ensure_all_clips if ensure_all_clips is not None else getattr(recipe, "ensure_all_clips", True)
    eff_trans_mode = transition_mode or getattr(recipe, "transition_mode", "cycle") or "cycle"
    eff_trans_frames = max(4, min(30, int(trans_frames if trans_frames is not None else getattr(recipe, "trans_frames", 12))))

    raw_pool = transitions if transitions is not None else getattr(recipe, "transitions", None)
    pool = [t for t in (raw_pool or []) if t in ALL_TRANSITIONS or t == "dissolve"]
    if not pool:
        pool = [recipe.transition] if eff_trans_mode == "single" else list(ALL_TRANSITIONS)

    # Filter mode resolution
    eff_filter_mode = filter_mode or getattr(recipe, "filter_mode", "global") or "global"
    eff_clip_effects = clip_effects if clip_effects is not None else getattr(recipe, "clip_effects", None) or {}
    base_fx_names = [name for name, _, _ in recipe.effects]
    preset_keys = list(PRESETS.keys())

    # Calculate granular beat intervals
    cut_seconds = max(0.30, float(recipe.cut_beats) * beat_dur)
    cut_frames = max(10, int(round(cut_seconds * CANVAS_FPS)))

    bounds = _compute_segment_bounds(
        n_frames=n_frames,
        cut_frames=cut_frames,
        n_clips=len(source_list),
        cut_mode=eff_cut_mode,
        ensure_all=eff_ensure_all,
        audio_curves=audio_curves,
        rng=rng,
    )

    max_seg_len = max(end - start for start, end in bounds) if bounds else cut_frames
    segments: list[SegmentSlice] = []
    source_pool: dict[str, list[np.ndarray]] = {}
    for src in source_list:
        needed_src_frames = max(36, int((max(cut_frames, max_seg_len) + 16) * speed * 1.35) + 4)
        max_start = max(0, src.frame_count - needed_src_frames - 5)
        start_frame = rng.randint(0, max_start) if max_start > 10 else 0
        source_pool[src.path] = GLOBAL_CACHE.load_segment(
            src,
            start_frame=start_frame,
            count=needed_src_frames,
            target_w=width,
            target_h=height,
        )

    prev_trans: str | None = None
    for seg_idx, (start_f, end_f) in enumerate(bounds):
        src = source_list[seg_idx % len(source_list)]
        clip_slot = seg_idx % len(source_list)
        clip_idx = seg_idx + 1

        seg_speed = speed
        pool_frames = source_pool[src.path]
        cycle = seg_idx // len(source_list)
        offset = (cycle * 12) % max(1, len(pool_frames) // 3)
        sliced_frames = pool_frames[offset:] + pool_frames[:offset]

        seg_dir = effective_direction
        if effective_direction == "reverse":
            sliced_frames = sliced_frames[::-1]
            seg_dir = "reverse"
        elif effective_direction == "alternate":
            if clip_idx % 2 == 1:
                sliced_frames = sliced_frames[::-1]
                seg_dir = "reverse"
            else:
                seg_dir = "forward"
        elif effective_direction == "chaos":
            seg_dir = rng.choice(["forward", "reverse", "pingpong"])
            if seg_dir == "reverse":
                sliced_frames = sliced_frames[::-1]
            elif seg_dir == "pingpong":
                sliced_frames = sliced_frames + sliced_frames[::-1]
        elif effective_direction == "pingpong":
            sliced_frames = sliced_frames + sliced_frames[::-1]
            seg_dir = "pingpong"

        if eff_trans_mode == "single" and len(pool) >= 1:
            seg_trans = pool[0]
        elif eff_trans_mode == "cycle":
            seg_trans = pool[seg_idx % len(pool)]
        else:
            candidates = [t for t in pool if t != prev_trans] or pool
            seg_trans = rng.choice(candidates)
        prev_trans = seg_trans

        # Precompute per-source or per-segment effect stacks
        if eff_filter_mode == "global":
            seg_effects = None
            seg_fx_names = list(base_fx_names)
        elif eff_filter_mode == "per_clip":
            custom_list = (
                eff_clip_effects.get(src.path)
                or eff_clip_effects.get(os.path.basename(src.path))
                or eff_clip_effects.get(str(clip_slot))
                or eff_clip_effects.get(f"clip_{clip_slot}")
            )
            if custom_list:
                seg_fx_names = list(custom_list)
            else:
                seg_fx_names = evolve_effect_names(base_fx_names, clip_slot, recipe.seed)
            seg_effects = build_effect_stack(
                seg_fx_names,
                seed=recipe.seed + clip_slot * 313,
                intensity=recipe.intensity,
            )
        elif eff_filter_mode == "preset_cycle":
            custom_list = (
                eff_clip_effects.get(src.path)
                or eff_clip_effects.get(os.path.basename(src.path))
                or eff_clip_effects.get(str(clip_slot))
                or eff_clip_effects.get(f"clip_{clip_slot}")
            )
            if custom_list:
                seg_fx_names = list(custom_list)
            else:
                if clip_slot == 0:
                    seg_fx_names = list(base_fx_names)
                else:
                    if recipe.preset in preset_keys:
                        preset_id = preset_keys[(preset_keys.index(recipe.preset) + clip_slot * 3) % len(preset_keys)]
                    else:
                        preset_id = preset_keys[(recipe.seed + clip_slot * 3) % len(preset_keys)]
                    seg_fx_names = list(PRESETS[preset_id]["effects"])
            seg_effects = build_effect_stack(
                seg_fx_names,
                seed=recipe.seed + clip_slot * 509,
                intensity=recipe.intensity,
            )
        else:  # eff_filter_mode == "evolve"
            seg_fx_names = evolve_effect_names(base_fx_names, seg_idx, recipe.seed)
            seg_effects = build_effect_stack(
                seg_fx_names,
                seed=recipe.seed + seg_idx * 409,
                intensity=recipe.intensity,
            )

        segments.append(
            SegmentSlice(
                source=src,
                frames=sliced_frames,
                start_canvas_frame=start_f,
                end_canvas_frame=end_f,
                speed=seg_speed,
                direction=seg_dir,
                transition=seg_trans,
                trans_frames=eff_trans_frames,
                effects=seg_effects,
                effect_names=seg_fx_names,
            )
        )

    return RenderPlan(
        sources=source_list,
        recipe=recipe,
        segments=segments,
        n_frames=n_frames,
        beat_dur=beat_dur,
        width=width,
        height=height,
        audio_curves=audio_curves,
    )
