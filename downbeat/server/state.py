"""Studio state management and background export sessions."""
from __future__ import annotations

import glob
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse

from .. import delivery
from .._cache import FileResultCache, file_version
from .library import Library, Track, is_audio_name, track_id
from .payloads import clip_payload, clip_payloads
from .projects import ProjectStore
from .storage import remove_file, write_json
from ..media.proxy import ProxyManager
from ..media.source import IMAGE_EXTS, Source, probe

PACKAGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.dirname(PACKAGE_DIR)
OUT_DIR = os.path.join(PROJECT_ROOT, "out")
STUDIO_DIR = os.path.join(PACKAGE_DIR, "studio")
STUDIO_DIST_DIR = os.path.join(STUDIO_DIR, "dist")
RAW_SESSION_IDLE_SECONDS = 15 * 60
MAX_RAW_SESSIONS = 4
_HIDDEN_LOCK = threading.Lock()


class StudioState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self._rescan_lock = threading.Lock()
        self._clips: dict[str, Source] = {}
        self._tracks: dict[str, Track] = {}
        self.library = Library(OUT_DIR)
        self._renders: list[dict] = []
        self.raw_sessions: dict[str, tuple[delivery.RawSession | delivery.ChunkSession, dict]] = {}
        self._raw_session_locks: dict[str, threading.RLock] = {}
        self._raw_session_activity: dict[str, float] = {}
        self.framing: FileResultCache[dict] = FileResultCache(128)  # clip id -> autoframe result
        self.palettes: FileResultCache[dict] = FileResultCache(128)
        self._proxies: ProxyManager | None = None
        self._clip_versions: dict[str, tuple[str, int, int]] = {}
        self._unreadable: dict[str, tuple[str, int, int]] = {}
        self._initialized: bool = False
        self._shutting_down: bool = False

    def ensure_initialized(self) -> StudioState:
        if self._initialized:
            return self
        with self._rescan_lock:
            with self.lock:
                if self._initialized:
                    return self
                if self._shutting_down:
                    raise RuntimeError("the studio has shut down")
                if self._proxies is None:
                    self._proxies = ProxyManager(os.path.join(OUT_DIR, ".proxies"))
                # Playback copies are made only for clips put in the edit (see app.py /api/proxies).
                self._tracks, self._clips = self._scan()
                self._discover_existing_renders()
                self._initialized = True
        return self

    @property
    def projects(self) -> ProjectStore:
        """Saved projects, and the edits kept with exports, in out/projects/."""
        return ProjectStore(os.path.join(OUT_DIR, "projects"))

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
        with self.lock:
            self._shutting_down = True
        if self._proxies is not None:
            self._proxies.shutdown()

    def clip_payload(self, src: Source) -> dict:
        self.ensure_initialized()
        return clip_payload(src, self.library.uploads, self.library.folders(), self.proxies.status)

    def snapshot(self, *, clips_only: bool = False) -> dict:
        """Copy mutable collections once, then serialize without holding the state lock.

        Proxy status and filesystem work can block. Neither should prevent an upload or export
        from recording its result, and iteration must not race with those writes.
        """
        self.ensure_initialized()
        with self.lock:
            clips = tuple(self._clips.values())
            tracks = () if clips_only else tuple(self._tracks.values())
            renders = [] if clips_only else list(self._renders)
        folders = self.library.folders()
        payload = {"clips": clip_payloads(clips, self.library.uploads, folders, self.proxies.status)}
        if not clips_only:
            payload.update(tracks=[t.to_dict() for t in tracks], renders=renders,
                           folders=folders, can_pick=sys.platform == "darwin")
        return payload

    def begin_shutdown(self) -> list[str]:
        """Stop accepting exports and return a stable snapshot to abort."""
        with self.lock:
            self._shutting_down = True
            return list(self.raw_sessions)

    def raw_session_lock(self, sid: str) -> threading.RLock:
        """Per-export lock serializing frame writes with finish/abort."""
        with self.lock:
            return self._raw_session_locks.setdefault(sid, threading.RLock())

    def add_raw_session(self, sid: str, session: delivery.RawSession | delivery.ChunkSession, meta: dict) -> None:
        with self.lock:
            if self._shutting_down:
                raise RuntimeError("the studio is shutting down")
            if sid in self.raw_sessions:
                raise FileExistsError(f"an export named {sid} is already running")
            if len(self.raw_sessions) >= MAX_RAW_SESSIONS:
                raise RuntimeError(f"at most {MAX_RAW_SESSIONS} exports can run at once")
            self._raw_session_locks.setdefault(sid, threading.RLock())
            self.raw_sessions[sid] = (session, meta)
            self._raw_session_activity[sid] = time.monotonic()

    def touch_raw_session(self, sid: str, entry: tuple | None = None) -> bool:
        """Refresh a session after a successful write without reviving a closed one."""
        with self.lock:
            current = self.raw_sessions.get(sid)
            if current is None or (entry is not None and current is not entry):
                return False
            self._raw_session_activity[sid] = time.monotonic()
            return True

    def pop_raw_session(self, sid: str, entry: tuple | None = None):
        """Remove a session only if it is still the instance the caller observed."""
        with self.lock:
            current = self.raw_sessions.get(sid)
            if current is None or (entry is not None and current is not entry):
                return None
            self.raw_sessions.pop(sid, None)
            self._raw_session_activity.pop(sid, None)
            return current

    def expire_raw_sessions(self, idle_seconds: float = RAW_SESSION_IDLE_SECONDS,
                            *, now: float | None = None) -> list[str]:
        """Abort idle browser exports without disturbing a write or finish in flight."""
        checked_at = time.monotonic() if now is None else now
        with self.lock:
            candidates = [
                (sid, entry, self._raw_session_locks.get(sid))
                for sid, entry in self.raw_sessions.items()
                if sid in self._raw_session_activity
                and checked_at - self._raw_session_activity[sid] >= idle_seconds
            ]
        expired: list[str] = []
        for sid, observed, session_lock in candidates:
            if session_lock is None or not session_lock.acquire(blocking=False):
                continue
            try:
                with self.lock:
                    current = self.raw_sessions.get(sid)
                    last_active = self._raw_session_activity.get(sid, checked_at)
                    if current is not observed or checked_at - last_active < idle_seconds:
                        continue
                    entry = self.pop_raw_session(sid, observed)
                if entry is None:
                    continue
                try:
                    entry[0].abort()
                except Exception:
                    pass
                expired.append(sid)
            finally:
                session_lock.release()
                self.drop_raw_session_lock(sid, session_lock)
        return expired

    def drop_raw_session_lock(self, sid: str, lock: threading.RLock) -> None:
        with self.lock:
            if sid not in self.raw_sessions and self._raw_session_locks.get(sid) is lock:
                self._raw_session_locks.pop(sid, None)
                self._raw_session_activity.pop(sid, None)

    def _scan(self) -> tuple[dict[str, Track], dict[str, Source]]:
        """The songs and the clips in out/uploads and the picked folders. A clip already listed keeps its
        probe, a video that can't be opened is skipped, and Downbeat's own exports are left out."""
        tracks, videos = self.library.scan()
        hidden = _hidden_clips()
        with self.lock:
            known = {s.path: s for s in self._clips.values()}
            known_versions = dict(self._clip_versions)
        clips: dict[str, Source] = {}
        versions: dict[str, tuple[str, int, int]] = {}
        for path in videos:
            if os.path.abspath(path) in hidden or _EXPORT_NAME.match(os.path.basename(path)):
                continue
            try:
                version = file_version(path)
            except OSError:
                continue
            src = known.get(path) if known_versions.get(path) == version else None
            if src is None:
                if self._unreadable.get(path) == version:
                    continue
                try:
                    src = probe(path)
                except Exception:
                    self._unreadable[path] = version
                    continue
                self._unreadable.pop(path, None)
            clips[src.id] = src
            versions[path] = version
        with self.lock:
            self._clip_versions = versions
            present = set(videos)
            self._unreadable = {path: version for path, version in self._unreadable.items() if path in present}
        return tracks, clips

    def rescan(self) -> dict[str, Track]:
        """Pick up songs and videos added to or removed from the folders since the last look. Clips from a
        folder that is no longer picked drop out."""
        with self._rescan_lock:
            tracks, clips = self._scan()
            with self.lock:
                self._tracks, self._clips = tracks, clips
        return tracks

    def _discover_existing_renders(self) -> None:
        os.makedirs(OUT_DIR, exist_ok=True)
        paths = glob.glob(os.path.join(OUT_DIR, "*.mp4")) + glob.glob(os.path.join(OUT_DIR, "*.mov"))
        for path in sorted(paths, key=os.path.getmtime, reverse=True):
            name = os.path.basename(path)
            if name.endswith(("-audio.mp4", "-audio.mov")) or re.search(r"-promo-\d+s\.mp4$", name):
                continue
            if os.path.getsize(path) == 0:
                continue
            size_mb = round(os.path.getsize(path) / (1024 * 1024), 2)
            audio_ext = ".mov" if path.lower().endswith(".mov") else ".mp4"
            audio = path[:-4] + "-audio" + audio_ext
            legacy_audio = path[:-4] + "-audio.mp4"
            if not os.path.isfile(audio) and os.path.isfile(legacy_audio):
                audio = legacy_audio
            cover = path[:-4] + "-cover-3000x3000.jpg"
            promos = sorted(glob.glob(glob.escape(path[:-4]) + "-promo-*s.mp4"))
            self._renders.append(
                {
                    "filename": name,
                    "url": f"/out/{urllib.parse.quote(name)}",
                    "audio_url": f"/out/{urllib.parse.quote(os.path.basename(audio))}" if os.path.isfile(audio) else None,
                    "promo_url": f"/out/{urllib.parse.quote(os.path.basename(promos[-1]))}" if promos else None,
                    "cover_url": f"/out/{urllib.parse.quote(os.path.basename(cover))}" if os.path.isfile(cover) else None,
                    "format": "spotify",
                    "size_mb": size_mb,
                    "created_at": int(os.path.getmtime(path)),
                    "resolution": "1080x1920" if "master" in name or "sample" in name else "540x960",
                    "preset": "canvas",
                    "has_edit": self.projects.has_export_edit(name),
                    **parse_export_name(name),
                }
            )

    def remove_clip(self, clip_id: str) -> bool:
        """Take a clip out of the library and delete its playback proxy. A copy the studio made in
        out/uploads/ is deleted, along with the image a still was made from. Any other file (one
        found in a picked folder) stays on disk and is hidden so it doesn't come back on the next scan.
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
            remove_file(proxy)
        path = os.path.abspath(src.path)
        if os.path.dirname(path) == os.path.abspath(os.path.join(OUT_DIR, "uploads")):
            doomed = [path]
            if path.endswith(".still.mp4"):
                stem = path[: -len(".still.mp4")]
                doomed += [p for p in glob.glob(glob.escape(stem) + ".*") if os.path.splitext(p)[1].lower() in IMAGE_EXTS]
            for p in doomed:
                if os.path.isfile(p):
                    remove_file(p)
            return True
        with _HIDDEN_LOCK:
            hidden = _hidden_clips()
            hidden.add(path)
            write_json(os.path.join(OUT_DIR, ".hidden-clips.json"), sorted(hidden))
        return False

    def add_clip_path(self, path: str) -> Source:
        self.ensure_initialized()
        src = probe(path)
        with self._rescan_lock:
            with self.lock:
                self._clips[src.id] = src
                try:
                    self._clip_versions[src.path] = file_version(src.path)
                except OSError:
                    self._clip_versions.pop(src.path, None)
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
            "output_codec": str(meta.get("codec") or "h264"),
            "checks": result["checks"],
            "engine": "gpu",
            "has_edit": self.projects.has_export_edit(name),
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
        if os.path.splitext(name)[1].lower() not in (".mp4", ".mov") or not os.path.isfile(path):
            raise FileNotFoundError(name)
        targets = self._export_files(path)
        self._remove_all(targets)
        self.projects.delete_export_edit(name)
        with self.lock:
            self.renders = [r for r in self.renders if r.get("filename") != name]
        return [os.path.basename(p) for p in targets]

    @staticmethod
    def _remove_all(targets: list[str]) -> None:
        """Delete an export's files, the export itself last: if one is in use and can't go, the export
        stays listed, and deleting it again finishes the job."""
        for p in targets[1:] + targets[:1]:
            if os.path.isfile(p):
                remove_file(p)

    @staticmethod
    def _export_files(path: str) -> list[str]:
        stem = os.path.splitext(path)[0]
        companion = re.compile(r"-(audio\.(mp4|mov)|promo-\d+s\.mp4|cover-\d+x\d+\.jpg|teaser\.(gif|webp)|[a-z0-9_]+\.jpg)$")
        return ([path] if os.path.isfile(path) else []) + [
            p for p in glob.glob(glob.escape(stem) + "-*")
            if os.path.isfile(p) and companion.fullmatch(p[len(stem):])
        ]

    def discard_export(self, filename: str) -> list[str]:
        """Remove a failed export and any companions even if its primary file is gone."""
        name = os.path.basename(filename)
        if os.path.splitext(name)[1].lower() not in (".mp4", ".mov"):
            return []
        targets = self._export_files(os.path.join(OUT_DIR, name))
        self._remove_all(targets)
        self.projects.delete_export_edit(name)
        with self.lock:
            self.renders = [r for r in self.renders if r.get("filename") != name]
        return [os.path.basename(p) for p in targets]

    def add_track_path(self, path: str) -> Track:
        """Add a song copied into out/uploads/. Its analysis runs when it's picked."""
        self.ensure_initialized()
        path = os.path.abspath(path)
        # An explicit upload is already known. Register it directly instead of walking every
        # chosen media folder again for every song in a multi-file import.
        if os.path.dirname(path) == os.path.abspath(self.library.uploads):
            if not is_audio_name(os.path.basename(path)) or not os.path.isfile(path) or os.path.getsize(path) < 1:
                raise ValueError(f"{os.path.basename(path)} is too short or not an audio file")
            track = Track(track_id(path), path, os.path.basename(path), "added", "", os.path.getmtime(path))
            with self._rescan_lock:
                with self.lock:
                    self._tracks[track.id] = track
            return track
        tracks = self.rescan()
        tid = track_id(path)
        if tid not in tracks:
            raise ValueError(f"{os.path.basename(path)} is too short or not an audio file")
        return tracks[tid]


