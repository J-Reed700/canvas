"""Command-line interface and Studio launcher."""
from __future__ import annotations

import argparse
import os
import random
import sys
import time

from . import __version__
from .render import effects
from .analysis.audio import analyze_track
from .render.compositor import CANVAS_FPS, CANVAS_H, CANVAS_SECONDS, CANVAS_W, build_plan
from .media.encoder import Encoder
from .render.recipe import PRESETS, WEIGHTS, make_recipe
from .media.source import probe


def list_effects() -> None:
    print("Presets:")
    for pid, pmeta in PRESETS.items():
        print(f"  {pid:18s} {pmeta['label']} - {pmeta['desc']}")
    print("\nEffects:")
    for name, meta in effects.EFFECTS.items():
        print(f"  {name:22s} [{meta['category']:8s}] weight={WEIGHTS.get(name, 0):.2f}  ({meta['label']})")


def render(
    input_paths: str | list[str],
    out_path: str,
    seed: int | None = None,
    bpm: int | None = None,
    speed: float = 1.0,
    max_effects: int = 6,
    preset: str | None = None,
    cut_beats: float | None = None,
    cut_mode: str = "steady",
    ensure_all_clips: bool = True,
    transition: str | None = None,
    transitions: list[str] | None = None,
    transition_mode: str = "cycle",
    trans_frames: int = 12,
    intensity: float = 1.0,
    duration: float = CANVAS_SECONDS,
    loop_mode: str = "crossfade",
    clip_direction: str = "forward",
    filter_mode: str = "global",
    clip_effects: dict[str, list[str]] | None = None,
    audio_path: str | None = None,
    width: int = CANVAS_W,
    height: int = CANVAS_H,
    quiet: bool = False,
) -> str:
    if isinstance(input_paths, str):
        paths = [input_paths]
    else:
        paths = list(input_paths)

    seed = seed if seed is not None else random.randrange(100_000, 999_999)
    sources = [probe(p) for p in paths]

    track_prof = None
    if audio_path:
        track_prof = analyze_track(audio_path)
        if bpm is None:
            bpm = track_prof.detected_bpm

    recipe = make_recipe(
        seed=seed,
        bpm=bpm,
        max_effects=max_effects,
        preset=preset,
        cut_beats=cut_beats,
        cut_mode=cut_mode,
        ensure_all_clips=ensure_all_clips,
        transition=transition,
        transitions=transitions,
        transition_mode=transition_mode,
        trans_frames=trans_frames,
        intensity=intensity,
        duration=duration,
        loop_mode=loop_mode,
        clip_direction=clip_direction,
        filter_mode=filter_mode,
        clip_effects=clip_effects,
    )
    if not quiet:
        for s in sources:
            print(f"source: {s.path}  ({s.width}x{s.height} @ {s.fps:.1f}fps, {s.duration:.1f}s)")
        if track_prof:
            print(f"audio : {track_prof.path}  (detected {track_prof.detected_bpm} BPM, drop @ {track_prof.best_start_sec:.1f}s)")
        print(recipe.describe())

    t0 = time.time()
    plan = build_plan(
        sources,
        recipe,
        speed=speed,
        width=width,
        height=height,
        duration=duration,
        audio_path=track_prof.path if track_prof else None,
        audio_start_sec=track_prof.best_start_sec if track_prof else None,
        clip_direction=clip_direction,
        cut_mode=cut_mode,
        ensure_all_clips=ensure_all_clips,
        transitions=transitions,
        transition_mode=transition_mode,
        trans_frames=trans_frames,
        filter_mode=filter_mode,
        clip_effects=clip_effects,
    )
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with Encoder(out_path, fps=CANVAS_FPS, width=width, height=height) as enc:
        for i in range(plan.n_frames):
            frame = plan.render(i)
            enc.write(frame)
            if not quiet and (i + 1) % 30 == 0:
                done = (i + 1) / plan.n_frames * 100
                eta = (time.time() - t0) / (i + 1) * (plan.n_frames - i - 1)
                print(f"\r  {done:5.1f}%  ({i+1}/{plan.n_frames} frames, eta {eta:.1f}s)", end="", flush=True)

    if not quiet:
        print(f"\r  100.0%  done in {time.time()-t0:.1f}s -> {out_path}")
    return out_path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="downbeat", description=__doc__)
    ap.add_argument("videos", nargs="*", help="input MP4s (omit to launch Studio UI)")
    ap.add_argument("-o", "--out", default=None, help="output .mp4 (default: out/sample-canvas.mp4)")
    ap.add_argument("--studio", action="store_true", help="launch Studio UI in browser")
    ap.add_argument("--app", action="store_true", help="launch Studio UI in a standalone desktop window")
    ap.add_argument("--port", type=int, default=8765, help="port for Studio UI (default: 8765)")
    ap.add_argument("--no-browser", action="store_true", help="do not auto-open browser when starting Studio")
    ap.add_argument("--audio", default=None, help="optional WAV/MP3 track for audio sync")
    ap.add_argument("--preset", choices=list(PRESETS.keys()), default=None, help="visual style preset")
    ap.add_argument("--seed", type=int, default=None, help="recipe seed (default: random)")
    ap.add_argument("--bpm", type=int, default=None, help="override BPM (default: auto-detected from --audio or random)")
    ap.add_argument("--duration", type=float, default=8.0, help="Spotify Canvas duration in seconds (3.0 to 24.0, default: 8.0)")
    ap.add_argument("--loop-mode", choices=["crossfade", "rebound", "hard", "morph"], default="crossfade", help="loop topology")
    ap.add_argument("--cut-beats", type=float, default=None, help="cut between clips every N beats (e.g. 0.5, 1, 2, 4)")
    ap.add_argument(
        "--cut-mode",
        choices=["steady", "fit_all", "fit_all_2x", "build_up", "syncopated", "transient", "chaos"],
        default="steady",
        help="cut rhythm and pacing mode",
    )
    ap.add_argument("--ensure-all-clips", dest="ensure_all_clips", action="store_true", default=True, help="include all clips at least once")
    ap.add_argument("--no-ensure-all", dest="ensure_all_clips", action="store_false", help="do not force all clips to appear")
    ap.add_argument(
        "--transition",
        choices=[
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
        ],
        default=None,
        help="cut transition",
    )
    ap.add_argument("--transitions", nargs="+", default=None, help="multi-transition pool")
    ap.add_argument("--transition-mode", choices=["cycle", "random", "single"], default="cycle", help="transition selection mode across cuts")
    ap.add_argument("--trans-frames", type=int, default=12, help="transition duration in frames (4 to 30, default: 12)")
    ap.add_argument(
        "--clip-direction",
        choices=["forward", "reverse", "alternate", "pingpong", "chaos"],
        default="forward",
        help="clip playback direction",
    )
    ap.add_argument(
        "--filter-mode",
        choices=["global", "evolve", "preset_cycle", "per_clip"],
        default="global",
        help="filter application mode across clips/segments (default: global)",
    )
    ap.add_argument("--intensity", type=float, default=1.0, help="effect intensity multiplier (default: 1.0)")
    ap.add_argument("--speed", type=float, default=1.0, help="source playback speed multiplier")
    ap.add_argument("--effects", type=int, default=6, help="max effects in the random stack")
    ap.add_argument("--separate", action="store_true", help="render each input video separately instead of a multi-clip montage")
    ap.add_argument("--list", action="store_true", help="list presets and effects and exit")
    ap.add_argument("--dry-run", action="store_true", help="print the recipe without rendering")
    ap.add_argument("--version", action="version", version=f"downbeat {__version__}")
    args = ap.parse_args(argv)

    if args.list:
        list_effects()
        return 0

    if args.dry_run:
        recipe = make_recipe(
            args.seed if args.seed is not None else 2026,
            bpm=args.bpm,
            max_effects=args.effects,
            preset=args.preset,
            cut_beats=args.cut_beats,
            cut_mode=args.cut_mode,
            ensure_all_clips=args.ensure_all_clips,
            transition=args.transition,
            transitions=args.transitions,
            transition_mode=args.transition_mode,
            trans_frames=args.trans_frames,
            intensity=args.intensity,
            duration=args.duration,
            loop_mode=args.loop_mode,
            clip_direction=args.clip_direction,
            filter_mode=args.filter_mode,
        )
        print(recipe.describe())
        return 0

    if args.app or (getattr(sys, "frozen", False) and not args.videos and not args.studio):
        from .desktop import serve_desktop

        return serve_desktop(port=args.port)

    if args.studio or not args.videos:
        from .server.app import serve_studio

        serve_studio(port=args.port, open_browser=not args.no_browser)
        return 0

    videos = [os.path.expanduser(v) for v in args.videos]
    common_kwargs = {
        "seed": args.seed,
        "bpm": args.bpm,
        "speed": args.speed,
        "max_effects": args.effects,
        "preset": args.preset,
        "cut_beats": args.cut_beats,
        "cut_mode": args.cut_mode,
        "ensure_all_clips": args.ensure_all_clips,
        "transition": args.transition,
        "transitions": args.transitions,
        "transition_mode": args.transition_mode,
        "trans_frames": args.trans_frames,
        "intensity": args.intensity,
        "duration": args.duration,
        "loop_mode": args.loop_mode,
        "clip_direction": args.clip_direction,
        "filter_mode": args.filter_mode,
        "audio_path": args.audio,
    }
    if args.separate and len(videos) > 1:
        for vid in videos:
            base = os.path.splitext(os.path.basename(vid))[0]
            out = f"out/{base}-canvas.mp4"
            render([vid], out, **common_kwargs)
    else:
        out = args.out or "out/sample-canvas.mp4"
        render(videos, out, **common_kwargs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
