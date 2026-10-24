// Edit planning and sampling. Segments are aligned to the beat grid; each cut,
// including the loop seam at t = 0, is a transition centered on its beat.
import type { Block, CameraTransform, FramePoint, RhythmDef, Segment, SegmentFrame, TimelinePlan, TimelinePlanOptions, TimelineSample, VelocityDef } from './types.ts';

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

// How a segment's own framing gets from where it starts to where it ends.
export const MOVES: Record<NonNullable<SegmentFrame['ease']>, { name: string; desc: string }> = {
  smooth: { name: 'Smooth', desc: 'Eases out of the start and into the end' },
  linear: { name: 'Steady', desc: 'The same speed all the way' },
  beats: { name: 'On the beat', desc: 'A quick step on every beat, holding in between' },
};

/** How much of a segment's framing move is done at its local time: 0 at the cut in, 1 at the cut out. */
export function moveAt(seg: Segment, local: number): number {
  const u = Math.max(0, Math.min(1, local / Math.max(seg.dur, 1e-3)));
  const ease = seg.frame?.ease || 'smooth';
  if (ease === 'linear') return u;
  if (ease === 'beats') {
    // each step lands in the first third of its beat
    const n = Math.max(1, Math.round(seg.dur / seg.bd));
    const k = Math.min(n - 1, Math.floor(u * n));
    const g = Math.min(1, (u * n - k) / 0.35);
    return (k + 1 - (1 - g) ** 3) / n;
  }
  return u * u * (3 - 2 * u);
}

/** The framing m of the way through a move: x and y straight across, the zoom at an even pace. */
export function frameAt(f: SegmentFrame, m: number): FramePoint {
  const { a, b = a } = f;
  return [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m, a[2] * (b[2] / a[2]) ** m];
}

