"""Seeded recipe generation and curated style presets for Canvas Forge."""
from __future__ import annotations

import dataclasses
import random
from typing import Callable

from . import effects

WEIGHTS = {
    # Original 19
    "zoom_pulse": 1.0,
    "beat_bounce": 0.85,
    "liquid_warp": 0.75,
    "mirror_quad": 0.65,
    "prism_echo": 0.8,
    "neon_bloom": 0.9,
    "crt_halation": 0.85,
    "chroma_pulse": 0.85,
    "bayer_dither": 0.55,
    "edge_neon": 0.60,
    "glitch": 0.65,
    "solarize_pulse": 0.45,
    "hue_cycle": 0.5,
    "color_grade": 1.0,
    "vignette": 0.85,
    "scanlines": 0.45,
    "grain": 0.75,
    "flash": 0.65,
    "letterbox": 0.25,
    # Motion
    "pendulum_sway": 0.70,
    "shockwave_ripple": 0.75,
    "slit_scan": 0.50,
    "gravity_droop": 0.50,
    "vortex_twirl": 0.60,
    # Geometry
    "kaleido_hex": 0.65,
    "grid_clone": 0.60,
    "fractal_tunnel": 0.65,
    "ribbon_split": 0.55,
    "polar_tunnel": 0.50,
    # Optics
    "anamorphic_flare": 0.85,
    "star_glint": 0.70,
    "tilt_shift": 0.65,
    "fisheye_lens": 0.70,
    "radial_zoom_blur": 0.75,
    "double_vision": 0.60,
    # Digital
    "pixel_sort": 0.70,
    "ascii_matrix": 0.60,
    "rgb_mosaic": 0.50,
    "vhs_tracking": 0.65,
    "datamosh_smear": 0.65,
    # Color
    "duotone_acid": 0.70,
    "thermal_infrared": 0.60,
    "bleach_bypass": 0.75,
    "cyberpunk_grade": 0.85,
    "golden_hour": 0.80,
    "sepia_noir": 0.55,
    "posterize_pop": 0.60,
    # Texture
    "film_burn": 0.75,
    "halftone_dots": 0.55,
    "frost_mist": 0.70,
    # Impact
    "strobe_shutter": 0.45,
    "bass_vignette_punch": 0.75,
}

