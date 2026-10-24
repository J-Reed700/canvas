import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimeline, resolve, sampleTimeline, clipTime, cameraFor, moveAt, loopBeats, velocityAt, RHYTHMS, DIRECTIONS, VELOCITY } from '../downbeat/studio/src/engine/timeline.ts';
import { segAt } from '../downbeat/studio/src/engine/blocks.ts';
import { compose, resolveParams } from '../downbeat/studio/src/engine/composer.ts';
import { flashesPerSecond } from '../downbeat/studio/src/engine/exporter.ts';
import { LOOKS, chaosLook, evolveLook, mutate, randomLook } from '../downbeat/studio/src/engine/looks.ts';
import { CAMERA, FINISH_DEF, MODULES, moduleSource, buildStageSource } from '../downbeat/studio/src/engine/modules.ts';
import { TRANSITIONS } from '../downbeat/studio/src/engine/shaders.ts';
import { makeSampler, modulationAt, withLook, lfoAt, lfoCycles, LFO_SHAPES, LFO_RATES } from '../downbeat/studio/src/engine/audio.ts';
import { MOD_SOURCES } from '../downbeat/studio/src/engine/modules.ts';

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
});

test('a five-minute loop keeps cutting on the beat and stays inside its footage', () => {
  const L = base.beatDur * 4 * 188; // 188 bars at 150 BPM, about 5 minutes
  const tl = planTimeline({ ...base, L, rhythm: 'bar' });
  assert.equal(tl.segs.length, 188);
  assert.ok(Math.abs(tl.segs.at(-1).t1 - L) < 1e-6);
  const durs = new Map(clips.map((c) => [c.id, c.duration]));
  for (const s of tl.segs) assert.ok(s.in >= 0 && s.in + s.dur * s.speed <= durs.get(s.clipId) + 1e-6, `cut ${s.i} runs past its clip`);
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 1, L });
  const ctx = { look: LOOKS[0], tl, sampler, clipDur: (id) => durs.get(id), L, beatDur: base.beatDur, seed: 1 };
  for (const t of [0, L / 3, L - 1 / FPS]) assert.equal(compose(ctx, t).seg.a.seg.clipId, sampleTimeline(tl, t).a.seg.clipId);
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

