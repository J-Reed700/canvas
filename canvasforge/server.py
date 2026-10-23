"""Canvas Forge Studio: Interactive Web UI & HTTP server (Lambda Audio dark aesthetic)."""
from __future__ import annotations

import glob
import json
import mimetypes
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import delivery, effects
from .audio import AudioProfile, analyze_track
from .compositor import CANVAS_FPS, CANVAS_H, CANVAS_W, build_plan
from .encoder import Encoder
from .features import track_features
from .proxy import ProxyManager
from .recipe import PRESETS, make_recipe
from .source import Source, extract_thumbnail_jpeg, probe

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(PROJECT_ROOT, "out")
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
UI_HTML_PATH = os.path.join(PACKAGE_DIR, "ui.html")
STUDIO_DIR = os.path.join(PACKAGE_DIR, "studio")
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}


class StudioState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.clips: dict[str, Source] = {}
        self.tracks: dict[str, AudioProfile] = {}
        self.renders: list[dict] = []
        self.active_job: dict | None = None
        self.raw_sessions: dict[str, tuple[delivery.RawSession, dict]] = {}
        self.proxies = ProxyManager(os.path.join(OUT_DIR, ".proxies"))
        self._discover_initial_clips()
        self._discover_initial_tracks()
        self._discover_existing_renders()
        for src in self.clips.values():
            self.proxies.request(src)

    def _discover_initial_clips(self) -> None:
        dl = os.path.expanduser("~/Downloads")
        candidates = sorted(glob.glob(os.path.join(dl, "*.mp4")))
        stock = [p for p in candidates if os.path.basename(p)[0].isdigit()]
        others = [p for p in candidates if p not in stock]
        for path in stock + others[:3]:
            try:
                src = probe(path)
                self.clips[src.id] = src
            except Exception:
                pass

    def _discover_initial_tracks(self) -> None:
        dl = os.path.expanduser("~/Downloads")
        wavs = sorted(glob.glob(os.path.join(dl, "*.wav")), key=os.path.getmtime, reverse=True)
        mp3s = sorted(glob.glob(os.path.join(dl, "*.mp3")), key=os.path.getmtime, reverse=True)
        # Filter out tiny segment files or duplicates
        candidates = [
            p
            for p in (wavs + mp3s)
            if not os.path.basename(p).startswith("segment-") and os.path.getsize(p) > 250_000
        ]
        for path in candidates[:8]:
            try:
                prof = analyze_track(path)
                self.tracks[prof.id] = prof
            except Exception:
                pass

    def _discover_existing_renders(self) -> None:
        os.makedirs(OUT_DIR, exist_ok=True)
        for path in sorted(glob.glob(os.path.join(OUT_DIR, "*.mp4")), key=os.path.getmtime, reverse=True):
            name = os.path.basename(path)
            if name.endswith("-audio.mp4"):
                continue
            size_mb = round(os.path.getsize(path) / (1024 * 1024), 2)
            self.renders.append(
                {
                    "filename": name,
                    "url": f"/out/{urllib.parse.quote(name)}",
                    "audio_url": None,
                    "size_mb": size_mb,
                    "created_at": int(os.path.getmtime(path)),
                    "resolution": "1080x1920" if "master" in name or "sample" in name else "540x960",
                    "preset": "canvas",
                }
            )

    def add_clip_path(self, path: str) -> Source:
        src = probe(path)
        with self.lock:
            self.clips[src.id] = src
        self.proxies.request(src, priority=5)
        return src

    def add_export(self, dest: str, meta: dict, result: dict) -> dict:
        name = os.path.basename(dest)
        audio_path = result.get("audio_path")
        entry = {
            "filename": name,
            "url": f"/out/{urllib.parse.quote(name)}?t={int(time.time())}",
            "audio_url": f"/out/{urllib.parse.quote(os.path.basename(audio_path))}" if audio_path else None,
            "size_mb": result["size_mb"],
            "created_at": int(time.time()),
            "resolution": f"{meta.get('width')}x{meta.get('height')}",
            "duration": meta.get("duration"),
            "bpm": meta.get("bpm"),
            "preset": meta.get("look") or "canvas",
            "look": meta.get("look"),
            "checks": result["checks"],
            "engine": "gpu",
        }
        with self.lock:
            self.renders = [r for r in self.renders if r.get("filename") != name]
            self.renders.insert(0, entry)
        return entry

    def add_track_path(self, path: str) -> AudioProfile:
        prof = analyze_track(path)
        with self.lock:
            self.tracks[prof.id] = prof
        return prof


