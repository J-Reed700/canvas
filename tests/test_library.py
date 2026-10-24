"""The song library: which files are listed, music folders, and converting formats for playback."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import unittest
import wave
from unittest import mock

from downbeat.server import library
from helpers import HAS_FFMPEG, ROOT


class TestLibraryHelpers(unittest.TestCase):
    def test_audio_names_skip_hidden_and_segment_files(self) -> None:
        for name, ok in (("Song.MP3", True), ("a.flac", True), ("x.opus", True), (".hidden.wav", False),
                         ("segment-3.wav", False), ("notes.txt", False), ("clip.mp4", False)):
            self.assertEqual(library.is_audio_name(name), ok, name)

    def test_scanning_a_missing_folder_finds_nothing(self) -> None:
        self.assertEqual(library.scan_folder("/no/such/folder", "x", recursive=True), [])

    def test_track_dicts_round_the_mtime(self) -> None:
        t = library.Track("id", "/m/a.wav", "a.wav", "downloads", "", 1700000000.9)
        self.assertEqual(t.to_dict()["mtime"], 1700000000)

    def test_folder_chooser_returns_the_path_or_none(self) -> None:
        done = subprocess.CompletedProcess
        with mock.patch.object(library.subprocess, "run", return_value=done([], 0, "/Users/me/Music/\n", "")) as run:
            self.assertEqual(library.pick_folder_dialog(), "/Users/me/Music/")
        self.assertEqual(run.call_args.args[0][0], "osascript")
        with mock.patch.object(library.subprocess, "run", return_value=done([], 1, "", "User canceled")):
            self.assertIsNone(library.pick_folder_dialog())
        with mock.patch.object(library.subprocess, "run", return_value=done([], 0, "  \n", "")):
            self.assertIsNone(library.pick_folder_dialog())

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg required")
    def test_conversion_cache_keeps_only_the_newest(self) -> None:
        tmp = tempfile.mkdtemp(prefix="db-lib-")
        self.addCleanup(shutil.rmtree, tmp, True)
        tracks = []
        for i in range(2):
            src = os.path.join(tmp, f"song-{i}.aif")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", src], check=True)
            tracks.append(library._track(src, "downloads", tmp, 0.0))
        cache = os.path.join(tmp, "cache")
        first = library.playable_path(tracks[0], cache, keep=1)
        os.utime(first, (time.time() - 60, time.time() - 60))
        second = library.playable_path(tracks[1], cache, keep=1)
        self.assertEqual(os.listdir(cache), [os.path.basename(second)])


@unittest.skipUnless(
    shutil.which("node") and (
        os.path.isfile(os.path.join(ROOT, "downbeat", "studio", "src", "engine", "timeline.ts"))
        or os.path.isfile(os.path.join(ROOT, "downbeat", "studio", "timeline.js"))
    ),
    "node and studio TS/JS modules required for the studio tests",
)
class TestSongLibrary(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.out = os.path.join(self.tmp, "out")
        self.downloads = os.path.join(self.tmp, "Downloads")
        self.music = os.path.join(self.tmp, "Music")
        for d in (self.out, self.downloads, self.music):
            os.makedirs(d)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _wav(self, path: str, seconds: float) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(b"\0" * int(44100 * seconds) * 4)
        return path

    def test_lists_every_song_without_analysing_and_keeps_added_ones(self) -> None:
        from downbeat.analysis.audio import analyze_track
        from downbeat.server.library import Library

        for i in range(12):  # more than the old limit of 8
            self._wav(os.path.join(self.downloads, f"song-{i}.wav"), 3.0)
        self._wav(os.path.join(self.downloads, "ping.wav"), 0.2)  # an alert sound, too small
        self._wav(os.path.join(self.downloads, "nested", "deeper.wav"), 3.0)  # Downloads is top level only
        added = self._wav(os.path.join(self.out, "uploads", "short-loop.wav"), 0.2)  # added on purpose: kept
        lib = Library(self.out, downloads=self.downloads)

        tracks = lib.scan()
        names = sorted(t.name for t in tracks.values())
        self.assertEqual(len(names), 13)
        self.assertNotIn("ping.wav", names)
        self.assertNotIn("deeper.wav", names)
        song = next(t for t in tracks.values() if t.name == "song-3.wav")
        self.assertEqual(song.source, "downloads")
        # Same id the old analysis gave, so a saved session still finds its song.
        self.assertEqual(song.id, analyze_track(song.path).id)
        self.assertEqual(next(t for t in tracks.values() if t.path == added).source, "added")

    def test_music_folders_are_scanned_with_subfolders_and_remembered(self) -> None:
        from downbeat.server.library import Library

        self._wav(os.path.join(self.music, "Artist", "Album", "01 Intro.wav"), 3.0)
        self._wav(os.path.join(self.music, "Library.musiclibrary", "inside.wav"), 3.0)
        self._wav(os.path.join(self.music, ".hidden", "secret.wav"), 3.0)
        lib = Library(self.out, downloads=self.downloads)
        with self.assertRaises(FileNotFoundError):
            lib.add_folder(os.path.join(self.tmp, "missing"))
        lib.add_folder(self.music)

        again = Library(self.out, downloads=self.downloads)  # a restart reads out/.library.json
        self.assertEqual(again.folders(), [self.music])
        tracks = list(again.scan().values())
        self.assertEqual([(t.name, t.dir, t.source) for t in tracks], [("01 Intro.wav", os.path.join("Artist", "Album"), self.music)])

        again.remove_folder(self.music)
        self.assertEqual(Library(self.out, downloads=self.downloads).scan(), {})

    def test_formats_browsers_cannot_decode_are_converted_once(self) -> None:
        from downbeat.server.library import Library, playable_path

        wav = self._wav(os.path.join(self.downloads, "plain.wav"), 3.0)
        aiff = os.path.join(self.downloads, "studio.aiff")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, aiff], check=True)
        tracks = {t.name: t for t in Library(self.out, downloads=self.downloads).scan().values()}
        cache = os.path.join(self.out, ".audio-cache")

        self.assertEqual(playable_path(tracks["plain.wav"], cache), wav)
        converted = playable_path(tracks["studio.aiff"], cache)
        self.assertTrue(converted.endswith(".wav") and os.path.isfile(converted))
        with wave.open(converted) as w:
            self.assertAlmostEqual(w.getnframes() / w.getframerate(), 3.0, places=2)
        stamp = os.path.getmtime(converted)
        self.assertEqual(playable_path(tracks["studio.aiff"], cache), converted)
        self.assertGreaterEqual(os.path.getmtime(converted), stamp)


if __name__ == "__main__":
    unittest.main()
