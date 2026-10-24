import { useStudioStore } from './store.ts';
import { compose } from '../composer.ts';
import { clamp } from '../looks.ts';
import { fetchJSON, METERS } from './utils.ts';
import type { ClipMeta, TrackMeta } from '../types.ts';

let thumbCursorIdx = 0;
let renderLoopStarted = false;

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
  const ambientCtx = ambientCanvas?.getContext('2d', { willReadFrequently: true });

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

    const t = transportInstance.loopTime();
    const fr = compose(ctx, t);
    bankObj.sync(fr.needs, transportInstance.playing);

    if (transportInstance.playing) {
      const ahead = compose(ctx, (t + 0.35) % ctx.L).needs.filter((n) => !fr.needs.some((m) => m.vkey === n.vkey));
      if (ahead.length) bankObj.prime(ahead);
    }

    const sources = fr.needs.map((n) => ({
      ...engineObj.video(n.vkey, bankObj.get(n.vkey, n.clipId)),
      cam: n.cam,
    }));
    const waiting = fr.needs.some((n) => bankObj.get(n.vkey, n.clipId).readyState < 2);
    const stageBadge = document.getElementById('stageBadge');
    if (stageBadge) {
      stageBadge.style.display = waiting ? 'block' : 'none';
      if (waiting) stageBadge.textContent = 'Preparing clip…';
    }

    const key = `${Math.round(t * 30)}|${s.version}|${waiting ? frameNo : ''}|${engineObj.main?.w}`;
    if (key !== lastKey || !engineObj.present()) {
      engineObj.renderMain({ ...fr, sources });
      lastKey = key;
    }

    const jobs = s.varOpen ? s.varJobs : s.tab === 'looks' ? s.lookJobs.filter((j) => j.visible) : [];
    if (jobs.length) {
      const texBy = new Map(fr.needs.map((n, i) => [n.vkey, sources[i]]));
      const per = Math.min(jobs.length, s.varOpen ? 3 : 3);
      for (let k = 0; k < per; k++) {
        const job = jobs[(thumbCursorIdx + k) % jobs.length];
        const f = compose(ctx, t, job.look);
        const src = f.needs.map((n) => ({ ...(texBy.get(n.vkey) || sources[0]), cam: n.cam }));
        engineObj.renderThumb(job.id, { ...f, sources: src }, job.ctx2d);
      }
      thumbCursorIdx += per;
    }

    if (ambientCtx && frameNo % 5 === 0) {
      ambientCtx.drawImage(viewCanvas, 0, 0, 48, 85);
      if (frameNo % 30 === 0) {
        const d = ambientCtx.getImageData(0, 0, 48, 85).data;
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

    const timeEl = document.getElementById('time');
    if (timeEl) timeEl.innerHTML = `${t.toFixed(2)} <small>/ ${ctx.L.toFixed(2)}</small>`;

    const beat = Math.floor(t / ctx.beatDur + 1e-6);
    const bbtEl = document.getElementById('bbt');
    if (bbtEl) bbtEl.textContent = `${Math.floor(beat / 4) + 1}.${(beat % 4) + 1}`;

    const playheadEl = document.getElementById('playhead');
    const laneEl = document.getElementById('lane');
    if (playheadEl && laneEl) {
      playheadEl.style.transform = `translateX(${(t / ctx.L) * laneEl.clientWidth}px)`;
    }

    METERS.forEach((m, idx) => {
      const bar = document.querySelector(`#meters .meter:nth-child(${idx + 1}) .bar i`) as HTMLElement | null;
      if (bar && fr.mv) {
        bar.style.height = `${clamp(fr.mv[m] || 0, 0, 1) * 100}%`;
      }
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
      if (s.modUI.drawEnv) s.modUI.drawEnv(t / ctx.L);
      const grid = s.modUI.grid as HTMLElement | null;
      if (grid?.isConnected) {
        const st = Math.floor((((t / ctx.beatDur) / 4) % 1) * 16);
        Array.from(grid.children).forEach((b, idx) => b.classList.toggle('cur', idx === st));
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
    if (cur.clips.some((c) => c.proxy && c.proxy !== 'ready' && c.proxy !== 'error')) {
      const fresh = await fetchJSON<{ clips: ClipMeta[]; tracks: TrackMeta[] }>('/api/state').catch(() => null);
      if (fresh) useStudioStore.setState({ clips: fresh.clips, tracks: fresh.tracks });
    }
    pollProxies();
  }, 2500);
}