PRESETS = {
    # 7 Original Curated Presets
    "hypnotic": {
        "label": "Hypnotic Tunnel",
        "desc": "Beat-synced zoom kicks, prismatic echoes, neon bloom & seamless multi-clip cuts",
        "effects": ["zoom_pulse", "prism_echo", "neon_bloom", "chroma_pulse", "color_grade", "vignette"],
        "cut_beats": 4,
        "transition": "luma",
    },
    "acid_dither": {
        "label": "Acid Dither 2026",
        "desc": "Ordered 4x4 Bayer matrix dithering, glowing cyber-sigil contours, CRT halation & scanlines",
        "effects": ["zoom_pulse", "bayer_dither", "edge_neon", "crt_halation", "scanlines", "color_grade"],
        "cut_beats": 4,
        "transition": "glitch",
    },
    "crt_melt": {
        "label": "Analog CRT Melt",
        "desc": "Sub-bass liquid UV wave displacement, warm red-orange CRT phosphor halation & 35mm grain",
        "effects": ["zoom_pulse", "liquid_warp", "crt_halation", "chroma_pulse", "scanlines", "grain"],
        "cut_beats": 4,
        "transition": "datamosh",
    },
    "kaleido": {
        "label": "Kaleido Rave",
        "desc": "4-way symmetrical geometry flips on the bar with acid hue drift & strobe impacts",
        "effects": ["zoom_pulse", "mirror_quad", "neon_bloom", "hue_cycle", "chroma_pulse", "vignette"],
        "cut_beats": 4,
        "transition": "whip",
    },
    "cyber_glitch": {
        "label": "Cyber Glitch",
        "desc": "Aggressive slice displacement, RGB split, cyber contours & rapid 2-beat datamosh cuts",
        "effects": ["zoom_pulse", "beat_bounce", "glitch", "edge_neon", "chroma_pulse", "color_grade"],
        "cut_beats": 4,
        "transition": "datamosh",
    },
    "liquid_dream": {
        "label": "Liquid Acid",
        "desc": "Fluid UV wave warp, solarize highlights, prism trails & warm analog halation",
        "effects": ["zoom_pulse", "liquid_warp", "prism_echo", "crt_halation", "solarize_pulse", "color_grade"],
        "cut_beats": 8,
        "transition": "luma",
    },
    "dark_cinema": {
        "label": "Dark Cinema",
        "desc": "Moody anamorphic contrast grade, subtle beat shake, film halation glow & heavy vignette",
        "effects": ["zoom_pulse", "beat_bounce", "crt_halation", "color_grade", "grain", "vignette"],
        "cut_beats": 8,
        "transition": "luma",
    },
    # Additional Curated Presets
    "anamorphic_flare": {
        "label": "Blade Runner Flare",
        "desc": "Horizontal cyan anamorphic lens streaks, neon cyberpunk split-tone & prism trails",
        "effects": ["zoom_pulse", "anamorphic_flare", "cyberpunk_grade", "prism_echo", "grain", "letterbox"],
        "cut_beats": 4,
        "transition": "prism_split",
    },
    "thermal_rave": {
        "label": "Thermal Predator",
        "desc": "Infrared FLIR heat-vision color map, shockwave bass ripples & cyber contours",
        "effects": ["zoom_pulse", "shockwave_ripple", "thermal_infrared", "edge_neon", "scanlines", "vignette"],
        "cut_beats": 4,
        "transition": "glitch",
    },
    "vhs_99": {
        "label": "1999 VHS Camcorder",
        "desc": "Skate fisheye barrel lens, VHS tape tracking noise, chroma bleed & CRT halation",
        "effects": ["beat_bounce", "fisheye_lens", "vhs_tracking", "crt_halation", "grain", "vignette"],
        "cut_beats": 4,
        "transition": "whip",
    },
    "super8_burn": {
        "label": "Super-8 Film Burn",
        "desc": "Kodak golden hour grade, organic 16mm amber light-leak burns & pendulum sway",
        "effects": ["pendulum_sway", "golden_hour", "film_burn", "crt_halation", "grain", "vignette"],
        "cut_beats": 8,
        "transition": "burn_luma",
    },
    "pixel_melt": {
        "label": "Pixel Sort Acid",
        "desc": "Luminance pixel-sorting streaks, acid duotone gradient map & 4x4 Bayer dither",
        "effects": ["zoom_pulse", "pixel_sort", "duotone_acid", "bayer_dither", "chroma_pulse", "vignette"],
        "cut_beats": 4,
        "transition": "pixelate",
    },
    "hex_portal": {
        "label": "Hex Kaleido Portal",
        "desc": "6-fold radial kaleidoscope symmetry, 4-point star filter glints & neon bloom",
        "effects": ["zoom_pulse", "kaleido_hex", "star_glint", "neon_bloom", "hue_cycle", "vignette"],
        "cut_beats": 4,
        "transition": "kaleido_twist",
    },
    "fractal_void": {
        "label": "Infinite Fractal Void",
        "desc": "Recursive picture-in-picture tunnel, vortex twist, bleach bypass & bass rim-punch",
        "effects": ["fractal_tunnel", "vortex_twirl", "bleach_bypass", "edge_neon", "bass_vignette_punch", "vignette"],
        "cut_beats": 4,
        "transition": "zoom_punch",
    },
    "pop_halftone": {
        "label": "Warhol Halftone Pop",
        "desc": "CMYK halftone dot screen, silkscreen posterize pop colors & ribbon slices",
        "effects": ["beat_bounce", "ribbon_split", "posterize_pop", "halftone_dots", "chroma_pulse", "grain"],
        "cut_beats": 4,
        "transition": "shutter_slice",
    },
    "matrix_sigil": {
        "label": "Matrix Cyber Terminal",
        "desc": "LED glyph dot-matrix synthesizer, glowing Sobel wireframes & datamosh smear",
        "effects": ["zoom_pulse", "ascii_matrix", "edge_neon", "datamosh_smear", "scanlines", "vignette"],
        "cut_beats": 4,
        "transition": "datamosh",
    },
    "velvet_mist": {
        "label": "Dreamy Pro-Mist Halo",
        "desc": "Ethereal highlight mist diffusion, miniature tilt-shift bokeh & star glints",
        "effects": ["pendulum_sway", "tilt_shift", "frost_mist", "star_glint", "golden_hour", "vignette"],
        "cut_beats": 8,
        "transition": "iris_wipe",
    },
    "clone_overdrive": {
        "label": "Clone Wall Overdrive",
        "desc": "Multi-tile video wall, radial zoom motion blur, double vision & neon rim-light",
        "effects": ["grid_clone", "double_vision", "radial_zoom_blur", "cyberpunk_grade", "bass_vignette_punch", "grain"],
        "cut_beats": 4,
        "transition": "whip_horiz",
    },
}