test("a segment's own framing replaces the drift, holding still or moving from start to end", () => {
  const seg0 = planTimeline({ ...base, rhythm: 'bar' }).segs[1];
  const cam = { zoom: 1.1, drift: 1, shake: 0, sway: 0 };
  const at = (frame, local) => cameraFor({ ...seg0, focus: [0.2, 0.2, 2], frame }, local, cam, 0, base.L, 0, 1);
  const still = at({ a: [0.3, 0.6, 1.5] }, seg0.dur * 0.7);
  assert.deepEqual(still.center, [0.3, 0.6]);
  assert.ok(Math.abs(still.zoom - 1.1 * 1.5) < 1e-12, 'no drift zoom, no clip framing');

  const move = { a: [0.3, 0.5, 1], b: [0.7, 0.5, 2], ease: 'smooth' };
  assert.deepEqual(at(move, -0.2).center, [0.3, 0.5], 'holds the start through the transition in');
  assert.deepEqual(at(move, seg0.dur + 0.2).center, [0.7, 0.5], 'and the end through the transition out');
  const mid = at(move, seg0.dur / 2);
  assert.ok(Math.abs(mid.center[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(mid.zoom - 1.1 * Math.SQRT2) < 1e-12, 'zoom moves at an even rate to the eye');
  // smooth eases out of the start; steady doesn't
  assert.ok(at(move, seg0.dur * 0.1).center[0] - 0.3 < 0.4 * 0.1);
  assert.ok(Math.abs(at({ ...move, ease: 'linear' }, seg0.dur * 0.1).center[0] - (0.3 + 0.04)) < 1e-12);
});

test('an on-the-beat move steps once a beat and holds in between', () => {
  const seg = { ...planTimeline({ ...base, rhythm: 'bar' }).segs[1], frame: { a: [0.5, 0.5, 1], b: [0.5, 0.5, 2], ease: 'beats' } };
  const bd = base.beatDur;
  assert.equal(seg.dur / bd, 4);
  assert.equal(moveAt(seg, 0), 0);
  for (let k = 0; k < 4; k++) {
    assert.ok(Math.abs(moveAt(seg, k * bd + bd * 0.36) - (k + 1) / 4) < 1e-12, `beat ${k + 1} lands early`);
    assert.ok(Math.abs(moveAt(seg, k * bd + bd * 0.9) - (k + 1) / 4) < 1e-12, `and holds`);
  }
  let prev = 0;
  for (let t = 0; t <= seg.dur; t += bd / 40) {
    const m = moveAt(seg, t);
    assert.ok(m >= prev - 1e-12, `never steps back at ${t}`);
    prev = m;
  }
  assert.equal(moveAt(seg, seg.dur), 1);
});

test('camera shake rattles within a step and repeats exactly at the loop seam', () => {
  const seg = planTimeline({ ...base, rhythm: 'bar' }).segs[0];
  const cam = { zoom: 1.06, drift: 0, shake: 1, sway: 0 };
  const at = (t) => cameraFor(seg, 0.1, cam, t, base.L, t / base.beatDur, 1).shake;
  for (let i = 0; i < 2; i++) assert.ok(Math.abs(at(0)[i] - at(base.L)[i]) < 1e-9);
  // over one sixteenth (3 frames at 30 fps here) the frame has to move noticeably, or a short hit reads as a nudge
  const step = base.beatDur / 4;
  let moved = 0;
  for (let t = 0; t < base.L; t += step) moved = Math.max(moved, Math.hypot(at(t + step)[0] - at(t)[0], at(t + step)[1] - at(t)[1]));
  assert.ok(moved > 0.01, `moved ${moved}`);
});

test('a step hit decays over a few frames instead of cutting off at the next step', () => {
  const look = { ...LOOKS[0], seq: [1, ...Array(15).fill(0)] };
  const seqAt = (steps) => withLook({}, look, 0, steps / 4).seq;
  assert.equal(seqAt(0), 1);
  assert.ok(seqAt(0.999) > 0.25 && Math.abs(seqAt(1) - seqAt(0.999)) < 0.01);
  assert.ok(seqAt(3) < 0.05);
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

test('route shaping is periodic and deterministic across seeks, with gate and sidechain ducking', () => {
  const L = 2, beatDur = 0.25;
  const sampler = (t) => {
    const u = ((t % L) + L) % L / L;
    return { kick: u < 0.2 ? 1 : 0.1, bass: u >= 0.45 && u < 0.8 ? 1 : 0 };
  };
  const look = LOOKS[0];
  const current = (t) => withLook(sampler(t), look, t / L, t / beatDur, L / beatDur);
  const shaped = { src: 'kick', amt: 0.5, attack: 80, decay: 300, gate: 0.2, duck: { src: 'bass', amount: 0.75 } };
  const plain = { ...shaped, duck: undefined };
  const at = (route, t) => modulationAt(route, sampler, look, t, L, beatDur, current(t));
  const times = [1.7, 0, 0.03, 0.5, 0.92, 1.2, 0.2];
  const outOfOrder = new Map(times.map((t) => [t, at(shaped, t)]));
  for (const t of [...times].sort((a, b) => a - b)) assert.equal(at(shaped, t), outOfOrder.get(t), `seek at ${t}`);
  assert.equal(at(shaped, 0), at(shaped, L), 'the shaped envelope closes exactly at the loop');
  assert.ok(at(shaped, 0.03) < 1, 'attack softens the leading edge');
  assert.ok(at(shaped, 0.5) > 0, 'decay holds the falling edge after the gated source closes');
  assert.ok(at(shaped, 1.2) < at(plain, 1.2), 'the bass sidechain ducks the route');
  assert.equal(modulationAt({ src: 'kick', amt: 1 }, sampler, look, 1, L, beatDur, current(1)), current(1).kick, 'old routes read the exact old source');
});

test('a dense look keeps more than 24 shaped routes hot between rendered frames', () => {
  let reads = 0;
  const L = 0.5, beatDur = 0.125;
  const sampler = (t) => { reads++; return { kick: ((t % L) + L) % L < L / 2 ? 1 : 0 }; };
  const routes = Array.from({ length: 40 }, (_, i) => ({ src: 'kick', amt: 0.2, attack: 10 + i * 5, decay: 80 }));
  const current = withLook(sampler(0.2), LOOKS[0], 0.4, 0.2 / beatDur, L / beatDur);
  for (const route of routes) modulationAt(route, sampler, LOOKS[0], 0.2, L, beatDur, current);
  const afterFirstFrame = reads;
  for (const route of routes) modulationAt(route, sampler, LOOKS[0], 0.21, L, beatDur, current);
  assert.equal(reads, afterFirstFrame, 'the next frame reuses the whole active route working set');
});

test('audio motion clocks only advance, seek deterministically and close their normalized loop', () => {
  const L = base.L;
  const make = () => makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 19, L });
  const sampler = make();
  const ordered = Array.from({ length: 193 }, (_, i) => sampler(i * L / 192));
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i].audioTime > ordered[i - 1].audioTime, `audio clock ${i}`);
    assert.ok(ordered[i].bassTime > ordered[i - 1].bassTime, `bass clock ${i}`);
  }
  assert.equal(ordered[0].audioTime, 0);
  assert.equal(ordered.at(-1).audioTime, L);
  assert.equal(ordered.at(-1).bassTime, L);
  assert.equal(ordered.at(-1).audioPhase, 0);
  assert.equal(ordered.at(-1).bassPhase, 0);
  const bassSteps = ordered.slice(1).map((v, i) => v.bassTime - ordered[i].bassTime);
  assert.ok(Math.max(...bassSteps) > Math.min(...bassSteps) * 1.1, 'bass changes speed instead of multiplying time and reversing');
  const randomOrder = [4.9, 0.2, 3.1, 6.2, 1.4];
  const a = randomOrder.map((t) => sampler(t).bassTime);
  const fresh = make();
  const b = randomOrder.map((t) => fresh(t).bassTime);
  assert.deepEqual(a, b, 'render invocation order does not affect the clock');
});

