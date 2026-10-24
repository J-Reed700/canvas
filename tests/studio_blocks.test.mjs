import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimeline, generateBlocks, resolve, sampleTimeline, cameraFor, frameAt, moveAt, rng, RHYTHMS } from '../downbeat/studio/src/engine/timeline.ts';

const FPS = 30;
const clips = [{ id: 'a', duration: 12 }, { id: 'b', duration: 9 }, { id: 'c', duration: 20 }];
const base = { L: 6.4, beatDur: 0.4, clips, transitions: ['dissolve', 'zoom'], transBeats: 1, seed: 7, rhythm: 'bar' };

test('the rolled edit is its blocks resolved, with ids g0, g1… and cuts where the rhythm puts them', () => {
  for (const rhythm of Object.keys(RHYTHMS)) {
    const opts = { ...base, rhythm };
    const blocks = generateBlocks(opts);
    const tl = planTimeline(opts);
    assert.deepEqual(resolve(blocks, opts), tl, rhythm);
    assert.deepEqual(tl.segs.map((s) => s.id), blocks.map((_, k) => `g${k}`), rhythm);
    assert.deepEqual(tl.blocks.map((b) => b.slot), blocks.map((_, k) => k), rhythm);
    assert.equal(tl.handCut, false, rhythm);
    for (const s of tl.segs) assert.ok(Math.abs(s.t0 / base.beatDur - blocks[s.i].at) < 1e-9, `${rhythm} block ${s.i} is in beats`);
  }
});

test('blocks keep their own order, stay inside the loop and fall back to clips in turn', () => {
  const blocks = generateBlocks(base);
  const moved = [blocks[2], { ...blocks[0] }, blocks[1], { ...blocks[3], at: 99 }];
  const tl = resolve(moved, base);
  assert.deepEqual(tl.segs.map((s) => s.id), ['g0', 'g1', 'g2'], 'sorted, and one past the end is dropped');
  assert.equal(tl.segs.at(-1).t1, base.L);
  assert.equal(tl.handCut, true);
  const lost = resolve(blocks.map((b) => ({ ...b, clipId: 'gone' })), base);
  assert.deepEqual(lost.segs.map((s) => s.clipId), ['a', 'b', 'c', 'a'], 'a clip that left the edit is covered by the clips in turn');
});

test('a block that grows past its footage starts earlier in its clip', () => {
  const blocks = generateBlocks({ ...base, clips: [{ id: 'a', duration: 3 }] });
  const grown = [{ ...blocks[0], in: 2.5 }, blocks[3]];
  const seg = resolve(grown, { ...base, clips: [{ id: 'a', duration: 3 }] }).segs[0];
  assert.ok(Math.abs(seg.dur - 4.8) < 1e-9);
  assert.equal(seg.in, 0, 'the clip is shorter than the block, so it starts at the top');
  const roomy = resolve([{ ...blocks[0], in: 9 }], base).segs[0];
  assert.ok(Math.abs(roomy.in - (12 - 6.4 - 0.1)) < 1e-9, 'slides back just far enough to fill the block');
});

test('each cut has its own transition length, held to 90% of the shorter segment either side', () => {
  const blocks = generateBlocks({ ...base, rhythm: 'build' }); // 8, 4, 2, 1, 1 beats
  const tl = resolve(blocks.map((b, k) => (k === 1 ? { ...b, transBeats: 8 } : b)), { ...base, rhythm: 'build', transBeats: 2 });
  const bd = base.beatDur;
  assert.deepEqual(tl.segs.map((s) => +(s.dur / bd).toFixed(6)), [8, 4, 2, 1, 1]);
  assert.ok(Math.abs(tl.segs[1].transDur - 0.9 * 4 * bd) < 1e-9, 'asked for 8 beats, held to the 4-beat segment');
  assert.ok(Math.abs(tl.segs[2].transDur - 0.9 * 2 * bd) < 1e-9, '2 beats asked, 2-beat segment');
  assert.ok(Math.abs(tl.segs[0].transDur - 0.9 * bd) < 1e-9, 'the seam is held by the 1-beat segment at the end');
  const hard = resolve(blocks.map((b, k) => (k === 2 ? { ...b, trans: 'cut' } : b)), base);
  assert.equal(hard.segs[2].transDur, 0, 'a hard cut has no window');
});

