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
// modulation; above 100% the layers stay fully wet, their strength settings go up by the same
// factor and the modulation hits harder.
export function intensityOf(ctx: { intensity?: number }): { wet: number; depth: number; boost: number } {
  const k = ctx.intensity ?? 1;
  return { wet: Math.min(1, k), depth: k, boost: Math.max(1, k) };
}

// The settings intensity turns up past 100%: these in every effect that has them, plus the ones listed
// for effects whose strength goes by another name. Shape settings such as size or slices stay put.
const STRENGTH = ['amount', 'intensity', 'strength', 'glow', 'rim', 'shine', 'mist'];
const STRENGTH_ALSO: Record<string, string[]> = {
  lens: ['bulge', 'disperse'],
  ribbons: ['shift'],
  broll: ['mix'],
  vortex: ['twist'],
  tiltshift: ['blur'],
  shutter: ['depth'],
  pixelsort: ['length'],
  crt: ['scan', 'mask'],
  chrome: ['mix'],
  glitch: ['split'],
  visualizer: ['mix'],
  hue: ['sat'],
  posterize: ['sat'],
};

/** A layer's settings with its strength settings multiplied by `k` (held to their ranges by resolveParams). */
export function boosted(m: string, values: Record<string, number> | undefined, k: number): Record<string, number> | undefined {
  if (k <= 1 || !MODULES[m]) return values;
  const out = { ...values };
  for (const p of MODULES[m].params) {
    if (isStepped(p) || !(STRENGTH.includes(p.id) || STRENGTH_ALSO[m]?.includes(p.id))) continue;
    out[p.id] = (values?.[p.id] ?? p.def) * k;
  }
  return out;
}

export function layerStack(
  look: Look,
  mv: ModValues,
  { wet, depth, boost = 1 }: { wet: number; depth: number; boost?: number },
  prefix: string = '',
): ComposedLayer[] {
  const out: ComposedLayer[] = [];
  look.layers.forEach((l, i) => {
    if (l.on === false || !MODULES[l.m]) return;
    const params = resolveParams(MODULES[l.m].params, boosted(l.m, l.p, boost), l.mods, mv, depth);
    out.push({ m: l.m, key: `${prefix}${i}:${l.m}`, src: l, params: { ...params, uWet: wet } });
  });
  return out;
}

