import type { StudioState } from '../state/storeTypes.ts';
import { sizeCanvas, roundRect } from '../lib/utils.ts';
import { cancelThumb, loadThumb } from '../lib/thumbs.ts';
import type { Segment } from '../engine/types.ts';
import { ThumbnailCache } from '../lib/thumbnailCache.ts';

const timelineThumbnails = new ThumbnailCache(512, undefined, (image, url, onReady, wanted) => {
  loadThumb(url, onReady, image, wanted);
  return () => cancelThumb(image);
});
export const thumbImgsMap = timelineThumbnails.images;

/** The block whose settings the inspector shows, outlined on the lane so you can see which one you're editing. */
let menuSeg: string | null = null;
export const setMenuSeg = (id: string | null) => { menuSeg = id; };

export function drawOverview(s: StudioState) {
  const c = document.getElementById('overview') as HTMLCanvasElement | null;
  if (!c) return;
  const [w, hh, dpr] = sizeCanvas(c);
  const x = c.getContext('2d');
  if (!x) return;
  x.clearRect(0, 0, w, hh);

  const f = s.features;
  if (!f || !f.duration) {
    x.fillStyle = '#94969f';
    x.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('No track selected: canvas uses a synthetic beat clock', w / 2, hh / 2);
    return;
  }
  const L = s.ctx?.L ?? s.loopLen();
  const D = f.duration;
  const x0 = (s.loopStart / D) * w;
  const x1 = ((s.loopStart + L) / D) * w;
  const n = f.peaks?.length || 0;

  for (let px = 0; px < w; px += 2 * dpr) {
    const v = f.peaks ? f.peaks[Math.floor((px / w) * n)] || 0 : 0;
    const bh = Math.max(dpr, v * hh * 0.74);
    x.fillStyle = px >= x0 && px <= x1 ? 'rgba(105,182,166,0.92)' : 'rgba(148,150,159,0.32)';
    x.fillRect(px, (hh - bh) / 2, 1.2 * dpr, bh);
  }
  x.fillStyle = 'rgba(185,164,255,0.10)';
  x.fillRect(x0, 0, x1 - x0, hh);
  x.strokeStyle = 'rgba(185,164,255,0.9)';
  x.lineWidth = dpr;
  x.strokeRect(x0, 0.5 * dpr, x1 - x0, hh - dpr);

  for (const l of f.loops || []) {
    const lx = (l.start / D) * w;
    x.fillStyle = '#e8e9ed';
    x.beginPath();
    x.moveTo(lx - 4 * dpr, 0);
    x.lineTo(lx + 4 * dpr, 0);
    x.lineTo(lx, 5 * dpr);
    x.fill();
  }
  if (s.transport.mode === 'listen' && s.transport.playing) {
    const sx = (s.transport.songTime() / D) * w;
    x.fillStyle = '#e8e9ed';
    x.fillRect(sx - dpr, 0, 2 * dpr, hh);
  }
}

