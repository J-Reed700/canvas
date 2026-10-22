"""Seeded recipe generation & curated 2026 style presets for Canvas Forge."""
from __future__ import annotations

import dataclasses
import random

from . import effects

WEIGHTS = {
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
}

PRESETS = {
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
}


def _params(name: str, rng: random.Random, intensity: float = 1.0) -> dict:
    scale = max(0.25, min(2.0, intensity))
    params_map = {
        "zoom_pulse": dict(
            cx=round(rng.uniform(0.42, 0.58), 2),
            cy=round(rng.uniform(0.42, 0.58), 2),
            period=rng.choice([2.0, 4.0]),
            kick=round(rng.uniform(0.07, 0.12) * scale, 2),
            sharp=round(rng.uniform(5.0, 7.5), 1),
        ),
        "beat_bounce": dict(
            amp=round(rng.uniform(0.018, 0.032) * scale, 3),
            sharp=round(rng.uniform(5.0, 7.5), 1),
        ),
        "liquid_warp": dict(
            amp=round(rng.uniform(6.0, 12.0) * scale, 1),
            freq=round(rng.uniform(0.009, 0.016), 4),
        ),
        "mirror_quad": dict(
            mode=rng.choice(["quad", "horiz"]),
            beat_toggle=False,
        ),
        "prism_echo": dict(
            strength=round(rng.uniform(0.18, 0.28) * min(scale, 1.3), 2),
            expand=round(rng.uniform(0.18, 0.32) * scale, 2),
        ),
        "neon_bloom": dict(
            intensity=round(rng.uniform(0.32, 0.52) * scale, 2),
            threshold=rng.randint(80, 115),
        ),
        "crt_halation": dict(
            strength=round(rng.uniform(0.32, 0.50) * scale, 2),
        ),
        "chroma_pulse": dict(
            max_shift=round(rng.uniform(5.0, 11.0) * scale, 1),
        ),
        "bayer_dither": dict(
            levels=rng.choice([5, 6, 7]),
            spread=round(rng.uniform(30.0, 44.0) * scale, 1),
            mix=round(rng.uniform(0.55, 0.78), 2),
        ),
        "edge_neon": dict(
            strength=round(rng.uniform(0.55, 0.85) * scale, 2),
        ),
        "glitch": dict(
            trigger=round(max(0.18, 0.42 - 0.12 * scale), 2),
        ),
        "solarize_pulse": dict(),
        "hue_cycle": dict(
            period=rng.choice([4.0, 8.0]),
            amount=round(rng.uniform(0.25, 0.65) * scale, 2),
        ),
        "color_grade": dict(
            contrast=round(rng.uniform(1.12, 1.26), 2),
            warm=rng.randint(-6, 22),
            cool=rng.randint(-18, 12),
        ),
        "vignette": dict(
            strength=round(rng.uniform(0.45, 0.72), 2),
        ),
        "scanlines": dict(
            gap=rng.choice([3, 4, 6]),
            darken=round(rng.uniform(0.68, 0.82), 2),
        ),
        "grain": dict(
            amount=int(rng.randint(10, 18) * min(scale, 1.4)),
        ),
        "flash": dict(
            amount=int(rng.randint(14, 24) * min(scale, 1.3)),
            period_beats=4.0,
            sharp=round(rng.uniform(9.0, 14.0), 1),
        ),
        "letterbox": dict(
            frac=round(rng.uniform(0.05, 0.09), 2),
        ),
    }
    return params_map[name]


# Order in which effects should execute so optics/zoom happen before texture/bars
_PIPELINE_ORDER = [
    "zoom_pulse",
    "beat_bounce",
    "liquid_warp",
    "mirror_quad",
    "prism_echo",
    "chroma_pulse",
    "glitch",
    "edge_neon",
    "bayer_dither",
    "solarize_pulse",
    "hue_cycle",
    "color_grade",
    "neon_bloom",
    "crt_halation",
    "scanlines",
    "grain",
    "vignette",
    "flash",
    "letterbox",
]


@dataclasses.dataclass
class Recipe:
    bpm: int
    effects: list  # list of (name, fn, kwargs)
    seed: int
    preset: str = "custom"
    cut_beats: int = 4
    transition: str = "flash"
    intensity: float = 1.0
    duration: float = 8.0
    loop_mode: str = "crossfade"

    def describe(self) -> str:
        lines = [
            f"seed={self.seed}  bpm={self.bpm}  preset={self.preset}  "
            f"dur={self.duration}s  loop={self.loop_mode}  "
            f"cut_every={self.cut_beats}beats  transition={self.transition}"
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
            "transition": self.transition,
            "intensity": self.intensity,
            "duration": self.duration,
            "loop_mode": self.loop_mode,
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
    cut_beats: int | None = None,
    transition: str | None = None,
    intensity: float = 1.0,
    duration: float = 8.0,
    loop_mode: str = "crossfade",
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
        if transition is None:
            transition = PRESETS[preset]["transition"]
    else:
        preset_key = rng.choice(list(PRESETS.keys()))
        picked = list(PRESETS[preset_key]["effects"])
        if cut_beats is None:
            cut_beats = PRESETS[preset_key]["cut_beats"]
        if transition is None:
            transition = PRESETS[preset_key]["transition"]

    if not picked:
        picked = ["zoom_pulse", "neon_bloom", "color_grade"]

    ordered = [name for name in _PIPELINE_ORDER if name in picked]
    for name in picked:
        if name not in ordered:
            ordered.append(name)

    chosen = []
    for name in ordered[: max(1, max_effects if not effect_names else len(ordered))]:
        fn = effects.EFFECTS[name]["fn"]
        chosen.append((name, fn, _params(name, rng, intensity=intensity)))

    return Recipe(
        bpm=bpm,
        effects=chosen,
        seed=seed,
        preset=preset_key,
        cut_beats=cut_beats or 4,
        transition=transition or "flash",
        intensity=intensity,
        duration=float(max(3.0, min(8.0, duration))),
        loop_mode=loop_mode if loop_mode in ("crossfade", "rebound", "hard") else "crossfade",
    )
