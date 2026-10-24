"""HTTP representations of media, separate from request handling and mutable state."""
from __future__ import annotations

from collections.abc import Callable, Iterable

from ..media.source import Source
from .library import source_of


def clip_payload(src: Source, uploads: str, folders: list[str], status: Callable[[Source], str]) -> dict:
    origin, subfolder = source_of(src.path, uploads, folders)
    return {
        "id": src.id,
        "name": src.name,
        "path": src.path,
        "source": origin,
        "dir": subfolder,
        "width": src.width,
        "height": src.height,
        "fps": round(src.fps, 1),
        "duration": round(src.duration, 1),
        "is_stock": src.name[:1].isdigit(),
        "still": src.path.endswith(".still.mp4"),
        "proxy": status(src),
    }


def clip_payloads(clips: Iterable[Source], uploads: str, folders: list[str], status: Callable[[Source], str]) -> list[dict]:
    return [clip_payload(src, uploads, folders, status) for src in clips]