export function drawLane(s: StudioState, onRedraw?: () => void) {
  const c = document.getElementById('lane') as HTMLCanvasElement | null;
  if (!c) return;
  const [w, hh, dpr] = sizeCanvas(c);
  const x = c.getContext('2d');
  if (!x) return;
  x.clearRect(0, 0, w, hh);

  const ctx = s.ctx;
  if (!ctx) return;

  const { L, beatDur: bd, tl } = ctx;
  const X = (t: number) => (t / L) * w;
  const rulerH = Math.min(20 * dpr, hh * 0.22);
  const audioH = Math.min(30 * dpr, Math.max(22 * dpr, hh * 0.23));
  const top = rulerH + 2 * dpr;
  const bot = Math.max(top + 10 * dpr, hh - audioH - 4 * dpr);
  const audioTop = Math.min(hh - 3 * dpr, bot + 4 * dpr);
  const audioBot = hh - 2 * dpr;

  x.fillStyle = '#121316';
  x.fillRect(0, 0, w, rulerH);
  x.fillStyle = '#17181c';
  x.fillRect(0, top, w, Math.max(0, bot - top));
  x.fillStyle = '#111817';
  x.fillRect(0, audioTop, w, Math.max(0, hh - audioTop));
  x.fillStyle = '#303136';
  x.fillRect(0, rulerH - dpr, w, dpr);
  x.fillRect(0, audioTop - 2 * dpr, w, dpr);

  // Long loops squeeze hundreds of bars into the lane, so beat lines drop out first, then bar
  // numbers go to every 2nd, 4th, 8th... bar.
  const beatPx = X(bd);
  let every = 1;
  while (beatPx * 4 * every < 26 * dpr) every *= 2;
  for (let b = 0; b * bd < L - 1e-6; b++) {
    const onBar = b % 4 === 0;
    const labelled = onBar && (b / 4) % every === 0;
    if (!labelled && !(onBar && beatPx * 4 >= 4 * dpr) && beatPx < 5 * dpr) continue;
    x.fillStyle = onBar ? 'rgba(232,233,237,0.16)' : 'rgba(232,233,237,0.055)';
    x.fillRect(Math.round(X(b * bd)), onBar ? 0 : rulerH, dpr, onBar ? hh : hh - rulerH);
    if (labelled) {
      x.fillStyle = 'rgba(232,233,237,0.55)';
      x.font = `600 ${9 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      x.textAlign = 'left';
      x.fillText(String(b / 4 + 1), X(b * bd) + 4 * dpr, 13 * dpr);
    }
  }
  if (w > 180 * dpr) {
    x.fillStyle = 'rgba(148,150,159,0.58)';
    x.font = `500 ${9 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    x.textAlign = 'right';
    x.fillText(`${L < 100 ? L.toFixed(1) : Math.round(L)} s`, w - 6 * dpr, 13 * dpr);
    x.textAlign = 'left';
  }
  // While one clip's own FX stack is open in Layers, show where that stack plays.
  const editing = !!s.editClip && s.editLook() !== s.look;

  // A block from t0 to t1. In a Rebound loop the second half plays the first backward: those blocks are
  // drawn again, mirrored and dimmed, and aren't for editing.
  const drawBlock = (seg: Segment, t0: number, t1: number, mirror: boolean) => {
    const span = X(t1) - X(t0);
    const pad = span > 8 * dpr ? 1.5 * dpr : 0;
    const a = X(t0) + pad;
    const W = Math.max(dpr, span - 2 * pad);
    const r = Math.min(7 * dpr, W / 2);
    x.save();
    roundRect(x, a, top, W, bot - top, r);
    x.clip();

    const ci = s.selected.indexOf(seg.clipId) + 1;
    if (W < 16 * dpr) {
      // Too narrow for a thumbnail to read: a flat color per clip, and no request for one.
      x.fillStyle = `hsl(${(ci * 67) % 360} 30% 34%)`;
      x.fillRect(a, top, W, bot - top);
    } else {
      const k = `${seg.clipId}@${seg.in.toFixed(1)}`;
      const img = timelineThumbnails.get(k, `/api/thumb/${seg.clipId}?w=200&t=${seg.in.toFixed(2)}`, onRedraw || s.drawLane);
      if (img.complete && img.naturalWidth) {
        const ir = img.naturalWidth / img.naturalHeight;
        const cr = W / (bot - top);
        let sw = img.naturalWidth;
        let sh = img.naturalHeight;
        let sx = 0;
        let sy = 0;
        if (ir > cr) {
          sw = sh * cr;
          sx = (img.naturalWidth - sw) / 2;
        } else {
          sh = sw / cr;
          sy = (img.naturalHeight - sh) / 2;
        }
        x.drawImage(img, sx, sy, sw, sh, a, top, W, bot - top);
      } else {
        x.fillStyle = '#1b1b22';
        x.fillRect(a, top, W, bot - top);
      }

      const grd = x.createLinearGradient(0, top, 0, bot);
      grd.addColorStop(0, 'rgba(0,0,0,0.02)');
      grd.addColorStop(0.62, 'rgba(0,0,0,0.08)');
      grd.addColorStop(1, 'rgba(0,0,0,0.7)');
      x.fillStyle = grd;
      x.fillRect(a, top, W, bot - top);
      x.fillStyle = '#e8e9ed';
      x.font = `700 ${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      if (W > 22 * dpr) x.fillText(`#${ci}`, a + 6 * dpr, bot - 6 * dpr);
      if (seg.look && W > 54 * dpr) {
        x.fillStyle = '#b9a4ff';
        x.textAlign = 'right';
        x.fillText('FX', a + W - 6 * dpr, bot - 6 * dpr);
        x.textAlign = 'left';
      }
    }
    if (editing && seg.clipId !== s.editClip) {
      x.fillStyle = 'rgba(10,10,14,0.62)';
      x.fillRect(a, top, W, bot - top);
    }
    if (mirror) {
      x.fillStyle = 'rgba(10,10,14,0.5)';
      x.fillRect(a, top, W, bot - top);
    }
    x.restore();
    if (mirror) return;

    if (editing && seg.clipId === s.editClip) {
      x.strokeStyle = '#b9a4ff';
      x.lineWidth = 2 * dpr;
      roundRect(x, a, top, W, bot - top, r);
      x.stroke();
    }
    if (seg.id === s.selectedBlock) {
      x.strokeStyle = '#b9a4ff';
      x.lineWidth = 2 * dpr;
      roundRect(x, a + dpr, top + dpr, W - 2 * dpr, bot - top - 2 * dpr, r);
      x.stroke();
    }
    if (seg.id === menuSeg) {
      x.strokeStyle = '#e8e9ed';
      x.lineWidth = 2 * dpr;
      roundRect(x, a + 3 * dpr, top + 3 * dpr, W - 6 * dpr, bot - top - 6 * dpr, Math.max(0, r - 2 * dpr));
      x.stroke();
    }
  };
  tl.segs.forEach((seg) => drawBlock(seg, seg.t0, seg.t1, false));
  if (tl.rebound) {
    tl.segs.forEach((seg) => drawBlock(seg, L - seg.t1, L - seg.t0, true));
    // where the footage turns round
    x.fillStyle = 'rgba(185,164,255,0.9)';
    for (let y = top; y < bot; y += 6 * dpr) x.fillRect(Math.round(X(tl.L)) - dpr, y, 2 * dpr, 3 * dpr);
  }

  // With cuts closer than ~10 px, the diamonds would overlap: keep only the cut lines, and drop
  // those too once they'd merge into a solid block.
  const gap = X(tl.L) / tl.segs.length;
  if (tl.rebound) {
    // the backward half's cuts and transitions, faint, at their mirrored times
    tl.segs.forEach((seg) => {
      if (seg.t0 <= 0) return;
      const cx = X(L - seg.t0);
      const half = (seg.transDur / 2 / L) * w;
      x.fillStyle = 'rgba(185,164,255,0.12)';
      if (half > 0) x.fillRect(cx - half, top, half * 2, bot - top);
      if (gap >= 3 * dpr) {
        x.fillStyle = 'rgba(232,233,237,0.4)';
        x.fillRect(cx - 0.75 * dpr, top, 1.5 * dpr, bot - top);
      }
    });
  }
  tl.segs.forEach((seg) => {
    const cx = X(seg.t0);
    const half = (seg.transDur / 2 / L) * w;
    if (seg.transDur > 0) {
      x.fillStyle = 'rgba(185,164,255,0.23)';
      x.fillRect(cx - half, top, half * 2, bot - top);
      if (seg.t0 === 0) x.fillRect(w - half, top, half, bot - top);
      // the window's edges drag to set its length
      if (half >= 6 * dpr) {
        x.fillStyle = 'rgba(185,164,255,0.76)';
        for (const ex of seg.t0 === 0 ? [half, w - half] : [cx - half, cx + half]) x.fillRect(ex - 0.5 * dpr, top, dpr, bot - top);
      }
    }
    if (gap >= 10 * dpr && !(tl.rebound && seg.t0 === 0)) {
      x.fillStyle = seg.trans === 'cut' ? '#e8e9ed' : '#b9a4ff';
      x.save();
      x.translate(cx === 0 ? 5 * dpr : cx, top);
      x.rotate(Math.PI / 4);
      x.fillRect(-4 * dpr, -4 * dpr, 8 * dpr, 8 * dpr);
      x.restore();
    }
    if (seg.t0 > 0 && gap >= 3 * dpr) {
      x.fillStyle = 'rgba(232,233,237,0.82)';
      x.fillRect(cx - 0.75 * dpr, top, 1.5 * dpr, bot - top);
      // a grip, so the line reads as something to drag
      if (gap >= 24 * dpr) {
        roundRect(x, cx - 2.5 * dpr, (top + bot) / 2 - 8 * dpr, 5 * dpr, 16 * dpr, 2.5 * dpr);
        x.fill();
      }
    }
  });

  const curveTop = audioTop + 2 * dpr;
  const curveBot = Math.max(curveTop, audioBot);
  const curveY = (v: number) => curveBot - Math.max(0, Math.min(1, v)) * Math.max(dpr, curveBot - curveTop);
  const plot = (key: string, color: string | null, fill: string | null) => {
    x.beginPath();
    for (let px = 0; px <= w; px += 2 * dpr) {
      const v = ctx.sampler((px / w) * L)[key] || 0;
      if (px === 0) x.moveTo(px, curveY(v));
      else x.lineTo(px, curveY(v));
    }
    if (fill) {
      x.lineTo(w, curveBot);
      x.lineTo(0, curveBot);
      x.fillStyle = fill;
      x.fill();
    } else if (color) {
      x.strokeStyle = color;
      x.lineWidth = 1.2 * dpr;
      x.stroke();
    }
  };

  const peaks = s.features?.peaks;
  const duration = s.features?.duration || 0;
  if (peaks?.length && duration > 0 && curveBot > curveTop) {
    const mid = (curveTop + curveBot) / 2;
    const amp = (curveBot - curveTop) * 0.46;
    const peakAt = (px: number) => {
      const sourceTime = Math.max(0, Math.min(duration, s.loopStart + (px / w) * L));
      return Math.max(0, Math.min(1, peaks[Math.min(peaks.length - 1, Math.floor((sourceTime / duration) * peaks.length))] || 0));
    };
    x.beginPath();
    for (let px = 0; px <= w; px += 2 * dpr) {
      const y = mid - peakAt(px) * amp;
      if (px === 0) x.moveTo(px, y);
      else x.lineTo(px, y);
    }
    for (let px = w; px >= 0; px -= 2 * dpr) x.lineTo(px, mid + peakAt(px) * amp);
    x.closePath();
    x.fillStyle = 'rgba(105,182,166,0.30)';
    x.fill();
  }
  plot('energy', null, 'rgba(124,255,155,0.12)');
  plot('kick', 'rgba(255,90,90,0.78)', null);
  plot('hats', 'rgba(90,216,255,0.72)', null);
}

export function drawTimeline(s: StudioState, onRedraw?: () => void) {
  drawOverview(s);
  drawLane(s, onRedraw);
}