STATE = StudioState()


_EXPORT_NAME = re.compile(
    r"^canvas-(?P<look>.+?)-(?:(?P<tag>apple-tall|apple-square|youtube-16-9|social-vertical|social-square|cover-art)-)?"
    r"(?P<bpm>\d+)bpm-(?P<dur>\d+(?:\.\d+)?)s(?:-(?P<w>\d+)x(?P<h>\d+))?"
)


def _hidden_clips() -> set[str]:
    """Paths of clips removed from the library that live outside out/ (see remove_clip)."""
    try:
        with open(os.path.join(OUT_DIR, ".hidden-clips.json")) as f:
            paths = json.load(f)
        return {path for path in paths if isinstance(path, str)} if isinstance(paths, list) else set()
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
    # A random suffix avoids same-second collisions between concurrent exports and
    # between a new export and one already on disk from a prior run.
    stamp = f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(4)}"
    fmt = _export_format(meta)
    tag = "" if fmt == "spotify" else f"{fmt.replace('_', '-')}-"
    dur, w, h = float(meta.get("duration") or 0), meta.get("width"), meta.get("height")
    if fmt in ("apple_tall", "apple_square"):
        w, h = delivery.FORMATS[fmt]["size"]
        # The name carries the length after the loop is repeated for Apple, as repeat_loop() will.
        dur *= delivery.loop_repeats(dur, delivery.APPLE["safe_min_seconds"], delivery.APPLE["max_seconds"])
    elif fmt in ("youtube_16_9", "social_vertical", "social_square"):
        if fmt in delivery.FORMATS:
            w, h = delivery.FORMATS[fmt].get("size", (w, h))
    codec = str(meta.get("codec") or "h264")
    ext = ".mov" if codec in ("prores_422_hq", "prores_4444") else ".mp4"
    name = f"canvas-{look}-{tag}{bpm}bpm-{dur:.1f}s-{w}x{h}-{stamp}{ext}"
    os.makedirs(OUT_DIR, exist_ok=True)
    return os.path.join(OUT_DIR, name)


def _abort_raw(sid: str) -> None:
    lock = STATE.raw_session_lock(sid)
    try:
        with lock:
            entry = STATE.pop_raw_session(sid)
            if entry:
                entry[0].abort()
    finally:
        STATE.drop_raw_session_lock(sid, lock)


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
        with_audio=bool(meta.get("with_audio", False)),
        promo_title=str(meta.get("promo_title") or ""),
        promo_out_now=bool(meta.get("promo_out_now", False)),
    )
    # The edit the export was made from, so the studio can open it again from the Exports list.
    if isinstance(meta.get("edit"), dict):
        try:
            STATE.projects.save_export_edit(os.path.basename(dest), meta["edit"])
        except (OSError, ValueError):
            pass  # the render is fine without it
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