def _params(name: str, rng: random.Random, intensity: float = 1.0) -> dict:
    scale = max(0.25, min(2.0, intensity))
    params_map = {
        # Original 19 — full parameter range unlocked
        "zoom_pulse": dict(
            cx=round(rng.uniform(0.32, 0.68), 2),
            cy=round(rng.uniform(0.32, 0.68), 2),
            period=rng.choice([1.0, 2.0, 4.0]),
            kick=round(rng.uniform(0.08, 0.14) * scale, 2),
            sharp=round(rng.uniform(2.0, 3.2), 1),
        ),
        "beat_bounce": dict(
            amp=round(rng.uniform(0.018, 0.035) * scale, 3),
            sharp=round(rng.uniform(2.0, 3.2), 1),
        ),
        "liquid_warp": dict(
            amp=round(rng.uniform(8.0, 24.0) * scale, 1),
            freq=round(rng.uniform(0.008, 0.024), 4),
        ),
        "mirror_quad": dict(
            mode=rng.choice(["quad", "horiz"]),
            beat_toggle=rng.choice([True, False]),
        ),
        "prism_echo": dict(
            strength=round(rng.uniform(0.16, 0.25) * min(scale, 1.3), 2),
            expand=round(rng.uniform(0.06, 0.12) * scale, 2),
        ),
        "neon_bloom": dict(
            intensity=round(rng.uniform(0.28, 0.38) * scale, 2),
            threshold=rng.randint(75, 130),
        ),
        "crt_halation": dict(
            strength=round(rng.uniform(0.28, 0.38) * scale, 2),
        ),
        "chroma_pulse": dict(
            max_shift=round(rng.uniform(6.0, 22.0) * scale, 1),
        ),
        "bayer_dither": dict(
            levels=rng.choice([3, 4, 5, 6, 8]),
            spread=round(rng.uniform(24.0, 52.0) * scale, 1),
            mix=round(rng.uniform(0.45, 0.85), 2),
        ),
        "edge_neon": dict(
            strength=round(rng.uniform(0.45, 0.92) * scale, 2),
        ),
        "glitch": dict(
            trigger=round(max(0.12, 0.42 - 0.15 * scale), 2),
        ),
        "solarize_pulse": dict(
            period_beats=rng.choice([1.0, 2.0, 4.0]),
        ),
        "hue_cycle": dict(
            period=rng.choice([2.0, 4.0, 8.0]),
            amount=round(rng.uniform(0.30, 0.95) * scale, 2),
        ),
        "color_grade": dict(
            contrast=round(rng.uniform(1.10, 1.34), 2),
            warm=rng.randint(-14, 28),
            cool=rng.randint(-24, 20),
        ),
        "vignette": dict(
            strength=round(rng.uniform(0.40, 0.78), 2),
        ),
        "scanlines": dict(
            gap=rng.choice([2, 3, 4, 6]),
            darken=round(rng.uniform(0.62, 0.84), 2),
        ),
        "grain": dict(
            amount=int(rng.randint(10, 24) * min(scale, 1.5)),
        ),
        "flash": dict(
            amount=int(rng.randint(14, 22) * min(scale, 1.2)),
            period_beats=rng.choice([2.0, 4.0]),
            sharp=round(rng.uniform(1.8, 2.5), 1),
        ),
        "letterbox": dict(
            frac=round(rng.uniform(0.04, 0.11), 2),
        ),
        # Motion (exact kwargs matching effects.py)
        "pendulum_sway": dict(
            max_deg=round(rng.uniform(2.5, 7.5) * scale, 1),
            zoom=round(rng.uniform(1.05, 1.12), 2),
        ),
        "shockwave_ripple": dict(
            amp=round(rng.uniform(12.0, 32.0) * scale, 1),
        ),
        "slit_scan": dict(
            amp=round(rng.uniform(10.0, 28.0) * scale, 1),
            freq=round(rng.uniform(0.012, 0.036), 4),
        ),
        "gravity_droop": dict(
            amp=round(rng.uniform(16.0, 44.0) * scale, 1),
        ),
        "vortex_twirl": dict(
            twist=round(rng.choice([-1.0, 1.0]) * rng.uniform(0.65, 1.85) * scale, 2),
        ),
        # Geometry (exact kwargs matching effects.py)
        "kaleido_hex": dict(
            slices=rng.choice([4, 6, 8, 10, 12]),
            rot_speed=round(rng.choice([-1.0, 1.0]) * rng.uniform(0.25, 0.85), 2),
        ),
        "grid_clone": dict(
            grid=rng.choice([2, 3]),
        ),
        "fractal_tunnel": dict(),
        "ribbon_split": dict(
            amp=round(rng.uniform(14.0, 38.0) * scale, 1),
            bands=rng.choice([6, 8, 10, 12, 16]),
        ),
        "polar_tunnel": dict(
            mix=round(rng.uniform(0.45, 0.82), 2),
        ),
        # Optics (exact kwargs matching effects.py)
        "anamorphic_flare": dict(
            strength=round(rng.uniform(0.38, 0.72) * scale, 2),
            threshold=rng.randint(125, 175),
        ),
        "star_glint": dict(
            strength=round(rng.uniform(0.35, 0.68) * scale, 2),
            threshold=rng.randint(145, 190),
        ),
        "tilt_shift": dict(
            cy=round(rng.uniform(0.35, 0.65), 2),
            focus_height=round(rng.uniform(0.15, 0.30), 2),
        ),
        "fisheye_lens": dict(
            k=round(rng.uniform(0.18, 0.48) * scale, 2),
        ),
        "radial_zoom_blur": dict(),
        "double_vision": dict(
            offset=round(rng.uniform(12.0, 34.0) * scale, 1),
        ),
        # Digital (exact kwargs matching effects.py)
        "pixel_sort": dict(
            mix=round(rng.uniform(0.50, 0.85), 2),
            threshold=rng.randint(95, 145),
        ),
        "ascii_matrix": dict(
            mix=round(rng.uniform(0.55, 0.85), 2),
        ),
        "rgb_mosaic": dict(
            block_size=rng.choice([8, 10, 12, 16, 20]),
            mix=round(rng.uniform(0.55, 0.85), 2),
        ),
        "vhs_tracking": dict(),
        "datamosh_smear": dict(),
        # Color (exact kwargs matching effects.py)
        "duotone_acid": dict(
            palette=rng.choice(["cyber", "infrared", "acid", "vapor"]),
            mix=round(rng.uniform(0.60, 0.90), 2),
        ),
        "thermal_infrared": dict(
            palette=rng.choice(["inferno", "jet"]),
            mix=round(rng.uniform(0.65, 0.90), 2),
        ),
        "bleach_bypass": dict(
            mix=round(rng.uniform(0.55, 0.88), 2),
        ),
        "cyberpunk_grade": dict(
            mix=round(rng.uniform(0.60, 0.90), 2),
        ),
        "golden_hour": dict(
            mix=round(rng.uniform(0.65, 0.92), 2),
        ),
        "sepia_noir": dict(
            contrast=round(rng.uniform(1.15, 1.45) * scale, 2),
            mix=round(rng.uniform(0.72, 0.95), 2),
        ),
        "posterize_pop": dict(
            levels=rng.choice([3, 4, 5, 6]),
            mix=round(rng.uniform(0.65, 0.92), 2),
        ),
        # Texture (exact kwargs matching effects.py)
        "film_burn": dict(
            strength=round(rng.uniform(0.45, 0.85) * scale, 2),
        ),
        "halftone_dots": dict(
            mix=round(rng.uniform(0.45, 0.78), 2),
        ),
        "frost_mist": dict(
            strength=round(rng.uniform(0.30, 0.58) * scale, 2),
        ),
        # Impact (exact kwargs matching effects.py)
        "strobe_shutter": dict(),
        "bass_vignette_punch": dict(
            intensity=round(rng.uniform(0.42, 0.65) * scale, 2),
        ),
    }
    return params_map.get(name, {})


