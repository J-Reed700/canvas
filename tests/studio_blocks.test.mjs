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
