"""Canvas Forge Studio: Interactive Web UI & HTTP server (Lambda Audio dark aesthetic)."""
from __future__ import annotations

import glob
import json
import mimetypes
import os
import random
import threading
import time
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import effects
from .audio import AudioProfile, analyze_track
from .compositor import CANVAS_FPS, CANVAS_H, CANVAS_W, build_plan
from .encoder import Encoder, mux_audio_preview
from .recipe import PRESETS, make_recipe
from .source import Source, extract_thumbnail_jpeg, probe

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(PROJECT_ROOT, "out")
UI_HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui.html")


class StudioState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.clips: dict[str, Source] = {}
        self.tracks: dict[str, AudioProfile] = {}
        self.renders: list[dict] = []
        self.active_job: dict | None = None
        self._discover_initial_clips()
        self._discover_initial_tracks()
        self._discover_existing_renders()

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
            audio_companion = path[:-4] + "-audio.mp4"
            audio_url = (
                f"/out/{urllib.parse.quote(os.path.basename(audio_companion))}"
                if os.path.isfile(audio_companion)
                else None
            )
            self.renders.append(
                {
                    "filename": name,
                    "url": f"/out/{urllib.parse.quote(name)}",
                    "audio_url": audio_url,
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
        return src

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

    seed = int(params.get("seed") or random.randrange(100_000, 999_999))
    bpm = int(params.get("bpm") or (track_prof.detected_bpm if track_prof else 128))
    preset = params.get("preset") or "hypnotic"
    effect_names = params.get("effects")
    cut_beats = int(params.get("cut_beats") or 4)
    transition = params.get("transition") or "flash"
    intensity = float(params.get("intensity") or 1.0)
    speed = float(params.get("speed") or 1.0)
    duration = float(params.get("duration") or 8.0)
    duration = max(3.0, min(8.0, duration))
    loop_mode = params.get("loop_mode") or "crossfade"
    quality = params.get("quality") or "preview"

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
        transition=transition,
        intensity=intensity,
        duration=duration,
        loop_mode=loop_mode,
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
            audio_start_sec=track_prof.best_start_sec if track_prof else None,
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

        audio_url = None
        audio_filename = None
        if track_prof:
            try:
                audio_filename = f"{base_stem}-audio.mp4"
                audio_out_path = os.path.join(OUT_DIR, audio_filename)
                mux_audio_preview(
                    silent_mp4_path=out_path,
                    audio_path=track_prof.path,
                    out_mp4_path=audio_out_path,
                    start_sec=track_prof.best_start_sec,
                    duration_sec=duration,
                )
                audio_url = f"/out/{urllib.parse.quote(audio_filename)}?t={int(time.time())}"
            except Exception:
                audio_url = None

        elapsed = round(time.time() - t0, 2)
        size_mb = round(os.path.getsize(out_path) / (1024 * 1024), 2)
        entry = {
            "filename": filename,
            "url": f"/out/{urllib.parse.quote(filename)}?t={int(time.time())}",
            "audio_url": audio_url,
            "audio_filename": audio_filename,
            "track_name": track_prof.name if track_prof else None,
            "size_mb": size_mb,
            "elapsed_s": elapsed,
            "resolution": f"{width}x{height}",
            "duration": duration,
            "loop_mode": loop_mode,
            "tag": tag,
            "quality": quality,
            "seed": seed,
            "bpm": bpm,
            "preset": recipe.preset,
            "cut_beats": recipe.cut_beats,
            "transition": recipe.transition,
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

        if range_header and range_header.startswith("bytes="):
            try:
                byte_range = range_header.split("=")[1].split("-")
                start = int(byte_range[0]) if byte_range[0] else 0
                end = int(byte_range[1]) if len(byte_range) > 1 and byte_range[1] else file_size - 1
                end = min(end, file_size - 1)
                length = max(0, end - start + 1)
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(length))
                self.end_headers()
                with open(path, "rb") as f:
                    f.seek(start)
                    self.wfile.write(f.read(length))
                return
            except Exception:
                pass

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with open(path, "rb") as f:
            self.wfile.write(f.read())

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path

        if route in ("/", "/index.html"):
            self._serve_file(UI_HTML_PATH, "text/html; charset=utf-8")
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
            try:
                jpg = extract_thumbnail_jpeg(src.path)
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

        if route.startswith("/out/"):
            fname = urllib.parse.unquote(route.split("/out/", 1)[1])
            safe_path = os.path.abspath(os.path.join(OUT_DIR, fname))
            if not safe_path.startswith(os.path.abspath(OUT_DIR)):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            self._serve_file(safe_path, "video/mp4")
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b"{}"

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


def serve_studio(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    server = ThreadingHTTPServer((host, port), StudioHandler)
    url = f"http://{host}:{port}"
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