STATE = StudioState()


def run_render_job(params: dict) -> dict:
    """Execute a fast preview (540x960) or master (1080x1920) Spotify Canvas render."""
    t0 = time.time()
    clip_ids = params.get("clip_ids") or []
    sources = [STATE.clips[cid] for cid in clip_ids if cid in STATE.clips]
    if not sources:
        sources = list(STATE.clips.values())[:5]
    if not sources:
        raise ValueError("No source clips loaded")

    track_id = params.get("track_id")
    track_prof = STATE.tracks.get(track_id) if track_id else None

    clip_direction = params.get("clip_direction") or "forward"
    raw_audio_start = params.get("audio_start_sec")
    if raw_audio_start is not None:
        try:
            audio_start_sec = float(raw_audio_start)
        except (ValueError, TypeError):
            audio_start_sec = track_prof.best_start_sec if track_prof else None
    else:
        audio_start_sec = track_prof.best_start_sec if track_prof else None

    seed = int(params.get("seed") or random.randrange(100_000, 999_999))
    bpm = int(params.get("bpm") or (track_prof.detected_bpm if track_prof else 128))
    preset = params.get("preset") or "hypnotic"
    effect_names = params.get("effects")
    cut_beats = float(params.get("cut_beats") or 4.0)
    cut_mode = str(params.get("cut_mode") or "steady")
    ensure_all_clips = bool(params.get("ensure_all_clips", True))
    transition = params.get("transition") or "luma"
    transitions = params.get("transitions") if isinstance(params.get("transitions"), list) else None
    transition_mode = str(params.get("transition_mode") or "cycle")
    trans_frames = int(params.get("trans_frames") or 12)
    intensity = float(params.get("intensity") or 1.0)
    speed = float(params.get("speed") or 1.0)
    duration = max(3.0, min(24.0, float(params.get("duration") or 8.0)))
    loop_mode = params.get("loop_mode") or "crossfade"
    quality = params.get("quality") or "preview"
    filter_mode = str(params.get("filter_mode") or "global")
    raw_clip_effects = params.get("clip_effects") if isinstance(params.get("clip_effects"), dict) else {}
    resolved_clip_effects: dict[str, list[str]] = {}
    for k, v in raw_clip_effects.items():
        if isinstance(v, list) and v:
            if k in STATE.clips:
                clip_obj = STATE.clips[k]
                clip_path = getattr(clip_obj, "path", getattr(getattr(clip_obj, "source", None), "path", None))
                if clip_path:
                    resolved_clip_effects[clip_path] = [str(x) for x in v]
            resolved_clip_effects[str(k)] = [str(x) for x in v]

    if quality == "master":
        width, height, crf = CANVAS_W, CANVAS_H, 17
        tag = "MASTER-1080x1920"
    else:
        width, height, crf = 540, 960, 21
        tag = "PREVIEW-540x960"

    recipe = make_recipe(
        seed=seed,
        bpm=bpm,
        preset=preset if not effect_names else "custom",
        effect_names=effect_names if effect_names else None,
        cut_beats=cut_beats,
        cut_mode=cut_mode,
        ensure_all_clips=ensure_all_clips,
        transition=transition,
        transitions=transitions,
        transition_mode=transition_mode,
        trans_frames=trans_frames,
        intensity=intensity,
        duration=duration,
        loop_mode=loop_mode,
        clip_direction=clip_direction,
        filter_mode=filter_mode,
        clip_effects=resolved_clip_effects,
    )

    os.makedirs(OUT_DIR, exist_ok=True)
    base_stem = f"canvas-{recipe.preset}-s{seed}-{bpm}bpm-{int(duration)}s-{quality}"
    filename = f"{base_stem}.mp4"
    out_path = os.path.join(OUT_DIR, filename)

    total_frames = int(round(duration * CANVAS_FPS))
    with STATE.lock:
        STATE.active_job = {
            "status": "rendering",
            "progress": 0.0,
            "frame": 0,
            "total_frames": total_frames,
            "filename": filename,
            "quality": quality,
            "recipe": recipe.to_dict(),
        }

    try:
        plan = build_plan(
            sources,
            recipe,
            speed=speed,
            width=width,
            height=height,
            duration=duration,
            audio_path=track_prof.path if track_prof else None,
            audio_start_sec=audio_start_sec,
            # The Studio UI sends clip_ids in the user's manually arranged order
            shuffle_order=False,
            clip_direction=clip_direction,
            cut_mode=cut_mode,
            ensure_all_clips=ensure_all_clips,
            transitions=transitions,
            transition_mode=transition_mode,
            trans_frames=trans_frames,
            filter_mode=filter_mode,
            clip_effects=resolved_clip_effects,
        )
        enc = Encoder(out_path, fps=CANVAS_FPS, width=width, height=height, crf=crf)
        for i in range(plan.n_frames):
            frame = plan.render(i)
            enc.write(frame)
            if (i + 1) % 6 == 0 or (i + 1) == plan.n_frames:
                with STATE.lock:
                    if STATE.active_job:
                        STATE.active_job["frame"] = i + 1
                        STATE.active_job["progress"] = round((i + 1) / plan.n_frames * 100, 1)
        enc.close()

        elapsed = round(time.time() - t0, 2)
        size_mb = round(os.path.getsize(out_path) / (1024 * 1024), 2)
        entry = {
            "filename": filename,
            "url": f"/out/{urllib.parse.quote(filename)}?t={int(time.time())}",
            "audio_url": None,
            "audio_filename": None,
            "track_id": track_prof.id if track_prof else None,
            "track_name": track_prof.name if track_prof else None,
            "audio_start_sec": round(audio_start_sec or 0.0, 2),
            "size_mb": size_mb,
            "elapsed_s": elapsed,
            "resolution": f"{width}x{height}",
            "duration": duration,
            "speed": speed,
            "clip_direction": clip_direction,
            "loop_mode": loop_mode,
            "tag": tag,
            "quality": quality,
            "seed": seed,
            "bpm": bpm,
            "preset": recipe.preset,
            "cut_beats": cut_beats,
            "cut_mode": cut_mode,
            "ensure_all_clips": ensure_all_clips,
            "transition": recipe.transition,
            "transitions": recipe.transitions,
            "transition_mode": transition_mode,
            "trans_frames": trans_frames,
            "filter_mode": filter_mode,
            "segment_effects": [seg.effect_names for seg in plan.segments],
            "segments_count": len(plan.segments),
            "clips_used": [s.name for s in sources],
            "recipe": recipe.to_dict(),
            "created_at": int(time.time()),
        }
        with STATE.lock:
            STATE.renders = [r for r in STATE.renders if r.get("filename") != filename]
            STATE.renders.insert(0, entry)
            STATE.active_job = {"status": "done", "progress": 100.0, "result": entry}
        return entry
    except Exception as exc:
        with STATE.lock:
            STATE.active_job = {"status": "error", "error": str(exc)}
        raise