test('transition windows never overlap, so at most two segments are ever on screen', () => {
  const r = rng(11);
  const pool = ['dissolve', 'zoom', 'cut'];
  for (let trial = 0; trial < 200; trial++) {
    const L = 0.5 * 4 * (1 + Math.floor(r() * 4));
    const opts = { ...base, L, beatDur: 0.5, transBeats: r() * 4 };
    const ats = [0];
    for (let at = 0.25 + Math.floor(r() * 8) * 0.25; at < L / 0.5; at += 0.25 + Math.floor(r() * 8) * 0.25) ats.push(at);
    const blocks = ats.map((at, k) => ({ id: `x${k}`, at, clipId: 'c', in: 1, seed: k, trans: pool[Math.floor(r() * 3)], transBeats: r() < 0.5 ? r() * 8 : undefined }));
    const tl = resolve(blocks, opts);
    const n = tl.segs.length;
    for (const [k, s] of tl.segs.entries()) {
      const prev = tl.segs[(k - 1 + n) % n];
      assert.ok(s.transDur <= 0.9 * Math.min(s.dur, prev.dur) + 1e-9, `trial ${trial} cut ${k}`);
    }
    for (let f = 0; f < L * FPS; f++) {
      const t = (((f / FPS) % L) + L) % L; // wrapped as sampleTimeline wraps it
      const open = tl.segs.filter((s) => {
        let d = t - s.t0;
        if (d > L / 2) d -= L;
        if (d < -L / 2) d += L;
        return s.transDur > 1 / 60 && Math.abs(d) < s.transDur / 2;
      });
      assert.ok(open.length <= 1, `trial ${trial} at ${t}: ${open.length} windows`);
      const smp = sampleTimeline(tl, t);
      if (open.length) assert.equal(smp.b.seg, open[0], `trial ${trial} at ${t}`);
      else assert.equal(smp.b, null, `trial ${trial} at ${t}`);
    }
  }
});

test('sample parts are keyed by block id, and a lone block wraps onto its own tail', () => {
  const tl = planTimeline(base);
  const mid = sampleTimeline(tl, tl.segs[1].t0);
  assert.deepEqual([mid.a.key, mid.b.key], ['g0', 'g1']);
  assert.equal(sampleTimeline(tl, tl.segs[2].t0 + 0.5).a.key, 'g2');
  const one = planTimeline({ ...base, clips: [clips[0]], rhythm: 'bar2', L: 3.2 });
  assert.equal(one.segs.length, 1);
  assert.deepEqual([sampleTimeline(one, 0).a.key, sampleTimeline(one, 0).b.key], ['g0:tail', 'g0']);
});

test('frameAt is the framing cameraFor shows for a move', () => {
  const seg = { ...planTimeline(base).segs[1], frame: { a: [0.3, 0.6, 1.2], b: [0.7, 0.4, 2.4], ease: 'smooth' } };
  const cam = { zoom: 1.1, drift: 0.3, shake: 0, sway: 0 };
  for (const local of [0, 0.3, 0.8, seg.dur]) {
    const p = frameAt(seg.frame, moveAt(seg, local));
    const c = cameraFor(seg, local, cam, seg.t0 + local, base.L, 0, 1);
    assert.ok(Math.abs(c.center[0] - p[0]) < 1e-12 && Math.abs(c.center[1] - p[1]) < 1e-12);
    assert.ok(Math.abs(c.zoom - 1.1 * p[2]) < 1e-12);
  }
  assert.deepEqual(frameAt({ a: [0.5, 0.5, 1], b: [0.5, 0.5, 4] }, 0.5), [0.5, 0.5, 2], 'zoom is geometric');
  assert.deepEqual(frameAt({ a: [0.2, 0.3, 1.5] }, 0.7), [0.2, 0.3, 1.5], 'a still framing holds');
});

// ---- block edits ----

const { splitBlock, repeatBlock, insertBlock, removeBlock, moveCut, patchBlock, autoBlock, newId, snapBeat, segAt, MIN_BEATS } = await import('../downbeat/studio/src/engine/blocks.ts');
const { clipTime, VELOCITY } = await import('../downbeat/studio/src/engine/timeline.ts');