test('block overrides reach macros, indexed layers, camera, finish and shader clocks', () => {
  const look = structuredClone(LOOKS[0]);
  const baseTl = planTimeline({ ...base, rhythm: 'bar' });
  const blocks = baseTl.blocks.map((b, i) => i === 1 ? {
    ...b,
    overrides: {
      macro: { a: 0.8 },
      camera: { drift: 0.91 },
      finish: { exposure: 1.25 },
      layers: {
        0: { m: look.layers[0].m, p: { scale: 5.5 } },
        1: { m: 'wrong-module', p: { mix: 0 } },
      },
    },
  } : b);
  const tl = resolve(blocks, { ...base, rhythm: 'bar' });
  const lut = { name: 'Test', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: '' };
  look.finish.lut = lut;
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 1, L: base.L });
  const ctx = { look, tl, sampler, clipDur: () => 20, L: base.L, beatDur: base.beatDur, seed: 1 };
  const seg = tl.segs[1];
  const fr = compose(ctx, seg.t0 + seg.dur * 0.6);
  assert.equal(fr.mv.macroA, 0.8);
  assert.equal(fr.camera.p_drift, 0.91);
  assert.equal(fr.finish.p_exposure, 1.25);
  assert.equal(fr.layers.length, 0, 'the block stack runs on its clip before transitions');
  assert.equal(fr.pre[0][0].params.p_scale, 5.5);
  assert.equal(fr.pre[0][1].params.p_mix, look.layers[1].p.mix, 'a module identity mismatch is ignored');
  assert.equal(fr.lut, lut);
  for (const key of ['uAudioTime', 'uBassTime', 'uAudioPhase', 'uBassPhase']) assert.ok(Number.isFinite(fr.globals[key]), key);
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

test("FX intensity past 100% turns up each layer's strength settings, but not its shape", () => {
  const tl = planTimeline({ ...base, rhythm: 'bar' });
  const sampler = () => ({ kick: 0, snare: 0, hats: 0, bass: 0, energy: 0, bright: 0, beat: 0, bar: 0, lfo: 0, rand: 0 });
  const look = {
    ...LOOKS[0],
    layers: [
      { m: 'bloom', on: true, p: { intensity: 0.5, radius: 0.4 } },
      { m: 'kaleido', on: true, p: { zoom: 1.2, slices: 6 } },
      { m: 'vortex', on: true, p: { twist: -0.4 } },
      { m: 'chroma', on: true, p: { amount: 0.8 } },
    ],
  };
  const at = (intensity) => compose({ look, tl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1, intensity }, 1).layers.map((l) => l.params);
  const [bloom1, kal1, vort1] = at(1);
  const [bloom, kal, vort, chroma] = at(1.8);
  assert.ok(Math.abs(bloom.p_intensity - 0.9) < 1e-9);
  assert.equal(bloom.p_radius, bloom1.p_radius, 'the glow gets brighter, not wider');
  assert.equal(kal.p_zoom, kal1.p_zoom);
  assert.equal(kal.p_slices, kal1.p_slices);
  assert.ok(Math.abs(vort.p_twist - -0.72) < 1e-9, 'a twist the other way gets stronger the other way');
  assert.equal(chroma.p_amount, 1, 'held to the slider range');
  assert.equal(vort1.p_twist, -0.4);
  // below 100% the settings stay as set and the layer fades instead
  const [half] = at(0.5);
  assert.equal(half.p_intensity, 0.5);
  assert.equal(half.uWet, 0.5);
});

