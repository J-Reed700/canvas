"""Media library: the songs and videos in the places the studio looks, listed without decoding any of them.

Tempo, beats and loop suggestions are worked out when a song is picked (/api/features), so a folder with
hundreds of songs lists instantly. Songs and videos come from two places, in this order:

- out/uploads/, where files added in the studio are copied, so they survive a restart
- the folders the user picked, scanned with their subfolders and saved in out/.library.json

Nothing is listed until the user picks a folder or adds a file.
"""
from __future__ import annotations

import dataclasses
import os
import subprocess
import tempfile
import threading

from ..media import file_id
from ..media.encoder import ffmpeg_path
from .storage import read_json, remove_file, replace_file, write_json

AUDIO_EXTS = (".wav", ".mp3", ".m4a", ".aac", ".flac", ".aif", ".aiff", ".ogg", ".opus")
VIDEO_EXTS = (".mp4", ".mov", ".m4v", ".webm", ".mkv")
# Formats every browser can decode as they are. Anything else is converted to WAV before playback.
BROWSER_AUDIO_EXTS = (".wav", ".mp3", ".flac")
MIN_BYTES = 250_000  # in scanned folders, skips alert sounds and clips too short to loop
MAX_PER_FOLDER = 5000
# Each video is probed and gets a playback proxy, so a big folder lists only its newest ones.
MAX_VIDEOS_PER_FOLDER = 50
_SKIP_DIR_SUFFIXES = (".app", ".photoslibrary", ".musiclibrary", ".tvlibrary", ".logicx", ".band")
_FOLDER_LOCK = threading.Lock()


@dataclasses.dataclass
class Track:
    id: str
    path: str
    name: str
    source: str  # "added", or the folder it was found in
    dir: str  # subfolder inside that folder, "" at the top
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
    return file_id(os.path.abspath(os.path.expanduser(path)))


def is_audio_name(name: str) -> bool:
    return name.lower().endswith(AUDIO_EXTS) and not name.startswith((".", "segment-"))


def _track(path: str, source: str, root: str, mtime: float) -> Track:
    rel = os.path.relpath(os.path.dirname(path), root)
    return Track(track_id(path), path, os.path.basename(path), source, "" if rel == "." else rel, mtime)


def source_of(path: str, uploads: str, folders: list[str]) -> tuple[str, str]:
    """Where a video is listed from, the way a Track says it: "added" or the picked folder that holds it, and
    the subfolder inside that. ("", "") for a path in none of them."""
    for root, source in [(uploads, "added"), *((f, f) for f in folders)]:
        try:
            rel = os.path.relpath(os.path.dirname(path), root)
        except ValueError:  # Windows folders on different drives have no relative path.
            continue
        if rel == ".":
            return source, ""
        if rel != os.pardir and not rel.startswith(os.pardir + os.sep):
            return source, rel
    return "", ""


def is_video_name(name: str) -> bool:
    return name.lower().endswith(VIDEO_EXTS) and not name.startswith(".")


def scan_folder(
    folder: str, source: str, recursive: bool, min_bytes: int = MIN_BYTES, max_videos: int | None = None
) -> tuple[list[Track], list[str]]:
    """The songs and the video paths in a folder, each newest first, with at most `max_videos` videos.
    Hidden folders and app bundles are skipped."""
    songs: list[Track] = []
    videos: list[tuple[float, str]] = []
    if not os.path.isdir(folder):
        return songs, []
    walker = os.walk(folder) if recursive else [(folder, [], os.listdir(folder))]
    for dirpath, dirnames, filenames in walker:
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and not d.lower().endswith(_SKIP_DIR_SUFFIXES)]
        for fn in filenames:
            audio = is_audio_name(fn)
            if not audio and not is_video_name(fn):
                continue
            path = os.path.join(dirpath, fn)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if not audio:
                videos.append((st.st_mtime, path))
            elif st.st_size >= min_bytes:
                songs.append(_track(path, source, folder, st.st_mtime))
                if len(songs) >= MAX_PER_FOLDER:
                    break
        if len(songs) >= MAX_PER_FOLDER:
            break
    songs.sort(key=lambda t: t.mtime, reverse=True)
    videos.sort(reverse=True)
    return songs, [p for _, p in videos[:max_videos]]


