"""Build a standalone double-click Downbeat desktop app and installer (Windows .exe / macOS .app + .dmg)."""
from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_icon_rgba(size: int = 256) -> np.ndarray:
    """Render the Downbeat studio icon (rounded graphite tile with violet downbeat pulse wave) as BGRA."""
    img = np.zeros((size, size, 4), dtype=np.uint8)
    pad = max(2, int(size * 0.06))
    radius = int(size * 0.22)

    # Rounded square mask
    mask = np.zeros((size, size), dtype=np.uint8)
    cv2.rectangle(mask, (pad + radius, pad), (size - pad - radius, size - pad), 255, -1)
    cv2.rectangle(mask, (pad, pad + radius), (size - pad, size - pad - radius), 255, -1)
    for cx, cy in (
        (pad + radius, pad + radius),
        (size - pad - radius, pad + radius),
        (pad + radius, size - pad - radius),
        (size - pad - radius, size - pad - radius),
    ):
        cv2.circle(mask, (cx, cy), radius, 255, -1, lineType=cv2.LINE_AA)

    # Subtle diagonal graphite gradient background
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / max(1, size - 1)
    grad = np.clip(1.0 - 0.55 * (x * 0.5 + y * 0.8), 0.0, 1.0)
    img[:, :, 0] = (24 + 18 * grad).astype(np.uint8)  # B
    img[:, :, 1] = (18 + 14 * grad).astype(np.uint8)  # G
    img[:, :, 2] = (20 + 16 * grad).astype(np.uint8)  # R
    img[:, :, 3] = mask

    # Waveform / downbeat bars in signature violet (#b9a4ff -> BGR 255, 164, 185) and hot magenta accent
    bars = [0.28, 0.48, 0.86, 0.62, 0.36]
    n = len(bars)
    span = size * 0.56
    x0 = (size - span) / 2.0
    bw = max(2, int(size * 0.075))
    cy = size // 2
    for i, h_frac in enumerate(bars):
        bx = int(round(x0 + i * (span / (n - 1))))
        bh = max(bw, int(round(size * h_frac * 0.68)))
        y1, y2 = cy - bh // 2, cy + bh // 2
        color = (255, 172, 195, 255) if i == 2 else (245, 145, 165, 255)
        cv2.line(img, (bx, y1), (bx, y2), color, thickness=bw, lineType=cv2.LINE_AA)

    img[:, :, 3] = np.minimum(img[:, :, 3], mask)
    return img


def write_ico(path: str) -> str:
    """Write a multi-resolution Windows .ico file containing PNG-encoded 256, 64, 48, 32, and 16 px icons."""
    sizes = (256, 64, 48, 32, 16)
    blobs: list[bytes] = []
    for s in sizes:
        bgra = make_icon_rgba(s)
        ok, buf = cv2.imencode(".png", bgra)
        if not ok:
            raise RuntimeError("Failed to encode icon PNG")
        blobs.append(buf.tobytes())

    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = bytearray()
    for s, blob in zip(sizes, blobs):
        dim = 0 if s >= 256 else s
        entries.extend(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset))
        offset += len(blob)

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        f.write(header)
        f.write(entries)
        for blob in blobs:
            f.write(blob)
    return path


def write_installer_scripts(dist_root: str) -> None:
    """Write a double-click Windows installer that installs to LocalAppData and adds Desktop/Start Menu shortcuts."""
    ps1_path = os.path.join(dist_root, "Install-Downbeat.ps1")
    bat_path = os.path.join(dist_root, "Install Downbeat.bat")
    ps1 = r"""$ErrorActionPreference = 'Stop'
$SourceDir = Join-Path $PSScriptRoot 'Downbeat'
if (-not (Test-Path -LiteralPath $SourceDir)) {
    Write-Error "Could not find built Downbeat folder next to this installer ($SourceDir)."
    exit 1
}

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Downbeat'
Write-Host "==> Installing Downbeat to $InstallDir ..." -ForegroundColor Green
if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse -Force

$ExePath = Join-Path $InstallDir 'Downbeat.exe'
$WshShell = New-Object -ComObject WScript.Shell

$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Downbeat.lnk'
$StartMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Downbeat'
New-Item -ItemType Directory -Path $StartMenuDir -Force | Out-Null
$StartMenuShortcut = Join-Path $StartMenuDir 'Downbeat.lnk'

foreach ($LinkPath in @($DesktopShortcut, $StartMenuShortcut)) {
    $Shortcut = $WshShell.CreateShortcut($LinkPath)
    $Shortcut.TargetPath = $ExePath
    $Shortcut.WorkingDirectory = $InstallDir
    $Shortcut.IconLocation = "$ExePath,0"
    $Shortcut.Description = 'Downbeat Studio'
    $Shortcut.Save()
}

Write-Host "==> Installed! Shortcuts added to your Desktop and Start Menu." -ForegroundColor Green
Start-Process -FilePath $ExePath
"""
    bat = """@echo off
title Downbeat Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Downbeat.ps1"
if errorlevel 1 pause
"""
    with open(ps1_path, "w", encoding="utf-8") as f:
        f.write(ps1)
    with open(bat_path, "w", encoding="utf-8") as f:
        f.write(bat)


