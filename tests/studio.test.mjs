import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimeline, sampleTimeline, clipTime, cameraFor, loopBeats, velocityAt, RHYTHMS, DIRECTIONS, VELOCITY } from '../downbeat/studio/timeline.ts';
import { compose, resolveParams } from '../downbeat/studio/composer.ts';
import { flashesPerSecond } from '../downbeat/studio/exporter.ts';
import { LOOKS, chaosLook, evolveLook, mutate, randomLook } from '../downbeat/studio/looks.ts';
import { CAMERA, FINISH_DEF, MODULES, moduleSource, buildStageSource } from '../downbeat/studio/modules.ts';
import { TRANSITIONS } from '../downbeat/studio/shaders.ts';
import { makeSampler, withLook, lfoAt, lfoCycles, LFO_SHAPES, LFO_RATES } from '../downbeat/studio/audio.ts';
import { MOD_SOURCES } from '../downbeat/studio/modules.ts';

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
    const at = (t) => withLook(sampler(t), look, (t % L) / L, t / base.beatDur, L / base.beatDur);
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