// Footage time (in seconds at speed 1) consumed between the segment start and `local`.
export function footageUsed(seg: Segment, local: number): number {
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
const DIRS3 = ['forward', 'reverse', 'pingpong'] as const;

/** How long a transition can last at a cut: what was asked for, held to 90% of the shorter segment either
 * side, so the windows at neighbouring cuts never overlap and at most two segments are ever on screen. */
export function fitTrans(want: number, dur: number, prevDur: number): number {
  return Math.max(0, Math.min(want, 0.9 * Math.min(dur, prevDur)));
}

/** Cut times in beats are kept to a millionth of a beat, so grid cuts stay exact whole and half beats. */
const toBeats = (t: number, beatDur: number): number => Math.round((t / beatDur) * 1e6) / 1e6;

// The rolled edit: cut times from the rhythm, clips in turn, in-points walked through each clip so a clip
// that comes round again shows new footage, and a seed per block. clips = [{id, duration}]
export function generateBlocks(opts: TimelinePlanOptions): Block[] {
  const { L, beatDur, clips, transBeats, seed, speed = 1, order = 'cycle', velocity = 'none' } = opts;
  const r = rng(seed * 2654435761);
  const cuts = cutTimes({ ...opts, nClips: clips.length });
  const n = cuts.length;
  const durs = cuts.map((t0, i) => (i + 1 < n ? cuts[i + 1] : L) - t0);
  const room = durs.map((d, i) => fitTrans(transBeats * beatDur, d, durs[(i - 1 + n) % n]));
  const cursor = new Map<string, number>();
  // a ramp can run ahead of constant speed inside a beat, so leave it a little more footage
  const vk = velocity === 'none' ? 1 : 2;
  return cuts.map((t0, i) => {
    const clip = clips[i % clips.length];
    const need = (durs[i] + ((room[i] + room[(i + 1) % n]) / 2) * vk + (velocity === 'none' ? 0 : beatDur)) * speed + 0.2;
    const span = Math.max(0, clip.duration - need - 0.1);
    let start = cursor.has(clip.id) ? (cursor.get(clip.id) as number) : r() * span * 0.6;
    if (start > span) start = r() * span * 0.3;
    // in-point leaves room for the transition that starts half a window before the cut
    const inPt = Math.min(Math.max(start, (room[i] / 2) * speed * vk), Math.max(0, clip.duration - 0.05));
    cursor.set(clip.id, start + durs[i] * speed + 0.5);
    // Transitions are dealt when the edit is resolved. A shuffled order drew one here, so the draw is
    // kept and every seed goes on giving the in-points and drift it always has.
    if (order === 'random') r();
    return { id: `g${i}`, at: toBeats(t0, beatDur), clipId: clip.id, in: inPt, seed: Math.floor(r() * 1e6), slot: i };
  });
}

// Blocks into segments: times in seconds, and everything a block leaves unset taken from the look's cut
// settings, the edit's direction and speed, and the transition pool.
export function resolve(blocks: Block[], opts: TimelinePlanOptions, rolled: Block[] = generateBlocks(opts)): TimelinePlan {
  const { L, beatDur, clips, transitions, transBeats, seed, speed = 1, direction = 'forward', order = 'cycle', velocity = 'none' } = opts;
  const end = L / beatDur;
  // in beat order and inside the loop
  const list: Block[] = [];
  for (const b of [...blocks].sort((x, y) => x.at - y.at)) {
    if (!list.length || (b.at > list[list.length - 1].at + 1e-6 && b.at < end - 1e-6)) list.push(b);
  }
  const n = list.length;
  const t0s = list.map((b, k) => (k ? b.at * beatDur : 0));
  const durs = t0s.map((t0, k) => (k + 1 < n ? t0s[k + 1] : L) - t0);
  const byId = new Map(clips.map((c) => [c.id, c]));

  const pool = transitions.length ? transitions : ['cut'];
  const nonCut = pool.filter((p) => p !== 'cut');
  const seamPool = nonCut.length ? nonCut : pool;
  const smoothSeam = seamPool.filter((p) => SMOOTH_TRANS.includes(p));
  const preferredSeam = smoothSeam.length ? smoothSeam : seamPool;
  const deal = (b: Block, k: number, prev: string | null): string => {
    if (order === 'random') {
      const from = k === 0 ? preferredSeam : pool;
      const j = Math.floor(rng(b.seed + 1)() * from.length);
      // never the same transition on back-to-back cuts
      return from[j] === prev && from.length > 1 ? from[(j + 1) % from.length] : from[j];
    }
    if (k === 0) return preferredSeam.includes(pool[0]) ? pool[0] : preferredSeam[0];
    return pool[(b.slot ?? k) % pool.length];
  };
  // random directions are drawn in slot order, as the rolled edit always drew them
  let draws: number[] = [];
  if (direction === 'random') {
    const dr = rng(seed * 40503 + 17);
    draws = Array.from({ length: Math.max(0, ...list.map((b) => (b.slot ?? -1) + 1)) }, () => dr());
  }

  let prevTrans: string | null = null;
  const segs: Segment[] = list.map((b, k) => {
    const clip = byId.get(b.clipId) || clips[k % clips.length];
    const dur = durs[k];
    const vel = b.vel ?? velocity;
    const d =
      b.dir ??
      (direction === 'random'
        ? DIRS3[Math.floor((b.slot != null ? draws[b.slot] : rng(b.seed * 7 + 3)()) * 3)]
        : direction === 'alternate'
          ? (b.slot ?? k) % 2 ? 'reverse' : 'forward'
          : direction);
    const trans = b.trans ?? deal(b, k, prevTrans);
    prevTrans = trans;
    // A block that grew past its footage starts earlier in its clip, so it doesn't stop on a frozen frame.
    const fit = Math.max(0, clip.duration - dur * speed - 0.1);
    const seg: Segment = {
      i: k,
      id: b.id,
      t0: t0s[k],
      t1: t0s[k] + dur,
      clipId: clip.id,
      dur,
      speed,
      vel,
      bd: beatDur,
      focus: clip.focus || null,
      rev: d === 'reverse',
      pp: d === 'pingpong',
      in: Math.min(Math.max(0, Math.min(b.in, fit)), Math.max(0, clip.duration - 0.05)),
      trans,
      transDur: trans === 'cut' ? 0 : fitTrans((b.transBeats ?? transBeats) * beatDur, dur, durs[(k - 1 + n) % n]),
      seed: b.seed,
      span: b.span || [0, 1],
    };
    if (b.frame) seg.frame = b.frame;
    if (k + 1 === n) seg.t1 = L;
    return seg;
  });
  const handCut = rolled.length !== n || rolled.some((b, k) => Math.abs(b.at - list[k].at) > 1e-6);
  return { L, beatDur, segs, blocks: list, rolled, handCut };
}

// Build the edit the rhythm and the seed give.
export function planTimeline(opts: TimelinePlanOptions): TimelinePlan {
  const rolled = generateBlocks(opts);
  return resolve(rolled, opts, rolled);
}

// Which segment(s) are visible at loop time t, with local times and transition progress. Part keys are
// block ids, so a player stays with its footage when blocks around it are split or deleted.
export function sampleTimeline(tl: TimelinePlan, t: number): TimelineSample {
  const { L, segs } = tl;
  t = wrap(t, L);
  const n = segs.length;
  for (let k = 0; k < n; k++) {
    const b = segs[k];
    if (b.transDur <= 1 / 60) continue;
    let d = t - b.t0;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    if (Math.abs(d) < b.transDur / 2) {
      const ai = (k - 1 + n) % n;
      const a = segs[ai];
      return {
        a: { seg: a, local: a.dur + d, key: ai === k ? `${a.id}:tail` : a.id },
        b: { seg: b, local: d, key: b.id },
        p: (d + b.transDur / 2) / b.transDur,
        trans: b.trans,
      };
    }
  }
  if (n === 1) {
    const b = segs[0];
    if (b.transDur <= 1 / 60) {
      const dur = Math.min(0.5 * (tl.beatDur || 0.5), b.dur * 0.25);
      if (dur > 1 / 60) {
        let d = t - b.t0;
        if (d > L / 2) d -= L;
        if (d < -L / 2) d += L;
        if (Math.abs(d) < dur / 2) {
          return {
            a: { seg: b, local: b.dur + d, key: `${b.id}:tail` },
            b: { seg: b, local: d, key: b.id },
            p: (d + dur / 2) / dur,
            trans: 'dissolve',
          };
        }
      }
    }
  }
  for (let k = n - 1; k >= 0; k--) {
    if (t >= segs[k].t0 - 1e-9) return { a: { seg: segs[k], local: t - segs[k].t0, key: segs[k].id }, b: null, p: 0, trans: null };
  }
  return { a: { seg: segs[0], local: t, key: segs[0].id }, b: null, p: 0, trans: null };
}

export function clipTime(seg: Segment, local: number, clipDur: number): number {
  // ping-pong plays forward to the middle of the segment, then back to its in-point
  const w = footageUsed(seg, local), wd = footageUsed(seg, seg.dur);
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
  // the halves of a split block each cover their stretch of one drift path
  const [u0, u1] = seg.span || [0, 1];
  const u = u0 + (u1 - u0) * Math.max(-0.5, Math.min(1.5, local / Math.max(seg.dur, 1e-3)));
  let center: [number, number] = [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u];
  let zoom = Math.max(1, cam.zoom * (fz || 1) * (1 + drift * 0.07 * u));
  if (seg.frame) {
    // the segment's own framing replaces the drift: a still crop, or a move from a to b
    const [x, y, z] = frameAt(seg.frame, moveAt(seg, local));
    center = [x, y];
    zoom = Math.max(1, cam.zoom * z);
  }
  const ph = (t / L) * Math.PI * 2;
  // Shake is a slow handheld wobble plus a 6-11 Hz rattle, as a fraction of the visible frame. The
  // rattle is what makes a short hit (kick, steps) read as a shake instead of a nudge. Each part
  // repeats a whole number of times per loop, so the seam doesn't jump.
  const shake = cam.shake * 0.025;
  const w = (hz: number, off: number) => Math.sin(Math.max(1, Math.round(hz * L)) * ph + off);
  return {
    center,
    zoom,
    rot: cam.sway * 0.06 * Math.sin((Math.PI * 2 * beat) / 4),
    shake: [
      shake * (w(0.9, 1.3) * 0.35 + w(6.3, 0.4) * 0.4 + w(10.7, 2.2) * 0.25),
      shake * (w(1.1, 2.1) * 0.35 + w(7.1, 5.2) * 0.4 + w(9.7, 0.7) * 0.25),
    ],
    flip: false,
  };
}