test('Show every clip splits the longest cuts on the grid until each clip has one', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, duration: 30 }));
  const opts = { ...base, clips: six, rhythm: 'bar' };
  assert.equal(planTimeline(opts).segs.length, 4, 'four bars, four cuts, two clips left out');
  const tl = planTimeline({ ...opts, fitAll: true });
  assert.equal(tl.segs.length, 6);
  assert.equal(new Set(tl.segs.map((s) => s.clipId)).size, 6);
  assert.deepEqual(tl.segs.map((s) => +(s.t0 / base.beatDur).toFixed(6)), [0, 2, 4, 6, 8, 12], 'the earliest of the longest cuts is split first');
  assert.equal(tl.handCut, false, "the split cuts are the rhythm's own");
  for (const s of tl.segs) assert.ok(s.in + s.dur * s.speed <= 30 + 1e-6);

  // a rhythm that already gives every clip a cut is left as it is
  const beat = (fitAll) => planTimeline({ ...opts, rhythm: 'beat', fitAll }).segs.map((s) => s.t0);
  assert.deepEqual(beat(true), beat(false));

  // past whole beats it splits on half and quarter beats, and a quarter beat is as short as a cut gets
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, duration: 30 }));
  const tiny = planTimeline({ ...base, L: base.beatDur, clips: nine, rhythm: 'bar', fitAll: true });
  assert.deepEqual(tiny.segs.map((s) => +(s.t0 / base.beatDur).toFixed(6)), [0, 0.25, 0.5, 0.75]);
});