def ensure_pyinstaller() -> None:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("==> Installing PyInstaller into virtual environment...")
        subprocess.run([sys.executable, "-m", "pip", "install", "pyinstaller"], check=True)


def build_desktop(skip_ui_build: bool = False) -> str:
    studio_dist = os.path.join(ROOT, "downbeat", "studio", "dist", "index.html")
    if not skip_ui_build or not os.path.isfile(studio_dist):
        npm = "npm.cmd" if sys.platform == "win32" else "npm"
        print("==> Building Studio UI (npm run build)...")
        subprocess.run([npm, "run", "build"], cwd=ROOT, check=True)

    ensure_pyinstaller()

    build_dir = os.path.join(ROOT, "build", "desktop")
    dist_dir = os.path.join(ROOT, "dist")
    os.makedirs(build_dir, exist_ok=True)
    os.makedirs(dist_dir, exist_ok=True)

    ico_path = write_ico(os.path.join(build_dir, "downbeat.ico"))
    png_path = os.path.join(build_dir, "downbeat.png")
    ok, buf = cv2.imencode(".png", make_icon_rgba(512))
    if ok:
        with open(png_path, "wb") as f:
            f.write(buf.tobytes())

    sep = ";" if sys.platform == "win32" else ":"
    studio_src = os.path.join(ROOT, "downbeat", "studio", "dist")
    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--windowed",
        "--name",
        "Downbeat",
        "--distpath",
        dist_dir,
        "--workpath",
        build_dir,
        "--specpath",
        build_dir,
        "--icon",
        ico_path,
        "--add-data",
        f"{studio_src}{sep}downbeat/studio/dist",
    ]

    for tool in ("ffmpeg", "ffprobe"):
        exe = shutil.which(tool)
        if exe and os.path.isfile(exe):
            args.extend(["--add-binary", f"{os.path.realpath(exe)}{sep}."])

    entry = os.path.join(ROOT, "downbeat", "desktop.py")
    args.append(entry)

    print("==> Packaging standalone Downbeat desktop application...")
    subprocess.run(args, cwd=ROOT, check=True)

    if sys.platform == "win32":
        write_installer_scripts(dist_dir)
        out_target = os.path.join(dist_dir, "Downbeat", "Downbeat.exe")
        print(f"\n==> Built standalone app: {out_target}")
        print(f"==> Double-click installer: {os.path.join(dist_dir, 'Install Downbeat.bat')}")
        return out_target

    if sys.platform == "darwin":
        app_bundle = os.path.join(dist_dir, "Downbeat.app")
        dmg_path = os.path.join(dist_dir, "Downbeat.dmg")
        if os.path.isdir(app_bundle) and shutil.which("hdiutil"):
            if os.path.exists(dmg_path):
                os.remove(dmg_path)
            subprocess.run(
                ["hdiutil", "create", "-volname", "Downbeat", "-srcfolder", app_bundle, "-ov", "-format", "UDZO", dmg_path],
                check=False,
            )
        return app_bundle

    return os.path.join(dist_dir, "Downbeat", "Downbeat")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-ui-build", action="store_true", help="use existing downbeat/studio/dist build")
    parsed = ap.parse_args(argv)
    build_desktop(skip_ui_build=parsed.skip_ui_build)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