// Optional ctx.clipLook(clipId, seg) applies a per-clip (or per-cut) stack before transitions.
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
  const need = (x: TimelineSamplePart, back: boolean | undefined, aux?: string): VideoNeed => {
    const rate = x.seg.speed * velocityAt(x.seg, x.local);
    const n: VideoNeed = {
      vkey: `${x.seg.clipId}#${x.key}`,
      clipId: x.seg.clipId,
      time: clipTime(x.seg, x.local, clipDur(x.seg.clipId)),
      rate: Math.min(16, rate),
      // reversed, ping-pong, near-frozen and rebounding footage is previewed by seeking instead of playing
      rev: x.seg.rev || x.seg.pp || rate < 0.1 || !!back,
      cam: cameraFor(x.seg, x.local, cam, t, L, beat, seed),
    };
    if (aux) n.aux = aux;
    return n;
  };
  const needs: VideoNeed[] = [need(s.a, s.back)];
  if (s.b) needs.push(need(s.b, s.back));

  const uniqueClips = ctx.clips ? ctx.clips.map((c) => c.id) : [...new Set(tl.segs.map((seg) => seg.clipId))];
  let broll: VideoNeed | undefined;
  if (uniqueClips.length <= 1) {
    const tBroll = (t + L * 0.5) % L;
    const sBroll = sampleTimeline(tl, tBroll);
    broll = need({ seg: sBroll.a.seg, local: sBroll.a.local, key: 'broll' }, sBroll.back, 'clipB');
  } else {
    const nextSeg = tl.segs[(s.a.seg.i + 1) % tl.segs.length];
    const brollLocal = s.a.local % nextSeg.dur;
    broll = need({ seg: nextSeg, local: brollLocal, key: 'broll' }, s.back, 'clipB');
  }

  const perClip = look === ctx.look && ctx.clipLook;
  const hasBroll = (look.layers || []).some((l) => l.on !== false && l.m === 'broll') ||
    (perClip && (tl.segs || []).some((seg) => ctx.clipLook?.(seg.clipId, seg)?.layers?.some((l) => l.on !== false && l.m === 'broll')));

  if (hasBroll && broll) needs.push(broll);

  // feedback histories are per clip; the same clip on both sides of a cut gets its own for side B
  const parts = s.b ? [s.a, s.b] : [s.a];
  const pre: ComposedLayer[][] | null = perClip
    ? needs.filter((n) => !n.aux).map((n, i) => {
        const clk = ctx.clipLook?.(n.clipId, parts[i]?.seg) || look;
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

// Pool of hidden <video> elements, one per (clip, timeline slot), that the preview keeps playing in
// sync with the transport. Exports don't use them: see clipFrames.ts.
/** How many <video> elements the preview keeps. */
const BANK_SIZE = 20;

export class VideoBank {
  root: HTMLElement;
  /** The clip's playback copy, or null while it's still being made. */
  urlFor: (clipId: string) => string | null;
  onDrop?: (k: string) => void;
  els: Map<string, HTMLVideoElement>;

  constructor(root: HTMLElement, urlFor: (clipId: string) => string | null, onDrop?: (k: string) => void) {
    this.root = root;
    this.urlFor = urlFor;
    this.onDrop = onDrop;
    this.els = new Map();
  }

  get(vkey: string, clipId?: string): HTMLVideoElement {
    let e = this.els.get(vkey);
    // With more cuts than the bank holds, a new element per cut would be made and thrown away every time
    // round the loop, each one loading its file again. A full bank hands the cut an element of the same
    // clip that nothing has asked for in the last second instead, which only has to seek.
    if (!e && this.els.size >= BANK_SIZE) {
      const url = this.urlFor(clipId ?? vkey.split('#')[0]);
      const now = performance.now();
      let idle: [string, HTMLVideoElement] | undefined;
      for (const kv of this.els) {
        const x = kv[1] as any;
        if (url && x._url === url && now - x._used > 1000 && (!idle || x._used < (idle[1] as any)._used)) idle = kv;
      }
      if (idle) {
        this.els.delete(idle[0]);
        this.onDrop?.(idle[0]);
        e = idle[1];
        this.els.set(vkey, e);
      }
    }
    if (!e) {
      e = document.createElement('video');
      e.muted = true;
      e.playsInline = true;
      e.preload = 'auto';
      e.disableRemotePlayback = true;
      // A proxy that was still building (or failed once) answers with an error: retry a few times.
      (e as any)._retries = 0;
      e.addEventListener('error', () => {
        const url = (e as any)._url;
        if ((e as any)._retries++ < 6) setTimeout(() => { if (e?.isConnected) e.src = `${url}?retry=${(e as any)._retries}`; }, 2000 * (e as any)._retries);
      });
      this.root.appendChild(e);
      this.els.set(vkey, e);
    }
    // No source until the playback copy is ready: a request for one still being made would hold one of the
    // browser's few connections to the server for minutes, and the song and the other clips wait behind it.
    if (!(e as any)._url) {
      const url = this.urlFor(clipId ?? vkey.split('#')[0]);
      if (url) e.src = (e as any)._url = url;
    }
    (e as any)._used = performance.now();
    return e;
  }

  sync(needs: VideoNeed[], playing: boolean): void {
    const active = new Set<HTMLVideoElement>();
    for (const n of needs) {
      const e = this.get(n.vkey, n.clipId);
      active.add(e);
      (e as any)._parked = undefined;
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

  // Park upcoming segments on their first frame so cuts land without a decode hitch. A cut is first asked
  // for when its start comes into view, so it's parked then and left there: moved on to the frames after
  // its start as they come into view, it would be past its first frame when it starts, and seek back.
  prime(needs: VideoNeed[]): void {
    for (const n of needs) {
      const e = this.get(n.vkey, n.clipId) as any;
      if (!e.paused || e.readyState < 1 || e.seeking || e._parked === n.vkey) continue;
      if (Math.abs(e.currentTime - n.time) > 0.05) e.currentTime = n.time;
      e._parked = n.vkey;
    }
  }

  _gc(active: Set<HTMLVideoElement>): void {
    if (this.els.size <= BANK_SIZE) return;
    const old = [...this.els.entries()].filter(([, e]) => !active.has(e)).sort((a, b) => (a[1] as any)._used - (b[1] as any)._used);
    for (const [k, e] of old.slice(0, this.els.size - BANK_SIZE)) {
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