# Order in which effects should execute so optics/zoom happen before texture/bars
_PIPELINE_ORDER = [
    # Motion
    "zoom_pulse",
    "beat_bounce",
    "pendulum_sway",
    "liquid_warp",
    "shockwave_ripple",
    "slit_scan",
    "gravity_droop",
    "vortex_twirl",
    # Geometry
    "mirror_quad",
    "kaleido_hex",
    "grid_clone",
    "fractal_tunnel",
    "ribbon_split",
    "polar_tunnel",
    # Optics
    "fisheye_lens",
    "tilt_shift",
    "radial_zoom_blur",
    "double_vision",
    "prism_echo",
    "chroma_pulse",
    "anamorphic_flare",
    "star_glint",
    "neon_bloom",
    "crt_halation",
    "frost_mist",
    # Digital
    "pixel_sort",
    "ascii_matrix",
    "rgb_mosaic",
    "vhs_tracking",
    "datamosh_smear",
    "glitch",
    "edge_neon",
    "bayer_dither",
    # Color
    "solarize_pulse",
    "hue_cycle",
    "duotone_acid",
    "thermal_infrared",
    "bleach_bypass",
    "cyberpunk_grade",
    "golden_hour",
    "sepia_noir",
    "posterize_pop",
    "color_grade",
    # Texture / bars / impacts
    "film_burn",
    "halftone_dots",
    "scanlines",
    "grain",
    "vignette",
    "bass_vignette_punch",
    "strobe_shutter",
    "flash",
    "letterbox",
]


