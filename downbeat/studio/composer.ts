// compose(): (look, edit, audio, t) -> one engine frame. Used identically by preview and export.
import { CAMERA, FINISH_DEF, MODULES } from './modules.ts';
import { withLook } from './audio.ts';
import { cameraFor, clipTime, sampleTimeline, velocityAt } from './timeline.ts';
import type { ComposedFrame, ComposedLayer, ComposeContext, Look, Modulation, ModValues, ParamDef, TimelineSamplePart, VideoNeed } from './types.ts';

const isStepped = (p: ParamDef): boolean => !!(p.opts || p.step >= 1);

export function resolveParams(
  defs: ParamDef[],
  values?: Record<string, number>,
  mods?: Record<string, Modulation>,
  mv: ModValues = {},
  depth: number = 1,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of defs) {
    let v = values?.[p.id] ?? p.def;
    const m = mods?.[p.id];
    if (m && !isStepped(p) && mv[m.src] !== undefined) v += m.amt * depth * mv[m.src] * (p.max - p.min);
    out[`p_${p.id}`] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

// FX intensity: below 100% it fades every layer toward the dry image and calms the audio
// modulation; above 100% the layers stay fully wet and the modulation hits harder.
export function intensityOf(ctx: { intensity?: number }): { wet: number; depth: number } {
  const k = ctx.intensity ?? 1;
  return { wet: Math.min(1, k), depth: k };
}

export function layerStack(
  look: Look,
  mv: ModValues,
  { wet, depth }: { wet: number; depth: number },
  prefix: string = '',
): ComposedLayer[] {
  const out: ComposedLayer[] = [];
  look.layers.forEach((l, i) => {
    if (l.on === false || !MODULES[l.m]) return;
    out.push({ m: l.m, key: `${prefix}${i}:${l.m}`, src: l, params: { ...resolveParams(MODULES[l.m].params, l.p, l.mods, mv, depth), uWet: wet } });
  });
  return out;
}

// Optional ctx.clipLook(clipId) applies a per-clip stack before transitions.
// Thumbnails and variation tiles always render a single look.
export function compose(ctx: ComposeContext, t: number, look: Look = ctx.look): ComposedFrame {
  const { tl, sampler, clipDur, L, beatDur, seed } = ctx;
  const beat = t / beatDur;
  const base = sampler(t);
  const forLook = (l: Look): ModValues => withLook(base, l, t / L, beat, L / beatDur);
  const mv = forLook(look);
  const s = sampleTimeline(tl, t);
  const k = intensityOf(ctx);
  const cp = resolveParams(CAMERA.params, look.camera.p, look.camera.mods, mv, k.depth);
  const cam = { zoom: cp.p_zoom, drift: cp.p_drift, shake: cp.p_shake, sway: cp.p_sway };
  const need = (x: TimelineSamplePart, aux?: string): VideoNeed => {
    const rate = x.seg.speed * velocityAt(x.seg, x.local);
    const n: VideoNeed = {
      vkey: `${x.seg.clipId}#${x.key}`,
      clipId: x.seg.clipId,
      time: clipTime(x.seg, x.local, clipDur(x.seg.clipId)),
      rate: Math.min(16, rate),
      // reversed, ping-pong and near-frozen footage is previewed by seeking instead of playing
      rev: x.seg.rev || x.seg.pp || rate < 0.1,
      cam: cameraFor(x.seg, x.local, cam, t, L, beat, seed),
    };
    if (aux) n.aux = aux;
    return n;
  };
  const needs: VideoNeed[] = [need(s.a)];
  if (s.b) needs.push(need(s.b));

  const uniqueClips = ctx.clips ? ctx.clips.map((c) => c.id) : [...new Set(tl.segs.map((seg) => seg.clipId))];
  let broll: VideoNeed | undefined;
  if (uniqueClips.length <= 1) {
    const tBroll = (t + L * 0.5) % L;
    const sBroll = sampleTimeline(tl, tBroll);
    broll = need({ seg: sBroll.a.seg, local: sBroll.a.local, key: 'broll' }, 'clipB');
  } else {
    const nextSeg = tl.segs[(s.a.seg.i + 1) % tl.segs.length];
    const brollLocal = s.a.local % nextSeg.dur;
    broll = need({ seg: nextSeg, local: brollLocal, key: 'broll' }, 'clipB');
  }

  const perClip = look === ctx.look && ctx.clipLook;
  const hasBroll = (look.layers || []).some((l) => l.on !== false && l.m === 'broll') ||
    (perClip && (tl.segs || []).some((seg) => ctx.clipLook?.(seg.clipId)?.layers?.some((l) => l.on !== false && l.m === 'broll')));

  if (hasBroll && broll) needs.push(broll);

  // feedback histories are per clip; the same clip on both sides of a cut gets its own for side B
  const pre: ComposedLayer[][] | null = perClip
    ? needs.filter((n) => !n.aux).map((n, i) => {
        const clk = ctx.clipLook?.(n.clipId) || look;
        return layerStack(clk, forLook(clk), k, `c:${n.clipId}${i && n.clipId === needs[0].clipId ? 'b' : ''}:`);
      })
    : null;
  return {
    needs,
    broll,
    trans: s.b && s.trans ? { name: s.trans, p: s.p } : null,
    seg: s,
    layers: perClip ? [] : layerStack(look, mv, k),
    pre,
    finish: resolveParams(FINISH_DEF.params, look.finish.p, look.finish.mods, mv, k.depth),
    camera: cp,
    mv,
    globals: {
      uTime: t, uLoop: L, uPhase: t / L, uBeat: beat, uBeatLen: beatDur, uSeed: seed % 997, uFrame: Math.round(t * 30) % Math.max(1, Math.round(L * 30)),
      uKick: mv.kick, uSnare: mv.snare, uHats: mv.hats, uBass: mv.bass, uEnergy: mv.energy, uBright: mv.bright,
      uVocals: mv.vocals ?? 0, uPresence: mv.presence ?? 0,
    },
  };
}

// Pool of hidden <video> elements, one per (clip, timeline slot). Preview keeps them playing in
// sync with the transport; export seeks each one frame-exactly.
export class VideoBank {
  root: HTMLElement;
  urlFor: (clipId: string) => string;
  onDrop?: (k: string) => void;
  els: Map<string, HTMLVideoElement>;

  constructor(root: HTMLElement, urlFor: (clipId: string) => string, onDrop?: (k: string) => void) {
    this.root = root;
    this.urlFor = urlFor;
    this.onDrop = onDrop;
    this.els = new Map();
  }

  get(vkey: string, clipId?: string): HTMLVideoElement {
    let e = this.els.get(vkey);
    if (!e) {
      e = document.createElement('video');
      e.muted = true;
      e.playsInline = true;
      e.preload = 'auto';
      e.disableRemotePlayback = true;
      const url = this.urlFor(clipId ?? vkey.split('#')[0]);
      e.src = url;
      // A proxy that was still building (or failed once) answers with an error: retry a few times.
      (e as any)._retries = 0;
      e.addEventListener('error', () => {
        if ((e as any)._retries++ < 6) setTimeout(() => { if (e?.isConnected) e.src = `${url}?retry=${(e as any)._retries}`; }, 2000 * (e as any)._retries);
      });
      this.root.appendChild(e);
      this.els.set(vkey, e);
    }
    (e as any)._used = performance.now();
    return e;
  }

  sync(needs: VideoNeed[], playing: boolean): void {
    const active = new Set<HTMLVideoElement>();
    for (const n of needs) {
      const e = this.get(n.vkey, n.clipId);
      active.add(e);
      if (e.readyState < 1) continue;
      const drift = e.currentTime - n.time;
      if (!playing || n.rev) {
        if (!e.paused) e.pause();
        if (Math.abs(drift) > 0.017 && !e.seeking) e.currentTime = n.time;
      } else {
        if (e.playbackRate !== n.rate) e.playbackRate = n.rate;
        if (e.paused) {
          if (Math.abs(drift) > 0.05) e.currentTime = n.time;
          e.play().catch(() => {});
        } else if (Math.abs(drift) > 0.15 && !e.seeking) {
          e.currentTime = n.time + 0.04;
        }
      }
    }
    for (const e of this.els.values()) if (!active.has(e) && !e.paused) e.pause();
    this._gc(active);
  }

  // Park upcoming segments on their first frame so cuts land without a decode hitch.
  prime(needs: VideoNeed[]): void {
    for (const n of needs) {
      const e = this.get(n.vkey, n.clipId);
      if (e.paused && e.readyState >= 1 && !e.seeking && Math.abs(e.currentTime - n.time) > 0.05) e.currentTime = n.time;
    }
  }

  async exact(needs: VideoNeed[]): Promise<void> {
    const els = needs.map((n) => this.get(n.vkey, n.clipId));
    await Promise.all(needs.map((n, i) => seekExact(els[i], n.time)));
    this._gc(new Set(els)); // exports walk every cut, so prune here too
  }

  _gc(active: Set<HTMLVideoElement>): void {
    if (this.els.size <= 20) return;
    const old = [...this.els.entries()].filter(([, e]) => !active.has(e)).sort((a, b) => (a[1] as any)._used - (b[1] as any)._used);
    for (const [k, e] of old.slice(0, this.els.size - 20)) {
      e.pause();
      e.removeAttribute('src');
      e.load();
      e.remove();
      this.els.delete(k);
      this.onDrop?.(k);
    }
  }

  clear(): void {
    for (const [k, e] of this.els) { e.pause(); e.removeAttribute('src'); e.load(); e.remove(); this.onDrop?.(k); }
    this.els.clear();
  }
}

// Resolves on `ev`; rejects on media errors or timeout to avoid black frames.
function once(el: HTMLElement, ev: string, ms: number, what: string): Promise<void> {
  return new Promise((res, rej) => {
    const off = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); clearTimeout(to); };
    const ok = () => { off(); res(); };
    const bad = () => { off(); rej(new Error(`${what}: the clip could not be decoded`)); };
    const to = setTimeout(() => { off(); rej(new Error(`${what}: timed out`)); }, ms);
    el.addEventListener(ev, ok);
    el.addEventListener('error', bad);
  });
}

export async function waitReady(e: HTMLVideoElement, ms: number = 240000): Promise<void> {
  if (e.readyState >= 2) return;
  await once(e, 'loadeddata', ms, 'Loading clip');
}

async function seekExact(e: HTMLVideoElement, t: number): Promise<void> {
  await waitReady(e);
  if (!e.paused) e.pause();
  if (e.seeking) await once(e, 'seeked', 5000, 'Seeking clip');
  if (Math.abs(e.currentTime - t) >= 1e-4) {
    const p = once(e, 'seeked', 5000, 'Seeking clip');
    e.currentTime = t;
    await p;
  }
  if (e.readyState < 2 || Math.abs(e.currentTime - t) > 0.02) throw new Error(`Seeking clip: landed at ${e.currentTime.toFixed(3)}s instead of ${t.toFixed(3)}s`);
}
