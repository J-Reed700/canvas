// compose(): (look, edit, audio, t) -> one engine frame. Used identically by preview and export.
import { CAMERA, FINISH_DEF, MODULES } from './modules.js';
import { withLook } from './audio.js';
import { cameraFor, clipTime, sampleTimeline, velocityAt } from './timeline.js';

const isStepped = (p) => p.opts || p.step >= 1;

export function resolveParams(defs, values, mods, mv, depth = 1) {
  const out = {};
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
export function intensityOf(ctx) {
  const k = ctx.intensity ?? 1;
  return { wet: Math.min(1, k), depth: k };
}

export function layerStack(look, mv, { wet, depth }, prefix = '') {
  const out = [];
  look.layers.forEach((l, i) => {
    if (l.on === false || !MODULES[l.m]) return;
    out.push({ m: l.m, key: `${prefix}${i}:${l.m}`, params: { ...resolveParams(MODULES[l.m].params, l.p, l.mods, mv, depth), uWet: wet } });
  });
  return out;
}

// ctx.clipLook(clipId) (optional) gives each clip its own stack, applied before the transition;
// only the main look gets it — look thumbnails and variation tiles always show one look.
export function compose(ctx, t, look = ctx.look) {
  const { tl, sampler, clipDur, L, beatDur, seed } = ctx;
  const beat = t / beatDur;
  const base = sampler(t);
  const forLook = (l) => withLook(base, l, t / L, beat);
  const mv = forLook(look);
  const s = sampleTimeline(tl, t);
  const k = intensityOf(ctx);
  const cp = resolveParams(CAMERA.params, look.camera.p, look.camera.mods, mv, k.depth);
  const cam = { zoom: cp.p_zoom, drift: cp.p_drift, shake: cp.p_shake, sway: cp.p_sway };
  const need = (x) => {
    const rate = x.seg.speed * velocityAt(x.seg, x.local);
    return {
      vkey: `${x.seg.clipId}#${x.key}`,
      clipId: x.seg.clipId,
      time: clipTime(x.seg, x.local, clipDur(x.seg.clipId)),
      rate: Math.min(16, rate),
      // reversed, ping-pong and near-frozen footage is previewed by seeking instead of playing
      rev: x.seg.rev || x.seg.pp || rate < 0.1,
      cam: cameraFor(x.seg, x.local, cam, t, L, beat, seed),
    };
  };
  const needs = [need(s.a)];
  if (s.b) needs.push(need(s.b));
  const perClip = look === ctx.look && ctx.clipLook;
  // feedback histories are per clip; the same clip on both sides of a cut gets its own for side B
  const pre = perClip ? needs.map((n, i) => layerStack(ctx.clipLook(n.clipId), forLook(ctx.clipLook(n.clipId)), k,
    `c:${n.clipId}${i && n.clipId === needs[0].clipId ? 'b' : ''}:`)) : null;
  return {
    needs,
    trans: s.b ? { name: s.trans, p: s.p } : null,
    seg: s,
    layers: perClip ? [] : layerStack(look, mv, k),
    pre,
    finish: resolveParams(FINISH_DEF.params, look.finish.p, look.finish.mods, mv, k.depth),
    camera: cp,
    mv,
    globals: {
      uTime: t, uLoop: L, uPhase: t / L, uBeat: beat, uBeatLen: beatDur, uSeed: seed % 997, uFrame: Math.round(t * 30) % Math.max(1, Math.round(L * 30)),
      uKick: mv.kick, uSnare: mv.snare, uHats: mv.hats, uBass: mv.bass, uEnergy: mv.energy, uBright: mv.bright,
    },
  };
}

// Pool of hidden <video> elements, one per (clip, timeline slot). Preview keeps them playing in
// sync with the transport; export seeks each one frame-exactly.
export class VideoBank {
  constructor(root, urlFor, onDrop) {
    this.root = root;
    this.urlFor = urlFor;
    this.onDrop = onDrop;
    this.els = new Map();
  }

  get(vkey, clipId) {
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
      e._retries = 0;
      e.addEventListener('error', () => {
        if (e._retries++ < 6) setTimeout(() => { if (e.isConnected) e.src = `${url}?retry=${e._retries}`; }, 2000 * e._retries);
      });
      this.root.appendChild(e);
      this.els.set(vkey, e);
    }
    e._used = performance.now();
    return e;
  }

  sync(needs, playing) {
    const active = new Set();
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
  prime(needs) {
    for (const n of needs) {
      const e = this.get(n.vkey, n.clipId);
      if (e.paused && e.readyState >= 1 && !e.seeking && Math.abs(e.currentTime - n.time) > 0.05) e.currentTime = n.time;
    }
  }

  async exact(needs) {
    await Promise.all(needs.map((n) => seekExact(this.get(n.vkey, n.clipId), n.time)));
  }

  _gc(active) {
    if (this.els.size <= 20) return;
    const old = [...this.els.entries()].filter(([, e]) => !active.has(e)).sort((a, b) => a[1]._used - b[1]._used);
    for (const [k, e] of old.slice(0, this.els.size - 20)) {
      e.pause();
      e.removeAttribute('src');
      e.load();
      e.remove();
      this.els.delete(k);
      this.onDrop?.(k);
    }
  }

  clear() {
    for (const [k, e] of this.els) { e.pause(); e.removeAttribute('src'); e.load(); e.remove(); this.onDrop?.(k); }
    this.els.clear();
  }
}

// Resolves on `ev`; rejects on a media error or after `ms` — an export must never silently
// encode a black or stale frame.
function once(el, ev, ms, what) {
  return new Promise((res, rej) => {
    const off = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); clearTimeout(to); };
    const ok = () => { off(); res(); };
    const bad = () => { off(); rej(new Error(`${what}: the clip could not be decoded`)); };
    const to = setTimeout(() => { off(); rej(new Error(`${what}: timed out`)); }, ms);
    el.addEventListener(ev, ok);
    el.addEventListener('error', bad);
  });
}

export async function waitReady(e, ms = 240000) {
  if (e.readyState >= 2) return;
  await once(e, 'loadeddata', ms, 'Loading clip');
}

async function seekExact(e, t) {
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