def build_effect_stack(
    effect_names: list[str],
    seed: int | random.Random,
    intensity: float = 1.0,
    max_effects: int | None = None,
) -> list[tuple[str, Callable, dict]]:
    """Build an ordered (name, fn, params) effect stack for a specific clip/segment."""
    valid = [e for e in effect_names if e in effects.EFFECTS]
    if not valid:
        valid = ["zoom_pulse", "neon_bloom", "color_grade", "vignette"]
    ordered = [e for e in _PIPELINE_ORDER if e in valid] + [e for e in valid if e not in _PIPELINE_ORDER]
    if max_effects is not None:
        ordered = ordered[: max(1, max_effects)]
    rng = seed if isinstance(seed, random.Random) else random.Random(seed)
    return [(name, effects.EFFECTS[name]["fn"], _params(name, rng, intensity=intensity)) for name in ordered]


def evolve_effect_names(base_names: list[str], slot_idx: int, seed: int) -> list[str]:
    """Deterministically evolve a 5-6 shader effect list for slot_idx while keeping visual identity."""
    if slot_idx == 0:
        return list(base_names)

    rng = random.Random(seed + slot_idx * 409)
    cats: dict[str, list[str]] = {
        cat: [name for name, meta in effects.EFFECTS.items() if meta.get("category") == cat]
        for cat in ("motion", "geometry", "optics", "digital", "color", "texture", "impact")
    }

    # Foundational motion
    motion_cands = [e for e in base_names if e in ("zoom_pulse", "beat_bounce", "pendulum_sway")]
    if motion_cands:
        chosen_motion = [motion_cands[slot_idx % len(motion_cands)]]
    else:
        chosen_motion = [rng.choice(cats["motion"])] if cats["motion"] else ["zoom_pulse"]

    # Framing / texture
    framing_cands = [e for e in base_names if e in ("vignette", "letterbox", "grain")]
    if framing_cands:
        chosen_framing = [framing_cands[slot_idx % len(framing_cands)]]
    else:
        chosen_framing = [rng.choice(cats["texture"])] if cats["texture"] else ["vignette"]

    # Distinct color filter for slot_idx
    base_colors = [e for e in base_names if effects.EFFECTS.get(e, {}).get("category") == "color"]
    if len(base_colors) > 1:
        chosen_color = [base_colors[slot_idx % len(base_colors)]]
    else:
        compl_colors = [c for c in cats["color"] if c not in base_colors] or cats["color"]
        chosen_color = [compl_colors[(slot_idx - 1) % len(compl_colors)]]

    # 1-2 distinct geometry / optics shaders
    geo_optics = cats["geometry"] + cats["optics"]
    n_geo = rng.choice([1, 2])
    chosen_geo = rng.sample(geo_optics, min(n_geo, len(geo_optics))) if geo_optics else []

    # 1 digital / impact shader (avoiding flash unless already in base_names)
    digi_impact_cands = [
        e for e in (cats["digital"] + cats["impact"])
        if e != "flash" or "flash" in base_names
    ]
    chosen_digi = [rng.choice(digi_impact_cands)] if digi_impact_cands else []

    combined = chosen_motion + chosen_framing + chosen_color + chosen_geo + chosen_digi
    dedup: list[str] = []
    seen = set()
    for e in combined:
        if e in effects.EFFECTS and e not in seen:
            seen.add(e)
            dedup.append(e)

    ordered = [e for e in _PIPELINE_ORDER if e in dedup] + [e for e in dedup if e not in _PIPELINE_ORDER]
    return ordered


