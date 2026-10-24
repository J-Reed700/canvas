"""HTTP server for Downbeat Studio."""
from __future__ import annotations

import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from .. import delivery
from ..analysis import framing
from ..analysis.features import track_features
from .library import AUDIO_EXTS, VIDEO_EXTS, pick_folder_dialog, playable_path, source_of
from ..media import frames as clip_frames
from ..media.encoder import CANVAS_FPS
from ..media.proxy import MAX_SECONDS as PROXY_SECONDS
from ..media.source import IMAGE_EXTS, extract_thumbnail_jpeg, still_to_clip, video_to_mp4
from .state import (
    OUT_DIR,
    PACKAGE_DIR,
    PROJECT_ROOT,
    STATE,
    STUDIO_DIR,
    STUDIO_DIST_DIR,
    StudioState,
    _abort_raw,
    _export_dest,
    _finish_export,
)

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}


# The most an open-ended range ("bytes=N-") gets in one response. Browsers ask each <video> for the rest of
# the file that way; answering with all of it keeps a connection busy for as long as the file plays, and the
# studio has a video per cut while a browser opens only about six connections to the server.
RANGE_CHUNK = 4 << 20


def _parse_byte_range(range_header: str | None, file_size: int, max_open: int | None = None) -> tuple[int, int, bool]:
    """Parse an HTTP Range header into (start, end, is_partial). An open-ended range covers at most
    `max_open` bytes when that's given."""
    if file_size == 0:
        return 0, -1, False
    if not range_header or not range_header.startswith("bytes="):
        return 0, file_size - 1, False
    try:
        first, _, last = range_header.split("=", 1)[1].split(",")[0].partition("-")
        if first:
            start = int(first)
            if last:
                end = min(int(last), file_size - 1)
            else:
                end = file_size - 1 if max_open is None else min(file_size - 1, start + max_open - 1)
        elif last:
            start = max(0, file_size - int(last))
            end = file_size - 1
        else:
            return 0, file_size - 1, False
        if 0 <= start <= end < file_size:
            return start, end, True
    except ValueError:
        pass
    return 0, file_size - 1, False


class StudioHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def _send_json(self, data: dict, status: int = 200) -> None:
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _serve_file(self, path: str, content_type: str | None = None) -> None:
        if not os.path.isfile(path):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        ctype = content_type or mimetypes.guess_type(path)[0] or "application/octet-stream"
        file_size = os.path.getsize(path)
        range_header = self.headers.get("Range")

        start, end, partial = _parse_byte_range(range_header, file_size, max_open=RANGE_CHUNK)
        length = max(0, end - start + 1)
        self.send_response(HTTPStatus.PARTIAL_CONTENT if partial else HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Content-Length", str(length))
        if ctype.startswith(("text/javascript", "text/css", "text/html")):
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        # stream in 1 MB chunks so 100+ MB proxies never sit in memory
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _trusted(self) -> bool:
        """Only answer requests addressed to this machine, and POSTs from our own pages.

        Blocks DNS-rebinding reads and cross-site POSTs (uploads, exports, shutdown) from other tabs.
        """
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        if (self.headers.get("Host") or "").lower() not in hosts:
            return False
        origin = self.headers.get("Origin")
        return self.command != "POST" or origin is None or origin.lower() in {f"http://{h}" for h in hosts}

    GET_EXACT_ROUTES: dict[str, Callable[[StudioHandler, dict[str, list[str]]], None]] = {
        "/": lambda self, q: self._get_root(),
        "/index.html": lambda self, q: self._get_root(),
        "/api/state": lambda self, q: self._get_state(q),
        "/api/status": lambda self, q: self._get_status(),
        "/api/tracks": lambda self, q: self._send_json(self._library_payload(rescan=True)),
        "/api/projects": lambda self, q: self._get_projects("/api/projects"),
    }
    GET_PREFIX_ROUTES: list[tuple[str, Callable[[StudioHandler, str, dict[str, list[str]]], None]]] = [
        ("/studio/", lambda self, r, q: self._get_studio_static(r)),
        ("/api/features/", lambda self, r, q: self._get_features(r, q)),
        ("/api/proxy/", lambda self, r, q: self._get_proxy(r)),
        ("/api/frames/", lambda self, r, q: self._get_frames(r, q)),
        ("/api/thumb/", lambda self, r, q: self._get_thumb(r, q)),
        ("/api/autoframe/", lambda self, r, q: self._get_autoframe(r)),
        ("/api/palette/", lambda self, r, q: self._get_palette(r)),
        ("/api/track_audio/", lambda self, r, q: self._get_track_audio(r)),
        ("/api/projects/", lambda self, r, q: self._get_projects(r)),
        ("/out/", lambda self, r, q: self._get_out(r)),
    ]

    POST_EXACT_ROUTES: dict[str, Callable[[StudioHandler, bytes, dict[str, list[str]]], None]] = {
        "/api/export": lambda self, b, q: self._post_export(b),
        "/api/export/companion": lambda self, b, q: self._post_export_companion(b),
        "/api/export/raw/begin": lambda self, b, q: self._post_raw_begin(b),
        "/api/export/raw/frames": lambda self, b, q: self._post_raw_frames(b, q),
        "/api/export/raw/abort": lambda self, b, q: self._post_raw_abort(q),
        "/api/export/raw/end": lambda self, b, q: self._post_raw_end(b, q),
        "/api/export/delete": lambda self, b, q: self._post_delete_export(b),
        "/api/clip/remove": lambda self, b, q: self._post_remove_clip(b),
        "/api/proxies": lambda self, b, q: self._post_proxies(b),
        "/api/library/folders": lambda self, b, q: self._post_library_folders(b),
        "/api/library/pick_folder": lambda self, b, q: self._post_pick_folder(),
        "/api/reveal": lambda self, b, q: self._post_reveal(b),
        "/api/shutdown": lambda self, b, q: self._post_shutdown(),
        "/api/upload": lambda self, b, q: self._post_upload(b),
    }
    POST_PREFIX_ROUTES: list[tuple[str, Callable[[StudioHandler, str, bytes, dict[str, list[str]]], None]]] = [
        ("/api/projects/", lambda self, r, b, q: self._post_projects(r, b)),
    ]

    def _dispatch_get(self, route: str, query: dict[str, list[str]]) -> None:
        handler = self.GET_EXACT_ROUTES.get(route)
        if handler is not None:
            handler(self, query)
            return
        for prefix, prefix_handler in self.GET_PREFIX_ROUTES:
            if route.startswith(prefix):
                prefix_handler(self, route, query)
                return
        if hasattr(super(), "do_GET"):
            super().do_GET()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def _dispatch_post(self, route: str, body: bytes, query: dict[str, list[str]]) -> None:
        handler = self.POST_EXACT_ROUTES.get(route)
        if handler is not None:
            handler(self, body, query)
            return
        for prefix, prefix_handler in self.POST_PREFIX_ROUTES:
            if route.startswith(prefix):
                prefix_handler(self, route, body, query)
                return
        if hasattr(super(), "do_POST"):
            super().do_POST()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_GET(self) -> None:
        if not self._trusted():
            self.send_error(HTTPStatus.FORBIDDEN, "Untrusted host or origin")
            return
        parsed = urllib.parse.urlparse(self.path)
        self._dispatch_get(parsed.path, urllib.parse.parse_qs(parsed.query))

    def _get_root(self) -> None:
        dist_index = os.path.join(STUDIO_DIST_DIR, "index.html")
        path = dist_index if os.path.isfile(dist_index) else os.path.join(STUDIO_DIR, "index.html")
        self._serve_file(path, "text/html; charset=utf-8")

    def _get_studio_static(self, route: str) -> None:
        rel = urllib.parse.unquote(route[len("/studio/"):])
        if not rel or rel.endswith("/"):
            rel = os.path.join(rel, "index.html")

        # Check STUDIO_DIST_DIR first (with path-traversal protection)
        dist_root = os.path.abspath(STUDIO_DIST_DIR)
        safe_dist_path = os.path.abspath(os.path.join(dist_root, rel))
        if not safe_dist_path.startswith(dist_root + os.sep):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if os.path.isfile(safe_dist_path):
            self._serve_file(safe_dist_path, STATIC_TYPES.get(os.path.splitext(safe_dist_path)[1].lower()))
            return

        # Fall back to STUDIO_DIR (with path-traversal protection)
        studio_root = os.path.abspath(STUDIO_DIR)
        safe_studio_path = os.path.abspath(os.path.join(studio_root, rel))
        if not safe_studio_path.startswith(studio_root + os.sep):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self._serve_file(safe_studio_path, STATIC_TYPES.get(os.path.splitext(safe_studio_path)[1].lower()))

    def _get_clip_analysis(
        self,
        route: str,
        prefix: str,
        cache: dict[str, object],
        compute_fn: Callable[[str], object],
    ) -> None:
        cid = urllib.parse.unquote(route.split(prefix, 1)[1])
        src = STATE.clips.get(cid)
        if not src:
            err = {"ok": False, "error": "unknown clip id"} if "/palette" in prefix else {"ok": False}
            self._send_json(err, status=404)
            return
        with STATE.lock:
            hit = cache.get(cid)
        if hit is None:
            # the short-GOP proxy seeks far faster than a long-GOP original; same framing
            proxy = STATE.proxies.path_for(src)
            path = proxy if STATE.proxies.ready(src) and os.path.isfile(proxy) else src.path
            try:
                hit = compute_fn(path)
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, status=500)
                return
            with STATE.lock:
                cache[cid] = hit
        self._send_json({"ok": True, **hit})

    def _get_autoframe(self, route: str) -> None:
        self._get_clip_analysis(route, "/api/autoframe/", STATE.framing, framing.autoframe)

    def _get_palette(self, route: str) -> None:
        self._get_clip_analysis(route, "/api/palette/", STATE.palettes, framing.extract_palette)

    def _get_features(self, route: str, query: dict[str, list[str]]) -> None:
        track_id = route.split("/api/features/", 1)[1]
        prof = STATE.tracks.get(track_id)
        if not prof:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown track id")
            return
        try:
            bpm = query.get("bpm", [None])[0]
            self._send_json(track_features(prof.path, float(bpm) if bpm else None))
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=500)

    def _get_proxy(self, route: str) -> None:
        clip_id = route.split("/api/proxy/", 1)[1]
        src = STATE.clips.get(clip_id)
        if not src:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown clip id")
            return
        path = STATE.proxies.ensure(src)
        if not path:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Proxy build failed")
            return
        self._serve_file(path, "video/mp4")

    def _get_frames(self, route: str, query: dict[str, list[str]]) -> None:
        """Numbered frames of a clip's playback copy for an export: ?start=N&count=M."""
        src = STATE.clips.get(route.split("/api/frames/", 1)[1])
        if not src:
            self._send_json({"error": "This clip is no longer in the library"}, status=404)
            return
        try:
            start = int(query.get("start", ["0"])[0])
            count = int(query.get("count", ["30"])[0])
        except ValueError:
            self._send_json({"error": "start and count must be whole numbers"}, status=400)
            return
        path = STATE.proxies.ensure(src)
        if not path:
            self._send_json({"error": f"The playback copy of {src.name} could not be made"}, status=500)
            return
        try:
            info, body = clip_frames.read_frames(path, start, count)
        except Exception as exc:
            self._send_json({"error": f"{src.name}: {exc}"}, status=500)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        for k, v in info.items():
            self.send_header(f"X-Frame-{k.capitalize()}", str(v))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _clip_dicts(self) -> list[dict]:
        folders = STATE.library.folders()
        where = {s.id: source_of(s.path, STATE.library.uploads, folders) for s in STATE.clips.values()}
        return [
            {
                "id": s.id,
                "name": s.name,
                "path": s.path,
                "source": where[s.id][0],
                "dir": where[s.id][1],
                "width": s.width,
                "height": s.height,
                "fps": round(s.fps, 1),
                "duration": round(s.duration, 1),
                "is_stock": s.name[0].isdigit(),
                "still": s.path.endswith(".still.mp4"),
                "proxy": STATE.proxies.status(s),
            }
            for s in STATE.clips.values()
        ]

    def _get_state(self, query: dict[str, list[str]]) -> None:
        clips_list = self._clip_dicts()
        # The studio polls ?only=clips while playback proxies build; that needn't carry the song library.
        if query.get("only") == ["clips"]:
            self._send_json({"clips": clips_list})
            return
        with STATE.lock:
            renders = list(STATE.renders)
        self._send_json(
            {
                "clips": clips_list,
                "tracks": [t.to_dict() for t in STATE.tracks.values()],
                "renders": renders,
                # With no folder picked and nothing added, the studio opens on Pick a folder.
                "folders": STATE.library.folders(),
                "can_pick": sys.platform == "darwin",
            }
        )

    def _get_status(self) -> None:
        # Lets a second launch find a running server (see _is_downbeat_running).
        self._send_json({"ok": True})

    def _get_thumb(self, route: str, query: dict[str, list[str]]) -> None:
        cid = route.split("/api/thumb/", 1)[1]
        src = STATE.clips.get(cid)
        if not src:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown clip id")
            return
        try:
            width = max(32, min(720, int(query.get("w", ["360"])[0])))
            at_sec = float(query.get("t", ["1.5"])[0])
            # The playback copy has a keyframe every 8 frames, so a frame from it comes 3 to 5 times faster
            # than from a long-GOP original. It holds the first PROXY_SECONDS of the clip.
            proxy = STATE.proxies.path_for(src)
            use_proxy = at_sec < PROXY_SECONDS - 0.1 and STATE.proxies.ready(src) and os.path.isfile(proxy)
            jpg = extract_thumbnail_jpeg(proxy if use_proxy else src.path, width=width, at_sec=at_sec)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpg)))
            self.send_header("Cache-Control", "max-age=3600")
            self.end_headers()
            self.wfile.write(jpg)
        except Exception as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def _get_track_audio(self, route: str) -> None:
        tid = route.split("/api/track_audio/", 1)[1]
        prof = STATE.tracks.get(tid)
        if not prof:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            path = playable_path(prof, os.path.join(OUT_DIR, ".audio-cache"))
        except Exception as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not convert {prof.name}: {exc}")
            return
        ctype = mimetypes.guess_type(path)[0] or "audio/mpeg"
        self._serve_file(path, ctype)

    def _library_payload(self, rescan: bool = False) -> dict:
        tracks = STATE.rescan() if rescan else STATE.tracks
        return {
            "ok": True,
            "tracks": [t.to_dict() for t in tracks.values()],
            "clips": self._clip_dicts(),
            "folders": STATE.library.folders(),
            "suggestions": STATE.library.suggestions(),
            "can_pick": sys.platform == "darwin",
        }

    def _post_library_folders(self, body: bytes) -> None:
        data = _json_body(body)
        added = None
        try:
            if data.get("add"):
                added = STATE.library.add_folder(str(data["add"]))
            if data.get("remove"):
                STATE.library.remove_folder(str(data["remove"]))
        except FileNotFoundError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=400)
            return
        self._send_json({**self._library_payload(rescan=True), "added": added})

    def _post_pick_folder(self) -> None:
        if sys.platform != "darwin":
            self._send_json({"ok": False, "error": "The folder chooser needs macOS. Type the folder's path instead."}, status=501)
            return
        picked = pick_folder_dialog()
        added = STATE.library.add_folder(picked) if picked else None
        self._send_json({**self._library_payload(rescan=True), "added": added})

    def _get_projects(self, route: str) -> None:
        """/api/projects lists the saved projects, /api/projects/<id> is one with its edit, and
        /api/projects/exports/<file> is the edit an export was made from."""
        rest = urllib.parse.unquote(route[len("/api/projects"):].lstrip("/"))
        try:
            if not rest:
                self._send_json({"ok": True, "projects": STATE.projects.list()})
            elif rest.startswith("exports/"):
                self._send_json({"ok": True, "data": STATE.projects.export_edit(rest[len("exports/"):])})
            else:
                self._send_json({"ok": True, "project": STATE.projects.get(rest)})
        except KeyError:
            self._send_json({"ok": False, "error": "Not found"}, status=404)

    def _post_projects(self, route: str, body: bytes) -> None:
        """/api/projects/create {name, data}, save {id, data}, rename {id, name} and delete {id}."""
        action = route[len("/api/projects/"):]
        store = STATE.projects
        try:
            data = _json_body(body)
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object")
            if action == "create":
                project = store.create(data.get("name"), data.get("data"))
            elif action == "save":
                project = store.save(str(data.get("id", "")), data.get("data"))
            elif action == "rename":
                project = store.rename(str(data.get("id", "")), data.get("name"))
            elif action == "delete":
                store.delete(str(data.get("id", "")))
                self._send_json({"ok": True})
                return
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
        except KeyError:
            self._send_json({"ok": False, "error": "That project has been deleted"}, status=404)
            return
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=400)
            return
        except OSError as exc:
            self._send_json({"ok": False, "error": f"The project couldn't be saved: {exc}"}, status=500)
            return
        self._send_json({"ok": True, "project": project})

    def _get_out(self, route: str) -> None:
        fname = urllib.parse.unquote(route.split("/out/", 1)[1])
        safe_path = os.path.abspath(os.path.join(OUT_DIR, fname))
        if not safe_path.startswith(os.path.abspath(OUT_DIR) + os.sep):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        ctype = mimetypes.guess_type(safe_path)[0] or "video/mp4"
        self._serve_file(safe_path, ctype)

    def do_POST(self) -> None:
        if not self._trusted():
            self.send_error(HTTPStatus.FORBIDDEN, "Untrusted host or origin")
            return
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b"{}"
        self._dispatch_post(parsed.path, body, urllib.parse.parse_qs(parsed.query))

    def _post_export(self, body: bytes) -> None:
        # body = H.264 Annex B elementary stream from the browser's WebCodecs encoder
        try:
            meta = json.loads(urllib.parse.unquote(self.headers.get("X-Export-Meta", "{}")))
            dest = _export_dest(meta)
            tmp = dest[:-4] + ".h264"
            with open(tmp, "wb") as f:
                f.write(body)
            try:
                delivery.mux_annexb(tmp, dest, int(meta.get("fps", CANVAS_FPS)))
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
            self._send_json({"ok": True, "render": _finish_export(dest, meta)})
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=500)

    def _post_export_companion(self, body: bytes) -> None:
        try:
            data = _json_body(body)
        except Exception as exc:
            self._send_json({"ok": False, "error": f"Invalid JSON body: {exc}"}, status=400)
            return

        fname = data.get("filename")
        clip_id = data.get("clip_id")
        kind = str(data.get("kind") or "")
        at_sec = float(data.get("at_sec") or 0.0)

        src_path = None
        if fname:
            candidate = os.path.abspath(os.path.join(OUT_DIR, os.path.basename(fname)))
            if os.path.isfile(candidate):
                src_path = candidate
        if not src_path and clip_id and clip_id in STATE.clips:
            src_path = STATE.clips[clip_id].path

        if not src_path or not os.path.isfile(src_path):
            self._send_json({"ok": False, "error": "source file not found"}, status=404)
            return

        stem = os.path.splitext(os.path.basename(fname if fname else src_path))[0]
        os.makedirs(OUT_DIR, exist_ok=True)

        try:
            extra: dict = {}
            if kind == "cover":
                out_name = f"{stem}-cover-3000x3000.jpg"
                dest_path = os.path.join(OUT_DIR, out_name)
                delivery.export_cover_art(src_path, dest_path, size=3000, at_sec=at_sec)
            elif kind in ("gif", "webp"):
                out_name = f"{stem}-teaser.{kind}"
                dest_path = os.path.join(OUT_DIR, out_name)
                delivery.export_animated(src_path, dest_path, fmt=kind)
            elif kind in ("spotify_header", "youtube_banner", "soundcloud_header"):
                out_name = f"{stem}-{kind}.jpg"
                dest_path = os.path.join(OUT_DIR, out_name)
                focus = None
                if clip_id:
                    with STATE.lock:
                        focus_val = STATE.framing.get(clip_id, {}).get("focus")
                    if focus_val:
                        focus = tuple(focus_val)
                if focus is None:
                    try:
                        focus = tuple(framing.autoframe(src_path)["focus"])
                    except Exception:
                        focus = (0.5, 0.5)
                extra = delivery.export_banner(src_path, dest_path, banner_type=kind, focus=focus, at_sec=at_sec)
            else:
                self._send_json({"ok": False, "error": f"unsupported kind: {kind}"}, status=400)
                return

            self._send_json({"ok": True, "filename": out_name, "url": f"/out/{urllib.parse.quote(out_name)}?t={int(time.time())}", **extra})
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=500)

    def _post_raw_begin(self, body: bytes) -> None:
        meta = _json_body(body)
        dest = _export_dest(meta)
        sid = os.path.basename(dest)
        fps = int(meta.get("fps", CANVAS_FPS))
        # stream "h264": the browser encoded the frames and sends Annex B chunks; otherwise raw RGBA frames
        try:
            session = (delivery.ChunkSession(dest, fps) if meta.get("stream") == "h264"
                       else delivery.RawSession(dest, int(meta["width"]), int(meta["height"]), fps))
        except Exception as exc:
            self._send_json({"ok": False, "error": f"Could not start the export: {exc}"}, status=500)
            return
        with STATE.lock:
            STATE.raw_sessions[sid] = (session, meta)
        self._send_json({"ok": True, "sid": sid})

    def _post_raw_frames(self, body: bytes, query: dict[str, list[str]]) -> None:
        sid = query.get("sid", [""])[0]
        entry = STATE.raw_sessions.get(sid)
        if not entry:
            self._send_json({"ok": False, "error": "unknown session"}, status=404)
            return
        try:
            self._send_json({"ok": True, "frames": entry[0].write(body)})
        except (BrokenPipeError, OSError) as exc:
            _abort_raw(sid)
            self._send_json({"ok": False, "error": f"encoder stopped: {exc}"}, status=500)

    def _post_raw_abort(self, query: dict[str, list[str]]) -> None:
        _abort_raw(query.get("sid", [""])[0])
        self._send_json({"ok": True})

    def _post_raw_end(self, body: bytes, query: dict[str, list[str]]) -> None:
        sid = query.get("sid", [""])[0]
        with STATE.lock:
            entry = STATE.raw_sessions.pop(sid, None)
        if not entry:
            self._send_json({"ok": False, "error": "unknown session"}, status=404)
            return
        session, meta = entry
        try:
            session.finish()
            meta["stats"] = _json_body(body).get("stats") or meta.get("stats")
            self._send_json({"ok": True, "render": _finish_export(session.dest, meta)})
        except Exception as exc:
            # The studio reports this export as failed, so it shouldn't turn up in Exports later.
            try:
                STATE.remove_export(os.path.basename(session.dest))
            except OSError:
                pass
            self._send_json({"ok": False, "error": str(exc)}, status=500)

    def _post_delete_export(self, body: bytes) -> None:
        data = _json_body(body)
        try:
            removed = STATE.remove_export(str(data.get("filename", "")))
        except FileNotFoundError:
            # Already gone is the outcome the caller wanted.
            self._send_json({"ok": True, "removed": []})
            return
        self._send_json({"ok": True, "removed": removed})

    def _post_proxies(self, body: bytes) -> None:
        """Queue playback copies for the clips the studio put in the edit, in the order given. Other videos in
        the folders stay as they are until they're added, so a big folder doesn't keep the machine busy."""
        clips = STATE.clips
        statuses = {}
        for cid in _json_body(body).get("ids") or []:
            src = clips.get(str(cid))
            if src:
                STATE.proxies.request(src, priority=0)
                statuses[src.id] = STATE.proxies.status(src)
        self._send_json({"ok": True, "proxies": statuses})

    def _post_remove_clip(self, body: bytes) -> None:
        data = _json_body(body)
        try:
            deleted = STATE.remove_clip(str(data.get("id", "")))
        except KeyError:
            # Already gone is the outcome the caller wanted.
            self._send_json({"ok": True, "deleted": False})
            return
        self._send_json({"ok": True, "deleted": deleted})

    def _post_reveal(self, body: bytes) -> None:
        """Shows an export in out/ in the Finder, or with clip_id a clip's file wherever it is."""
        data = _json_body(body)
        src = STATE.clips.get(str(data.get("clip_id", "")))
        path = src.path if src else os.path.abspath(os.path.join(OUT_DIR, os.path.basename(str(data.get("filename", "")))))
        if os.path.isfile(path) and sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
            self._send_json({"ok": True})
        else:
            self._send_json({"ok": False, "path": path})

    def _post_shutdown(self) -> None:
        STATE.shutdown()
        for sid in list(STATE.raw_sessions):
            _abort_raw(sid)
        self._send_json({"ok": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def _post_upload(self, body: bytes) -> None:
        fname = self.headers.get("X-Filename", f"upload-{int(time.time())}.mp4")
        safe_name = os.path.basename(urllib.parse.unquote(fname))
        uploads_dir = os.path.join(OUT_DIR, "uploads")
        os.makedirs(uploads_dir, exist_ok=True)
        dest = os.path.join(uploads_dir, safe_name)
        with open(dest, "wb") as f:
            f.write(body)
        ext = os.path.splitext(safe_name)[1].lower()
        made = None
        try:
            if ext in AUDIO_EXTS:
                track = STATE.add_track_path(dest)
                self._send_json({"ok": True, "kind": "audio", "id": track.id, "name": track.name})
            else:
                still = ext in IMAGE_EXTS
                converted = not still and ext not in VIDEO_EXTS
                if still:
                    made = still_to_clip(dest)
                elif converted:
                    # The library only lists the usual video types, so the others (.avi, .mts, .wmv...) become an
                    # .mp4, which is what's kept.
                    made = video_to_mp4(dest)
                    os.remove(dest)
                src = STATE.add_clip_path(made or dest)
                self._send_json({"ok": True, "kind": "video", "id": src.id, "name": src.name, "still": still, "converted": converted})
        except Exception as exc:
            # Files in out/uploads come back on the next start, so one that can't be used isn't kept.
            for path in (dest, made):
                if path and os.path.exists(path):
                    os.remove(path)
            self._send_json({"ok": False, "error": str(exc)}, status=400)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        # Browsers routinely abort media range requests mid-stream; that is not an error.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def _json_body(body: bytes) -> dict:
    return json.loads(body.decode("utf-8") or "{}")


def _is_downbeat_running(host: str, port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/status", timeout=0.6) as resp:
            return resp.status == 200
    except Exception:
        return False


def serve_studio(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    STATE.ensure_initialized()
    if _is_downbeat_running(host, port):
        print(f"\nFound running Downbeat server at http://{host}:{port}. Reloading...")
        try:
            req = urllib.request.Request(
                f"http://{host}:{port}/api/shutdown",
                data=b"{}",
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=1.0).close()
        except Exception:
            pass
        for _ in range(40):
            if not _is_downbeat_running(host, port):
                break
            time.sleep(0.05)
        time.sleep(0.05)

    server = None
    chosen_port = port
    for candidate in range(port, port + 15):
        try:
            server = ReusableThreadingHTTPServer((host, candidate), StudioHandler)
            chosen_port = candidate
            break
        except OSError:
            continue

    if server is None:
        raise RuntimeError(f"Could not bind any port in range {port}..{port + 14}")

    url = f"http://{host}:{chosen_port}"
    print(f"\nDownbeat Studio running at {url}")
    if STATE.library.folders() or STATE.clips:
        print(f"Loaded {len(STATE.clips)} video clips and {len(STATE.tracks)} songs")
    else:
        print("No folder picked yet, so the studio opens on Pick a folder")
    print("Press Ctrl+C to stop\n")
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Downbeat Studio.")
    finally:
        for sid in list(STATE.raw_sessions):
            _abort_raw(sid)
        server.server_close()


__all__ = [
    "PROJECT_ROOT",
    "OUT_DIR",
    "PACKAGE_DIR",
    "STUDIO_DIR",
    "STUDIO_DIST_DIR",
    "StudioState",
    "STATE",
    "_export_dest",
    "_abort_raw",
    "_finish_export",
    "STATIC_TYPES",
    "_parse_byte_range",
    "StudioHandler",
    "ReusableThreadingHTTPServer",
    "_is_downbeat_running",
    "serve_studio",
]