test('a Rebound loop plays its edit forward, then backward, and meets itself at the seam', () => {
  const half = base.L / 2;
  const tl = planTimeline({ ...base, L: half, rhythm: 'half', rebound: true });
  assert.equal(tl.rebound, true);
  assert.deepEqual([tl.segs[0].trans, tl.segs[0].transDur], ['cut', 0], 'nothing to hide at the seam');
  assert.ok(tl.segs.slice(1).every((s) => s.transDur > 0), 'the other cuts keep their transitions');

  // the second half mirrors the first, transitions included
  // (sampled off the frame grid, so no sample sits exactly on a transition's edge)
  const N = Math.round(base.L * FPS);
  for (let i = 0; i < N / 2; i++) {
    const f = sampleTimeline(tl, (i + 0.37) / FPS);
    const b = sampleTimeline(tl, base.L - (i + 0.37) / FPS);
    assert.equal(f.back, false);
    assert.equal(b.back, true);
    assert.equal(b.a.seg.id, f.a.seg.id, `frame ${i}`);
    assert.ok(Math.abs(b.a.local - f.a.local) < 1e-6, `frame ${i}`);
    assert.equal(b.trans, f.trans);
    if (f.b) assert.ok(Math.abs(b.p - f.p) < 1e-6);
  }

  // the footage turns round in the middle and runs back into the first frame
  const clipAt = (t) => {
    const s = sampleTimeline(tl, t);
    return [s.a.key, clipTime(s.a.seg, s.a.local, 60)];
  };
  const [k0, c0] = clipAt(0);
  const [kEnd, cEnd] = clipAt(base.L - 1 / FPS);
  assert.equal(kEnd, k0);
  assert.ok(Math.abs(cEnd - c0 - 1 / FPS) < 1e-6, 'one frame away from the first frame, the other side of the seam');
  const [kIn, cIn] = clipAt(half - 1 / FPS);
  const [kOut, cOut] = clipAt(half + 1 / FPS);
  assert.equal(kIn, kOut);
  assert.ok(Math.abs(cIn - cOut) < 1e-6);
  assert.equal(segAt(tl, half + 1e-3).id, tl.segs.at(-1).id, 'the turn belongs to the last block');
  assert.equal(segAt(tl, base.L - 0.05).id, tl.segs[0].id);

  // the backward half is previewed by seeking, since a video can't play backward
  const ctx = { look: LOOKS[0], tl, sampler: makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 1, L: base.L }), clipDur: () => 60, L: base.L, beatDur: base.beatDur, seed: 1 };
  assert.equal(compose(ctx, 0.1).needs[0].rev, false);
  assert.equal(compose(ctx, base.L - 0.1).needs[0].rev, true);
  assert.equal(compose(ctx, base.L - 0.1).globals.uTime, base.L - 0.1, 'the effects and the music keep going forward');
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
  for (const L of [base.beatDur * 4, base.beatDur * 16, base.beatDur * 20, base.beatDur * 32]) {
    const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 3, L });
    const look = { ...LOOKS[0], env: [0, 1, 0.2, 0.9, 0.5, 0, 1, 0.3], seq: Array.from({ length: 16 }, (_, i) => i % 3 === 0 ? 1 : 0), macro: { a: 0.7, b: 0.2 } };
    const at = (t) => withLook(sampler(t), look, (t % L) / L, t / base.beatDur, L / base.beatDur);
    for (let i = 0; i < 97; i++) {
      const t = (i / 97) * L;
      const v = at(t), w = at(t + L);
      for (const k of Object.keys(MOD_SOURCES)) {
        assert.ok(v[k] >= 0 && v[k] <= 1, `${k} = ${v[k]}`);
        if (k !== 'build' && k !== 'rand') assert.ok(Math.abs(v[k] - w[k]) < 1e-6, `${k} is not loop-periodic (L=${L})`);
      }
    }
    // a smooth clock also keeps its direction across the wrap, or it visibly bounces there
    const h = 1e-3;
    for (const k of ['vocals', 'presence', 'lfo', 'lfoH', 'lfo2', 'arc']) {
      const before = at(L - h)[k] - at(L - 2 * h)[k], after = at(h)[k] - at(0)[k];
      assert.ok(Math.abs(before - after) < 1e-4, `${k} turns around at the wrap (L=${L})`);
    }
    assert.equal(at(0).macroA, 0.7);
  }
});

test('vocals and presence modulation sources and seamless loop wrap of makeSampler', () => {
  assert.ok(MOD_SOURCES.vocals);
  assert.equal(MOD_SOURCES.vocals.name, 'Vocals');
  assert.equal(MOD_SOURCES.vocals.short, 'VOC');
  assert.equal(MOD_SOURCES.vocals.color, '#FF94D2');

  assert.ok(MOD_SOURCES.presence);
  assert.equal(MOD_SOURCES.presence.name, 'Presence');
  assert.equal(MOD_SOURCES.presence.short, 'PRS');
  assert.equal(MOD_SOURCES.presence.color, '#80FFE5');

  const L = base.beatDur * 16;
  const synthSampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 5, L });
  const v0 = synthSampler(0);
  const vEnd = synthSampler(L - 1e-4);

  assert.ok(v0.vocals >= 0 && v0.vocals <= 1);
  assert.ok(v0.presence >= 0 && v0.presence <= 1);
  assert.ok(Math.abs(v0.vocals - vEnd.vocals) < 0.01, `vocals seam jump: ${Math.abs(v0.vocals - vEnd.vocals)}`);
  assert.ok(Math.abs(v0.presence - vEnd.presence) < 0.01, `presence seam jump: ${Math.abs(v0.presence - vEnd.presence)}`);

  assert.equal(v0.build, 0);
  assert.ok(vEnd.build < 0.001, `build at end is ${vEnd.build}`);

  assert.equal(v0.bar, 0);
  assert.ok(vEnd.bar < 0.001, `bar at end is ${vEnd.bar}`);

  assert.equal(v0.beat, 0);
  assert.ok(Math.abs(v0.beat - vEnd.beat) < 0.01, `beat jump: ${Math.abs(v0.beat - vEnd.beat)}`);
  assert.ok(Math.abs(v0.off - vEnd.off) < 0.01, `off jump: ${Math.abs(v0.off - vEnd.off)}`);

  const fps = 30;
  const nFrames = Math.round((0 + L + 2) * fps);
  const testCurves = {
    vocals: Array.from({ length: nFrames }, (_, i) => 0.2 + 0.6 * ((i / nFrames) ** 2)),
    presence: Array.from({ length: nFrames }, (_, i) => 0.8 - 0.5 * (i / nFrames)),
    kick: Array.from({ length: nFrames }, (_, i) => (i % 12 === 0 ? 0.9 : 0.05)),
  };
  const realSampler = makeSampler({ features: { curves: testCurves, fps }, loopStart: 0, beatDur: base.beatDur, seed: 1, L });
  const r0 = realSampler(0);
  const rEnd = realSampler(L - 1e-4);
  for (const k of ['vocals', 'presence', 'kick']) {
    assert.ok(Math.abs(r0[k] - rEnd[k]) < 0.02, `real curve ${k} crossfade seam jump: ${Math.abs(r0[k] - rEnd[k])}`);
  }
});

