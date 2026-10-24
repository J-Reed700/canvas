"""Audio-reactive Spotify Canvas and shader studio."""
from __future__ import annotations

__version__ = "4.0.0"

from .audio import AudioProfile, FrameAudioCurves, analyze_track, extract_frame_curves
from .compositor import CANVAS_FPS, CANVAS_H, CANVAS_SECONDS, CANVAS_W, RenderPlan, build_plan
from .effects import EFFECTS
from .encoder import Encoder, mux_audio_preview
from .recipe import PRESETS, Recipe, make_recipe
from .source import Source, extract_thumbnail_jpeg, fit_portrait, probe

__all__ = [
    "__version__",
    "AudioProfile",
    "FrameAudioCurves",
    "analyze_track",
    "extract_frame_curves",
    "CANVAS_FPS",
    "CANVAS_H",
    "CANVAS_SECONDS",
    "CANVAS_W",
    "RenderPlan",
    "build_plan",
    "EFFECTS",
    "Encoder",
    "mux_audio_preview",
    "PRESETS",
    "Recipe",
    "make_recipe",
    "Source",
    "extract_thumbnail_jpeg",
    "fit_portrait",
    "probe",
]
