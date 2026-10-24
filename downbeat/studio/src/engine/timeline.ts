// Edit planning and sampling. Segments are aligned to the beat grid; each cut,
// including the loop seam at t = 0, is a transition centered on its beat.
import type { CameraTransform, RhythmDef, Segment, TimelinePlan, TimelinePlanOptions, TimelineSample, VelocityDef } from './types.ts';

export const RHYTHMS: Record<string, RhythmDef> = {
  hits: { name: 'On hits', short: 'Hits', beats: null },
  eighth: { name: '½ beat', short: '½ beat', beats: 0.5 },
  beat: { name: 'Every beat', short: 'Beat', beats: 1 },
  half: { name: '½ bar', short: '½ bar', beats: 2 },
  bar: { name: 'Bar', short: 'Bar', beats: 4 },
  bar2: { name: '2 bars', short: '2 bars', beats: 8 },
  sync: { name: '3-3-2 swing', short: '3-3-2', beats: null },
  build: { name: 'Build-up', short: 'Build', beats: null },
  varied: { name: 'Varied', short: 'Varied', beats: null },
  even: { name: 'One per clip', short: '1/clip', beats: null },
  twice: { name: 'Two per clip', short: '2/clip', beats: null },
};

export const DIRECTIONS: Record<string, string> = {
  forward: 'Forward', reverse: 'Reverse', alternate: 'Alternate', pingpong: 'Ping-pong', random: 'Random',
};

// Speed ramps ("velocity edits"): clip speed follows a curve that repeats every `per` beats and
// averages 1, so a segment uses the same amount of footage as at constant speed. v(x) is the
// speed at phase x in [0, 1); f(x) its integral (f(1) = 1).
const surge = (x: number): number => 0.15 * x + 0.85 * (1 - Math.exp(-5 * x)) / (1 - Math.exp(-5));
export const VELOCITY: Record<string, VelocityDef> = {
  none: { name: 'Constant', per: 1, v: () => 1, f: (x: number) => x },
  surge: { name: 'Surge', per: 1, desc: 'Burst on every beat, slow-mo in between', v: (x: number) => 0.15 + 0.85 * 5 * Math.exp(-5 * x) / (1 - Math.exp(-5)), f: surge },
  swell: { name: 'Swell', per: 1, desc: 'Slow on the beat, speeding up into the next', v: (x: number) => 0.25 + 2.25 * x * x, f: (x: number) => 0.25 * x + 0.75 * x ** 3 },
  hold: { name: 'Hold & jump', per: 1, desc: 'Freeze for half a beat, then double speed', v: (x: number) => (x < 0.5 ? 0 : 2), f: (x: number) => (x < 0.5 ? 0 : 2 * (x - 0.5)) },
  wave: { name: 'Wave', per: 2, desc: 'Speeds up and slows down every two beats', v: (x: number) => 1 + 0.75 * Math.sin(Math.PI * 2 * x), f: (x: number) => x + (0.75 * (1 - Math.cos(Math.PI * 2 * x))) / (Math.PI * 2) },
  ramp: { name: 'Bar ramp', per: 4, desc: 'Slow-mo that accelerates through the bar', v: (x: number) => 0.3 + 2.1 * x * x, f: (x: number) => 0.3 * x + 0.7 * x ** 3 },
};

// Footage time (in seconds at speed 1) consumed between the segment start and `local`.
function warp(seg: Segment, local: number): number {
  const V = VELOCITY[seg.vel];
  if (!V || seg.vel === 'none' || !seg.bd) return local;
  const span = V.per * seg.bd;
  const F = (t: number): number => { const x = t / span; return (Math.floor(x) + V.f(x - Math.floor(x))) * span; };
  return F(seg.t0 + local) - F(seg.t0);
}

