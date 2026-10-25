"""Bounded caches that share in-flight work between HTTP request threads."""
from __future__ import annotations

import os
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterator, MutableMapping
from concurrent.futures import Future
from typing import Generic, TypeVar

K = TypeVar("K")
V = TypeVar("V")


def file_version(path: str) -> tuple[str, int, int]:
    """Invalidate media results when the file at a path is replaced or edited."""
    path = os.path.abspath(os.path.expanduser(path))
    st = os.stat(path)
    return path, st.st_mtime_ns, st.st_size


class BoundedCache(MutableMapping[K, V], Generic[K, V]):
    """LRU storage with one producer per key and a limit on concurrent producers.

    Expensive decodes run outside the bookkeeping lock. Exceptions are shared with
    current waiters and are never cached, so a later request can retry.
    """

    def __init__(self, max_entries: int, *, max_bytes: int | None = None,
                 weigh: Callable[[V], int] | None = None, workers: int = 2) -> None:
        self.max_entries = max(0, max_entries)
        self.max_bytes = max_bytes
        self._weigh = weigh or (lambda value: 0)
        self._values: OrderedDict[K, tuple[V, int]] = OrderedDict()
        self._pending: dict[K, Future[V]] = {}
        self._lock = threading.RLock()
        self._workers = threading.BoundedSemaphore(max(1, workers))
        self._bytes = 0
        self._generation = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._values)

    def __iter__(self) -> Iterator[K]:
        with self._lock:
            return iter(tuple(self._values))

    def __getitem__(self, key: K) -> V:
        with self._lock:
            value, _ = self._values[key]
            self._values.move_to_end(key)
            return value

    def __setitem__(self, key: K, value: V) -> None:
        size = max(0, self._weigh(value))
        if self.max_entries <= 0 or (self.max_bytes is not None and size > self.max_bytes):
            raise ValueError("value exceeds cache capacity")
        with self._lock:
            self._store(key, value, size)

    def _store(self, key: K, value: V, size: int) -> None:
        """Replace a value under the caller's lock, accounting for an existing entry exactly once."""
        old = self._values.pop(key, None)
        if old is not None:
            self._bytes -= old[1]
        while self._values and (len(self._values) >= self.max_entries
                                or (self.max_bytes is not None and self._bytes + size > self.max_bytes)):
            _, (_, old_size) = self._values.popitem(last=False)
            self._bytes -= old_size
        self._values[key] = value, size
        self._bytes += size

    def __delitem__(self, key: K) -> None:
        with self._lock:
            _, size = self._values.pop(key)
            self._bytes -= size

    def clear(self) -> None:
        with self._lock:
            self._generation += 1
            self._values.clear()
            self._bytes = 0

    def get_or_create(self, key: K, create: Callable[[], V]) -> V:
        with self._lock:
            if key in self._values:
                return self[key]
            pending = self._pending.get(key)
            producer = pending is None
            if producer:
                pending = self._pending[key] = Future()
            generation = self._generation
        assert pending is not None
        if not producer:
            return pending.result()
        try:
            with self._workers:
                value = create()
            size = max(0, self._weigh(value))
            with self._lock:
                if (generation == self._generation and self.max_entries > 0
                        and (self.max_bytes is None or size <= self.max_bytes)):
                    self._store(key, value, size)
                self._pending.pop(key, None)
                pending.set_result(value)
            return value
        except BaseException as exc:
            with self._lock:
                self._pending.pop(key, None)
                pending.set_exception(exc)
            raise


class FileResultCache(MutableMapping[str, V], Generic[V]):
    """A small dict-like view backed by fingerprinted, coalescing file results.

    The mapping interface keeps the latest result for callers that need a previously
    computed value (for example a companion crop).  ``get_or_create`` additionally
    keys the expensive result by path, nanosecond mtime, and size, so replacing a file
    at the same path cannot return the old analysis.  Both views use the same bound.
    """

    def __init__(self, max_entries: int = 128) -> None:
        self.max_entries = max(0, max_entries)
        self._results: BoundedCache[tuple[str, str, int, int], V] = BoundedCache(max_entries)
        self._latest: OrderedDict[str, tuple[tuple[str, int, int] | None, V]] = OrderedDict()
        self._lock = threading.RLock()
        self._generation = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._latest)

    def __iter__(self) -> Iterator[str]:
        with self._lock:
            return iter(tuple(self._latest))

    def __getitem__(self, key: str) -> V:
        with self._lock:
            version, value = self._latest[key]
            self._latest.move_to_end(key)
            return value

    def __setitem__(self, key: str, value: V) -> None:
        # Direct assignment is used for an explicit/manual result.  With no file
        # version attached it remains available until replaced or evicted.
        with self._lock:
            self._remember(key, None, value)

    def __delitem__(self, key: str) -> None:
        with self._lock:
            del self._latest[key]

    def clear(self) -> None:
        with self._lock:
            self._generation += 1
            self._latest.clear()
        self._results.clear()

    def get_or_create(self, key: str, path: str, create: Callable[[], V]) -> V:
        version = file_version(path)
        with self._lock:
            generation = self._generation
        value = self._results.get_or_create((key, *version), create)
        with self._lock:
            if generation == self._generation:
                self._remember(key, version, value)
        return value

    def current(self, key: str, path: str) -> V | None:
        """Return the latest result only when it still describes ``path``.

        A directly assigned value has no fingerprint and is treated as intentional;
        this also keeps the mapping useful to tests and callers injecting a focus.
        """
        try:
            version = file_version(path)
        except OSError:
            return None
        with self._lock:
            item = self._latest.get(key)
            if item is None or (item[0] is not None and item[0] != version):
                return None
            self._latest.move_to_end(key)
            return item[1]

    def _remember(self, key: str, version: tuple[str, int, int] | None, value: V) -> None:
        if self.max_entries <= 0:
            return
        self._latest[key] = (version, value)
        self._latest.move_to_end(key)
        while len(self._latest) > self.max_entries:
            self._latest.popitem(last=False)
