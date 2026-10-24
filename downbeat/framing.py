"""Auto-framing and release palette extraction for 9:16 crops."""
from __future__ import annotations

import colorsys

import cv2
import numpy as np

SAMPLES = 8
WORK_WIDTH = 480
MOTION_GAP = 3  # frames between the pair used for motion energy


def _sample_pairs(path: str) -> list[tuple[np.ndarray, np.ndarray | None]]:
    """(frame, frame MOTION_GAP later) at SAMPLES positions, downscaled to WORK_WIDTH."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return []
    try:
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        positions = [int((i + 0.5) / SAMPLES * max(1, n - MOTION_GAP - 1)) for i in range(SAMPLES)] if n > 1 else [0]
        out: list[tuple[np.ndarray, np.ndarray | None]] = []
        for pos in positions:
            cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
            ok, a = cap.read()
            if not ok:
                continue
            b = None
            for _ in range(MOTION_GAP):
                ok, f = cap.read()
                if not ok:
                    break
                b = f
            scale = WORK_WIDTH / a.shape[1]
            size = (WORK_WIDTH, max(1, int(round(a.shape[0] * scale))))
            out.append((cv2.resize(a, size, interpolation=cv2.INTER_AREA),
                        cv2.resize(b, size, interpolation=cv2.INTER_AREA) if b is not None else None))
        return out
    finally:
        cap.release()


def _norm(m: np.ndarray) -> np.ndarray:
    hi = float(np.percentile(m, 99))
    return np.clip(m / hi, 0, 1) if hi > 1e-6 else np.zeros_like(m)


def _subject(pairs: list[tuple[np.ndarray, np.ndarray | None]]) -> tuple[float, float] | None:
    acc = None
    for a, b in pairs:
        gray = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float32)
        motion = cv2.absdiff(gray, cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.float32)) if b is not None else np.zeros_like(gray)
        edges = cv2.Canny(a, 80, 160).astype(np.float32)
        hsv = cv2.cvtColor(a, cv2.COLOR_BGR2HSV).astype(np.float32)
        contrast = hsv[..., 1] * 0.5 + np.abs(hsv[..., 2] - float(hsv[..., 2].mean()))
        m = 0.45 * _norm(motion) + 0.3 * _norm(edges) + 0.25 * _norm(contrast)
        acc = m if acc is None else acc + m
    if acc is None:
        return None
    h, w = acc.shape
    sigma = 0.04 * w
    acc = cv2.GaussianBlur(acc, (0, 0), sigmaX=sigma, sigmaY=sigma)
    p50, p85, p95 = (float(np.percentile(acc, q)) for q in (50, 85, 95))
    if p95 <= 1e-6 or (p95 - p50) / p95 < 0.15:
        return None  # nothing stands out: keep the centre
    weights = np.where(acc >= p85, acc - p85, 0.0)
    total = float(weights.sum())
    if total <= 1e-9:
        return None
    ys, xs = np.mgrid[0:h, 0:w]
    return float((weights * xs).sum() / total + 0.5) / w, float((weights * ys).sum() / total + 0.5) / h


def autoframe(path: str) -> dict:
    """{"focus": [x, y], "method": "subject" | "center"}; x, y in 0..1, origin top-left."""
    pairs = _sample_pairs(path)
    subj = _subject(pairs)
    focus, method = (subj, "subject") if subj else ((0.5, 0.5), "center")
    x, y = focus
    return {"focus": [round(min(1.0, max(0.0, x)), 4), round(min(1.0, max(0.0, y)), 4)], "method": method}


def extract_palette(path: str, k: int = 5) -> dict:
    """Extract release color palette, gradient, and primary hue."""
    pairs = _sample_pairs(path)
    frames = [p[0] for p in pairs[:4]] if pairs else []
    if not frames:
        still = cv2.imread(path)
        if still is not None:
            frames = [still]
    if not frames:
        frames = [np.zeros((64, 64, 3), dtype=np.uint8)]

    pixels = np.vstack([cv2.resize(f, (64, 64), interpolation=cv2.INTER_AREA).reshape(-1, 3) for f in frames]).astype(np.float32)
    K = min(k, len(pixels))
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 15, 1.0)
    _, labels, centers = cv2.kmeans(pixels, K, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.flatten()
    counts = np.bincount(labels, minlength=K)
    total = max(1, len(pixels))

    swatches: list[dict] = []
    for i in range(K):
        b, g, r = centers[i]
        r_int = int(np.clip(round(float(r)), 0, 255))
        g_int = int(np.clip(round(float(g)), 0, 255))
        b_int = int(np.clip(round(float(b)), 0, 255))
        h, s, _ = colorsys.rgb_to_hsv(r_int / 255.0, g_int / 255.0, b_int / 255.0)
        luma = (0.2126 * r_int + 0.7152 * g_int + 0.0722 * b_int) / 255.0
        hex_code = f"#{r_int:02X}{g_int:02X}{b_int:02X}"
        share = float(counts[i]) / total
        swatches.append({
            "rgb": [r_int, g_int, b_int],
            "hex": hex_code,
            "hue": round(float(h), 4),
            "saturation": round(float(s), 4),
            "luma": round(float(luma), 4),
            "share": round(float(share), 4),
        })

    swatches.sort(key=lambda s: s["share"], reverse=True)

    pool = list(swatches)
    vibrant = None
    shadow = None

    if pool:
        vibrant = max(pool, key=lambda s: (s["saturation"], s["share"]))
        vibrant["role"] = "Accent"
        pool.remove(vibrant)

    if pool:
        highlight = max(pool, key=lambda s: (s["luma"], s["share"]))
        highlight["role"] = "Highlight"
        pool.remove(highlight)

    if pool:
        shadow = min(pool, key=lambda s: (s["luma"], -s["share"]))
        shadow["role"] = "Shadow"
        pool.remove(shadow)

    if pool:
        dominant = max(pool, key=lambda s: s["share"])
        dominant["role"] = "Dominant"
        pool.remove(dominant)

    for s in pool:
        s["role"] = "Secondary"

    vibrant_hex = vibrant["hex"] if vibrant else "#808080"
    shadow_hex = shadow["hex"] if shadow is not None else vibrant_hex
    css_gradient = f"linear-gradient(180deg, {vibrant_hex} 0%, {shadow_hex} 100%)"
    primary_hue = round(float(vibrant["hue"]), 3) if vibrant else 0.0

    return {"colors": swatches, "css_gradient": css_gradient, "primary_hue": primary_hue}
