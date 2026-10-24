import { useStudioStore } from '../state/store.ts';
import { compose } from '../engine/composer.ts';
import { clamp } from '../engine/looks.ts';
import { fetchJSON, METERS } from '../lib/utils.ts';
import type { ClipMeta, ComposedFrame } from '../engine/types.ts';

const THUMBS_PER_FRAME = 3;

let thumbCursorIdx = 0;
let renderLoopStarted = false;
let lastFrame: ComposedFrame | null = null;

/** Canvases that show a live copy of the preview, such as the segment menu's when it has to sit over the stage. */
export const mirrors = new Set<HTMLCanvasElement>();

/** The frame on screen, so the preview can tell which clip a drag or scroll should reframe. */
export const getLastFrame = (): ComposedFrame | null => lastFrame;

// Per-frame readouts are written straight to the DOM, and only when they change, to keep React out of the loop.
function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

export function fitView(viewCanvas: HTMLCanvasElement, engineObj: any, force = false) {
  const r = viewCanvas.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = Math.round(r.width * dpr);
  let hh = Math.round(r.height * dpr);
  if (w > 1080) {
    hh = Math.round((hh * 1080) / w);
    w = 1080;
  }
  if (hh < 400) {
    w = Math.round((w * 400) / hh);
    hh = 400;
  }
  if (force || viewCanvas.width !== w || viewCanvas.height !== hh) {
    engineObj.resize(w, hh);
  }
}

