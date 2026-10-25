"""The downbeat command: argument parsing, listing, dry runs and a tiny real render."""
from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

from downbeat import __version__, cli
from downbeat.render import effects
from downbeat.render.recipe import PRESETS
from helpers import HAS_FFMPEG


def _run(argv: list[str]) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli.main(argv)
    return code, out.getvalue()


class TestCommandLine(unittest.TestCase):
    def test_list_prints_every_preset_and_effect(self) -> None:
        code, text = _run(["--list"])
        self.assertEqual(code, 0)
        self.assertIn("Presets:", text)
        self.assertIn("Effects:", text)
        for pid in PRESETS:
            self.assertIn(pid, text)
        for name in effects.EFFECTS:
            self.assertIn(name, text)

    def test_dry_run_prints_the_same_recipe_for_the_same_seed(self) -> None:
        preset = next(iter(PRESETS))
        argv = ["--dry-run", "--seed", "7", "--preset", preset, "--bpm", "124", "--duration", "6"]
        code, first = _run(argv)
        self.assertEqual(code, 0)
        self.assertEqual(_run(argv)[1], first)
        self.assertIn("seed=7", first)
        self.assertIn(f"preset={preset}", first)
        self.assertIn("bpm=124", first)
        self.assertIn("dur=6.0s", first)
        # without a seed the dry run uses 2026, so it is repeatable too
        self.assertIn("seed=2026", _run(["--dry-run"])[1])

    def test_dry_run_passes_the_edit_options_to_the_recipe(self) -> None:
        argv = ["--dry-run", "--seed", "3", "--loop-mode", "rebound", "--clip-direction", "pingpong",
                "--cut-mode", "syncopated", "--filter-mode", "evolve", "--transition", "glitch"]
        text = _run(argv)[1]
        for part in ("loop=rebound", "dir=pingpong", "cut_mode=syncopated", "filter_mode=evolve", "transition=glitch"):
            self.assertIn(part, text)

    def test_version_and_bad_arguments_exit(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as done:
            cli.main(["--version"])
        self.assertEqual(done.exception.code, 0)
        self.assertEqual(out.getvalue().strip(), f"downbeat {__version__}")
        for bad in (["--preset", "no-such-preset"], ["--bpm", "fast"], ["--loop-mode", "spiral"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as done:
                cli.main(bad)
            self.assertEqual(done.exception.code, 2, bad)

    def test_no_videos_or_studio_flag_starts_the_studio(self) -> None:
        with mock.patch("downbeat.server.app.serve_studio") as serve:
            self.assertEqual(cli.main([]), 0)
            serve.assert_called_once_with(port=8765, open_browser=True)
        with mock.patch("downbeat.server.app.serve_studio") as serve:
            self.assertEqual(cli.main(["--studio", "--port", "9123", "--no-browser", "clip.mp4"]), 0)
            serve.assert_called_once_with(port=9123, open_browser=False)

    def test_videos_render_one_montage_with_the_chosen_options(self) -> None:
        with mock.patch.object(cli, "render") as render:
            argv = ["~/a.mp4", "b.mp4", "-o", "x.mp4", "--seed", "5", "--cut-beats", "0.5", "--transitions", "dissolve", "glitch",
                    "--no-ensure-all", "--speed", "1.5", "--effects", "3", "--intensity", "0.7", "--audio", "song.wav"]
            self.assertEqual(cli.main(argv), 0)
        render.assert_called_once()
        (paths, out), kw = render.call_args
        self.assertEqual((paths, out), ([os.path.expanduser("~/a.mp4"), "b.mp4"], "x.mp4"))
        self.assertEqual(
            {k: kw[k] for k in ("seed", "cut_beats", "transitions", "ensure_all_clips", "speed", "max_effects", "intensity", "audio_path")},
            {"seed": 5, "cut_beats": 0.5, "transitions": ["dissolve", "glitch"], "ensure_all_clips": False, "speed": 1.5,
             "max_effects": 3, "intensity": 0.7, "audio_path": "song.wav"},
        )
        self.assertEqual((kw["duration"], kw["loop_mode"], kw["cut_mode"], kw["transition_mode"]), (8.0, "crossfade", "steady", "cycle"))

    def test_separate_renders_each_video_to_its_own_file(self) -> None:
        with mock.patch.object(cli, "render") as render:
            cli.main(["clips/a.mp4", "clips/b.mp4", "--separate"])
        self.assertEqual([c.args for c in render.call_args_list],
                         [(["clips/a.mp4"], "out/a-canvas.mp4"), (["clips/b.mp4"], "out/b-canvas.mp4")])
        with mock.patch.object(cli, "render") as render:
            cli.main(["only.mp4", "--separate"])  # one video is a normal render
        self.assertEqual(render.call_args.args, (["only.mp4"], "out/sample-canvas.mp4"))

    def test_running_the_package_runs_the_command(self) -> None:
        with mock.patch.object(sys, "argv", ["downbeat", "--list"]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as done:
                runpy.run_module("downbeat", run_name="__main__")
        self.assertEqual(done.exception.code, 0)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe required")
class TestRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="db-cli-")
        cls.clip = os.path.join(cls.tmp, "clip.mp4")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x160:rate=30", "-t", "2",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", cls.clip],
            check=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _probe(self, path: str) -> dict:
        info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]))
        return info["streams"][0]

    def test_renders_a_short_silent_loop_at_the_asked_size(self) -> None:
        dest = os.path.join(self.tmp, "nested", "out.mp4")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            path = cli.render([self.clip], dest, seed=11, duration=3.0, width=108, height=192)
        self.assertEqual(path, dest)
        video = self._probe(dest)
        self.assertEqual((video["width"], video["height"], int(video["nb_frames"])), (108, 192, 90))
        self.assertEqual(video["codec_name"], "h264")
        text = out.getvalue()
        self.assertIn("source: ", text)
        self.assertIn("seed=11", text)
        self.assertIn("100.0%", text)

    def test_a_song_sets_the_tempo_when_none_is_given(self) -> None:
        import wave

        song = os.path.join(self.tmp, "song_140bpm.wav")
        sr = 22050
        y = (np.sin(np.arange(sr * 4) * 2 * np.pi * 80 / sr) * 8000).astype(np.int16)
        with wave.open(song, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(y.tobytes())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cli.render(self.clip, os.path.join(self.tmp, "song.mp4"), seed=2, duration=3.0, width=108, height=192, audio_path=song)
        self.assertIn("detected 140 BPM", out.getvalue())
        self.assertIn("bpm=140", out.getvalue())

    def test_quiet_render_prints_nothing(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cli.render([self.clip], os.path.join(self.tmp, "quiet.mp4"), seed=4, duration=3.0, width=108, height=192, quiet=True)
        self.assertEqual(out.getvalue(), "")

    def test_a_failed_or_interrupted_render_aborts_ffmpeg_and_removes_its_partial_output(self) -> None:
        from downbeat.media.encoder import Encoder

        for error in (RuntimeError("effect failed"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                encoders = []

                def start(*args, **kwargs):
                    encoder = Encoder(*args, **kwargs)
                    encoders.append(encoder)
                    return encoder

                plan = mock.Mock(n_frames=1)
                plan.render.side_effect = error
                dest = os.path.join(self.tmp, "failed.mp4")
                with mock.patch.object(cli, "build_plan", return_value=plan), \
                     mock.patch.object(cli, "Encoder", side_effect=start), self.assertRaises(type(error)):
                    cli.render(self.clip, dest, seed=4, width=108, height=192, quiet=True)
                self.assertIsNotNone(encoders[0].proc.poll())
                self.assertFalse(os.path.exists(dest))


if __name__ == "__main__":
    unittest.main()
