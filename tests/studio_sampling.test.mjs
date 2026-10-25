import test from 'node:test';
import assert from 'node:assert/strict';
import { editTime, planTimeline, resolve, rng, RHYTHMS, sampleTimeline } from '../downbeat/studio/src/engine/timeline.ts';
import { segAt } from '../downbeat/studio/src/engine/blocks.ts';
import { compose } from '../downbeat/studio/src/engine/composer.ts';
import { makeSampler } from '../downbeat/studio/src/engine/audio.ts';
import { LOOKS, cloneLook } from '../downbeat/studio/src/engine/looks.ts';

// Independent linear reference preserves the pre-optimization selection semantics. Test results
// include source identity, transition progress, local footage time, direction and the loop seam.
function reference(tl, time) {
  const { L, segs } = tl;
  const { t, back } = editTime(tl, time);
  const n = segs.length;
  for (let k = 0; k < n; k++) {
    const b = segs[k];
    if (b.transDur <= 1 / 60) continue;
    let d = t - b.t0;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    if (Math.abs(d) < b.transDur / 2) {
      const ai = (k - 1 + n) % n, a = segs[ai];
      return { a: { seg: a, local: a.dur + d, key: ai === k ? `${a.id}:tail` : a.id }, b: { seg: b, local: d, key: b.id }, p: (d + b.transDur / 2) / b.transDur, trans: b.trans, back };
    }
  }
  if (n === 1 && !tl.rebound && segs[0].transDur <= 1 / 60) {
    const b = segs[0], dur = Math.min(0.5 * (tl.beatDur || 0.5), b.dur * 0.25);
    let d = t - b.t0;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    if (dur > 1 / 60 && Math.abs(d) < dur / 2) return { a: { seg: b, local: b.dur + d, key: `${b.id}:tail` }, b: { seg: b, local: d, key: b.id }, p: (d + dur / 2) / dur, trans: 'dissolve', back };
  }
  for (let k = n - 1; k >= 0; k--) if (t >= segs[k].t0 - 1e-9) return { a: { seg: segs[k], local: t - segs[k].t0, key: segs[k].id }, b: null, p: 0, trans: null, back };
  return { a: { seg: segs[0], local: t, key: segs[0].id }, b: null, p: 0, trans: null, back };
}

function check(tl, times) {
  for (const t of times) {
    assert.deepEqual(sampleTimeline(tl, t), reference(tl, t), `sampling at ${t}`);
    const x = editTime(tl, t).t;
    assert.equal(segAt(tl, t), tl.segs.find((s) => x >= s.t0 - 1e-9 && x < s.t1 - 1e-9) || tl.segs.at(-1), `selection at ${t}`);
  }
}

test('indexed sampling matches linear sampling at every boundary, transition and wrap', () => {
  const random = rng(3701);
  for (let seed = 1; seed <= 40; seed++) {
    const L = seed % 5 === 0 ? 0.04 : 4 + random() * 56;
    const opts = { L, beatDur: 0.3 + random() * 0.4, clips: Array.from({ length: seed % 7 + 1 }, (_, i) => ({ id: `c${i}`, duration: 60 })), transitions: seed % 3 ? ['dissolve', 'cut', 'zoom'] : ['cut'], transBeats: seed % 6, seed, rhythm: Object.keys(RHYTHMS)[seed % Object.keys(RHYTHMS).length], rebound: seed % 2 === 0 };
    const tl = planTimeline(opts);
    const manual = resolve(tl.blocks.map((b, i) => ({ ...b, trans: i % 2 ? 'cut' : 'dissolve', transBeats: i % 4 / 4 })), opts);
    for (const plan of [tl, manual]) {
      const times = [-2 * L, -1e-9, 0, L, L + 1e-9, 2 * L];
      for (const s of plan.segs) for (const center of [s.t0, s.t0 - s.transDur / 2, s.t0 + s.transDur / 2]) for (const epsilon of [-1e-8, -1e-10, 0, 1e-10, 1e-8]) times.push(center + epsilon);
      times.push(...Array.from({ length: 120 }, () => (random() * 4 - 1) * L));
      check(plan, times);
    }
  }
});

test('large timelines and single-clip seams preserve exact sampling', () => {
  for (const cuts of [1, 4096]) {
    const L = 600;
    const tl = planTimeline({ L, beatDur: 0.5, clips: [{ id: 'one', duration: 60 }], seed: 4, rhythm: 'custom', custom: Array.from({ length: cuts - 1 }, (_, i) => (i + 1) * L / cuts), transitions: ['cut'], transBeats: 0 });
    check(tl, Array.from({ length: 600 }, (_, i) => i * 1.001 - 0.2));
  }
});

test('per-clip composition examines the visible cuts without scanning the entire timeline', () => {
  const L = 600, beatDur = 0.5, cuts = 4096, seed = 4;
  const clips = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, duration: 60 }));
  const tl = planTimeline({ L, beatDur, clips, seed, rhythm: 'custom', custom: Array.from({ length: cuts - 1 }, (_, i) => (i + 1) * L / cuts), transitions: ['dissolve'], transBeats: 1 });
  const look = { ...cloneLook(LOOKS[0]), layers: [] };
  const broll = { ...look, layers: [{ m: 'broll', p: {} }] };
  let reads = 0;
  const ctx = { tl, L, beatDur, seed, clips, look, clipDur: () => 60, sampler: makeSampler({ L, beatDur, seed, loopStart: 0 }),
    clipLook: (_id, seg) => { reads++; return seg.i === 101 ? broll : look; } };
  const before = compose(ctx, tl.segs[100].t0);
  assert.ok(before.trans);
  assert.ok(reads <= 8, `composition inspected ${reads} looks for one frame`);
  assert.equal(before.needs.some((need) => need.aux === 'clipB'), false, 'a future B-roll layer does not load footage for this frame');
  reads = 0;
  const during = compose(ctx, tl.segs[101].t0);
  assert.ok(reads <= 8);
  assert.ok(during.needs.some((need) => need.aux === 'clipB'), 'both visible sides can request B-roll');
});

test('look parameter reuse is limited to one frame so in-place edits remain immediate', () => {
  const L = 8, beatDur = 0.5, seed = 4;
  const clips = [{ id: 'a', duration: 60 }, { id: 'b', duration: 60 }];
  const tl = planTimeline({ L, beatDur, clips, seed, rhythm: 'bar', transitions: ['dissolve'], transBeats: 1 });
  const look = cloneLook(LOOKS[0]);
  look.camera.mods = {};
  look.finish.mods = {};
  look.camera.p.zoom = 1.15;
  look.finish.p.exposure = 0.3;
  const ctx = { tl, L, beatDur, seed, clips, look, clipDur: () => 60, sampler: makeSampler({ L, beatDur, seed, loopStart: 0 }) };
  const first = compose(ctx, 2);
  look.camera.p.zoom = 1.5;
  look.finish.p.exposure = 0.6;
  const edited = compose(ctx, 2);
  assert.equal(first.camera.p_zoom, 1.15);
  assert.equal(first.finish.p_exposure, 0.3);
  assert.equal(edited.camera.p_zoom, 1.5);
  assert.equal(edited.finish.p_exposure, 0.6);
});