export function startRenderLoop(viewCanvas: HTMLCanvasElement, ambientCanvas?: HTMLCanvasElement) {
  if (renderLoopStarted) return;
  renderLoopStarted = true;

  let frameNo = 0;
  let fpsAcc = 0;
  let fpsN = 0;
  let lastNow = performance.now();
  let lastKey = '';
  let lastStep = -1;
  let meterEls: (HTMLElement | null)[] = [];
  // The visible glow copies the preview GPU-to-GPU; only a 48×85 sample is read back for the phone's tint.
  const ambientCtx = ambientCanvas?.getContext('2d');
  const sample = document.createElement('canvas');
  sample.width = 48;
  sample.height = 85;
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true });

  const tick = (now: number) => {
    requestAnimationFrame(tick);
    frameNo++;
    const dt = now - lastNow;
    lastNow = now;
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc > 500) {
      const fpsVal = `${Math.round((1000 * fpsN) / fpsAcc)} fps`;
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = fpsVal;
      fpsAcc = 0;
      fpsN = 0;
    }

    const s = useStudioStore.getState();
    const engineObj = s.engine;
    const bankObj = s.bank;
    const transportInstance = s.transport;
    if (!engineObj || !bankObj || s.exporting) return;

    fitView(viewCanvas, engineObj);

    const ctx = s.ctx;
    if (!ctx) return;

    // Layout reads before this frame's DOM writes, so the browser doesn't lay out twice.
    const laneEl = document.getElementById('lane');
    const laneW = laneEl?.clientWidth || 0;

    const t = transportInstance.loopTime();
    const fr = compose(ctx, t);
    lastFrame = fr;
    bankObj.sync(fr.needs, transportInstance.playing);

    if (transportInstance.playing) {
      const ahead = compose(ctx, (t + 0.35) % ctx.L).needs.filter((n) => !fr.needs.some((m) => m.vkey === n.vkey));
      if (ahead.length) bankObj.prime(ahead);
    }

    // Uploading video frames is the expensive part, so it only happens on frames that draw something.
    let sources: any[] | null = null;
    const getSources = () =>
      (sources ??= fr.needs.map((n) => ({
        ...engineObj.video(n.vkey, bankObj.get(n.vkey, n.clipId)),
        cam: n.cam,
      })));
    const waiting = fr.needs.some((n) => bankObj.get(n.vkey, n.clipId).readyState < 2);
    const stageBadge = document.getElementById('stageBadge');
    if (stageBadge) {
      stageBadge.style.display = waiting ? 'block' : 'none';
      if (waiting) stageBadge.textContent = 'Preparing clip…';
    }

    const key = `${Math.round(t * 30)}|${s.version}|${waiting ? frameNo : ''}|${engineObj.main?.w}`;
    if (key !== lastKey || !engineObj.present()) {
      engineObj.renderMain({ ...fr, sources: getSources() });
      lastKey = key;
    }

    const jobs = s.varOpen ? s.varJobs : s.tab === 'looks' ? s.lookJobs.filter((j) => j.visible) : [];
    if (jobs.length) {
      const srcs = getSources();
      const texBy = new Map(fr.needs.map((n, i) => [n.vkey, srcs[i]]));
      const per = Math.min(jobs.length, THUMBS_PER_FRAME);
      for (let k = 0; k < per; k++) {
        const job = jobs[(thumbCursorIdx + k) % jobs.length];
        const f = compose(ctx, t, job.look);
        const src = f.needs.map((n) => ({ ...(texBy.get(n.vkey) || srcs[0]), cam: n.cam }));
        engineObj.renderThumb(job.id, { ...f, sources: src }, job.ctx2d, false);
      }
      engineObj.present();
      thumbCursorIdx += per;
    }

    // copied in the frame it was drawn, while the preview canvas still holds it
    for (const m of mirrors) if (m.isConnected && m.offsetParent) m.getContext('2d')?.drawImage(viewCanvas, 0, 0, m.width, m.height);

    if (ambientCtx && frameNo % 5 === 0) {
      ambientCtx.drawImage(viewCanvas, 0, 0, 48, 85);
      if (sampleCtx && frameNo % 30 === 0) {
        sampleCtx.drawImage(ambientCtx.canvas, 0, 0);
        const d = sampleCtx.getImageData(0, 0, 48, 85).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 16) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 16;
        const phoneEl = document.getElementById('phone');
        if (phoneEl) {
          phoneEl.style.setProperty('--glow', `rgba(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0},0.55)`);
        }
      }
    }

    setText('timeNow', t.toFixed(2));
    setText('timeLen', ctx.L.toFixed(2));

    const beat = Math.floor(t / ctx.beatDur + 1e-6);
    setText('bbt', `${Math.floor(beat / 4) + 1}.${(beat % 4) + 1}`);

    const playheadEl = document.getElementById('playhead');
    if (playheadEl && laneEl) {
      playheadEl.style.transform = `translateX(${(t / ctx.L) * laneW}px)`;
    }

    if (!meterEls[0]?.isConnected) {
      meterEls = METERS.map((_, idx) => document.querySelector<HTMLElement>(`#meters .meter:nth-child(${idx + 1}) .bar i`));
    }
    METERS.forEach((m, idx) => {
      const bar = meterEls[idx];
      if (bar && fr.mv) bar.style.height = `${clamp(fr.mv[m] || 0, 0, 1) * 100}%`;
    });

    const hudProgEl = document.getElementById('hudProg');
    if (hudProgEl) {
      const dur = s.features?.duration || ctx.L;
      hudProgEl.style.width = `${clamp((transportInstance.songTime() / dur) * 100, 0, 100)}%`;
    }

    if (frameNo % 120 === 0) s.ghosts.splice(0, s.ghosts.length, ...s.ghosts.filter((g) => g.el?.isConnected));
    for (const gh of s.ghosts) {
      if (!gh.el?.isConnected) continue;
      const v = gh.read(fr);
      if (v !== undefined) {
        gh.el.style.left = `${((v - gh.def.min) / (gh.def.max - gh.def.min)) * 100}%`;
      }
    }

    if (s.modUI && s.tab === 'layers') {
      if (s.modUI.drawEnv && frameNo % 2 === 0) s.modUI.drawEnv(t / ctx.L);
      const grid = s.modUI.grid as HTMLElement | null;
      const step = Math.floor((((t / ctx.beatDur) / 4) % 1) * 16);
      if (grid?.isConnected && step !== lastStep) {
        grid.children[lastStep]?.classList.remove('cur');
        grid.children[step]?.classList.add('cur');
        lastStep = step;
      }
    }

    if (frameNo % 2 === 0 && s.features && transportInstance.mode === 'listen') {
      s.drawOverview();
    }
  };

  requestAnimationFrame(tick);
}

export function pollProxies() {
  setTimeout(async () => {
    const cur = useStudioStore.getState();
    if (cur.clips.some((c) => c.proxy === 'queued' || c.proxy === 'building')) {
      const fresh = await fetchJSON<{ clips: ClipMeta[] }>('/api/state?only=clips').catch(() => null);
      if (fresh) useStudioStore.setState({ clips: fresh.clips });
    }
    pollProxies();
  }, 2500);
}
