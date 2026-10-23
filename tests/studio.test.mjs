// Unit tests for the GPU Studio's pure modules (run: node --test tests/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimeline, sampleTimeline, clipTime, loopBeats } from '../canvasforge/studio/timeline.js';
import { compose, resolveParams } from '../canvasforge/studio/composer.js';
import { flashesPerSecond } from '../canvasforge/studio/exporter.js';
import { LOOKS, mutate, randomLook } from '../canvasforge/studio/looks.js';
import { MODULES } from '../canvasforge/studio/modules.js';
import { makeSampler } from '../canvasforge/studio/audio.js';

const FPS = 30;
const clips = [{ id: 'a', duration: 12 }, { id: 'b', duration: 9 }, { id: 'c', duration: 20 }];
const base = { L: 6.4, beatDur: 0.4, clips, transitions: ['dissolve', 'zoom'], transBeats: 1, seed: 7 };

test('cuts land on the beat grid and tile the loop', () => {
  for (const rhythm of ['beat', 'half', 'bar', 'bar2', 'build', 'even']) {
    const tl = planTimeline({ ...base, rhythm });
    assert.equal(tl.segs[0].t0, 0, rhythm);
    assert.ok(Math.abs(tl.segs.at(-1).t1 - base.L) < 1e-9, rhythm);
    for (const s of tl.segs) {
      const beats = s.t0 / base.beatDur;
      assert.ok(Math.abs(beats - Math.round(beats)) < 1e-9, `${rhythm} cut at ${s.t0}`);
      assert.ok(s.t1 > s.t0);
    }
  }
  assert.equal(loopBeats(6.4, 0.4).length, 16);
});

test('every visible clip plays continuously, including across the loop seam', () => {
  for (const rhythm of ['bar', 'half', 'build']) {
    const tl = planTimeline({ ...base, rhythm });
    const N = Math.round(base.L * FPS);
    const at = (i) => {
      const s = sampleTimeline(tl, i / FPS);
      const parts = [s.a, s.b].filter(Boolean);
      return new Map(parts.map((x) => [x.key, clipTime(x.seg, x.local, 60)]));
    };
    for (let i = 0; i < N; i++) {
      const now = at(i), next = at((i + 1) % N);
      for (const [key, t] of now) {
        if (!next.has(key)) continue;
        const step = next.get(key) - t;
        assert.ok(Math.abs(step - 1 / FPS) < 1e-6, `${rhythm} frame ${i}→${(i + 1) % N} key ${key}: clip time step ${step}`);
      }
    }
  }
});

test('transitions are centred on their beat (p = 0.5 exactly on the cut)', () => {
  const tl = planTimeline({ ...base, rhythm: 'bar' });
  for (const s of tl.segs) {
    const r = sampleTimeline(tl, s.t0);
    assert.equal(r.b?.seg, s);
    assert.ok(Math.abs(r.p - 0.5) < 1e-9);
  }
  const single = planTimeline({ ...base, clips: [clips[0]], rhythm: 'bar2' });
  const seam = sampleTimeline(single, 0);
  assert.notEqual(seam.a.key, seam.b.key, 'a one-clip seam needs two distinct players');
});

test('modulation adds to the base value and respects the param range', () => {
  const defs = [{ id: 'x', min: 0, max: 2, def: 1, step: 0.01 }, { id: 'n', min: 1, max: 8, def: 4, step: 1 }];
  const out = resolveParams(defs, { x: 1.8, n: 4 }, { x: { src: 'kick', amt: 0.5 }, n: { src: 'kick', amt: 1 } }, { kick: 1 });
  assert.equal(out.p_x, 2, 'clamped to max');
  assert.equal(out.p_n, 4, 'stepped params are never modulated (they would break seamless loops)');
});

test('compose() builds valid frames for every curated look', () => {
  const tl = planTimeline({ ...base, rhythm: 'bar' });
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 1 });
  for (const look of LOOKS) {
    const ctx = { look, tl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1 };
    for (const t of [0, 1.234, base.L - 0.01]) {
      const fr = compose(ctx, t);
      assert.ok(fr.needs.length >= 1 && fr.needs.length <= 2);
      for (const l of fr.layers) {
        for (const p of MODULES[l.m].params) {
          const v = l.params[`p_${p.id}`];
          assert.ok(v >= p.min && v <= p.max, `${look.id}/${l.m}.${p.id}=${v}`);
        }
      }
    }
  }
});

test('mutations and random looks only reference real modules', () => {
  for (let s = 1; s < 60; s++) {
    for (const l of [mutate(LOOKS[s % LOOKS.length], 0.9, s), randomLook(s)]) {
      assert.ok(l.layers.length >= 1 && l.layers.length <= 5);
      for (const layer of l.layers) assert.ok(MODULES[layer.m], layer.m);
    }
  }
});

test('flash counter follows the WCAG pair-of-opposing-changes rule', () => {
  const toggle = Array.from({ length: 90 }, (_, i) => (Math.floor(i / 3) % 2 ? 0.6 : 0.2)); // 5 Hz square
  assert.equal(flashesPerSecond(toggle, FPS), 5);
  assert.equal(flashesPerSecond(Array(90).fill(0.4), FPS), 0);
  const gentle = Array.from({ length: 90 }, (_, i) => 0.4 + 0.04 * Math.sin(i));
  assert.equal(flashesPerSecond(gentle, FPS), 0);
  const bright = Array.from({ length: 90 }, (_, i) => (Math.floor(i / 3) % 2 ? 0.95 : 0.85)); // darker state ≥ 0.8
  assert.equal(flashesPerSecond(bright, FPS), 0);
});