const durOf = (id) => clips.find((c) => c.id === id).duration;
const plan = (opts = {}) => {
  const o = { ...base, ...opts };
  const tl = planTimeline(o);
  return { o, tl, blocks: tl.blocks };
};

test('a split keeps the footage running through the new cut, for every ramp and direction', () => {
  for (const velocity of Object.keys(VELOCITY)) {
    for (const direction of ['forward', 'reverse', 'pingpong']) {
      const { o, tl, blocks } = plan({ velocity, direction });
      const seg = tl.segs[1];
      for (const beats of [1, 1.5, 2.25]) {
        const next = resolve(splitBlock(blocks, tl, seg.id, seg.t0 / o.beatDur + beats), o);
        const [l, r] = [next.segs[1], next.segs[2]];
        const at = beats * o.beatDur;
        assert.equal(r.trans, 'cut', 'a split is a hard cut');
        assert.equal(r.vel, seg.vel);
        assert.deepEqual([r.rev, r.pp], [seg.rev, seg.pp]);
        if (direction === 'pingpong') {
          assert.ok(Math.abs(clipTime(l, at, durOf(l.clipId)) - clipTime(r, 0, durOf(r.clipId))) < 1e-9, 'both halves meet at the in-point');
          continue;
        }
        for (let f = 0; f < seg.dur * FPS; f++) {
          const local = f / FPS;
          const was = clipTime(seg, local, durOf(seg.clipId));
          const now = local < at - 1e-9 ? clipTime(l, local, durOf(l.clipId)) : clipTime(r, local - at, durOf(r.clipId));
          assert.ok(Math.abs(now - was) < 1e-9, `${velocity} ${direction} split ${beats} beats in, at ${local}: ${now} vs ${was}`);
        }
      }
    }
  }
});

test('a split keeps the camera where it was: the drift path, and a framing move cut at the split', () => {
  const cam = { zoom: 1.2, drift: 0.4, shake: 0, sway: 0 };
  const { o, tl, blocks } = plan();
  const seg = tl.segs[1];
  const at = 1.25 * o.beatDur;
  const camAt = (tlx, k, local) => cameraFor(tlx.segs[k], local, cam, seg.t0 + local, o.L, 0, o.seed);
  const drifted = resolve(splitBlock(blocks, tl, seg.id, seg.t0 / o.beatDur + 1.25), o);
  for (const [k, local, orig] of [[1, at, at], [2, 0, at], [2, 0.4, at + 0.4], [1, 0.2, 0.2]]) {
    const was = cameraFor(seg, orig, cam, seg.t0 + orig, o.L, 0, o.seed);
    const now = camAt(drifted, k, local);
    assert.ok(Math.abs(now.center[0] - was.center[0]) < 1e-9 && Math.abs(now.zoom - was.zoom) < 1e-9, `drift at ${orig}`);
  }

  const move = { a: [0.3, 0.6, 1.2], b: [0.7, 0.4, 2.4], ease: 'smooth' };
  const framed = patchBlock(blocks, seg.id, { frame: move });
  const ftl = resolve(framed, o);
  const split = splitBlock(framed, ftl, seg.id, seg.t0 / o.beatDur + 1.25);
  const mid = frameAt(move, moveAt(ftl.segs[1], at));
  assert.deepEqual(split[1].frame, { a: move.a, b: mid, ease: 'smooth' });
  assert.deepEqual(split[2].frame, { a: mid, b: move.b, ease: 'smooth' });
  const st = resolve(split, o);
  const end = camAt(st, 1, at), start = camAt(st, 2, 0);
  assert.ok(Math.abs(end.center[0] - start.center[0]) < 1e-12 && Math.abs(end.zoom - start.zoom) < 1e-12, 'the crop meets itself at the cut');

  const held = patchBlock(blocks, seg.id, { frame: { a: [0.4, 0.5, 1.5] } });
  const still = splitBlock(held, resolve(held, o), seg.id, seg.t0 / o.beatDur + 2);
  assert.deepEqual([still[1].frame, still[2].frame], [{ a: [0.4, 0.5, 1.5] }, { a: [0.4, 0.5, 1.5] }], 'a still framing goes to both halves');
  const none = splitBlock(blocks, tl, seg.id, seg.t0 / o.beatDur + 2);
  assert.ok(!('frame' in none[1]) && !('frame' in none[2]));
});

