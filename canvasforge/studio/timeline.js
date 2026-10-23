// Edit planning and sampling. The loop [0, L) is cut into segments on the beat grid; every cut —
// including the loop seam at t = 0 — is a transition centred on its beat, so the loop is seamless.

export const RHYTHMS = {
  hits: { name: 'On hits', beats: null },
  beat: { name: 'Every beat', beats: 1 },
  half: { name: '½ bar', beats: 2 },
  bar: { name: 'Bar', beats: 4 },
  bar2: { name: '2 bars', beats: 8 },
  build: { name: 'Build-up', beats: null },
  even: { name: 'One per clip', beats: null },
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (x, L) => ((x % L) + L) % L;

// Beat times inside the loop, relative to its start (the loop starts on a downbeat).
export function loopBeats(L, beatDur) {
  const out = [];
  for (let b = 0; b * beatDur < L - 1e-6; b++) out.push(b * beatDur);
  return out;
}

function cutTimes(opts) {
  const { L, beatDur, rhythm, nClips, hitCurve, custom } = opts;
  const beats = loopBeats(L, beatDur);
  const nb = beats.length;
  if (rhythm === 'custom' && custom?.length) return [0, ...custom.filter((c) => c > 0.05 && c < L - 0.05)].sort((a, b) => a - b);
  if (RHYTHMS[rhythm]?.beats) {
    const step = RHYTHMS[rhythm].beats;
    return beats.filter((_, i) => i % step === 0);
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
  // even: one segment per clip, snapped to beats
  const n = Math.max(1, Math.min(nClips, nb));
  return Array.from({ length: n }, (_, k) => beats[Math.round((k * nb) / n)]);
}

// Build the edit: segments with clip, in-point, transition. clips = [{id, duration}]
export function planTimeline(opts) {
  const { L, beatDur, clips, transitions, transBeats, seed, speed = 1, direction = 'forward', order = 'cycle' } = opts;
  const r = rng(seed * 2654435761);
  const cuts = cutTimes({ ...opts, nClips: clips.length });
  const segs = cuts.map((t0, i) => ({ i, t0, t1: i + 1 < cuts.length ? cuts[i + 1] : L }));
  const minDur = Math.min(...segs.map((s) => s.t1 - s.t0));
  const transDur = Math.min(transBeats * beatDur, minDur * 0.9);
  const pool = transitions.length ? transitions : ['cut'];
  const cursor = new Map();
  let prevTrans = null;
  segs.forEach((s, i) => {
    const clip = clips[i % clips.length];
    s.clipId = clip.id;
    s.dur = s.t1 - s.t0;
    s.speed = speed;
    s.rev = direction === 'reverse' || (direction === 'alternate' && i % 2 === 1);
    const need = (s.dur + transDur) * speed + 0.2;
    const span = Math.max(0, clip.duration - need - 0.1);
    let start = cursor.has(clip.id) ? cursor.get(clip.id) : r() * span * 0.6;
    if (start > span) start = r() * span * 0.3;
    // in-point leaves room for the transition that starts half a window before the cut
    s.in = Math.min(Math.max(start, (transDur / 2) * speed), Math.max(0, clip.duration - 0.05));
    cursor.set(clip.id, start + s.dur * speed + 0.5);
    let tr;
    if (order === 'random') {
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
export function sampleTimeline(tl, t) {
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
  for (let k = n - 1; k >= 0; k--) {
    if (t >= segs[k].t0 - 1e-9) return { a: { seg: segs[k], local: t - segs[k].t0, key: `${k}` }, b: null, p: 0, trans: null };
  }
  return { a: { seg: segs[0], local: t, key: '0' }, b: null, p: 0, trans: null };
}

export function clipTime(seg, local, clipDur) {
  const span = seg.rev ? seg.in + (seg.dur - local) * seg.speed : seg.in + local * seg.speed;
  return Math.min(Math.max(0, span), Math.max(0, clipDur - 1 / 30));
}

// Ken Burns drift, beat sway and loop-periodic shake for one segment at its local time.
export function cameraFor(seg, local, cam, t, L, beat, seed) {
  const r = rng(seg.seed + seed * 31);
  const drift = cam.drift;
  const c0 = [0.5 + (r() - 0.5) * drift, 0.5 + (r() - 0.5) * drift * 0.6];
  const c1 = [0.5 + (r() - 0.5) * drift, 0.5 + (r() - 0.5) * drift * 0.6];
  const u = Math.max(-0.5, Math.min(1.5, local / Math.max(seg.dur, 1e-3)));
  const ph = (t / L) * Math.PI * 2;
  const shake = cam.shake * 0.012;
  return {
    center: [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u],
    zoom: Math.max(1, cam.zoom * (1 + drift * 0.07 * u)),
    rot: cam.sway * 0.06 * Math.sin((Math.PI * 2 * beat) / 4),
    shake: [
      shake * (Math.sin(ph * 7 + 1.3) * 0.6 + Math.sin(ph * 13 + 0.4) * 0.4),
      shake * (Math.sin(ph * 11 + 2.1) * 0.6 + Math.sin(ph * 17 + 5.2) * 0.4),
    ],
    flip: false,
  };
}
