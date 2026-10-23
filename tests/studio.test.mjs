// Unit tests for the GPU Studio's pure modules (run: node --test tests/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimeline, sampleTimeline, clipTime, cameraFor, loopBeats, velocityAt, RHYTHMS, DIRECTIONS, VELOCITY } from '../canvasforge/studio/timeline.js';
import { compose, resolveParams } from '../canvasforge/studio/composer.js';
import { flashesPerSecond } from '../canvasforge/studio/exporter.js';
import { LOOKS, chaosLook, evolveLook, mutate, randomLook } from '../canvasforge/studio/looks.js';
import { CAMERA, FINISH_DEF, MODULES } from '../canvasforge/studio/modules.js';
import { TRANSITIONS } from '../canvasforge/studio/shaders.js';
import { makeSampler, withLook } from '../canvasforge/studio/audio.js';
import { MOD_SOURCES } from '../canvasforge/studio/modules.js';

const FPS = 30;
const clips = [{ id: 'a', duration: 12 }, { id: 'b', duration: 9 }, { id: 'c', duration: 20 }];
const base = { L: 6.4, beatDur: 0.4, clips, transitions: ['dissolve', 'zoom'], transBeats: 1, seed: 7 };

test('cuts land on the beat grid and tile the loop', () => {
  for (const rhythm of Object.keys(RHYTHMS)) {
    const tl = planTimeline({ ...base, rhythm });
    assert.equal(tl.segs[0].t0, 0, rhythm);
    assert.ok(Math.abs(tl.segs.at(-1).t1 - base.L) < 1e-9, rhythm);
    // ½-beat and 3-3-2 cuts sit on the eighth-note grid, everything else on the beat
    const grid = rhythm === 'eighth' || rhythm === 'sync' ? 2 : 1;
    for (const s of tl.segs) {
      const units = (s.t0 / base.beatDur) * grid;
      assert.ok(Math.abs(units - Math.round(units)) < 1e-9, `${rhythm} cut at ${s.t0}`);
      assert.ok(s.t1 - s.t0 >= base.beatDur / 2 - 1e-9, `${rhythm} segment too short`);
    }
  }
  assert.equal(planTimeline({ ...base, rhythm: 'twice' }).segs.length, clips.length * 2);
  assert.equal(planTimeline({ ...base, rhythm: 'eighth' }).segs.length, 32);
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

test('every clip direction keeps clip time inside the clip and moving at real speed', () => {
  for (const direction of Object.keys(DIRECTIONS)) {
    const tl = planTimeline({ ...base, rhythm: 'bar', direction });
    const N = Math.round(base.L * FPS);
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const s = sampleTimeline(tl, (i % N) / FPS);
      const t = clipTime(s.a.seg, s.a.local, 12);
      assert.ok(t >= 0 && t < 12, `${direction} frame ${i}: ${t}`);
      if (prev && prev.key === s.a.key) assert.ok(Math.abs(t - prev.t) <= 1 / FPS + 1e-6, `${direction} frame ${i}: jumped ${t - prev.t}`);
      prev = { key: s.a.key, t };
    }
  }
  const pp = planTimeline({ ...base, rhythm: 'bar', direction: 'pingpong' }).segs[0];
  assert.ok(Math.abs(clipTime(pp, 0, 60) - clipTime(pp, pp.dur, 60)) < 1e-9, 'ping-pong returns to its in-point');
});

test('speed ramps follow their curve, use the same footage per beat and never leave the clip', () => {
  for (const [vel, V] of Object.entries(VELOCITY)) {
    const tl = planTimeline({ ...base, rhythm: 'bar', velocity: vel });
    const vmax = Math.max(...Array.from({ length: 101 }, (_, i) => V.v(Math.min(0.9999, i / 100))));
    for (const seg of tl.segs) {
      // a whole number of ramp periods consumes exactly the footage of constant speed
      const per = V.per * base.beatDur;
      if (Math.abs(seg.dur / per - Math.round(seg.dur / per)) < 1e-9) {
        assert.ok(Math.abs(clipTime(seg, seg.dur, 60) - clipTime(seg, 0, 60) - seg.dur) < 1e-6, `${vel}: footage used`);
      }
      for (let i = -6; i < seg.dur * FPS + 6; i++) {
        const a = clipTime(seg, i / FPS, 12), b = clipTime(seg, (i + 1) / FPS, 12);
        assert.ok(a >= 0 && a < 12, `${vel}: ${a}`);
        assert.ok(b - a >= -1e-9 && b - a <= (vmax / FPS) + 1e-6, `${vel}: step ${b - a}`);
        // the preview's playback rate is the derivative of the clip time
        const mid = (i + 0.5) / FPS;
        if (b - a > 1e-6 && Math.abs(clipTime(seg, (i + 1) / FPS, 60) - clipTime(seg, i / FPS, 60)) > 1e-6 && vel !== 'hold') {
          assert.ok(Math.abs((b - a) * FPS - velocityAt(seg, mid)) < 0.35 * vmax, `${vel}: rate at ${mid}`);
        }
      }
    }
  }
});

test('clip framing moves the crop centre and zoom', () => {
  const seg = { ...planTimeline({ ...base, rhythm: 'bar' }).segs[0], focus: [0.2, 0.7, 1.5] };
  const cam = { zoom: 1, drift: 0, shake: 0, sway: 0 };
  const c = cameraFor(seg, 0.1, cam, 0.1, base.L, 0.25, 1);
  assert.deepEqual(c.center, [0.2, 0.7]);
  assert.equal(c.zoom, 1.5);
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

test('per-clip looks run before the transition, with their own feedback keys', () => {
  const tl = planTimeline({ ...base, rhythm: 'bar' });
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 1 });
  const own = { a: LOOKS[0], b: LOOKS[1], c: LOOKS[2] };
  const ctx = { look: LOOKS[3], tl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1, clipLook: (id) => own[id] };
  const cut = tl.segs[1].t0;
  const fr = compose(ctx, cut);
  assert.equal(fr.layers.length, 0, 'nothing runs after the transition');
  assert.equal(fr.pre.length, 2);
  fr.pre.forEach((stack, i) => {
    const id = fr.needs[i].clipId;
    assert.deepEqual(stack.map((l) => l.m), own[id].layers.map((l) => l.m));
    for (const l of stack) assert.ok(l.key.startsWith(`c:${id}`), l.key);
  });
  // a look thumbnail (any look other than ctx.look) always renders as one look
  const thumb = compose(ctx, cut, LOOKS[4]);
  assert.equal(thumb.pre, null);
  assert.equal(thumb.layers.length, LOOKS[4].layers.length);
});

test('FX intensity fades layers toward dry and scales modulation depth', () => {
  const tl = planTimeline({ ...base, rhythm: 'bar' });
  const sampler = () => ({ kick: 1, snare: 0, hats: 0, bass: 0, energy: 0, bright: 0, beat: 0, bar: 0, lfo: 0, rand: 0 });
  const look = { ...LOOKS[0], layers: [{ m: 'bloom', on: true, p: { intensity: 0.5 }, mods: { intensity: { src: 'kick', amt: 0.1 } } }] };
  const at = (intensity) => compose({ look, tl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1, intensity }, 1).layers[0].params;
  const range = MODULES.bloom.params.find((p) => p.id === 'intensity');
  assert.equal(at(1).uWet, 1);
  assert.equal(at(0.4).uWet, 0.4);
  assert.equal(at(1.5).uWet, 1);
  assert.ok(Math.abs(at(1).p_intensity - (0.5 + 0.1 * (range.max - range.min))) < 1e-9);
  assert.ok(Math.abs(at(0).p_intensity - 0.5) < 1e-9, 'no modulation at 0%');
});

test('chaos rolls build full, valid stacks', () => {
  for (let s = 1; s < 120; s++) {
    const l = chaosLook(s * 977);
    assert.ok(l.layers.length >= 4 && l.layers.length <= 7, `${l.layers.length} layers`);
    assert.equal(new Set(l.layers.map((x) => x.m)).size, l.layers.length, 'no duplicate effects');
    for (const layer of l.layers) {
      const m = MODULES[layer.m];
      assert.ok(m, layer.m);
      for (const p of m.params) {
        const v = layer.p[p.id];
        assert.ok(v >= p.min && v <= p.max, `${layer.m}.${p.id}=${v}`);
      }
    }
    const e = evolveLook(LOOKS[s % LOOKS.length], 0.5, s);
    assert.equal(e.finish, LOOKS[s % LOOKS.length].finish, 'evolve keeps the shared grade');
  }
});

test('every look only sets real parameters, modulations and transitions', () => {
  const check = (where, defs, values = {}, mods = {}) => {
    for (const k of Object.keys(values)) assert.ok(defs.some((p) => p.id === k), `${where}: unknown param ${k}`);
    for (const k of Object.keys(mods)) {
      const p = defs.find((d) => d.id === k);
      assert.ok(p && !p.opts && p.step < 1, `${where}: cannot modulate ${k}`);
    }
  };
  assert.equal(new Set(LOOKS.map((l) => l.id)).size, LOOKS.length, 'look ids are unique');
  for (const l of LOOKS) {
    for (const x of l.layers) { assert.ok(MODULES[x.m], `${l.id}: ${x.m}`); check(`${l.id}/${x.m}`, MODULES[x.m].params, x.p, x.mods); }
    check(`${l.id}/camera`, CAMERA.params, l.camera.p, l.camera.mods);
    check(`${l.id}/finish`, FINISH_DEF.params, l.finish.p, l.finish.mods);
    for (const t of l.cut.transitions) assert.ok(TRANSITIONS[t], `${l.id}: transition ${t}`);
    assert.ok(RHYTHMS[l.cut.rhythm], `${l.id}: rhythm ${l.cut.rhythm}`);
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

test('every modulation source stays in 0..1 and the clocks repeat exactly once per loop', () => {
  for (const L of [base.beatDur * 4, base.beatDur * 16, base.beatDur * 32]) {
    const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 3, L });
    const look = { ...LOOKS[0], env: [0, 1, 0.2, 0.9, 0.5, 0, 1, 0.3], seq: Array.from({ length: 16 }, (_, i) => i % 3 === 0 ? 1 : 0), macro: { a: 0.7, b: 0.2 } };
    const at = (t) => withLook(sampler(t), look, (t % L) / L, t / base.beatDur);
    for (let i = 0; i < 97; i++) {
      const t = (i / 97) * L;
      const v = at(t), w = at(t + L);
      for (const k of Object.keys(MOD_SOURCES)) {
        assert.ok(v[k] >= 0 && v[k] <= 1, `${k} = ${v[k]}`);
        if (k !== 'build' && k !== 'rand') assert.ok(Math.abs(v[k] - w[k]) < 1e-6, `${k} is not loop-periodic (L=${L})`);
      }
    }
    assert.equal(at(0).macroA, 0.7);
  }
});