test('a split copies block look overrides to both independent halves', () => {
  const { o, tl, blocks } = plan();
  const seg = tl.segs[1];
  const overrides = { macro: { a: 0.7 }, camera: { shake: 0.4 }, finish: { grain: 0.1 }, layers: { 0: { m: 'glass', p: { scale: 4 } } } };
  const owned = patchBlock(blocks, seg.id, { overrides });
  const ownedTl = resolve(owned, o);
  assert.deepEqual(ownedTl.segs[1].overrides, overrides, 'the resolved segment carries its block settings');
  const split = splitBlock(owned, ownedTl, seg.id, seg.t0 / o.beatDur + 2);
  assert.deepEqual(split[1].overrides, overrides);
  assert.deepEqual(split[2].overrides, overrides);
  assert.notEqual(split[1].overrides.layers[0].p, split[2].overrides.layers[0].p, 'the halves can be edited separately');
  assert.ok(!('overrides' in autoBlock(split, split[1].id)[1]), 'Use look clears the block styling');
});

test('a block camera speed override retimes only that segment', () => {
  const { o, blocks } = plan();
  let next = patchBlock(blocks, 'g1', { overrides: { camera: { speed: 1.75 } } });
  next = patchBlock(next, 'g2', { overrides: { camera: { speed: -4 } } });
  const tl = resolve(next, o);
  assert.equal(tl.segs[0].speed, 1);
  assert.equal(tl.segs[1].speed, 1.75);
  assert.equal(tl.segs[2].speed, 0.25, 'saved data is constrained to the same range as the editor');
  next = patchBlock(next, 'g2', { overrides: { camera: { speed: Number.NaN } } });
  assert.equal(resolve(next, o).segs[2].speed, 1, 'invalid saved data follows the edit speed');
});

test('a split leaves the transitions after it alone, needs room on both sides, and works on the first and only block', () => {
  const { o, tl, blocks } = plan({ rhythm: 'beat' });
  const next = resolve(splitBlock(blocks, tl, 'g3', 3.5), o);
  assert.deepEqual(next.segs.map((s) => s.id).slice(2, 6), ['g2', 'g3', 'h1', 'g4']);
  assert.deepEqual(next.segs.filter((s) => s.id !== 'h1').map((s) => s.trans), tl.segs.map((s) => s.trans), 'every other cut keeps its transition');
  assert.equal(next.handCut, true);
  assert.equal(splitBlock(blocks, tl, 'g3', 3 + MIN_BEATS / 2), null, 'too close to the cut');
  assert.equal(splitBlock(blocks, tl, 'g3', 4 - MIN_BEATS / 2), null, 'too close to the next cut');
  assert.equal(splitBlock(blocks, tl, 'g3', 3 + MIN_BEATS).length, blocks.length + 1);
  const seam = splitBlock(blocks, tl, 'g0', 0.5);
  assert.deepEqual(seam.slice(0, 2).map((b) => [b.id, b.at]), [['g0', 0], ['h1', 0.5]]);
  const one = plan({ clips: [clips[0]], rhythm: 'bar2', L: 3.2 });
  const two = resolve(splitBlock(one.blocks, one.tl, 'g0', 4), one.o);
  assert.deepEqual(two.segs.map((s) => [s.id, s.t0]), [['g0', 0], ['h1', 1.6]]);
  assert.equal(newId(splitBlock(seam, resolve(seam, o), 'h1', 0.75)), 'h3');
});

test('deleting a block lets the one before it play on, the first block hands the seam on, and the last one stays', () => {
  const { o, blocks } = plan();
  const del = resolve(removeBlock(blocks, 'g2'), o);
  assert.deepEqual(del.segs.map((s) => [s.id, +s.t0.toFixed(6), +s.dur.toFixed(6)]), [['g0', 0, 1.6], ['g1', 1.6, 3.2], ['g3', 4.8, 1.6]]);
  const first = resolve(removeBlock(blocks, 'g0'), o);
  assert.deepEqual(first.segs.map((s) => [s.id, +s.t0.toFixed(6)]), [['g1', 0], ['g2', 3.2], ['g3', 4.8]]);
  assert.equal(first.segs[0].trans, 'dissolve', 'the new first block is dealt the seam transition');
  let left = blocks;
  for (const id of ['g3', 'g2', 'g1']) left = removeBlock(left, id);
  assert.equal(removeBlock(left, 'g0'), null, 'the loop needs a block');
  assert.equal(removeBlock(blocks, 'nope'), null);
});

