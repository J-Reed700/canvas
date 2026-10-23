"""Auto-framing: where should a 9:16 crop of this clip sit?

Samples a handful of frames, looks for faces first (OpenCV's bundled Haar cascade), and
otherwise estimates the subject from motion, edge density and colour/brightness contrast.
Returns a focus point in image coordinates (origin top-left, y down), both 0..1.
"""
from __future__ import annotations

import os
import threading

import cv2
import numpy as np

SAMPLES = 8
WORK_WIDTH = 480
MOTION_GAP = 3  # frames between the pair used for motion energy

_cascade = None  # cv2.CascadeClassifier, or False once we know there is none
_cascade_lock = threading.Lock()
CASCADE = "haarcascade_frontalface_default.xml"
# OpenCV 4 wheels bundle the cascades in cv2.data; OpenCV 5 wheels dropped them (and the
# classifier), so also look where a system OpenCV keeps them. Without one, framing skips faces.
CASCADE_DIRS = ["/opt/homebrew/share/opencv4/haarcascades", "/usr/local/share/opencv4/haarcascades", "/usr/share/opencv4/haarcascades"]


def _face_cascade():
    global _cascade
    with _cascade_lock:
        if _cascade is None:
            _cascade = False
            make = getattr(cv2, "CascadeClassifier", None)
            dirs = [getattr(getattr(cv2, "data", None), "haarcascades", "")] + CASCADE_DIRS
            path = next((os.path.join(d, CASCADE) for d in dirs if d and os.path.isfile(os.path.join(d, CASCADE))), None)
            if make and path:
                c = make(path)
                if not c.empty():
                    _cascade = c
        return _cascade or None


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


def _faces(frames: list[np.ndarray]) -> tuple[float, float] | None:
    cascade = _face_cascade()
    if cascade is None or not frames:
        return None
    h, w = frames[0].shape[:2]
    boxes, hits = [], 0
    for f in frames:
        gray = cv2.equalizeHist(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
        found = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(int(h * 0.07), int(h * 0.07)))
        if len(found):
            hits += 1
            boxes.extend(found.tolist())
    # one stray detection in textured footage is usually noise; a real face recurs
    if not boxes or hits < min(2, len(frames)):
        return None
    b = np.array(boxes, dtype=np.float64)
    area = b[:, 2] * b[:, 3]
    cx = float(np.sum((b[:, 0] + b[:, 2] / 2) * area) / area.sum()) / w
    cy = float(np.sum((b[:, 1] + b[:, 3] / 2) * area) / area.sum()) / h
    mean_h = float(np.sum(b[:, 3] * area) / area.sum()) / h
    return cx, cy - 0.15 * mean_h  # a little headroom above the faces


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
    """{"focus": [x, y], "method": "faces" | "subject" | "center"}; x, y in 0..1, origin top-left."""
    pairs = _sample_pairs(path)
    focus, method = None, "center"
    face = _faces([a for a, _ in pairs])
    if face:
        focus, method = face, "faces"
    else:
        subj = _subject(pairs)
        if subj:
            focus, method = subj, "subject"
    x, y = focus or (0.5, 0.5)
    return {"focus": [round(min(1.0, max(0.0, x)), 4), round(min(1.0, max(0.0, y)), 4)], "method": method}
