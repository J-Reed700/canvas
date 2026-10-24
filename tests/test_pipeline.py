from __future__ import annotations

import unittest
import numpy as np

from downbeat import EFFECTS, PRESETS, make_recipe
from downbeat.compositor import _blend_transition
from downbeat.source import fit_portrait


class TestDownbeatPipeline(unittest.TestCase):
    def setUp(self) -> None:
        rng = np.random.default_rng(2026)
        self.frame_a = rng.integers(0, 256, (320, 180, 3), dtype=np.uint8)
        self.frame_b = rng.integers(0, 256, (320, 180, 3), dtype=np.uint8)

    def test_all_19_shaders_preserve_shape_and_dtype(self) -> None:
        self.assertGreaterEqual(len(EFFECTS), 46)
        recipe = make_recipe(seed=42, bpm=128, effect_names=list(EFFECTS.keys()))
        fn_map = {name: (fn, kw) for name, fn, kw in recipe.effects}
        for name, meta in EFFECTS.items():
            fn, kw = fn_map[name]
            out_clock = fn(self.frame_a, t=0.35, beat_dur=0.46875, **kw)
            self.assertEqual(out_clock.shape, self.frame_a.shape, f"{name} changed shape")
            self.assertEqual(out_clock.dtype, np.uint8, f"{name} changed dtype")

            audio_kw = {**kw, "_sub": 0.92, "_transient": 0.85, "_air": 0.74, "_rms": 0.88}
            out_audio = fn(self.frame_a, t=0.35, beat_dur=0.46875, **audio_kw)
            self.assertEqual(out_audio.shape, self.frame_a.shape)
            self.assertEqual(out_audio.dtype, np.uint8)

    def test_all_curated_presets_and_spotify_duration_bounds(self) -> None:
        self.assertGreaterEqual(len(PRESETS), 18)
        for preset_id in PRESETS:
            rec = make_recipe(seed=777, preset=preset_id, duration=12.0)
            self.assertEqual(rec.preset, preset_id)
            self.assertLessEqual(rec.duration, 8.0)
            self.assertGreaterEqual(rec.duration, 3.0)
            self.assertGreaterEqual(len(rec.effects), 4)

    def test_all_transitions_including_optical_flow_datamosh(self) -> None:
        all_modes = (
            "datamosh",
            "flash",
            "dissolve",
            "whip",
            "whip_horiz",
            "glitch",
            "luma",
            "zoom_punch",
            "spin_vortex",
            "prism_split",
            "pixelate",
            "iris_wipe",
            "burn_luma",
            "shutter_slice",
            "kaleido_twist",
        )
        for mode in all_modes:
            blended = _blend_transition(self.frame_a, self.frame_b, alpha=0.5, mode=mode)
            self.assertEqual(blended.shape, self.frame_a.shape, f"transition {mode} shape mismatch")
            self.assertEqual(blended.dtype, np.uint8, f"transition {mode} dtype mismatch")

    def test_clip_directions_and_order_preservation(self) -> None:
        from downbeat.compositor import build_plan
        from downbeat.source import GLOBAL_CACHE, Source

        src_a = Source(path="mock_a.mp4", width=180, height=320, fps=30.0, frame_count=60, duration=2.0)
        src_b = Source(path="mock_b.mp4", width=180, height=320, fps=30.0, frame_count=60, duration=2.0)
        frames_a = [np.full((320, 180, 3), i, dtype=np.uint8) for i in range(60)]
        frames_b = [np.full((320, 180, 3), 200 - i, dtype=np.uint8) for i in range(60)]

        orig_load = GLOBAL_CACHE.load_segment
        try:
            GLOBAL_CACHE.load_segment = lambda src, start_frame, count, target_w, target_h, **kw: (
                frames_a[:count] if src.path == "mock_a.mp4" else frames_b[:count]
            )
            for direction in ("forward", "reverse", "alternate", "pingpong", "chaos"):
                rec = make_recipe(seed=101, bpm=120, preset="hypnotic", clip_direction=direction, duration=4.0)
                plan = build_plan([src_a, src_b], rec, width=180, height=320, duration=4.0, shuffle_order=False)
                self.assertEqual(plan.sources[0].path, "mock_a.mp4")
                self.assertEqual(plan.sources[1].path, "mock_b.mp4")
                out0 = plan.render(0)
                self.assertEqual(out0.shape, (320, 180, 3))
        finally:
            GLOBAL_CACHE.load_segment = orig_load

    def test_photosensitive_transitions_no_flash(self) -> None:
        black = np.zeros((100, 100, 3), dtype=np.uint8)
        for mode in ("flash", "dissolve"):
            mid = _blend_transition(black, black, alpha=0.5, mode=mode)
            self.assertLessEqual(float(mid.mean()), 10.0)

    def test_photosensitive_slew_limiter_and_determinism(self) -> None:
        from downbeat.compositor import RenderPlan, SegmentSlice
        import cv2

        class DummySource:
            path = "dummy"
            frame_count = 100

        black = np.zeros((120, 100, 3), dtype=np.uint8)
        white = np.full((120, 100, 3), 255, dtype=np.uint8)
        strobe_frames = [black, white] * 20

        rec = make_recipe(seed=42, preset="hypnotic")
        rec.effects = []
        seg = SegmentSlice(source=DummySource(), frames=strobe_frames, start_canvas_frame=0, end_canvas_frame=20, speed=1.0)
        plan = RenderPlan(sources=[DummySource()], recipe=rec, segments=[seg], n_frames=20, beat_dur=0.5)

        rendered_first_pass = []
        last_luma = None
        for i in range(20):
            frame = plan.render(i)
            rendered_first_pass.append(frame.copy())
            b, g, r, _ = cv2.mean(frame)
            luma = 0.114 * b + 0.587 * g + 0.299 * r
            if last_luma is not None:
                delta = abs(luma - last_luma)
                self.assertLessEqual(delta, 18.05, f"Frame {i} delta {delta} exceeded 18.0 max slew")
            last_luma = luma

        for i in range(20):
            frame = plan.render(i)
            np.testing.assert_array_equal(frame, rendered_first_pass[i], f"Frame {i} non-deterministic")

    def test_preset_photosafety_defaults(self) -> None:
        for pid, p in PRESETS.items():
            self.assertGreaterEqual(p["cut_beats"], 4, f"Preset {pid} cut_beats < 4")
        self.assertEqual(PRESETS["dark_cinema"]["cut_beats"], 8)
        self.assertEqual(PRESETS["liquid_dream"]["cut_beats"], 8)
        self.assertNotIn("flash", PRESETS["kaleido"]["effects"])
        self.assertIn("vignette", PRESETS["kaleido"]["effects"])
        self.assertEqual(PRESETS["hypnotic"]["transition"], "luma")

    def test_portrait_cover_crop(self) -> None:
        wide = np.zeros((1080, 1920, 3), dtype=np.uint8)
        cropped = fit_portrait(wide, 540, 960, pan_x=0.3)
        self.assertEqual(cropped.shape, (960, 540, 3))

    def test_chaos_seed_randomizes_shader_subparameters(self) -> None:
        rec1 = make_recipe(seed=1001, bpm=128, effect_names=list(EFFECTS.keys()), intensity=1.35)
        rec2 = make_recipe(seed=9999, bpm=128, effect_names=list(EFFECTS.keys()), intensity=1.35)
        kw_map1 = {name: kw for name, _, kw in rec1.effects}
        kw_map2 = {name: kw for name, _, kw in rec2.effects}
        self.assertIn("max_deg", kw_map1["pendulum_sway"])
        self.assertIn("twist", kw_map1["vortex_twirl"])
        self.assertIn("slices", kw_map1["kaleido_hex"])
        self.assertIn("grid", kw_map1["grid_clone"])
        self.assertIn("bands", kw_map1["ribbon_split"])
        self.assertIn("strength", kw_map1["anamorphic_flare"])
        self.assertIn("focus_height", kw_map1["tilt_shift"])
        self.assertIn("offset", kw_map1["double_vision"])
        self.assertIn("block_size", kw_map1["rgb_mosaic"])
        self.assertIn("palette", kw_map1["duotone_acid"])
        self.assertIn("palette", kw_map1["thermal_infrared"])
        self.assertIn("intensity", kw_map1["bass_vignette_punch"])
        self.assertNotEqual(kw_map1, kw_map2)

    def test_granular_cuts_fit_all_clips_and_multi_transitions(self) -> None:
        from downbeat.compositor import build_plan
        from downbeat.source import GLOBAL_CACHE, Source

        sources = [
            Source(path=f"mock_{k}.mp4", width=180, height=320, fps=30.0, frame_count=90, duration=3.0)
            for k in range(4)
        ]
        mock_frames = [np.full((320, 180, 3), 100, dtype=np.uint8) for _ in range(90)]
        orig_load = GLOBAL_CACHE.load_segment
        try:
            GLOBAL_CACHE.load_segment = lambda src, start_frame, count, target_w, target_h, **kw: mock_frames[:count]

            pool = ["luma", "datamosh", "whip", "prism_split", "zoom_punch", "kaleido_twist"]
            rec = make_recipe(
                seed=2026,
                bpm=130,
                cut_beats=8.0,
                cut_mode="steady",
                ensure_all_clips=True,
                transitions=pool,
                transition_mode="random",
                trans_frames=10,
                loop_mode="morph",
            )
            plan = build_plan(sources, rec, width=180, height=320, duration=8.0, shuffle_order=False)
            self.assertGreaterEqual(len(plan.segments), 4)
            covered_paths = {seg.source.path for seg in plan.segments}
            self.assertEqual(len(covered_paths), 4)

            for idx in range(1, len(plan.segments)):
                self.assertNotEqual(plan.segments[idx].transition, plan.segments[idx - 1].transition)

            for mode in ("steady", "fit_all", "fit_all_2x", "build_up", "syncopated", "transient", "chaos"):
                rec_m = make_recipe(
                    seed=55,
                    bpm=128,
                    cut_beats=1.75,
                    cut_mode=mode,
                    ensure_all_clips=True,
                    transitions=pool,
                    transition_mode="cycle",
                )
                plan_m = build_plan(sources, rec_m, width=180, height=320, duration=8.0, shuffle_order=False)
                self.assertGreaterEqual(len(plan_m.segments), 4, f"mode {mode} dropped clips")
                self.assertEqual(plan_m.segments[0].transition, "luma")
                self.assertEqual(plan_m.segments[1].transition, "datamosh")
        finally:
            GLOBAL_CACHE.load_segment = orig_load

    def test_per_video_filters_modes_and_transition_blending(self) -> None:
        from downbeat.compositor import build_plan
        from downbeat.source import GLOBAL_CACHE, Source

        sources = [
            Source(path=f"mock_{k}.mp4", width=180, height=320, fps=30.0, frame_count=90, duration=3.0)
            for k in range(3)
        ]
        mock_frames = [np.full((320, 180, 3), (50 + k * 2) % 250, dtype=np.uint8) for k in range(90)]
        orig_load = GLOBAL_CACHE.load_segment
        try:
            GLOBAL_CACHE.load_segment = lambda src, start_frame, count, target_w, target_h, **kw: mock_frames[:count]

            custom_clip_fx = {
                "mock_0.mp4": ["zoom_pulse", "cyberpunk_grade", "vignette"],
                "mock_1.mp4": ["pendulum_sway", "golden_hour", "film_burn"],
            }

            for mode in ("global", "evolve", "preset_cycle", "per_clip"):
                rec = make_recipe(
                    seed=2026,
                    bpm=128,
                    preset="hypnotic",
                    filter_mode=mode,
                    clip_effects=custom_clip_fx,
                    cut_beats=2.0,
                    cut_mode="steady",
                    transitions=["flash", "luma", "dissolve"],
                    transition_mode="cycle",
                    trans_frames=8,
                    duration=6.0,
                )
                self.assertEqual(rec.filter_mode, mode)
                self.assertEqual(rec.clip_effects, custom_clip_fx)
                rec_dict = rec.to_dict()
                self.assertEqual(rec_dict["filter_mode"], mode)
                self.assertEqual(rec_dict["clip_effects"], custom_clip_fx)

                plan = build_plan(
                    sources,
                    rec,
                    width=180,
                    height=320,
                    duration=6.0,
                    shuffle_order=False,
                )
                self.assertGreaterEqual(len(plan.segments), 2)

                if mode == "global":
                    self.assertIsNone(plan.segments[0].effects)
                    self.assertIsNone(plan.segments[1].effects)
                    base_names = [name for name, _, _ in rec.effects]
                    self.assertEqual(plan.segments[0].effect_names, base_names)
                    self.assertEqual(plan.segments[1].effect_names, base_names)
                elif mode == "per_clip":
                    self.assertIsNotNone(plan.segments[0].effects)
                    self.assertIsNotNone(plan.segments[1].effects)
                    self.assertEqual(plan.segments[0].effect_names, ["zoom_pulse", "cyberpunk_grade", "vignette"])
                    self.assertEqual(plan.segments[1].effect_names, ["pendulum_sway", "golden_hour", "film_burn"])
                    self.assertNotEqual(plan.segments[0].effect_names, plan.segments[1].effect_names)
                elif mode == "evolve":
                    self.assertIsNotNone(plan.segments[0].effects)
                    self.assertIsNotNone(plan.segments[1].effects)
                    self.assertNotEqual(plan.segments[0].effect_names, plan.segments[1].effect_names)
                    self.assertGreaterEqual(len(plan.segments[1].effect_names), 4)
                elif mode == "preset_cycle":
                    self.assertIsNotNone(plan.segments[0].effects)
                    self.assertIsNotNone(plan.segments[1].effects)
                    self.assertNotEqual(plan.segments[0].effect_names, plan.segments[1].effect_names)

                for i in range(min(45, plan.n_frames)):
                    frame = plan.render(i)
                    self.assertEqual(frame.shape, (320, 180, 3), f"Mode {mode} frame {i} bad shape")
                    self.assertEqual(frame.dtype, np.uint8, f"Mode {mode} frame {i} bad dtype")

                trans_frame_idx = plan.segments[1].start_canvas_frame + 2
                trans_out = plan.render(trans_frame_idx)
                self.assertEqual(trans_out.shape, (320, 180, 3))
                self.assertEqual(trans_out.dtype, np.uint8)
        finally:
            GLOBAL_CACHE.load_segment = orig_load


if __name__ == "__main__":
    unittest.main()