test('repeat plays the first half twice, with a hard cut between', () => {
  const { o, tl, blocks } = plan();
  const seg = tl.segs[2];
  const rep = resolve(repeatBlock(blocks, tl, seg.id), o);
  const [a, b] = [rep.segs[2], rep.segs[3]];
  assert.ok(Math.abs(a.dur - seg.dur / 2) < 1e-9 && Math.abs(b.dur - seg.dur / 2) < 1e-9);
  assert.equal(b.trans, 'cut');
  for (const local of [0, 0.2, 0.7]) assert.ok(Math.abs(clipTime(a, local, durOf(a.clipId)) - clipTime(b, local, durOf(b.clipId))) < 1e-9);
  assert.deepEqual(b.span, a.span, 'the camera repeats too');
});

test('insert puts a clip in from a beat to the next cut and deals it the next transition', () => {
  const { o, tl, blocks } = plan();
  const ins = resolve(insertBlock(blocks, tl, 'g1', 6, 'c', 3.5), o);
  const s = ins.segs[2];
  assert.deepEqual([s.id, s.clipId, s.in, +s.t0.toFixed(6), +s.t1.toFixed(6)], ['h1', 'c', 3.5, 2.4, 3.2]);
  assert.notEqual(s.trans, 'cut');
  assert.equal(s.trans, o.transitions[(tl.blocks[1].slot + 1) % 2]);
  assert.deepEqual(s.span, [0, 1], 'its own drift path');
  assert.ok(Math.abs(ins.segs[1].t1 - 2.4) < 1e-9);
});

test('trimming a cut snaps to the beat, the half or the quarter, keeps a step from its neighbours, and never moves the seam', () => {
  const { o, blocks } = plan();
  const end = o.L / o.beatDur;
  const at = (bs) => bs.find((b) => b.id === 'g2').at;
  assert.equal(at(moveCut(blocks, 'g2', 9.4, 1, end)), 9);
  assert.equal(at(moveCut(blocks, 'g2', 9.4, 2, end)), 9.5);
  assert.equal(at(moveCut(blocks, 'g2', 9.4, 4, end)), 9.5);
  assert.equal(at(moveCut(blocks, 'g2', 9.3, 4, end)), 9.25);
  assert.equal(at(moveCut(blocks, 'g2', 9.37, 0, end)), 9.37, 'off the grid');
  assert.equal(at(moveCut(blocks, 'g2', 2, 1, end)), 5, 'a beat after the cut before');
  assert.equal(at(moveCut(blocks, 'g2', 20, 4, end)), 11.75, 'a quarter beat before the next cut');
  assert.equal(moveCut(blocks, 'g2', 8.1, 1, end), blocks, 'nothing moved, nothing changed');
  assert.equal(moveCut(blocks, 'g0', 1, 1, end), null, 'the seam stays put');
  assert.equal(snapBeat(2.6, 0), 2.6);
});

test('patching sets and clears what a block does, and auto hands it back to the look', () => {
  const { o, blocks } = plan();
  const set = patchBlock(blocks, 'g1', { trans: 'zoom', transBeats: 2, vel: 'surge', dir: 'reverse', frame: { a: [0.5, 0.5, 2] } });
  const seg = resolve(set, o).segs[1];
  assert.deepEqual([seg.trans, seg.vel, seg.rev, seg.frame.a[2]], ['zoom', 'surge', true, 2]);
  assert.ok(Math.abs(seg.transDur - 2 * o.beatDur) < 1e-9);
  assert.ok(!('vel' in patchBlock(set, 'g1', { vel: undefined })[1]));
  assert.deepEqual(autoBlock(set, 'g1')[1], blocks[1]);
  assert.equal(segAt(resolve(set, o), 1.7).id, 'g1');
  assert.equal(segAt(resolve(set, o), -0.1).id, 'g3', 'wraps');
});