test('broll module shader compilation and composition', () => {
  const broll = MODULES.broll;
  assert.ok(broll, 'broll module exists in MODULES');
  assert.equal(broll.name, 'B-Roll Blend');
  assert.equal(broll.cat, 'space');
  assert.equal(broll.aux, 'clipB');
  const paramIds = broll.params.map((p) => p.id);
  assert.deepEqual(paramIds, ['mode', 'mix', 'thresh', 'soft', 'zoom']);

  const src = moduleSource('broll');
  assert.ok(typeof src === 'string' && src.length > 100);
  assert.ok(src.includes('uniform sampler2D uAux;'), 'contains uAux sampler');
  assert.ok(src.includes('p_mode') && src.includes('p_mix') && src.includes('p_thresh') && src.includes('p_zoom'));
  assert.ok(src.includes('outColor = vec4(mix(a, blended, p_mix), 1.0);'));

  const tl = planTimeline({ ...base, rhythm: 'bar' });
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 1 });
  const lookWithBroll = {
    ...LOOKS[0],
    layers: [{ m: 'broll', on: true, p: { mode: 1, mix: 0.6, thresh: 0.35, soft: 0.15, zoom: 1 } }],
  };

  const ctxMulti = { look: lookWithBroll, tl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1, clips };
  const frMulti = compose(ctxMulti, 0.4);
  assert.ok(frMulti.broll, 'broll descriptor present in compose result');
  assert.equal(frMulti.broll.aux, 'clipB');
  assert.ok(frMulti.needs.some((n) => n.aux === 'clipB'), 'needs includes broll need with aux: clipB');
  assert.equal(frMulti.broll.clipId, tl.segs[1].clipId, 'picks next clip in timeline');
  assert.equal(frMulti.broll.vkey, `${tl.segs[1].clipId}#broll`);

  const singleTl = planTimeline({ ...base, clips: [clips[0]], rhythm: 'bar2' });
  const ctxSingle = { look: lookWithBroll, tl: singleTl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1, clips: [clips[0]] };
  const frSingle = compose(ctxSingle, 0.2);
  assert.ok(frSingle.broll);
  assert.equal(frSingle.broll.clipId, clips[0].id);
  assert.ok(frSingle.needs.some((n) => n.aux === 'clipB'));

  const lookBrollOff = {
    ...LOOKS[0],
    layers: [{ m: 'broll', on: false, p: {} }],
  };
  const frOff = compose({ ...ctxMulti, look: lookBrollOff }, 0.4);
  assert.ok(!frOff.needs.some((n) => n.aux === 'clipB'), 'disabled broll is not added to needs');
});

test('timeline seam transitions prefer smooth transitions and single-clip loop dissolves at wrap', () => {
  const tlCutDissolve = planTimeline({ ...base, transitions: ['cut', 'dissolve'] });
  assert.notEqual(tlCutDissolve.segs[0].trans, 'cut');
  assert.equal(tlCutDissolve.segs[0].trans, 'dissolve');

  const tlHarshSmooth = planTimeline({ ...base, transitions: ['zoom', 'morph'] });
  assert.equal(tlHarshSmooth.segs[0].trans, 'morph');

  const singleCut = planTimeline({ ...base, clips: [clips[0]], transitions: ['cut'], transBeats: 0 });
  const seamSample = sampleTimeline(singleCut, 0);
  assert.ok(seamSample.b, 'single-clip seam at t = 0 is a 2-source blend');
  assert.equal(seamSample.trans, 'dissolve');
  assert.equal(seamSample.p, 0.5);
});

