// compose(): (look, edit, audio, t) -> one engine frame. Used identically by preview and export.
import { CAMERA, FINISH_DEF, MODULES } from './modules.ts';
import { modulationAt, withLook } from './audio.ts';
import { cameraFor, clipTime, sampleTimeline, velocityAt } from './timeline.ts';
import type { BlockOverrides, ComposedFrame, ComposedLayer, ComposeContext, Look, Modulation, ModValues, ParamDef, TimelineSamplePart, VideoNeed } from './types.ts';

const isStepped = (p: ParamDef): boolean => !!(p.opts || p.step >= 1);

export function resolveParams(
  defs: ParamDef[],
  values?: Record<string, number>,
  mods?: Record<string, Modulation>,
  mv: ModValues = {},
  depth: number = 1,
  readMod?: (route: Modulation) => number | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of defs) {
    let v = values?.[p.id] ?? p.def;
    const m = mods?.[p.id];
    const source = m ? (readMod ? readMod(m) : mv[m.src]) : undefined;
    if (m && !isStepped(p) && source !== undefined) v += m.amt * depth * source * (p.max - p.min);
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
  readMod?: (route: Modulation) => number | undefined,
): ComposedLayer[] {
  const out: ComposedLayer[] = [];
  look.layers.forEach((l, i) => {
    if (l.on === false || !MODULES[l.m]) return;
    const params = resolveParams(MODULES[l.m].params, boosted(l.m, l.p, boost), l.mods, mv, depth, readMod);
    out.push({ m: l.m, key: `${prefix}${i}:${l.m}`, src: l, params: { ...params, uWet: wet } });
  });
  return out;
}

/** Applies the sparse visual settings owned by one block. Layer overrides carry the module id as
 * well as the index, so a saved block remains safe when another look has a different layer there. */
export function lookWithOverrides(look: Look, overrides?: BlockOverrides): Look {
  if (!overrides) return look;
  const layers = overrides.layers
    ? look.layers.map((layer, i) => {
        const own = overrides.layers?.[String(i)];
        return own?.m === layer.m ? { ...layer, p: { ...layer.p, ...own.p } } : layer;
      })
    : look.layers;
  return {
    ...look,
    layers,
    macro: overrides.macro ? { a: look.macro?.a ?? 0, b: look.macro?.b ?? 0, ...overrides.macro } : look.macro,
    camera: overrides.camera ? { ...look.camera, p: { ...look.camera.p, ...overrides.camera } } : look.camera,
    finish: overrides.finish ? { ...look.finish, p: { ...look.finish.p, ...overrides.finish } } : look.finish,
  };
}

const mixParams = (a: Record<string, number>, b: Record<string, number>, p: number): Record<string, number> =>
  Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + ((b[key] ?? a[key]) - a[key]) * p]));

