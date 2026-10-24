"""Encoder pipe failures are covered on every host, including the Windows writer."""
from __future__ import annotations

import os
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

from downbeat.media import encoder
from helpers import TempDirCase


class Pipe:
    def __init__(self, mode: str):
        self.mode = mode
        self.closed = False
        self.received = bytearray()
        self.entered = threading.Event()
        self.released = threading.Event()

    def write(self, data: memoryview) -> int:
        if self.mode == "blocked":
            self.entered.set()
            if not self.released.wait(2):
                raise AssertionError("killing the child did not release its pipe")
            raise BrokenPipeError("child killed")
        if self.mode == "closed":
            return 0
        count = min(3, len(data))
        self.received.extend(data[:count])
        return count

    def close(self) -> None:
        self.closed = True


class Child:
    def __init__(self, mode: str):
        self.stdin = Pipe(mode)
        self.returncode = None
        self.killed = False

    def poll(self):
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9
        self.stdin.released.set()

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class TestEncoderResilience(TempDirCase):
    def writer(self, mode: str):
        child = Child(mode)
        # Replace this module's OS adapter rather than changing os.name for the test runner.
        windows = SimpleNamespace(name="nt", path=os.path, remove=os.remove)
        self.enterContext(mock.patch.object(encoder, "os", windows))
        self.enterContext(mock.patch.object(encoder, "ffmpeg_path", return_value="ffmpeg"))
        self.enterContext(mock.patch.object(encoder.subprocess, "Popen", return_value=child))
        enc = encoder.Encoder(self.path(mode + ".mp4"), width=16, height=16, use_hw=False, write_timeout=0.1)
        self.addCleanup(enc.abort)
        return enc, child

    def test_partial_windows_pipe_writes_preserve_every_byte_and_close_once(self) -> None:
        enc, child = self.writer("partial")
        frame = bytes(range(32))
        enc.write(frame)
        self.assertEqual(bytes(child.stdin.received), frame)
        enc.close()
        enc.close()
        self.assertTrue(child.stdin.closed)
        self.assertFalse(child.killed)
        self.assertTrue(enc._stderr.closed)
        with self.assertRaisesRegex(RuntimeError, "Encoder is closed"):
            enc.write(frame)

    def test_a_closed_windows_pipe_aborts_and_removes_the_partial_output(self) -> None:
        enc, child = self.writer("closed")
        with open(enc.path, "wb") as output:
            output.write(b"incomplete")
        with self.assertRaisesRegex(BrokenPipeError, "stopped accepting"):
            enc.write(b"frame")
        self.assertTrue(child.killed)
        self.assertTrue(child.stdin.closed)
        self.assertTrue(enc._stderr.closed)
        self.assertFalse(os.path.exists(enc.path))

    def test_a_blocked_windows_writer_is_released_before_its_pipe_is_closed(self) -> None:
        enc, child = self.writer("blocked")
        with open(enc.path, "wb") as output:
            output.write(b"incomplete")
        with self.assertRaisesRegex(TimeoutError, "stopped accepting"):
            enc.write(b"frame")
        self.assertTrue(child.stdin.entered.is_set())
        self.assertTrue(child.killed)
        self.assertTrue(child.stdin.closed)
        self.assertTrue(enc._stderr.closed)
        self.assertFalse(os.path.exists(enc.path))
        self.assertFalse(any(t.name == "downbeat-ffmpeg-write" and t.is_alive() for t in threading.enumerate()))

    def test_invalid_output_settings_never_start_an_encoder(self) -> None:
        cases = [dict(codec="unknown"), dict(width=0), dict(fps=0), dict(codec="prores_422_hq")]
        with mock.patch.object(encoder.subprocess, "Popen") as spawn:
            for options in cases:
                with self.subTest(options=options), self.assertRaises(ValueError):
                    encoder.Encoder(self.path("invalid.mp4"), **options)
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