class Library:
    def __init__(self, out_dir: str) -> None:
        self.uploads = os.path.join(out_dir, "uploads")
        self.config_path = os.path.join(out_dir, ".library.json")

    def folders(self) -> list[str]:
        folders = (read_json(self.config_path) or {}).get("folders")
        return [p for p in folders if isinstance(p, str)] if isinstance(folders, list) else []

    def _save(self, folders: list[str]) -> None:
        write_json(self.config_path, {"folders": folders})

    def add_folder(self, path: str) -> str:
        folder = os.path.abspath(os.path.expanduser(path.strip()))
        if not os.path.isdir(folder):
            raise FileNotFoundError(f"No folder at {folder}")
        with _FOLDER_LOCK:
            folders = self.folders()
            if folder not in folders:
                self._save(folders + [folder])
        return folder

    def remove_folder(self, path: str) -> None:
        folder = os.path.abspath(os.path.expanduser(path))
        with _FOLDER_LOCK:
            self._save([p for p in self.folders() if p != folder])

    def suggestions(self) -> list[str]:
        """The home Music folder, if it exists and isn't being scanned yet."""
        chosen = set(self.folders())
        # Normalized the way add_folder stores it; "~/Music" expands to C:\Users\me/Music on Windows.
        music = os.path.abspath(os.path.expanduser(os.path.join("~", "Music")))
        return [p for p in (music,) if os.path.isdir(p) and p not in chosen]

    def scan(self) -> tuple[dict[str, Track], list[str]]:
        """Every song keyed by id, and the paths of the videos to list as clips. A file reachable from two
        places is listed under the first."""
        # Files added in the studio were chosen on purpose, so any length and any number of them count.
        groups = [scan_folder(self.uploads, "added", recursive=False, min_bytes=1)]
        groups += [scan_folder(p, p, recursive=True, max_videos=MAX_VIDEOS_PER_FOLDER) for p in self.folders()]
        tracks: dict[str, Track] = {}
        videos: list[str] = []
        for songs, paths in groups:
            for t in songs:
                tracks.setdefault(t.id, t)
            videos += paths
        return tracks, list(dict.fromkeys(videos))


def playable_path(track: Track, cache_dir: str, keep: int = 20) -> str:
    """A file the browser can decode. AIFF, OGG, Opus, AAC and M4A (which may hold ALAC) are converted
    to WAV once with ffmpeg, the same decoder the analysis uses, so playback and beat grid line up. Only
    the most recent `keep` conversions are kept."""
    if track.path.lower().endswith(BROWSER_AUDIO_EXTS):
        return track.path
    os.makedirs(cache_dir, exist_ok=True)
    dest = os.path.join(cache_dir, f"{track.id}.wav")
    if not os.path.isfile(dest) or os.path.getmtime(dest) < os.path.getmtime(track.path):
        fd, tmp = tempfile.mkstemp(prefix=f".{track.id}-", suffix=".part.wav", dir=cache_dir)
        os.close(fd)
        try:
            subprocess.run(
                [ffmpeg_path(), "-v", "error", "-y", "-i", track.path, "-vn", "-acodec", "pcm_s16le", "-f", "wav", tmp],
                check=True,
                capture_output=True,
                timeout=300,
            )
            replace_file(tmp, dest)  # the studio may be playing the previous copy
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        cached = sorted((os.path.join(cache_dir, f) for f in os.listdir(cache_dir) if f.endswith(".wav")), key=os.path.getmtime)
        for old in cached[:-keep]:
            remove_file(old)
    else:
        os.utime(dest)
    return dest


def pick_folder_dialog() -> str | None:
    """Open the macOS folder chooser on this Mac. Returns the chosen path, or None if cancelled."""
    script = [
        "-e", "activate",
        "-e", 'POSIX path of (choose folder with prompt "Choose the folder your videos and songs are in" default location (path to home folder))',
    ]
    res = subprocess.run(["osascript", *script], capture_output=True, text=True)
    if res.returncode != 0:
        return None
    return res.stdout.strip() or None
