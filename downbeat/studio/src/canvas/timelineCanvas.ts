import type { StudioState } from '../state/store.ts';
import { sizeCanvas, roundRect } from '../lib/utils.ts';
import { MOD_SOURCES } from '../engine/modules.ts';

export const thumbImgsMap = new Map<string, HTMLImageElement>();

/** The block whose menu is open, outlined on the lane so you can see which one you're editing. */
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
    x.fillStyle = 'rgba(255,255,255,0.35)';
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
    const bh = Math.max(1, v * hh * 0.82);
    x.fillStyle = px >= x0 && px <= x1 ? 'rgba(200,255,77,0.95)' : 'rgba(255,255,255,0.24)';
    x.fillRect(px, (hh - bh) / 2, 1.2 * dpr, bh);
  }
  x.fillStyle = 'rgba(200,255,77,0.12)';
  x.fillRect(x0, 0, x1 - x0, hh);
  x.strokeStyle = 'rgba(200,255,77,0.9)';
  x.lineWidth = 1.5 * dpr;
  x.strokeRect(x0, 0.75 * dpr, x1 - x0, hh - 1.5 * dpr);

  for (const l of f.loops || []) {
    const lx = (l.start / D) * w;
    x.fillStyle = '#fff';
    x.beginPath();
    x.moveTo(lx - 4 * dpr, 0);
    x.lineTo(lx + 4 * dpr, 0);
    x.lineTo(lx, 5 * dpr);
    x.fill();
  }
  if (s.transport.mode === 'listen' && s.transport.playing) {
    const sx = (s.transport.songTime() / D) * w;
    x.fillStyle = '#fff';
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

  // Long loops squeeze hundreds of bars into the lane, so beat lines drop out first, then bar
  // numbers go to every 2nd, 4th, 8th... bar.
  const beatPx = X(bd);
  let every = 1;
  while (beatPx * 4 * every < 26 * dpr) every *= 2;
  for (let b = 0; b * bd < L - 1e-6; b++) {
    const onBar = b % 4 === 0;
    const labelled = onBar && (b / 4) % every === 0;
    if (!labelled && !(onBar && beatPx * 4 >= 4 * dpr) && beatPx < 5 * dpr) continue;
    x.fillStyle = onBar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
    x.fillRect(Math.round(X(b * bd)), 0, dpr, hh);
    if (labelled) {
      x.fillStyle = 'rgba(255,255,255,0.4)';
      x.font = `600 ${9 * dpr}px ui-monospace, Menlo, monospace`;
      x.fillText(String(b / 4 + 1), X(b * bd) + 3 * dpr, 10 * dpr);
    }
  }

  const top = 15 * dpr;
  const bot = hh - 26 * dpr;
  // While one clip's own FX stack is open in Layers, show where that stack plays.
  const editing = !!s.editClip && s.editLook() !== s.look;

  tl.segs.forEach((seg) => {
    const span = X(seg.t1) - X(seg.t0);
    const pad = span > 8 * dpr ? 1.5 * dpr : 0;
    const a = X(seg.t0) + pad;
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
      let img = thumbImgsMap.get(k);
      if (!img) {
        img = new Image();
        img.onload = () => onRedraw ? onRedraw() : s.drawLane();
        img.src = `/api/thumb/${seg.clipId}?w=200&t=${seg.in.toFixed(2)}`;
        thumbImgsMap.set(k, img);
      }
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
      grd.addColorStop(0, 'rgba(0,0,0,0.05)');
      grd.addColorStop(1, 'rgba(0,0,0,0.65)');
      x.fillStyle = grd;
      x.fillRect(a, top, W, bot - top);
      x.fillStyle = '#fff';
      x.font = `700 ${10 * dpr}px ui-monospace, Menlo, monospace`;
      if (W > 22 * dpr) x.fillText(`#${ci}`, a + 6 * dpr, bot - 7 * dpr);
    }
    if (editing && seg.clipId !== s.editClip) {
      x.fillStyle = 'rgba(10,10,14,0.62)';
      x.fillRect(a, top, W, bot - top);
    }
    x.restore();

    if (editing && seg.clipId === s.editClip) {
      x.strokeStyle = '#C8FF4D';
      x.lineWidth = 2 * dpr;
      roundRect(x, a, top, W, bot - top, r);
      x.stroke();
    }
    if (seg.id === s.selectedBlock) {
      x.strokeStyle = '#C8FF4D';
      x.lineWidth = 2 * dpr;
      roundRect(x, a + dpr, top + dpr, W - 2 * dpr, bot - top - 2 * dpr, r);
      x.stroke();
    }
    if (seg.id === menuSeg) {
      x.strokeStyle = '#fff';
      x.lineWidth = 2 * dpr;
      roundRect(x, a + 3 * dpr, top + 3 * dpr, W - 6 * dpr, bot - top - 6 * dpr, Math.max(0, r - 2 * dpr));
      x.stroke();
    }
  });

  // With cuts closer than ~10 px, the diamonds would overlap: keep only the cut lines, and drop
  // those too once they'd merge into a solid block.
  const gap = w / tl.segs.length;
  tl.segs.forEach((seg) => {
    const cx = X(seg.t0);
    const half = (seg.transDur / 2 / L) * w;
    if (seg.transDur > 0) {
      x.fillStyle = 'rgba(255,79,163,0.28)';
      x.fillRect(cx - half, top, half * 2, bot - top);
      if (seg.t0 === 0) x.fillRect(w - half, top, half, bot - top);
      // the window's edges drag to set its length
      if (half >= 6 * dpr) {
        x.fillStyle = 'rgba(255,79,163,0.75)';
        for (const ex of seg.t0 === 0 ? [half, w - half] : [cx - half, cx + half]) x.fillRect(ex - 0.5 * dpr, top, dpr, bot - top);
      }
    }
    if (gap >= 10 * dpr) {
      x.fillStyle = seg.trans === 'cut' ? '#fff' : '#FF4FA3';
      x.save();
      x.translate(cx === 0 ? 5 * dpr : cx, top);
      x.rotate(Math.PI / 4);
      x.fillRect(-4 * dpr, -4 * dpr, 8 * dpr, 8 * dpr);
      x.restore();
    }
    if (seg.t0 > 0 && gap >= 3 * dpr) {
      x.fillStyle = 'rgba(255,255,255,0.85)';
      x.fillRect(cx - 0.75 * dpr, top, 1.5 * dpr, bot - top);
      // a grip, so the line reads as something to drag
      if (gap >= 24 * dpr) {
        roundRect(x, cx - 2.5 * dpr, (top + bot) / 2 - 8 * dpr, 5 * dpr, 16 * dpr, 2.5 * dpr);
        x.fill();
      }
    }
  });

  const curveY = (v: number) => hh - 3 * dpr - v * (20 * dpr);
  const plot = (key: string, color: string | null, fill: string | null) => {
    x.beginPath();
    for (let px = 0; px <= w; px += 2 * dpr) {
      const v = ctx.sampler((px / w) * L)[key] || 0;
      if (px === 0) x.moveTo(px, curveY(v));
      else x.lineTo(px, curveY(v));
    }
    if (fill) {
      x.lineTo(w, hh);
      x.lineTo(0, hh);
      x.fillStyle = fill;
      x.fill();
    } else if (color) {
      x.strokeStyle = color;
      x.lineWidth = 1.2 * dpr;
      x.stroke();
    }
  };
  plot('energy', null, 'rgba(124,255,155,0.10)');
  plot('kick', MOD_SOURCES.kick?.color || '#FF5A5A', null);
  plot('hats', 'rgba(90,216,255,0.6)', null);
}

export function drawTimeline(s: StudioState, onRedraw?: () => void) {
  drawOverview(s);
  drawLane(s, onRedraw);
}
