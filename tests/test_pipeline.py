"""Automated test suite for Canvas Forge v2.5 (shaders, transitions, recipes, loop topologies)."""
from __future__ import annotations

import unittest
import numpy as np

from canvasforge import EFFECTS, PRESETS, make_recipe
from canvasforge.compositor import _blend_transition
from canvasforge.source import fit_portrait


class TestCanvasForgePipeline(unittest.TestCase):
    def setUp(self) -> None:
        rng = np.random.default_rng(2026)
        self.frame_a = rng.integers(0, 256, (320, 180, 3), dtype=np.uint8)
        self.frame_b = rng.integers(0, 256, (320, 180, 3), dtype=np.uint8)

    def test_all_19_shaders_preserve_shape_and_dtype(self) -> None:
        self.assertGreaterEqual(len(EFFECTS), 19)
        recipe = make_recipe(seed=42, bpm=128, effect_names=list(EFFECTS.keys()))
        fn_map = {name: (fn, kw) for name, fn, kw in recipe.effects}
        for name, meta in EFFECTS.items():
            fn, kw = fn_map[name]
            out_clock = fn(self.frame_a, t=0.35, beat_dur=0.46875, **kw)
            self.assertEqual(out_clock.shape, self.frame_a.shape, f"{name} changed shape")
            self.assertEqual(out_clock.dtype, np.uint8, f"{name} changed dtype")

            # Also verify audio-reactive modulation kwargs
            audio_kw = {**kw, "_sub": 0.92, "_transient": 0.85, "_air": 0.74, "_rms": 0.88}
            out_audio = fn(self.frame_a, t=0.35, beat_dur=0.46875, **audio_kw)
            self.assertEqual(out_audio.shape, self.frame_a.shape)
            self.assertEqual(out_audio.dtype, np.uint8)

    def test_all_curated_presets_and_spotify_duration_bounds(self) -> None:
        for preset_id in PRESETS:
            rec = make_recipe(seed=777, preset=preset_id, duration=12.0)
            self.assertEqual(rec.preset, preset_id)
            self.assertLessEqual(rec.duration, 8.0)
            self.assertGreaterEqual(rec.duration, 3.0)
            self.assertGreaterEqual(len(rec.effects), 4)

    def test_all_transitions_including_optical_flow_datamosh(self) -> None:
        for mode in ("datamosh", "flash", "whip", "glitch", "luma"):
            blended = _blend_transition(self.frame_a, self.frame_b, alpha=0.5, mode=mode)
            self.assertEqual(blended.shape, self.frame_a.shape, f"transition {mode} shape mismatch")
            self.assertEqual(blended.dtype, np.uint8, f"transition {mode} dtype mismatch")

    def test_portrait_cover_crop(self) -> None:
        wide = np.zeros((1080, 1920, 3), dtype=np.uint8)
        cropped = fit_portrait(wide, 540, 960, pan_x=0.3)
        self.assertEqual(cropped.shape, (960, 540, 3))


if __name__ == "__main__":
    unittest.main()