// Optional ctx.clipLook(clipId, seg) applies a per-clip (or per-cut) stack before transitions.
// Thumbnails and variation tiles always render a single look.
export function compose(ctx: ComposeContext, t: number, look: Look = ctx.look): ComposedFrame {
  const { tl, sampler, clipDur, L, beatDur, seed } = ctx;
  const beat = t / beatDur;
  const base = sampler(t);
  const s = sampleTimeline(tl, t);
  const parts = s.b ? [s.a, s.b] : [s.a];
  const useBlockOverrides = look === ctx.look;
  const effective = (l: Look, part: TimelineSamplePart): Look => lookWithOverrides(l, useBlockOverrides ? part.seg.overrides : undefined);
  const k = intensityOf(ctx);
  // A frame often uses the same look for both clips, B-roll, camera and finish. Resolve its sources
  // and parameters once in this frame; a fresh cache on the next frame sees in-place inspector edits.
  const resolved = new Map<Look, {
    values: ModValues;
    readMod: (route: Modulation) => number | undefined;
    camera?: Record<string, number>;
    finish?: Record<string, number>;
  }>();
  const forLook = (l: Look) => {
    let result = resolved.get(l);
    if (!result) {
      const values = withLook(base, l, t / L, beat, L / beatDur);
      result = {
        values,
        readMod: (route: Modulation) => values[route.src] === undefined ? undefined : modulationAt(route, sampler, l, t, L, beatDur, values),
      };
      resolved.set(l, result);
    }
    return result;
  };
  const cameraParams = (l: Look) => {
    const data = forLook(l);
    return data.camera ??= resolveParams(CAMERA.params, l.camera.p, l.camera.mods, data.values, k.depth, data.readMod);
  };
  // The incoming block owns the cut from its midpoint onward. Finish settings are blended through the
  // transition below; this dominant look supplies inspector values and post-cut global uniforms.
  const active = s.b && s.p >= 0.5 ? s.b : s.a;
  const activeLook = effective(look, active);
  const mv = forLook(activeLook).values;
  const need = (x: TimelineSamplePart, back: boolean | undefined, aux?: string): VideoNeed => {
    const cameraLook = effective(look, x);
    const cp = cameraParams(cameraLook);
    const cam = { zoom: cp.p_zoom, drift: cp.p_drift, shake: cp.p_shake, sway: cp.p_sway };
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

  const multipleClips = ctx.clips ? ctx.clips.length > 1 : tl.segs.some((seg) => seg.clipId !== tl.segs[0].clipId);
  let broll: VideoNeed | undefined;
  if (!multipleClips) {
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
    (perClip && parts.some(({ seg }) => ctx.clipLook?.(seg.clipId, seg)?.layers?.some((l) => l.on !== false && l.m === 'broll')));

  if (hasBroll && broll) needs.push(broll);

  // Block layer and macro settings, like per-clip looks, run on each side before the transition. Feedback
  // histories are per clip; the same clip on both sides of a cut gets its own for side B.
  const perBlock = useBlockOverrides && parts.some((part) => !!(part.seg.overrides?.layers || part.seg.overrides?.macro));
  const beforeTransition = !!perClip || perBlock;
  const pre: ComposedLayer[][] | null = beforeTransition
    ? needs.filter((n) => !n.aux).map((n, i) => {
        const part = parts[i] || s.a;
        const baseLook = (perClip && ctx.clipLook?.(n.clipId, part.seg)) || look;
        const blockLook = effective(baseLook, part);
        const { values, readMod } = forLook(blockLook);
        return layerStack(blockLook, values, k, `c:${n.clipId}${i && n.clipId === needs[0].clipId ? 'b' : ''}:`, readMod);
      })
    : null;
  const finishFor = (part: TimelineSamplePart): Record<string, number> => {
    const l = effective(look, part);
    const data = forLook(l);
    return data.finish ??= resolveParams(FINISH_DEF.params, l.finish.p, l.finish.mods, data.values, k.depth, data.readMod);
  };
  const finishA = finishFor(s.a);
  const finish = s.b ? mixParams(finishA, finishFor(s.b), s.p) : finishA;
  const cp = cameraParams(activeLook);
  return {
    needs,
    broll,
    trans: s.b && s.trans ? { name: s.trans, p: s.p } : null,
    seg: s,
    layers: beforeTransition ? [] : layerStack(activeLook, mv, k, '', forLook(activeLook).readMod),
    pre,
    finish,
    camera: cp,
    mv,
    globals: {
      uTime: t, uLoop: L, uPhase: t / L, uBeat: beat, uBeatLen: beatDur, uSeed: seed % 997, uFrame: Math.round(t * 30) % Math.max(1, Math.round(L * 30)),
      uKick: mv.kick, uSnare: mv.snare, uHats: mv.hats, uBass: mv.bass, uEnergy: mv.energy, uBright: mv.bright,
      uVocals: mv.vocals ?? 0, uPresence: mv.presence ?? 0,
      uAudioTime: base.audioTime ?? t, uBassTime: base.bassTime ?? t,
      uAudioPhase: base.audioPhase ?? (((t / L) % 1) + 1) % 1,
      uBassPhase: base.bassPhase ?? (((t / L) % 1) + 1) % 1,
    },
    lut: look.finish.lut,
  };
}

// Pool of hidden <video> elements, one per (clip, timeline slot), that the preview keeps playing in
// sync with the transport. Exports don't use them: see clipFrames.ts.
/** How many <video> elements the preview keeps. */
const BANK_SIZE = 20;

interface BankVideo extends HTMLVideoElement {
  _url?: string;
  _used: number;
  _retries: number;
  _parked?: string;
  _retryTimer?: ReturnType<typeof setTimeout>;
  _onError?: () => void;
}

export class VideoBank {
  root: HTMLElement;
  /** The clip's playback copy, or null while it's still being made. */
  urlFor: (clipId: string) => string | null;
  onDrop?: (k: string) => void;
  els: Map<string, BankVideo>;

  constructor(root: HTMLElement, urlFor: (clipId: string) => string | null, onDrop?: (k: string) => void) {
    this.root = root;
    this.urlFor = urlFor;
    this.onDrop = onDrop;
    this.els = new Map();
  }

  get(vkey: string, clipId?: string): BankVideo {
    let e = this.els.get(vkey);
    // With more cuts than the bank holds, a new element per cut would be made and thrown away every time
    // round the loop, each one loading its file again. A full bank hands the cut an element of the same
    // clip that nothing has asked for in the last second instead, which only has to seek.
    if (!e && this.els.size >= BANK_SIZE) {
      const url = this.urlFor(clipId ?? vkey.split('#')[0]);
      const now = performance.now();
      let idle: [string, BankVideo] | undefined;
      for (const kv of this.els) {
        const x = kv[1];
        if (url && x._url === url && now - x._used > 1000 && (!idle || x._used < idle[1]._used)) idle = kv;
      }
      if (idle) {
        this.els.delete(idle[0]);
        this.onDrop?.(idle[0]);
        e = idle[1];
        this.els.set(vkey, e);
      }
    }
    if (!e) {
      const video: BankVideo = Object.assign(document.createElement('video'), { _retries: 0, _used: performance.now() });
      e = video;
      e.muted = true;
      e.playsInline = true;
      e.preload = 'auto';
      e.disableRemotePlayback = true;
      // A proxy that was still building (or failed once) answers with an error: retry a few times.
      video._onError = () => {
        if (!video._url || video._retryTimer !== undefined || video._retries >= 6) return;
        const url = video._url;
        const attempt = ++video._retries;
        video._retryTimer = setTimeout(() => {
          video._retryTimer = undefined;
          if (video.isConnected && video._url === url) video.src = `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;
        }, 2000 * attempt);
      };
      video.addEventListener('error', video._onError);
      this.root.appendChild(e);
      this.els.set(vkey, e);
    }
    // No source until the playback copy is ready: a request for one still being made would hold one of the
    // browser's few connections to the server for minutes, and the song and the other clips wait behind it.
    if (!e._url) {
      const url = this.urlFor(clipId ?? vkey.split('#')[0]);
      if (url) e.src = e._url = url;
    }
    e._used = performance.now();
    return e;
  }

  sync(needs: VideoNeed[], playing: boolean): void {
    const active = new Set<HTMLVideoElement>();
    for (const n of needs) {
      const e = this.get(n.vkey, n.clipId);
      active.add(e);
      e._parked = undefined;
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
      const e = this.get(n.vkey, n.clipId);
      if (!e.paused || e.readyState < 1 || e.seeking || e._parked === n.vkey) continue;
      if (Math.abs(e.currentTime - n.time) > 0.05) e.currentTime = n.time;
      e._parked = n.vkey;
    }
  }

  _gc(active: Set<HTMLVideoElement>): void {
    if (this.els.size <= BANK_SIZE) return;
    const old = [...this.els.entries()].filter(([, e]) => !active.has(e)).sort((a, b) => a[1]._used - b[1]._used);
    for (const [k, e] of old.slice(0, this.els.size - BANK_SIZE)) {
      this.release(e);
      this.els.delete(k);
      this.onDrop?.(k);
    }
  }

  clear(): void {
    for (const [k, e] of this.els) { this.release(e); this.onDrop?.(k); }
    this.els.clear();
  }

  private release(video: BankVideo): void {
    clearTimeout(video._retryTimer);
    video._retryTimer = undefined;
    if (video._onError) video.removeEventListener('error', video._onError);
    video._onError = undefined;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}
