"""Bounded media caches share work and invalidate results when files change."""
from __future__ import annotations

import os
import tempfile
import threading
import unittest

from downbeat._cache import BoundedCache, FileResultCache


class TestBoundedCache(unittest.TestCase):
    def test_assignment_during_a_producer_keeps_byte_accounting_accurate(self) -> None:
        cache: BoundedCache[str, bytes] = BoundedCache(3, max_bytes=8, weigh=len)

        def create() -> bytes:
            cache["same"] = b"old"
            return b"new!"

        self.assertEqual(cache.get_or_create("same", create), b"new!")
        cache["other"] = b"more"
        self.assertEqual(dict(cache), {"same": b"new!", "other": b"more"})
        del cache["same"]
        cache["third"] = b"last"
        self.assertEqual(dict(cache), {"other": b"more", "third": b"last"})

    def test_concurrent_misses_share_one_producer(self) -> None:
        cache: BoundedCache[str, object] = BoundedCache(2)
        entered = threading.Event()
        release = threading.Event()
        calls = []
        value = object()

        def create() -> object:
            calls.append(True)
            entered.set()
            self.assertTrue(release.wait(2))
            return value

        results: list[object] = []
        threads = [threading.Thread(target=lambda: results.append(cache.get_or_create("same", create))) for _ in range(6)]
        for thread in threads:
            thread.start()
        self.assertTrue(entered.wait(2))
        release.set()
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(calls), 1)
        self.assertEqual(results, [value] * 6)

    def test_file_results_are_bounded_and_recomputed_after_replacement(self) -> None:
        cache: FileResultCache[int] = FileResultCache(2)
        with tempfile.TemporaryDirectory(prefix="db-cache-") as tmp:
            paths = [os.path.join(tmp, f"{n}.bin") for n in range(3)]
            for path in paths:
                with open(path, "wb") as f:
                    f.write(b"a")
            calls = []
            first = cache.get_or_create("clip", paths[0], lambda: calls.append("a") or 1)
            again = cache.get_or_create("clip", paths[0], lambda: calls.append("duplicate") or 2)
            self.assertEqual((first, again, calls), (1, 1, ["a"]))

            with open(paths[0], "wb") as f:
                f.write(b"b")
            stamp = os.stat(paths[0]).st_mtime_ns + 1_000_000
            os.utime(paths[0], ns=(stamp, stamp))
            changed = cache.get_or_create("clip", paths[0], lambda: calls.append("b") or 3)
            self.assertEqual((changed, calls), (3, ["a", "b"]))

            cache.get_or_create("two", paths[1], lambda: 2)
            cache.get_or_create("three", paths[2], lambda: 3)
            self.assertEqual(len(cache), 2)
            self.assertNotIn("clip", cache)


if __name__ == "__main__":
    unittest.main()
