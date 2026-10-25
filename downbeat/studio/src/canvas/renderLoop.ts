import { timecode } from '../lib/playback.ts';
import type { StudioStore, StudioState } from '../state/storeTypes.ts';
import { isMediaLoading } from '../state/mediaLoading.ts';
import { compose } from '../engine/composer.ts';
import { clamp } from '../engine/looks.ts';
import { fetchJSON, METERS } from '../lib/utils.ts';
import type { ClipMeta, ComposedFrame, ComposedSource } from '../engine/types.ts';
import type { Engine } from '../engine/engine.ts';

/** Preview state and scheduling belong to the studio that owns the canvas. */
export function createPreviewController(store: StudioStore, mirrors = new Set<HTMLCanvasElement>()) {
  const THUMBS_PER_FRAME = 3;
  type ModUI = NonNullable<StudioState['modUI']>;
  const modulatorUIs = new Set<ModUI>();
  const registerModUI = (ui: ModUI) => {
    modulatorUIs.add(ui);
    store.setState({ modUI: ui });
    return () => {
      modulatorUIs.delete(ui);
      store.setState({ modUI: [...modulatorUIs].at(-1) ?? null });
    };
  };

  let thumbCursorIdx = 0;
  let stopRenderLoop: (() => void) | undefined;
  let lastFrame: ComposedFrame | null = null;

  /** Canvases that show a live copy of the preview, such as the segment menu's when it has to sit over the stage. */

  /** The frame on screen, so the preview can tell which clip a drag or scroll should reframe. */
  const getLastFrame = (): ComposedFrame | null => lastFrame;

  // Per-frame readouts are written straight to the DOM, and only when they change, to keep React out of the loop.
  function setText(id: string, text: string) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function fitView(viewCanvas: HTMLCanvasElement, engineObj: Engine, force = false) {
    const r = viewCanvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
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

  function startRenderLoop(viewCanvas: HTMLCanvasElement, ambientCanvas?: HTMLCanvasElement) {
    if (stopRenderLoop) return stopRenderLoop;
    let active = true;
    let frameId = 0;

    let frameNo = 0;
    let fpsAcc = 0;
    let fpsN = 0;
    let lastNow = performance.now();
    let lastKey = '';
    const lastSteps = new WeakMap<ModUI, number>();
    let meterEls: (HTMLElement | null)[] = [];
    // The visible glow copies the preview GPU-to-GPU; only a 48×85 sample is read back for the phone's tint.
    const ambientCtx = ambientCanvas?.getContext('2d');
    const sample = document.createElement('canvas');
    sample.width = 48;
    sample.height = 85;
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true });

    const tick = (now: number) => {
      if (!active) return;
      frameId = requestAnimationFrame(tick);
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

      const s = store.getState();
      const engineObj = s.engine;
      const bankObj = s.bank;
      const transportInstance = s.transport;
      if (!engineObj || !bankObj || s.exporting) return;
      if (isMediaLoading(s)) {
        transportInstance.pause();
        bankObj.sync([], false);
        return;
      }
      if (engineObj.gl?.isContextLost?.()) {
        if (!s.glError) store.setState({ glError: 'The graphics context was lost. Reload the studio to restart the preview' });
        return;
      }

      fitView(viewCanvas, engineObj);

      const ctx = s.ctx;
      if (!ctx) return;

      // Layout reads before this frame's DOM writes, so the browser doesn't lay out twice.
      const laneEl = document.getElementById('lane');
      const laneW = laneEl?.clientWidth || 0;

      const t = transportInstance.loopTime();
      const fr = compose(ctx, t);
      lastFrame = fr;
      // A cut shown by seeking (reversed, ping-pong, slowed to a stop, or paused) takes the frame its last
      // seek landed on before sync starts the next one. Left to the draw below, the frame is lost: sync
      // starts a new seek as soon as one lands, so the video is mid-seek whenever the draw looks at it.
      for (const n of fr.needs) if (n.rev || !transportInstance.playing) engineObj.video(n.vkey, bankObj.get(n.vkey, n.clipId));
      bankObj.sync(fr.needs, transportInstance.playing);

      if (transportInstance.playing) {
        const ahead = compose(ctx, (t + 0.35) % ctx.L).needs.filter((n) => !fr.needs.some((m) => m.vkey === n.vkey));
        if (ahead.length) bankObj.prime(ahead);
      }

      // Uploading video frames is the expensive part, so it only happens on frames that draw something.
      let sources: ComposedSource[] | null = null;
      const getSources = () =>
        (sources ??= fr.needs.map((n) => ({
          ...engineObj.video(n.vkey, bankObj.get(n.vkey, n.clipId)),
          cam: n.cam,
        })));
      const waiting = fr.needs.some((n) => bankObj.get(n.vkey, n.clipId).readyState < 2);
      // Only a video that hasn't drawn a frame yet is waiting for its clip: one between seeks still shows its last frame.
      const loading = waiting && fr.needs.some((n) => {
        const e = bankObj.get(n.vkey, n.clipId);
        return e.readyState < 2 && engineObj.videoTex.get(n.vkey)?.el !== e;
      });
      const stageBadge = document.getElementById('stageBadge');
      if (stageBadge) {
        stageBadge.style.display = loading ? 'block' : 'none';
        if (loading) stageBadge.textContent = 'Preparing clip…';
      }

      // A paused decoder can finish seeking without changing the timecode or look version.
      const seeking = !transportInstance.playing && fr.needs.some((n) => bankObj.get(n.vkey, n.clipId).seeking);
      const key = `${Math.round(t * 30)}|${s.version}|${waiting ? frameNo : ''}|${seeking ? 1 : 0}|${engineObj.main?.w}`;
      if (key !== lastKey || !engineObj.present()) {
        engineObj.renderMain({ ...fr, sources: getSources() });
        lastKey = key;
      }

      const jobs = s.varOpen ? s.varJobs : s.tab === 'looks' ? s.lookJobs.filter((j) => j.visible) : [];
      if (jobs.length) {
        const srcs = getSources();
        const texBy = new Map(fr.needs.map((n, i) => [n.vkey, srcs[i]]));
        const per = Math.min(jobs.length, THUMBS_PER_FRAME);
        // While paused, the thumbnails keep moving on a clock of their own over the paused footage.
        const tt = transportInstance.playing ? t : (now / 1000) % ctx.L;
        for (let k = 0; k < per; k++) {
          const job = jobs[(thumbCursorIdx + k) % jobs.length];
          const f = compose(ctx, tt, job.look);
          const src = f.needs.map((n) => ({ ...(texBy.get(n.vkey) || srcs[0]), cam: n.cam }));
          if (job.ctx2d) engineObj.renderThumb(job.id, { ...f, sources: src }, job.ctx2d, false);
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
      setText('viewerTimecode', timecode(t));
      setText('viewerDuration', timecode(ctx.L));

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

      const modUIs = modulatorUIs.size ? modulatorUIs : s.modUI && s.tab === 'layers' ? [s.modUI] : [];
      for (const ui of modUIs) {
        const grid = ui.grid as HTMLElement | null;
        if (modulatorUIs.size && (!grid?.isConnected || grid.offsetParent === null)) continue;
        if (ui.drawEnv && frameNo % 2 === 0) ui.drawEnv(t / ctx.L);
        const step = Math.floor((((t / ctx.beatDur) / 4) % 1) * 16);
        const lastStep = lastSteps.get(ui) ?? -1;
        if (grid?.isConnected && step !== lastStep) {
          grid.children[lastStep]?.classList.remove('cur');
          grid.children[step]?.classList.add('cur');
          lastSteps.set(ui, step);
        }
      }

      if (frameNo % 2 === 0 && s.features && transportInstance.mode === 'listen') {
        s.drawOverview();
      }
    };

    frameId = requestAnimationFrame(tick);
    const stop = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frameId);
      lastFrame = null;
      stopRenderLoop = undefined;
    };
    stopRenderLoop = stop;
    return stop;
  }

  function pollProxies() {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active) return;
      const cur = store.getState();
      if (cur.clips.some((c) => c.proxy === 'queued' || c.proxy === 'building')) {
        const fresh = await fetchJSON<{ clips: ClipMeta[] }>('/api/state?only=clips').catch(() => null);
        if (active && fresh) store.setState({ clips: fresh.clips });
      }
      if (active) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => { active = false; clearTimeout(timer); };
  }

  return { mirrors, getLastFrame, fitView, startRenderLoop, pollProxies, registerModUI };
}