test('audio visualizer module shader compilation, composition, and art looks', () => {
  const vis = MODULES.visualizer;
  assert.ok(vis, 'visualizer module exists in MODULES');
  assert.equal(vis.name, 'Audio Visualizer');
  assert.equal(vis.cat, 'stylize');
  const paramIds = vis.params.map((p) => p.id);
  assert.deepEqual(paramIds, ['mode', 'scale', 'glow', 'hue', 'mix']);
  assert.deepEqual(vis.params[0].opts, ['Ring Spectrum', 'EQ Bars', 'Oscilloscope', 'Dual Horizon']);

  const stageSourceFn = typeof buildStageSource === 'function' ? buildStageSource : moduleSource;
  const src = stageSourceFn('visualizer');
  assert.ok(typeof src === 'string' && src.length > 200, 'shader source generated');
  for (const p of ['p_mode', 'p_scale', 'p_glow', 'p_hue', 'p_mix']) {
    assert.ok(src.includes(p), `shader declares uniform ${p}`);
  }
  assert.ok(src.includes('loopPhase'), 'shader computes seamless loopPhase');
  assert.ok(src.includes('uKick') && src.includes('uBass') && src.includes('uSnare') && src.includes('uHats'), 'audio reactivity uniforms used');
  assert.ok(src.includes('outColor = vec4(mix(c, blended, p_mix), 1.0);'), 'composites over c = tex(vUv)');

  const livingCover = LOOKS.find((l) => l.id === 'art-living-cover');
  assert.ok(livingCover, 'LOOKS contains art-living-cover');
  assert.equal(livingCover.name, 'Living Cover Art');
  assert.equal(livingCover.group, 'art');
  assert.ok(livingCover.layers.some((l) => l.m === 'parallax'));
  assert.ok(livingCover.layers.some((l) => l.m === 'pulse'));
  assert.ok(livingCover.layers.some((l) => l.m === 'bloom'));

  const trackVis = LOOKS.find((l) => l.id === 'art-visualizer');
  assert.ok(trackVis, 'LOOKS contains art-visualizer');
  assert.equal(trackVis.name, 'Track Visualizer');
  assert.equal(trackVis.group, 'art');
  assert.ok(trackVis.layers.some((l) => l.m === 'parallax'));
  assert.ok(trackVis.layers.some((l) => l.m === 'visualizer'));
  assert.ok(trackVis.layers.some((l) => l.m === 'bloom'));

  const tl = planTimeline({ ...base, rhythm: 'bar' });
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 1 });
  for (const lk of [livingCover, trackVis]) {
    const ctx = { look: lk, tl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1 };
    for (const t of [0, 1.2, base.L - 0.05]) {
      const fr = compose(ctx, t);
      assert.ok(fr.layers.length >= 1);
      for (const layer of fr.layers) {
        const m = MODULES[layer.m];
        assert.ok(m, `Module ${layer.m} exists`);
        for (const p of m.params) {
          const val = layer.params[`p_${p.id}`];
          assert.ok(val >= p.min && val <= p.max, `${layer.m}.${p.id}=${val} within [${p.min}, ${p.max}]`);
        }
      }
    }
  }

  for (let m = 0; m < 4; m++) {
    const customLook = {
      ...trackVis,
      layers: [
        {
          m: 'visualizer',
          on: true,
          p: { mode: m, scale: 0.5, glow: 0.8, hue: 0.3, mix: 0.9 },
          mods: { scale: { src: 'kick', amt: 0.1 }, glow: { src: 'energy', amt: 0.2 } },
        },
      ],
    };
    const ctx = { look: customLook, tl, sampler, clipDur: () => 10, L: base.L, beatDur: base.beatDur, seed: 1 };
    const fr = compose(ctx, 0.4);
    assert.equal(fr.layers[0].params.p_mode, m);
    assert.ok(fr.layers[0].params.p_scale >= 0.15 && fr.layers[0].params.p_scale <= 1.0);
  }
});