@dataclasses.dataclass
class Recipe:
    bpm: int
    effects: list  # list of (name, fn, kwargs)
    seed: int
    preset: str = "custom"
    cut_beats: float = 4.0
    cut_mode: str = "steady"
    ensure_all_clips: bool = True
    transition: str = "flash"
    transitions: list[str] = dataclasses.field(default_factory=list)
    transition_mode: str = "cycle"
    trans_frames: int = 12
    intensity: float = 1.0
    duration: float = 8.0
    loop_mode: str = "crossfade"
    clip_direction: str = "forward"
    filter_mode: str = "global"
    clip_effects: dict[str, list[str]] = dataclasses.field(default_factory=dict)

    def describe(self) -> str:
        lines = [
            f"seed={self.seed}  bpm={self.bpm}  preset={self.preset}  "
            f"dur={self.duration}s  loop={self.loop_mode}  dir={self.clip_direction}  "
            f"filter_mode={self.filter_mode}  "
            f"cut_every={self.cut_beats}beats  cut_mode={self.cut_mode}  transition={self.transition}"
        ]
        for name, _, kw in self.effects:
            kwstr = ", ".join(
                f"{k}={v:g}" if isinstance(v, float) else f"{k}={v}"
                for k, v in kw.items()
            )
            lines.append(f"  {name}({kwstr})")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "seed": self.seed,
            "bpm": self.bpm,
            "preset": self.preset,
            "cut_beats": self.cut_beats,
            "cut_mode": self.cut_mode,
            "ensure_all_clips": self.ensure_all_clips,
            "transition": self.transition,
            "transitions": list(self.transitions),
            "transition_mode": self.transition_mode,
            "trans_frames": self.trans_frames,
            "clip_direction": self.clip_direction,
            "intensity": self.intensity,
            "duration": self.duration,
            "loop_mode": self.loop_mode,
            "filter_mode": self.filter_mode,
            "clip_effects": dict(self.clip_effects),
            "effects": [
                {
                    "name": name,
                    "label": effects.EFFECTS[name]["label"],
                    "category": effects.EFFECTS[name]["category"],
                    "params": kw,
                }
                for name, _, kw in self.effects
            ],
        }


