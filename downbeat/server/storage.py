"""Atomic JSON persistence shared by projects and library preferences, and file operations that hold up
on Windows while another request is reading the same file."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from collections.abc import Callable
from typing import BinaryIO, TypeVar

T = TypeVar("T")

# Windows won't replace or delete a file while another handle has it open: a request reading it, the
# search indexer or an antivirus scan. Those last milliseconds, so the operation is retried this long.
# Elsewhere a PermissionError means what it says, so only Windows waits.
RETRY_IN_USE = sys.platform == "win32"
LOCK_RETRY_SECONDS = 1.0

if sys.platform == "win32":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                      wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _GENERIC_READ = 0x80000000
    _SHARE_READ_WRITE_DELETE = 0x7
    _OPEN_EXISTING = 3
    _INVALID_HANDLE = wintypes.HANDLE(-1).value


def open_shared(path: str) -> BinaryIO:
    """Open a file for reading without stopping it from being deleted meanwhile.

    Python's open() on Windows doesn't share delete access, so deleting an export failed while the
    studio was still streaming it. With delete sharing the name goes at once and the data when the
    reader closes, as on macOS and Linux.
    """
    if sys.platform != "win32":
        return open(path, "rb")
    handle = _kernel32.CreateFileW(path, _GENERIC_READ, _SHARE_READ_WRITE_DELETE, None, _OPEN_EXISTING, 0, None)
    if handle == _INVALID_HANDLE:
        code = ctypes.get_last_error()
        raise OSError(None, ctypes.FormatError(code), path, code)
    try:
        return os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb")
    except BaseException:
        _kernel32.CloseHandle(handle)
        raise


def _retry_while_in_use(op: Callable[[], T]) -> T:
    deadline = time.monotonic() + LOCK_RETRY_SECONDS
    delay = 0.01
    while True:
        try:
            return op()
        except PermissionError:
            if not RETRY_IN_USE or time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.1)


def replace_file(src: str, dst: str) -> None:
    """os.replace, waiting briefly while another handle has the destination open on Windows."""
    _retry_while_in_use(lambda: os.replace(src, dst))


def remove_file(path: str) -> None:
    """os.remove, waiting briefly while another handle has the file open on Windows."""
    _retry_while_in_use(lambda: os.remove(path))


def read_json(path: str) -> dict | None:
    def load() -> object:
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    try:
        # Opening can briefly fail on Windows while write_json is replacing the file.
        data = _retry_while_in_use(load)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_json(path: str, payload: dict | list) -> None:
    """Replace a complete file so interrupted writes cannot truncate the previous save."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        replace_file(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
