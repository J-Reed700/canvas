"""Studio state management and background export sessions."""
from __future__ import annotations

import glob
import json
import os
import re
import threading
import time
import urllib.parse

from .. import delivery
from .library import Library, Track, track_id
from ..media.proxy import ProxyManager
from ..media.source import IMAGE_EXTS, Source, probe

PACKAGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.dirname(PACKAGE_DIR)
OUT_DIR = os.path.join(PROJECT_ROOT, "out")
STUDIO_DIR = os.path.join(PACKAGE_DIR, "studio")
STUDIO_DIST_DIR = os.path.join(STUDIO_DIR, "dist")


class StudioState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self._clips: dict[str, Source] = {}
        self._tracks: dict[str, Track] = {}
        self.library = Library(OUT_DIR)
        self._renders: list[dict] = []
        self.raw_sessions: dict[str, tuple[delivery.RawSession | delivery.ChunkSession, dict]] = {}
        self.framing: dict[str, dict] = {}  # clip id -> autoframe result
        self.palettes: dict[str, dict] = {}
        self._proxies: ProxyManager | None = None
        self._initialized: bool = False

    def ensure_initialized(self) -> StudioState:
        if self._initialized:
            return self
        with self.lock:
            if self._initialized:
                return self
            if self._proxies is None:
                self._proxies = ProxyManager(os.path.join(OUT_DIR, ".proxies"))
            self._discover_initial_clips()
            self._discover_initial_tracks()
            self._discover_existing_renders()
            for src in self._clips.values():
                self._proxies.request(src)
            self._initialized = True
        return self

    @property
    def proxies(self) -> ProxyManager:
        self.ensure_initialized()
        assert self._proxies is not None
        return self._proxies

    @property
    def clips(self) -> dict[str, Source]:
        self.ensure_initialized()
        return self._clips

    @property
    def tracks(self) -> dict[str, Track]:
        self.ensure_initialized()
        return self._tracks

    @property
    def renders(self) -> list[dict]:
        self.ensure_initialized()
        return self._renders

    @renders.setter
    def renders(self, value: list[dict]) -> None:
        self._renders = value

    def shutdown(self) -> None:
        if self._proxies is not None:
            self._proxies.shutdown()

    def _discover_initial_clips(self) -> None:
        dl = os.path.expanduser("~/Downloads")
        hidden = _hidden_clips()
        candidates = [p for p in sorted(glob.glob(os.path.join(dl, "*.mp4"))) if os.path.abspath(p) not in hidden]
        stock = [p for p in candidates if os.path.basename(p)[0].isdigit()]
        others = [p for p in candidates if p not in stock]
        for path in stock + others[:3]:
            try:
                src = probe(path)
                self._clips[src.id] = src
            except Exception:
                pass

    def _discover_initial_tracks(self) -> None:
        self._tracks = self.library.scan()

    def rescan_tracks(self) -> dict[str, Track]:
        """Pick up songs added to or removed from the library folders since the last look."""
        tracks = self.library.scan()
        with self.lock:
            self._tracks = tracks
        return tracks

    def _discover_existing_renders(self) -> None:
        os.makedirs(OUT_DIR, exist_ok=True)
        for path in sorted(glob.glob(os.path.join(OUT_DIR, "*.mp4")), key=os.path.getmtime, reverse=True):
            name = os.path.basename(path)
            if name.endswith("-audio.mp4") or re.search(r"-promo-\d+s\.mp4$", name):
                continue
            if os.path.getsize(path) == 0:
                continue
            size_mb = round(os.path.getsize(path) / (1024 * 1024), 2)
            audio = path[:-4] + "-audio.mp4"
            promos = sorted(glob.glob(glob.escape(path[:-4]) + "-promo-*s.mp4"))
            self._renders.append(
                {
                    "filename": name,
                    "url": f"/out/{urllib.parse.quote(name)}",
                    "audio_url": f"/out/{urllib.parse.quote(os.path.basename(audio))}" if os.path.isfile(audio) else None,
                    "promo_url": f"/out/{urllib.parse.quote(os.path.basename(promos[-1]))}" if promos else None,
                    "format": "spotify",
                    "size_mb": size_mb,
                    "created_at": int(os.path.getmtime(path)),
                    "resolution": "1080x1920" if "master" in name or "sample" in name else "540x960",
                    "preset": "canvas",
                    **parse_export_name(name),
                }
            )

    def remove_clip(self, clip_id: str) -> bool:
        """Take a clip out of the library and delete its playback proxy. A copy the studio made in
        out/uploads/ is deleted, along with the image a still was made from. Any other file (one
        found in ~/Downloads) stays on disk and is hidden so it doesn't come back on the next start.
        Returns True if the clip's file was deleted."""
        with self.lock:
            src = self._clips.pop(clip_id, None)
        if src is None:
            raise KeyError(clip_id)
        try:
            proxy = self.proxies.path_for(src)
        except OSError:
            proxy = None
        if proxy and os.path.isfile(proxy):
            os.remove(proxy)
        path = os.path.abspath(src.path)
        if os.path.dirname(path) == os.path.abspath(os.path.join(OUT_DIR, "uploads")):
            doomed = [path]
            if path.endswith(".still.mp4"):
                stem = path[: -len(".still.mp4")]
                doomed += [p for p in glob.glob(glob.escape(stem) + ".*") if os.path.splitext(p)[1].lower() in IMAGE_EXTS]
            for p in doomed:
                if os.path.isfile(p):
                    os.remove(p)
            return True
        hidden = _hidden_clips()
        hidden.add(path)
        with open(os.path.join(OUT_DIR, ".hidden-clips.json"), "w") as f:
            json.dump(sorted(hidden), f, indent=1)
        return False

    def add_clip_path(self, path: str) -> Source:
        src = probe(path)
        with self.lock:
            self.clips[src.id] = src
        self.proxies.request(src, priority=5)
        return src

    def add_export(self, dest: str, meta: dict, result: dict) -> dict:
        name = os.path.basename(dest)
        audio_path = result.get("audio_path")
        promo_path = result.get("promo_path")
        cover_path = result.get("cover_path")
        entry = {
            "filename": name,
            "url": f"/out/{urllib.parse.quote(name)}?t={int(time.time())}",
            "audio_url": f"/out/{urllib.parse.quote(os.path.basename(audio_path))}" if audio_path else None,
            "promo_url": f"/out/{urllib.parse.quote(os.path.basename(promo_path))}" if promo_path else None,
            "cover_url": f"/out/{urllib.parse.quote(os.path.basename(cover_path))}" if cover_path else None,
            "format": _export_format(meta),
            "size_mb": result["size_mb"],
            "created_at": int(time.time()),
            "resolution": f"{result.get('width') or meta.get('width')}x{result.get('height') or meta.get('height')}",
            "duration": result.get("duration") or meta.get("duration"),
            "bpm": meta.get("bpm"),
            "preset": meta.get("look") or "canvas",
            "look": meta.get("look"),
            "checks": result["checks"],
            "engine": "gpu",
        }
        with self.lock:
            self.renders = [r for r in self.renders if r.get("filename") != name]
            self.renders.insert(0, entry)
        return entry

    def remove_export(self, filename: str) -> list[str]:
        """Delete an export from out/ along with its companion files (the -audio and -promo copies,
        cover art, teasers and banners made from it). Returns the names of the deleted files."""
        name = os.path.basename(filename)
        path = os.path.join(OUT_DIR, name)
        if not name.endswith(".mp4") or not os.path.isfile(path):
            raise FileNotFoundError(name)
        stem = path[:-4]
        companion = re.compile(r"-(audio\.mp4|promo-\d+s\.mp4|cover-\d+x\d+\.jpg|teaser\.(gif|webp)|[a-z0-9_]+\.jpg)$")
        targets = [path] + [
            p for p in glob.glob(glob.escape(stem) + "-*")
            if os.path.isfile(p) and companion.fullmatch(p[len(stem):])
        ]
        for p in targets:
            os.remove(p)
        with self.lock:
            self.renders = [r for r in self.renders if r.get("filename") != name]
        return [os.path.basename(p) for p in targets]

    def add_track_path(self, path: str) -> Track:
        """Add a song copied into out/uploads/. Its analysis runs when it's picked."""
        tracks = self.rescan_tracks()
        tid = track_id(path)
        if tid not in tracks:
            raise ValueError(f"{os.path.basename(path)} is too short or not an audio file")
        return tracks[tid]


