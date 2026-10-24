"""Media files and ffmpeg: probing, thumbnails, playback proxies, encoding."""
from __future__ import annotations

import hashlib


def file_id(path: str) -> str:
    """Short stable id for a media file, from its path. Clips and songs both use it."""
    return hashlib.md5(path.encode("utf-8")).hexdigest()[:10]
