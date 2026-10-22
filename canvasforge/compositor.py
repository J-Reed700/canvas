"""Multi-clip beat-synced & audio-reactive timeline compositor for Spotify Canvas (1080x1920 @ 30fps).

Strictly enforces Spotify Canvas duration limits (3.0s - 8.0s, default 8.0s = 240 frames)
and supports 3 loop topologies (`crossfade`, `rebound`, `hard`) + 5 transition modes
including Optical Flow Datamoshing (`datamosh`).
"""
from __future__ import annotations

import dataclasses
import random

import cv2
import numpy as np

from .audio import FrameAudioCurves, extract_frame_curves
from .recipe import Recipe
from .source import GLOBAL_CACHE, Source

CANVAS_FPS = 30
CANVAS_SECONDS = 8.0  # Official Spotify Canvas max duration (3.0s - 8.0s)
CANVAS_W, CANVAS_H = 1080, 1920

_FLOW_GRID_CACHE: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}


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
    """Blend outgoing clip `frame_a` -> incoming clip `frame_b` over alpha in [0, 1]."""
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
        trans_frames = 12  # 400ms transition
        if len(self.segments) > 1 and local_i < trans_frames and eff_i >= trans_frames:
            prev_seg = self.segments[(seg_idx - 1) % len(self.segments)]
            prev_local = (prev_seg.end_canvas_frame - prev_seg.start_canvas_frame) + local_i
            frame_prev = prev_seg.frames[min(len(prev_seg.frames) - 1, int(prev_local * prev_seg.speed) % len(prev_seg.frames))]
            alpha = (local_i + 1) / (trans_frames + 1)
            return _blend_transition(frame_prev, frame_curr, alpha, self.recipe.transition)

        # Seamless loop crossfade in the final 10 frames back to frame 0 (when loop_mode == "crossfade")
        if loop_mode == "crossfade":
            loop_tail = 10
            if i >= self.n_frames - loop_tail:
                first_seg = self.segments[0]
                tail_offset = i - (self.n_frames - loop_tail)
                alpha = (tail_offset + 1) / (loop_tail + 1)
                frame_zero = first_seg.frames[0]
                return cv2.addWeighted(frame_curr, 1.0 - alpha, frame_zero, alpha, 0)

        return frame_curr

    def render(self, i: int) -> np.ndarray:
        """Render canvas frame `i` with full beat-synced & audio-reactive effect stack."""
        t = i / CANVAS_FPS
        frame = self._raw_frame_at(i)
        audio_kw: dict[str, float] = {}
        if self.audio_curves is not None and 0 <= i < self.n_frames:
            audio_kw = {
                "_sub": float(self.audio_curves.sub_bass[i]),
                "_transient": float(self.audio_curves.transient[i]),
                "_air": float(self.audio_curves.high_air[i]),
                "_rms": float(self.audio_curves.rms[i]),
            }
        for _name, fn, kw in self.recipe.effects:
            if audio_kw:
                merged = {**kw, **audio_kw}
                frame = fn(frame, t, self.beat_dur, **merged)
            else:
                frame = fn(frame, t, self.beat_dur, **kw)
        return self.limit_luminance_slew(frame, i)


def build_plan(
    sources: Source | list[Source],
    recipe: Recipe,
    speed: float = 1.0,
    width: int = CANVAS_W,
    height: int = CANVAS_H,
    duration: float | None = None,
    audio_path: str | None = None,
    audio_start_sec: float | None = None,
) -> RenderPlan:
    if isinstance(sources, Source):
        source_list = [sources]
    else:
        source_list = list(sources)
    if not source_list:
        raise ValueError("At least one video Source is required")

    dur = float(duration if duration is not None else getattr(recipe, "duration", CANVAS_SECONDS))
    dur = max(3.0, min(8.0, dur))
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

    # Calculate beat-locked cut intervals
    cut_seconds = max(0.65, recipe.cut_beats * beat_dur)
    cut_frames = max(16, int(round(cut_seconds * CANVAS_FPS)))

    segments: list[SegmentSlice] = []
    source_pool: dict[str, list[np.ndarray]] = {}
    for src in source_list:
        needed_src_frames = max(36, int((cut_frames + 16) * speed * 1.35) + 4)
        max_start = max(0, src.frame_count - needed_src_frames - 5)
        start_frame = rng.randint(0, max_start) if max_start > 10 else 0
        source_pool[src.path] = GLOBAL_CACHE.load_segment(
            src,
            start_frame=start_frame,
            count=needed_src_frames,
            target_w=width,
            target_h=height,
        )

    cursor = 0
    clip_idx = 0
    while cursor < n_frames:
        end = min(n_frames, cursor + cut_frames)
        if n_frames - end < 12:
            end = n_frames
        src = source_list[clip_idx % len(source_list)]
        clip_idx += 1

        seg_speed = speed
        pool_frames = source_pool[src.path]
        cycle = (clip_idx - 1) // len(source_list)
        offset = (cycle * 12) % max(1, len(pool_frames) // 3)
        sliced_frames = pool_frames[offset:] + pool_frames[:offset]

        segments.append(
            SegmentSlice(
                source=src,
                frames=sliced_frames,
                start_canvas_frame=cursor,
                end_canvas_frame=end,
                speed=seg_speed,
            )
        )
        cursor = end

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