def _export_dest(meta: dict) -> str:
    look = re.sub(r"[^a-z0-9]+", "-", str(meta.get("look") or "canvas").lower()).strip("-") or "canvas"
    bpm = int(round(float(meta.get("bpm") or 0)))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"canvas-{look}-{bpm}bpm-{float(meta.get('duration') or 0):.1f}s-{meta.get('width')}x{meta.get('height')}-{stamp}.mp4"
    os.makedirs(OUT_DIR, exist_ok=True)
    return os.path.join(OUT_DIR, name)


def _abort_raw(sid: str) -> None:
    with STATE.lock:
        entry = STATE.raw_sessions.pop(sid, None)
    if not entry:
        return
    proc = entry[0].encoder.proc
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    if os.path.exists(entry[0].dest):
        os.remove(entry[0].dest)


def _finish_export(dest: str, meta: dict) -> dict:
    prof = STATE.tracks.get(meta.get("track_id") or "")
    result = delivery.deliver(
        dest,
        prof.path if prof and meta.get("with_audio", True) else None,
        float(meta.get("audio_start") or 0.0),
        float(meta.get("duration") or 8.0),
        meta.get("stats"),
    )
    return STATE.add_export(dest, meta, result)


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

        start, end = 0, file_size - 1
        partial = False
        if range_header and range_header.startswith("bytes="):
            try:
                first, _, last = range_header.split("=", 1)[1].split(",")[0].partition("-")
                if first:
                    start = int(first)
                    end = min(int(last), file_size - 1) if last else file_size - 1
                elif last:  # suffix range: last N bytes
                    start = max(0, file_size - int(last))
                partial = start <= end
            except ValueError:
                partial = False
            if not partial:
                start, end = 0, file_size - 1

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

    def do_GET(self) -> None:
        if not self._trusted():
            self.send_error(HTTPStatus.FORBIDDEN, "Untrusted host or origin")
            return
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path

        if route in ("/", "/index.html"):
            studio_index = os.path.join(STUDIO_DIR, "index.html")
            self._serve_file(studio_index if os.path.isfile(studio_index) else UI_HTML_PATH, "text/html; charset=utf-8")
            return

        if route in ("/classic", "/classic/"):
            self._serve_file(UI_HTML_PATH, "text/html; charset=utf-8")
            return

        if route.startswith("/studio/"):
            rel = urllib.parse.unquote(route[len("/studio/"):])
            safe_path = os.path.abspath(os.path.join(STUDIO_DIR, rel))
            if not safe_path.startswith(os.path.abspath(STUDIO_DIR) + os.sep):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            self._serve_file(safe_path, STATIC_TYPES.get(os.path.splitext(safe_path)[1].lower()))
            return

        if route.startswith("/api/features/"):
            prof = STATE.tracks.get(route.split("/api/features/", 1)[1])
            if not prof:
                self.send_error(HTTPStatus.NOT_FOUND, "Unknown track id")
                return
            try:
                bpm = urllib.parse.parse_qs(parsed.query).get("bpm", [None])[0]
                self._send_json(track_features(prof.path, float(bpm) if bpm else None))
            except Exception as exc:
                self._send_json({"error": str(exc)}, status=500)
            return

        if route.startswith("/api/proxy/"):
            src = STATE.clips.get(route.split("/api/proxy/", 1)[1])
            if not src:
                self.send_error(HTTPStatus.NOT_FOUND, "Unknown clip id")
                return
            path = STATE.proxies.ensure(src)
            if not path:
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Proxy build failed")
                return
            self._serve_file(path, "video/mp4")
            return

        if route == "/api/state":
            clips_list = [
                {
                    "id": s.id,
                    "name": s.name,
                    "path": s.path,
                    "width": s.width,
                    "height": s.height,
                    "fps": round(s.fps, 1),
                    "duration": round(s.duration, 1),
                    "is_stock": s.name[0].isdigit(),
                    "proxy": STATE.proxies.status(s),
                }
                for s in STATE.clips.values()
            ]
            tracks_list = [t.to_dict() for t in STATE.tracks.values()]
            effects_list = [
                {"name": k, "label": v["label"], "category": v["category"]}
                for k, v in effects.EFFECTS.items()
            ]
            presets_list = [
                {
                    "id": k,
                    "label": v["label"],
                    "desc": v["desc"],
                    "effects": v["effects"],
                    "cut_beats": v["cut_beats"],
                    "transition": v["transition"],
                }
                for k, v in PRESETS.items()
            ]
            with STATE.lock:
                job = STATE.active_job
                renders = list(STATE.renders)
            self._send_json(
                {
                    "clips": clips_list,
                    "tracks": tracks_list,
                    "effects": effects_list,
                    "presets": presets_list,
                    "renders": renders,
                    "job": job,
                }
            )
            return

        if route == "/api/status":
            with STATE.lock:
                self._send_json({"job": STATE.active_job, "renders": STATE.renders[:10]})
            return

        if route.startswith("/api/thumb/"):
            cid = route.split("/api/thumb/", 1)[1]
            src = STATE.clips.get(cid)
            if not src:
                self.send_error(HTTPStatus.NOT_FOUND, "Unknown clip id")
                return
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                width = max(32, min(720, int(qs.get("w", ["360"])[0])))
                at_sec = float(qs.get("t", ["1.5"])[0])
                jpg = extract_thumbnail_jpeg(src.path, width=width, at_sec=at_sec)
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpg)))
                self.send_header("Cache-Control", "max-age=3600")
                self.end_headers()
                self.wfile.write(jpg)
            except Exception as exc:
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
            return

        if route.startswith("/api/clip_video/"):
            cid = route.split("/api/clip_video/", 1)[1]
            src = STATE.clips.get(cid)
            if not src:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._serve_file(src.path, "video/mp4")
            return

        if route.startswith("/api/track_audio/"):
            tid = route.split("/api/track_audio/", 1)[1]
            prof = STATE.tracks.get(tid)
            if not prof:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            ctype = mimetypes.guess_type(prof.path)[0] or "audio/mpeg"
            self._serve_file(prof.path, ctype)
            return

        if route.startswith("/out/"):
            fname = urllib.parse.unquote(route.split("/out/", 1)[1])
            safe_path = os.path.abspath(os.path.join(OUT_DIR, fname))
            if not safe_path.startswith(os.path.abspath(OUT_DIR) + os.sep):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            self._serve_file(safe_path, "video/mp4")
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if not self._trusted():
            self.send_error(HTTPStatus.FORBIDDEN, "Untrusted host or origin")
            return
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b"{}"
        qs = urllib.parse.parse_qs(parsed.query)

        if route == "/api/export":
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
                    os.remove(tmp)
                self._send_json({"ok": True, "render": _finish_export(dest, meta)})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, status=500)
            return

        if route == "/api/export/raw/begin":
            meta = json.loads(body.decode("utf-8") or "{}")
            dest = _export_dest(meta)
            sid = os.path.basename(dest)
            session = delivery.RawSession(dest, int(meta["width"]), int(meta["height"]), int(meta.get("fps", CANVAS_FPS)))
            with STATE.lock:
                STATE.raw_sessions[sid] = (session, meta)
            self._send_json({"ok": True, "sid": sid})
            return

        if route == "/api/export/raw/frames":
            entry = STATE.raw_sessions.get(qs.get("sid", [""])[0])
            if not entry:
                self._send_json({"ok": False, "error": "unknown session"}, status=404)
                return
            try:
                self._send_json({"ok": True, "frames": entry[0].write(body)})
            except (BrokenPipeError, OSError) as exc:  # ffmpeg died: drop the session and say so
                _abort_raw(qs.get("sid", [""])[0])
                self._send_json({"ok": False, "error": f"encoder stopped: {exc}"}, status=500)
            return

        if route == "/api/export/raw/abort":
            _abort_raw(qs.get("sid", [""])[0])
            self._send_json({"ok": True})
            return

        if route == "/api/export/raw/end":
            with STATE.lock:
                entry = STATE.raw_sessions.pop(qs.get("sid", [""])[0], None)
            if not entry:
                self._send_json({"ok": False, "error": "unknown session"}, status=404)
                return
            session, meta = entry
            try:
                session.finish()
                meta["stats"] = json.loads(body.decode("utf-8") or "{}").get("stats") or meta.get("stats")
                self._send_json({"ok": True, "render": _finish_export(session.dest, meta)})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, status=500)
            return

        if route == "/api/reveal":
            data = json.loads(body.decode("utf-8") or "{}")
            path = os.path.abspath(os.path.join(OUT_DIR, os.path.basename(str(data.get("filename", "")))))
            if os.path.isfile(path) and sys.platform == "darwin":
                subprocess.Popen(["open", "-R", path])
                self._send_json({"ok": True})
            else:
                self._send_json({"ok": False, "path": path})
            return

        if route == "/api/preview_frame":
            try:
                data = json.loads(body.decode("utf-8")) if body else {}
            except Exception:
                data = {}
            clip_ids = data.get("clip_ids") or []
            src = None
            for cid in clip_ids:
                if cid in STATE.clips:
                    src = STATE.clips[cid]
                    break
            if src is None and STATE.clips:
                src = next(iter(STATE.clips.values()))
            if not src:
                self._send_json({"ok": False, "error": "No clips available"}, status=404)
                return

            preset = data.get("preset")
            effects_list = data.get("effects")
            bpm = int(data.get("bpm") or 128)
            intensity = float(data.get("intensity") or 1.0)
            seed = int(data.get("seed") or 2026)
            t = float(data.get("t") if data.get("t") is not None else 0.35)

            recipe = make_recipe(
                seed=seed,
                bpm=bpm,
                preset=preset if not effects_list else "custom",
                effect_names=effects_list if effects_list else None,
                intensity=intensity,
            )
            from .source import GLOBAL_CACHE
            start_frame = int(t * src.fps) % max(1, src.frame_count)
            frames = GLOBAL_CACHE.load_segment(src, start_frame=start_frame, count=1, target_w=360, target_h=640)
            if not frames:
                self._send_json({"ok": False, "error": "Failed to extract frame"}, status=500)
                return
            frame = frames[0].copy()
            beat_dur = 60.0 / recipe.bpm
            for _name, fn, kw in recipe.effects:
                frame = fn(frame, t=t, beat_dur=beat_dur, **kw)

            import base64
            import cv2
            _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            jpg_bytes = buf.tobytes()

            accept = self.headers.get("Accept", "")
            if "application/json" in accept or data.get("format") == "json":
                b64 = base64.b64encode(jpg_bytes).decode("ascii")
                self._send_json({"ok": True, "jpeg_b64": b64})
            else:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpg_bytes)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(jpg_bytes)
            return

        if route == "/api/shutdown":
            STATE.proxies.shutdown()
            for sid in list(STATE.raw_sessions):
                _abort_raw(sid)
            self._send_json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        if route == "/api/render":
            params = json.loads(body.decode("utf-8"))
            with STATE.lock:
                if STATE.active_job and STATE.active_job.get("status") == "rendering":
                    self._send_json({"error": "Render already in progress"}, status=409)
                    return

            def _worker():
                try:
                    run_render_job(params)
                except Exception:
                    pass

            threading.Thread(target=_worker, daemon=True).start()
            self._send_json({"started": True})
            return

        if route == "/api/upload":
            fname = self.headers.get("X-Filename", f"upload-{int(time.time())}.mp4")
            safe_name = os.path.basename(urllib.parse.unquote(fname))
            uploads_dir = os.path.join(OUT_DIR, "uploads")
            os.makedirs(uploads_dir, exist_ok=True)
            dest = os.path.join(uploads_dir, safe_name)
            with open(dest, "wb") as f:
                f.write(body)
            ext = os.path.splitext(safe_name)[1].lower()
            try:
                if ext in (".wav", ".mp3", ".flac", ".aif", ".aiff", ".m4a"):
                    prof = STATE.add_track_path(dest)
                    self._send_json(
                        {
                            "ok": True,
                            "kind": "audio",
                            "id": prof.id,
                            "name": prof.name,
                            "detected_bpm": prof.detected_bpm,
                        }
                    )
                else:
                    src = STATE.add_clip_path(dest)
                    self._send_json({"ok": True, "kind": "video", "id": src.id, "name": src.name})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, status=400)
            return

        self.send_error(HTTPStatus.NOT_FOUND)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        # Browsers routinely abort media range requests mid-stream; that is not an error.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def _is_canvas_forge_running(host: str, port: int) -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/status", timeout=0.6) as resp:
            return resp.status == 200
    except Exception:
        return False


def serve_studio(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    if _is_canvas_forge_running(host, port):
        print(f"\n  ✦ Found running Canvas Forge server at http://{host}:{port}. Reloading...")
        try:
            req = urllib.request.Request(
                f"http://{host}:{port}/api/shutdown",
                data=b"{}",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                pass
        except Exception:
            pass
        time.sleep(0.4)

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
    print(f"\n  ✦ Canvas Forge Studio running at {url}")
    print(f"  ✦ Loaded {len(STATE.clips)} video clips & {len(STATE.tracks)} audio tracks from ~/Downloads")
    print("  ✦ Press Ctrl+C to stop\n")
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Canvas Forge Studio.")
        server.server_close()
