"""Song library: every audio file in the places the studio looks, listed without decoding any of them.

Tempo, beats and loop suggestions are worked out when a song is picked (/api/features), so a folder with
hundreds of songs lists instantly. Songs come from three places, in this order:

- out/uploads/, where songs added in the studio are copied, so they survive a restart
- the top level of ~/Downloads
- music folders the user chose, scanned with their subfolders and saved in out/.library.json
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import subprocess

from .encoder import ffmpeg_path

AUDIO_EXTS = (".wav", ".mp3", ".m4a", ".aac", ".flac", ".aif", ".aiff", ".ogg", ".opus")
# Formats every browser can decode as they are. Anything else is converted to WAV before playback.
BROWSER_AUDIO_EXTS = (".wav", ".mp3", ".flac")
MIN_BYTES = 250_000  # in scanned folders, skips alert sounds and clips too short to loop
MAX_PER_FOLDER = 5000
_SKIP_DIR_SUFFIXES = (".app", ".photoslibrary", ".musiclibrary", ".tvlibrary", ".logicx", ".band")


@dataclasses.dataclass
class Track:
    id: str
    path: str
    name: str
    source: str  # "added", "downloads", or the music folder it was found in
    dir: str  # subfolder inside a music folder, "" at the top
    mtime: float

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "path": self.path,
            "source": self.source,
            "dir": self.dir,
            "mtime": int(self.mtime),
        }


def track_id(path: str) -> str:
    """Stable id for a song file. analyze_track() uses it too, so saved sessions keep their song."""
    return hashlib.md5(os.path.abspath(os.path.expanduser(path)).encode("utf-8")).hexdigest()[:10]


def is_audio_name(name: str) -> bool:
    return name.lower().endswith(AUDIO_EXTS) and not name.startswith((".", "segment-"))


def _track(path: str, source: str, root: str, mtime: float) -> Track:
    rel = os.path.relpath(os.path.dirname(path), root)
    return Track(track_id(path), path, os.path.basename(path), source, "" if rel == "." else rel, mtime)


def scan_folder(folder: str, source: str, recursive: bool, min_bytes: int = MIN_BYTES) -> list[Track]:
    """Audio files in a folder, newest first. Hidden folders and app bundles are skipped."""
    found: list[Track] = []
    if not os.path.isdir(folder):
        return found
    walker = os.walk(folder) if recursive else [(folder, [], os.listdir(folder))]
    for dirpath, dirnames, filenames in walker:
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and not d.lower().endswith(_SKIP_DIR_SUFFIXES)]
        for fn in filenames:
            if not is_audio_name(fn):
                continue
            path = os.path.join(dirpath, fn)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_size >= min_bytes:
                found.append(_track(path, source, folder, st.st_mtime))
                if len(found) >= MAX_PER_FOLDER:
                    break
        if len(found) >= MAX_PER_FOLDER:
            break
    found.sort(key=lambda t: t.mtime, reverse=True)
    return found


class Library:
    def __init__(self, out_dir: str, downloads: str = "~/Downloads") -> None:
        self.uploads = os.path.join(out_dir, "uploads")
        self.config_path = os.path.join(out_dir, ".library.json")
        self.downloads = os.path.abspath(os.path.expanduser(downloads))

    def folders(self) -> list[str]:
        try:
            with open(self.config_path) as f:
                return [p for p in json.load(f).get("folders", []) if isinstance(p, str)]
        except (OSError, ValueError):
            return []

    def _save(self, folders: list[str]) -> None:
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        with open(self.config_path, "w") as f:
            json.dump({"folders": folders}, f, indent=1)

    def add_folder(self, path: str) -> str:
        folder = os.path.abspath(os.path.expanduser(path.strip()))
        if not os.path.isdir(folder):
            raise FileNotFoundError(f"No folder at {folder}")
        folders = self.folders()
        if folder not in folders:
            self._save(folders + [folder])
        return folder

    def remove_folder(self, path: str) -> None:
        folder = os.path.abspath(os.path.expanduser(path))
        self._save([p for p in self.folders() if p != folder])

    def suggestions(self) -> list[str]:
        """Common Mac music folders that exist and aren't being scanned yet."""
        chosen = set(self.folders())
        return [p for p in (os.path.expanduser("~/Music"),) if os.path.isdir(p) and p not in chosen]

    def scan(self) -> dict[str, Track]:
        """Every song, keyed by id. A file reachable from two places is listed under the first."""
        groups = [
            # Songs added in the studio were chosen on purpose, so any length counts.
            scan_folder(self.uploads, "added", recursive=False, min_bytes=1),
            scan_folder(self.downloads, "downloads", recursive=False),
        ] + [scan_folder(p, p, recursive=True) for p in self.folders()]
        tracks: dict[str, Track] = {}
        for group in groups:
            for t in group:
                tracks.setdefault(t.id, t)
        return tracks


def playable_path(track: Track, cache_dir: str, keep: int = 20) -> str:
    """A file the browser can decode. AIFF, OGG, Opus, AAC and M4A (which may hold ALAC) are converted
    to WAV once with ffmpeg, the same decoder the analysis uses, so playback and beat grid line up. Only
    the most recent `keep` conversions are kept."""
    if track.path.lower().endswith(BROWSER_AUDIO_EXTS):
        return track.path
    os.makedirs(cache_dir, exist_ok=True)
    dest = os.path.join(cache_dir, f"{track.id}.wav")
    if not os.path.isfile(dest) or os.path.getmtime(dest) < os.path.getmtime(track.path):
        tmp = dest + ".part"
        subprocess.run(
            [ffmpeg_path(), "-v", "error", "-y", "-i", track.path, "-vn", "-acodec", "pcm_s16le", "-f", "wav", tmp],
            check=True,
            capture_output=True,
        )
        os.replace(tmp, dest)
        cached = sorted((os.path.join(cache_dir, f) for f in os.listdir(cache_dir) if f.endswith(".wav")), key=os.path.getmtime)
        for old in cached[:-keep]:
            os.remove(old)
    else:
        os.utime(dest)
    return dest


def pick_folder_dialog() -> str | None:
    """Open the macOS folder chooser on this Mac. Returns the chosen path, or None if cancelled."""
    script = [
        "-e", "activate",
        "-e", 'POSIX path of (choose folder with prompt "Choose a folder of songs for Downbeat" default location (path to music folder))',
    ]
    res = subprocess.run(["osascript", *script], capture_output=True, text=True)
    if res.returncode != 0:
        return None
    return res.stdout.strip() or None
