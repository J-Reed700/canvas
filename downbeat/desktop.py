"""Standalone desktop window launcher and frozen-bundle entrypoint for Downbeat Studio."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser

from downbeat.server.app import ReusableThreadingHTTPServer, StudioHandler, _abort_raw, _is_downbeat_running
from downbeat.server.state import OUT_DIR, STATE


def find_app_browser() -> str | None:
    """Return a Chromium-based browser executable that supports ``--app=<url>`` window mode."""
    override = os.environ.get("DOWNBEAT_BROWSER") or os.environ.get("CHROME_PATH")
    if override and os.path.isfile(override):
        return override

    if sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
        for path in candidates:
            if os.path.isfile(path):
                return path

    if sys.platform == "win32":
        roots = [
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
            os.environ.get("LOCALAPPDATA"),
        ]
        rel_paths = [
            os.path.join("Google", "Chrome", "Application", "chrome.exe"),
            os.path.join("Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            os.path.join("Chromium", "Application", "chrome.exe"),
        ]
        for root in roots:
            if not root:
                continue
            for rel in rel_paths:
                candidate = os.path.join(root, rel)
                if os.path.isfile(candidate):
                    return candidate

    for name in ("google-chrome", "google-chrome-stable", "microsoft-edge", "brave-browser", "chromium", "chromium-browser", "chrome", "msedge"):
        found = shutil.which(name)
        if found:
            return found

    return None


def launch_app_window(url: str, profile_dir: str | None = None) -> subprocess.Popen | None:
    """Open ``url`` in a standalone chromeless desktop window if a Chromium browser is available."""
    exe = find_app_browser()
    if not exe:
        webbrowser.open(url)
        return None

    user_data = profile_dir or os.path.join(OUT_DIR, ".app-window")
    os.makedirs(user_data, exist_ok=True)
    args = [
        exe,
        f"--app={url}",
        f"--user-data-dir={user_data}",
        "--window-size=1440,920",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
    ]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    return subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def serve_desktop(host: str = "127.0.0.1", port: int = 8765) -> int:
    """Run the Downbeat Studio server and open a dedicated desktop window.

    When the window process exits (the user closes the Downbeat window), the server shuts down
    automatically so no background process is left behind.
    """
    STATE.ensure_initialized()
    if _is_downbeat_running(host, port):
        url = f"http://{host}:{port}"
        proc = launch_app_window(url)
        if proc is not None:
            proc.wait()
        return 0

    server: ReusableThreadingHTTPServer | None = None
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
    print(f"\nDownbeat Desktop running at {url}")

    server_thread = threading.Thread(target=server.serve_forever, name="downbeat-desktop-http", daemon=True)
    server_thread.start()

    try:
        proc = launch_app_window(url)
        if proc is not None:
            # Wait for the standalone window process to close; if the browser handed off to an
            # existing process in < 1.5s, fall back to keeping the server alive until interrupted.
            t0 = time.monotonic()
            proc.wait()
            if time.monotonic() - t0 < 1.5:
                while server_thread.is_alive():
                    time.sleep(0.5)
        else:
            while server_thread.is_alive():
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for sid in STATE.begin_shutdown():
            _abort_raw(sid)
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(serve_desktop())