test('Fractal Tunnel, Prism Echo and Acid Solarize are back, and the classic looks that had them use them again', () => {
  const ports = { fractal: ['Fractal Tunnel', 'space'], prismecho: ['Prism Echo', 'light'], acidsolar: ['Acid Solarize', 'color'] };
  for (const [id, [name, cat]] of Object.entries(ports)) {
    const m = MODULES[id];
    assert.ok(m, id);
    assert.equal(m.name, name);
    assert.equal(m.cat, cat);
    assert.ok(!m.feedback, `${id} needs no frame history`);
    const src = moduleSource(id);
    for (const p of m.params) assert.ok(src.includes(`uniform float p_${p.id};`), `${id}: p_${p.id}`);
    // they move only with the beat or the kick, so every export loops without a seam
    assert.ok(!/uTime|uFrame|uPhase/.test(m.glsl), `${id} uses a free-running clock`);
    assert.ok(/uBeat|beatEnv/.test(m.glsl) && m.glsl.includes('uKick'), `${id} pulses on the beat or the kick`);
  }
  assert.ok(MODULES.fractal.glsl.includes('uScale') && MODULES.prismecho.glsl.includes('uScale'), 'pixel sizes follow the output size');
  const uses = (id) => LOOKS.find((l) => l.id === `classic-${id}`).layers.map((l) => l.m);
  for (const id of ['hypnotic', 'liquid-acid', 'neon-tokyo', 'prism-velocity', 'cosmic-hyperdrive']) assert.ok(uses(id).includes('prismecho'), id);
  for (const id of ['liquid-acid', 'solar-flare']) assert.ok(uses(id).includes('acidsolar'), id);
  assert.ok(uses('cosmic-hyperdrive').includes('fractal'));
});

test('LFOs make whole cycles per loop in every shape, rate and phase, so the seam never jumps', () => {
  for (const loopBeats of [4, 8, 16, 32]) {
    for (const [shape] of LFO_SHAPES) {
      for (const [rate] of LFO_RATES) {
        for (const phase of [0, 0.25, 0.6]) {
          const lfo = { shape, rate, phase, seed: 3 };
          const first = lfoAt(lfo, 0, loopBeats);
          const last = lfoAt(lfo, 1 - 1e-9, loopBeats);
          assert.ok(Math.abs(first - last) < 1e-3, `${shape} ${rate} bars, phase ${phase}, ${loopBeats}-beat loop: ${first} vs ${last}`);
          for (let f = 0; f < 97; f++) {
            const v = lfoAt(lfo, f / 97, loopBeats);
            assert.ok(v >= 0 && v <= 1, `${shape} out of range: ${v}`);
          }
        }
      }
    }
  }
  assert.equal(lfoCycles(1, 16), 4);
  assert.equal(lfoCycles(0.25, 16), 16);
  assert.equal(lfoCycles(4, 4), 1, 'a rate longer than the loop plays once per loop');
  assert.equal(lfoCycles(0, 32), 1);
  const sine = { shape: 'sine', rate: 1, phase: 0 };
  assert.ok(lfoAt(sine, 0, 4) < 1e-9 && Math.abs(lfoAt(sine, 0.5, 4) - 1) < 1e-9, 'sine starts low and peaks mid-cycle');
  assert.ok(Math.abs(lfoAt({ ...sine, phase: 0.5 }, 0, 4) - 1) < 1e-9, 'phase moves the start point');
  const a = lfoAt({ shape: 'random', rate: 1, phase: 0, seed: 1 }, 0.4, 16);
  const b = lfoAt({ shape: 'random', rate: 1, phase: 0, seed: 2 }, 0.4, 16);
  assert.notEqual(a, b, 'a new seed gives a new random pattern');
});

test('looks route LFO A and B through compose like any other source', () => {
  const L = base.beatDur * 16;
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur: base.beatDur, seed: 3, L });
  const look = { ...LOOKS[0], lfos: [{ shape: 'square', rate: 0.5, phase: 0, seed: 1 }, { shape: 'saw', rate: 0, phase: 0, seed: 1 }] };
  const mv = withLook(sampler(L * 0.3), look, 0.3, (L * 0.3) / base.beatDur, 16);
  assert.equal(mv.lfoA, lfoAt(look.lfos[0], 0.3, 16));
  assert.equal(mv.lfoB, lfoAt(look.lfos[1], 0.3, 16));
  const plain = withLook(sampler(0), LOOKS[0], 0, 0, 16);
  assert.ok(plain.lfoA >= 0 && plain.lfoB >= 0, 'looks saved before LFOs existed get the default LFOs');
});