STATE = StudioState()


_EXPORT_NAME = re.compile(
    r"^canvas-(?P<look>.+?)-(?:(?P<tag>apple-tall|apple-square|youtube-16-9|social-square|cover-art)-)?"
    r"(?P<bpm>\d+)bpm-(?P<dur>\d+(?:\.\d+)?)s(?:-(?P<w>\d+)x(?P<h>\d+))?"
)


def _hidden_clips() -> set[str]:
    """Paths of clips removed from the library that live outside out/ (see remove_clip)."""
    try:
        with open(os.path.join(OUT_DIR, ".hidden-clips.json")) as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def parse_export_name(name: str) -> dict:
    """Recover look, format, tempo, length and size from a name written by _export_dest."""
    m = _EXPORT_NAME.match(name)
    if not m:
        return {}
    out: dict = {"bpm": float(m["bpm"]), "duration": float(m["dur"])}
    if m["tag"]:
        out["format"] = m["tag"].replace("-", "_")
    if m["w"]:
        out["resolution"] = f"{m['w']}x{m['h']}"
        out["look"] = m["look"].replace("-", " ").title()
        out["preset"] = out["look"]
    return out


def _export_format(meta: dict) -> str:
    fmt = str(meta.get("format") or "spotify")
    return fmt if fmt in delivery.FORMATS else "spotify"


