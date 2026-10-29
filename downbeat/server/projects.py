"""Saved projects. Each one is a JSON file in out/projects/ holding a name and the edit the studio autosaves
to it. An export keeps a copy of the edit it was made from in out/projects/exports/, so a render can be
opened again in the studio."""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import threading
import time

from .storage import read_json as _read_json, remove_file, write_json as _write_json

_ID = re.compile(r"^[0-9a-f]{12}$")
NAME_MAX = 80
# An edit is a few kilobytes, or a few hundred with a stack for every clip. This only stops a runaway request.
DATA_MAX = 8 << 20
# One write at a time across the server's threads: a save can't land between a rename's read and its write.
_LOCK = threading.Lock()


def clean_name(name: object) -> str:
    """One line of at most NAME_MAX characters, or "Untitled"."""
    text = " ".join(str(name or "").split())[:NAME_MAX].strip()
    return text or "Untitled"


def _summary(record: dict) -> dict:
    """What the project list shows, without the edit itself."""
    data = record.get("data") or {}
    selected = data.get("selected") if isinstance(data.get("selected"), list) else []
    look = data.get("look") if isinstance(data.get("look"), dict) else {}
    return {
        "id": record["id"],
        "name": record.get("name") or "Untitled",
        "created": record.get("created"),
        "updated": record.get("updated"),
        "clips": len(selected),
        "first_clip": selected[0] if selected else None,
        "track_id": data.get("trackId") or None,
        "look": look.get("name"),
        "bars": data.get("bars"),
    }


def _check_data(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("The edit must be a JSON object")
    if len(json.dumps(data)) > DATA_MAX:
        raise ValueError("The edit is too large to save")
    return data


class ProjectStore:
    def __init__(self, root: str) -> None:
        self.root = root
        self.exports = os.path.join(root, "exports")

    def _path(self, pid: str) -> str:
        if not _ID.fullmatch(str(pid)):
            raise KeyError(pid)
        return os.path.join(self.root, f"{pid}.json")

    def _load(self, pid: str) -> dict:
        record = _read_json(self._path(pid))
        if (record is None or record.get("id") != pid or not isinstance(record.get("data"), dict)
                or not isinstance(record.get("name", ""), str)):
            raise KeyError(pid)
        for field in ("created", "updated"):
            value = record.get(field)
            if value is not None and (not isinstance(value, (int, float)) or not math.isfinite(value)):
                raise KeyError(pid)
        return record

    def _unique(self, name: str, skip: str | None = None) -> str:
        """The name, or the name with the next free number after it when another project has it."""
        taken = {p["name"].lower() for p in self.list() if p["id"] != skip}
        if name.lower() not in taken:
            return name
        base = re.sub(r" \d+$", "", name)
        n = 2
        while f"{base} {n}".lower() in taken:
            n += 1
        return f"{base} {n}"

    def list(self) -> list[dict]:
        """Every project, the most recently saved first. A file that can't be read is left out."""
        out = []
        try:
            names = os.listdir(self.root)
        except OSError:
            return []
        for fname in names:
            pid, ext = os.path.splitext(fname)
            if ext != ".json" or not _ID.fullmatch(pid):
                continue
            try:
                out.append(_summary(self._load(pid)))
            except KeyError:
                continue
        return sorted(out, key=lambda p: p.get("updated") or 0, reverse=True)

    def get(self, pid: str) -> dict:
        return self._load(pid)

    def create(self, name: object, data: object) -> dict:
        data = _check_data(data)
        with _LOCK:
            pid = secrets.token_hex(6)
            while os.path.exists(self._path(pid)):
                pid = secrets.token_hex(6)
            now = round(time.time(), 3)
            record = {"id": pid, "name": self._unique(clean_name(name)), "created": now, "updated": now, "data": data}
            _write_json(self._path(pid), record)
        return _summary(record)

    def save(self, pid: str, data: object) -> dict:
        """Replace a project's edit. A project that was deleted stays deleted (KeyError)."""
        data = _check_data(data)
        with _LOCK:
            record = self._load(pid)
            record["data"] = data
            record["updated"] = round(time.time(), 3)
            _write_json(self._path(pid), record)
        return _summary(record)

    def rename(self, pid: str, name: object) -> dict:
        with _LOCK:
            record = self._load(pid)
            record["name"] = self._unique(clean_name(name), skip=pid)
            _write_json(self._path(pid), record)
        return _summary(record)

    def delete(self, pid: str) -> None:
        path = self._path(pid)
        with _LOCK:
            if os.path.isfile(path):
                remove_file(path)

    def _export_path(self, filename: str) -> str:
        name = os.path.basename(str(filename))
        stem, ext = os.path.splitext(name)
        if ext.lower() not in (".mp4", ".mov"):
            raise KeyError(filename)
        # Preserve the established MP4 sidecar name.  MOV keeps its extension so
        # equally named masters cannot overwrite one another's saved edits.
        suffix = ".mov.json" if ext.lower() == ".mov" else ".json"
        return os.path.join(self.exports, stem + suffix)

    def save_export_edit(self, filename: str, data: object) -> None:
        checked = _check_data(data)
        with _LOCK:
            _write_json(self._export_path(filename), {"export": os.path.basename(filename), "data": checked})

    def export_edit(self, filename: str) -> dict:
        record = _read_json(self._export_path(filename))
        if record is None or not isinstance(record.get("data"), dict):
            raise KeyError(filename)
        return record["data"]

    def has_export_edit(self, filename: str) -> bool:
        try:
            return os.path.isfile(self._export_path(filename))
        except KeyError:
            return False

    def delete_export_edit(self, filename: str) -> None:
        try:
            path = self._export_path(filename)
        except KeyError:
            return
        with _LOCK:
            if os.path.isfile(path):
                remove_file(path)