// Instantaneous speed multiplier of the ramp at `local` (for preview playback rate).
export function velocityAt(seg: Segment, local: number): number {
  const V = VELOCITY[seg.vel];
  if (!V || seg.vel === 'none' || !seg.bd) return 1;
  const x = (seg.t0 + local) / (V.per * seg.bd);
  return V.v(x - Math.floor(x));
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (x: number, L: number): number => ((x % L) + L) % L;

// Beat times inside the loop, relative to its start (the loop starts on a downbeat).
export function loopBeats(L: number, beatDur: number): number[] {
  const out: number[] = [];
  for (let b = 0; b * beatDur < L - 1e-6; b++) out.push(b * beatDur);
  return out;
}

function cutTimes(opts: TimelinePlanOptions): number[] {
  const { L, beatDur, rhythm, nClips, hitCurve, custom, seed = 1 } = opts;
  const beats = loopBeats(L, beatDur);
  const nb = beats.length;
  if (rhythm === 'custom' && custom?.length) return [0, ...custom.filter((c) => c > 0.05 && c < L - 0.05)].sort((a, b) => a - b);
  if (RHYTHMS[rhythm]?.beats) {
    const step = RHYTHMS[rhythm].beats;
    if (step < 1) return Array.from({ length: Math.round(nb / step) }, (_, k) => k * step * beatDur).filter((t) => t < L - 1e-6);
    return beats.filter((_, i) => i % step === 0);
  }
  if (rhythm === 'sync') {
    // 3-3-2 clave feel: cuts on beat 1, the "and" of 2, and beat 4 of every bar.
    const cuts = [];
    for (let b = 0; b < nb; b += 4) for (const o of [0, 1.5, 3]) if (b + o < nb) cuts.push((b + o) * beatDur);
    return cuts;
  }
  if (rhythm === 'varied') {
    const r = rng(seed * 7 + 3);
    const cuts = [0];
    let pos = 0;
    for (;;) {
      pos += [1, 2, 2, 3, 4][Math.floor(r() * 5)];
      if (pos > nb - 1) break;
      cuts.push(beats[pos]);
    }
    return cuts;
  }
  if (rhythm === 'build') {
    const cuts = [0];
    let pos = 0, len = Math.max(1, Math.floor(nb / 2));
    while (pos + len < nb) { pos += len; cuts.push(beats[pos]); len = Math.max(1, Math.floor(len / 2)); }
    return cuts;
  }
  if (rhythm === 'hits' && hitCurve) {
    const fps = 30;
    const score = beats.map((b) => {
      let m = 0;
      for (let f = Math.round(b * fps) - 2; f <= Math.round(b * fps) + 2; f++) m = Math.max(m, hitCurve[Math.max(0, f)] || 0);
      return m;
    });
    const want = Math.max(nClips, Math.round(nb / 4));
    const order = score.map((s, i) => [s, i]).filter(([, i]) => i > 0).sort((a, b) => b[0] - a[0]);
    const picked = [0];
    for (const [, i] of order) {
      if (picked.length >= want) break;
      if (picked.every((p) => Math.abs(p - i) >= 2)) picked.push(i);
    }
    return picked.sort((a, b) => a - b).map((i) => beats[i]);
  }
  // even / twice: one (or two) segments per clip, snapped to beats
  const n = Math.max(1, Math.min(nClips * (rhythm === 'twice' ? 2 : 1), nb));
  return Array.from({ length: n }, (_, k) => beats[Math.round((k * nb) / n)]);
}

const SMOOTH_TRANS = ['dissolve', 'morph', 'luma', 'prism', 'swirl', 'kaleido', 'iris', 'ripple'];

// Build the edit: segments with clip, in-point, transition. clips = [{id, duration}]
export function planTimeline(opts: TimelinePlanOptions): TimelinePlan {
  const { L, beatDur, clips, transitions, transBeats, seed, speed = 1, direction = 'forward', order = 'cycle', velocity = 'none' } = opts;
  const r = rng(seed * 2654435761);
  const cuts = cutTimes({ ...opts, nClips: clips.length });
  const segs: Segment[] = cuts.map((t0, i) => ({
    i,
    t0,
    t1: i + 1 < cuts.length ? cuts[i + 1] : L,
    clipId: '',
    dur: 0,
    speed: 1,
    vel: 'none',
    bd: beatDur,
    rev: false,
    pp: false,
    in: 0,
    trans: 'cut',
    seed: 0,
  }));
  const minDur = Math.min(...segs.map((s) => s.t1 - s.t0));
  const transDur = Math.min(transBeats * beatDur, minDur * 0.9);
  const pool = transitions.length ? transitions : ['cut'];
  const nonCut = pool.filter((p) => p !== 'cut');
  const seamPool = nonCut.length ? nonCut : pool;
  const smoothSeam = seamPool.filter((p) => SMOOTH_TRANS.includes(p));
  const preferredSeam = smoothSeam.length ? smoothSeam : seamPool;
  const cursor = new Map<string, number>();
  const dr = rng(seed * 40503 + 17);
  let prevTrans: string | null = null;
  segs.forEach((s, i) => {
    const clip = clips[i % clips.length];
    s.clipId = clip.id;
    s.dur = s.t1 - s.t0;
    s.speed = speed;
    s.vel = velocity;
    s.bd = beatDur;
    s.focus = clip.focus || null;
    const d = direction === 'random' ? ['forward', 'reverse', 'pingpong'][Math.floor(dr() * 3)] : direction;
    s.rev = d === 'reverse' || (d === 'alternate' && i % 2 === 1);
    s.pp = d === 'pingpong';
    // a ramp can run ahead of constant speed inside a beat, so leave it a little more footage
    const vk = velocity === 'none' ? 1 : 2;
    const need = (s.dur + transDur * vk + (velocity === 'none' ? 0 : beatDur)) * speed + 0.2;
    const span = Math.max(0, clip.duration - need - 0.1);
    let start = cursor.has(clip.id) ? (cursor.get(clip.id) as number) : r() * span * 0.6;
    if (start > span) start = r() * span * 0.3;
    // in-point leaves room for the transition that starts half a window before the cut
    s.in = Math.min(Math.max(start, (transDur / 2) * speed * vk), Math.max(0, clip.duration - 0.05));
    cursor.set(clip.id, start + s.dur * speed + 0.5);
    let tr: string;
    if (i === 0) {
      if (order === 'random') {
        tr = preferredSeam[Math.floor(r() * preferredSeam.length)];
      } else {
        tr = preferredSeam.includes(pool[0]) ? pool[0] : preferredSeam[0];
      }
    } else if (order === 'random') {
      const cands = pool.filter((p) => p !== prevTrans);
      tr = (cands.length ? cands : pool)[Math.floor(r() * (cands.length || pool.length))];
    } else tr = pool[i % pool.length];
    s.trans = tr;
    prevTrans = tr;
    s.seed = Math.floor(r() * 1e6);
  });
  return { L, beatDur, segs, transDur };
}

// Which segment(s) are visible at loop time t, with local times and transition progress.
export function sampleTimeline(tl: TimelinePlan, t: number): TimelineSample {
  const { L, segs, transDur } = tl;
  t = wrap(t, L);
  const n = segs.length;
  if (transDur > 1 / 60) {
    for (let k = 0; k < n; k++) {
      const b = segs[k];
      if (b.trans === 'cut') continue;
      let d = t - b.t0;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      if (Math.abs(d) < transDur / 2) {
        const ai = (k - 1 + n) % n;
        const a = segs[ai];
        return {
          a: { seg: a, local: a.dur + d, key: ai === k ? `${ai}:tail` : `${ai}` },
          b: { seg: b, local: d, key: `${k}` },
          p: (d + transDur / 2) / transDur,
          trans: b.trans,
        };
      }
    }
  }
  if (n === 1) {
    const b = segs[0];
    if (b.trans === 'cut' || transDur <= 1 / 60) {
      const dur = Math.min(0.5 * (tl.beatDur || 0.5), b.dur * 0.25);
      if (dur > 1 / 60) {
        let d = t - b.t0;
        if (d > L / 2) d -= L;
        if (d < -L / 2) d += L;
        if (Math.abs(d) < dur / 2) {
          return {
            a: { seg: b, local: b.dur + d, key: '0:tail' },
            b: { seg: b, local: d, key: '0' },
            p: (d + dur / 2) / dur,
            trans: 'dissolve',
          };
        }
      }
    }
  }
  for (let k = n - 1; k >= 0; k--) {
    if (t >= segs[k].t0 - 1e-9) return { a: { seg: segs[k], local: t - segs[k].t0, key: `${k}` }, b: null, p: 0, trans: null };
  }
  return { a: { seg: segs[0], local: t, key: '0' }, b: null, p: 0, trans: null };
}

export function clipTime(seg: Segment, local: number, clipDur: number): number {
  // ping-pong plays forward to the middle of the segment, then back to its in-point
  const w = warp(seg, local), wd = warp(seg, seg.dur);
  const u = seg.pp ? Math.min(w, wd - w) : seg.rev ? wd - w : w;
  const span = seg.in + u * seg.speed;
  return Math.min(Math.max(0, span), Math.max(0, clipDur - 1 / 30));
}

// Ken Burns drift, beat sway and loop-periodic shake for one segment at its local time.
export function cameraFor(
  seg: Segment,
  local: number,
  cam: { zoom: number; drift: number; shake: number; sway: number },
  t: number,
  L: number,
  beat: number,
  seed: number,
): CameraTransform {
  const r = rng(seg.seed + seed * 31);
  const drift = cam.drift;
  // drift wanders around the clip's framing point (default: center)
  const [fx, fy, fz] = seg.focus || [0.5, 0.5, 1];
  const c0 = [fx + (r() - 0.5) * drift, fy + (r() - 0.5) * drift * 0.6];
  const c1 = [fx + (r() - 0.5) * drift, fy + (r() - 0.5) * drift * 0.6];
  const u = Math.max(-0.5, Math.min(1.5, local / Math.max(seg.dur, 1e-3)));
  const ph = (t / L) * Math.PI * 2;
  // Shake is a slow handheld wobble plus a 6-11 Hz rattle, as a fraction of the visible frame. The
  // rattle is what makes a short hit (kick, steps) read as a shake instead of a nudge. Each part
  // repeats a whole number of times per loop, so the seam doesn't jump.
  const shake = cam.shake * 0.025;
  const w = (hz: number, off: number) => Math.sin(Math.max(1, Math.round(hz * L)) * ph + off);
  return {
    center: [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u],
    zoom: Math.max(1, cam.zoom * (fz || 1) * (1 + drift * 0.07 * u)),
    rot: cam.sway * 0.06 * Math.sin((Math.PI * 2 * beat) / 4),
    shake: [
      shake * (w(0.9, 1.3) * 0.35 + w(6.3, 0.4) * 0.4 + w(10.7, 2.2) * 0.25),
      shake * (w(1.1, 2.1) * 0.35 + w(7.1, 5.2) * 0.4 + w(9.7, 0.7) * 0.25),
    ],
    flip: false,
  };
}