def _export_dest(meta: dict) -> str:
    look = re.sub(r"[^a-z0-9]+", "-", str(meta.get("look") or "canvas").lower()).strip("-") or "canvas"
    bpm = int(round(float(meta.get("bpm") or 0)))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    fmt = _export_format(meta)
    tag = "" if fmt == "spotify" else f"{fmt.replace('_', '-')}-"
    dur, w, h = float(meta.get("duration") or 0), meta.get("width"), meta.get("height")
    if fmt in ("apple_tall", "apple_square"):
        w, h = delivery.FORMATS[fmt]["size"]
        # The name carries the length after the loop is repeated for Apple, as repeat_loop() will.
        dur *= delivery.loop_repeats(dur, delivery.APPLE["safe_min_seconds"], delivery.APPLE["max_seconds"])
    elif fmt in ("youtube_16_9", "social_square", "cover_art"):
        if fmt in delivery.FORMATS:
            w, h = delivery.FORMATS[fmt].get("size", (w, h))
    name = f"canvas-{look}-{tag}{bpm}bpm-{dur:.1f}s-{w}x{h}-{stamp}.mp4"
    os.makedirs(OUT_DIR, exist_ok=True)
    return os.path.join(OUT_DIR, name)


def _abort_raw(sid: str) -> None:
    with STATE.lock:
        entry = STATE.raw_sessions.pop(sid, None)
    if entry:
        entry[0].abort()


def _finish_export(dest: str, meta: dict) -> dict:
    prof = STATE.tracks.get(meta.get("track_id") or "")
    try:
        promo = max(0.0, min(60.0, float(meta.get("promo_seconds") or 0)))
    except (TypeError, ValueError):
        promo = 0.0
    result = delivery.deliver(
        dest,
        prof.path if prof else None,
        float(meta.get("audio_start") or 0.0),
        float(meta.get("duration") or 8.0),
        meta.get("stats"),
        fmt=_export_format(meta),
        promo_seconds=promo,
        with_audio=bool(meta.get("with_audio", True)),
    )
    return STATE.add_export(dest, meta, result)


__all__ = [
    "PROJECT_ROOT",
    "OUT_DIR",
    "PACKAGE_DIR",
    "STUDIO_DIR",
    "StudioState",
    "STATE",
    "_export_dest",
    "_abort_raw",
    "_finish_export",
    "_export_format",
]