def make_recipe(
    seed: int,
    bpm: int | None = None,
    max_effects: int = 6,
    preset: str | None = None,
    effect_names: list[str] | None = None,
    cut_beats: float | None = None,
    cut_mode: str = "steady",
    ensure_all_clips: bool = True,
    transition: str | None = None,
    transitions: list[str] | None = None,
    transition_mode: str = "cycle",
    trans_frames: int = 12,
    intensity: float = 1.0,
    duration: float = 8.0,
    loop_mode: str = "crossfade",
    clip_direction: str = "forward",
    filter_mode: str = "global",
    clip_effects: dict[str, list[str]] | None = None,
) -> Recipe:
    rng = random.Random(seed)
    bpm = bpm or rng.choice([116, 120, 124, 128, 132, 136, 140])

    if effect_names:
        picked = [n for n in effect_names if n in effects.EFFECTS]
        preset_key = preset or "custom"
    elif preset and preset in PRESETS:
        picked = list(PRESETS[preset]["effects"])
        preset_key = preset
        if cut_beats is None:
            cut_beats = PRESETS[preset]["cut_beats"]
        if transition is None and not transitions:
            transition = PRESETS[preset]["transition"]
    else:
        preset_key = rng.choice(list(PRESETS.keys()))
        picked = list(PRESETS[preset_key]["effects"])
        if cut_beats is None:
            cut_beats = PRESETS[preset_key]["cut_beats"]
        if transition is None and not transitions:
            transition = PRESETS[preset_key]["transition"]

    if not picked:
        picked = ["zoom_pulse", "neon_bloom", "color_grade"]

    limit = len(picked) if effect_names else max_effects
    chosen = build_effect_stack(picked, seed=rng, intensity=intensity, max_effects=limit)

    resolved_trans = transition or (transitions[0] if transitions else None) or "flash"
    resolved_transitions = list(transitions) if transitions else [resolved_trans]

    return Recipe(
        bpm=bpm,
        effects=chosen,
        seed=seed,
        preset=preset_key,
        cut_beats=float(cut_beats if cut_beats is not None else 4.0),
        cut_mode=cut_mode or "steady",
        ensure_all_clips=bool(ensure_all_clips),
        transition=resolved_trans,
        transitions=resolved_transitions,
        transition_mode=transition_mode or "cycle",
        trans_frames=max(4, min(30, int(trans_frames or 12))),
        intensity=intensity,
        duration=float(max(3.0, min(8.0, duration))),
        loop_mode=loop_mode if loop_mode in ("crossfade", "rebound", "hard", "morph") else "crossfade",
        clip_direction=clip_direction or "forward",
        filter_mode=filter_mode or "global",
        clip_effects=dict(clip_effects or {}),
    )
