import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, stubFetch, tick, fakeEngine, fakeFrames, framesReply, exportServer } from './fakes.mjs';

installDom();
const { ClipFrames, frameIndex, fnv } = await import('../downbeat/studio/src/engine/clipFrames.ts');
const { checkFootage, HOLD_LIMIT } = await import('../downbeat/studio/src/engine/footage.ts');
const { exportLoop } = await import('../downbeat/studio/src/engine/exporter.ts');
const { planTimeline } = await import('../downbeat/studio/src/engine/timeline.ts');
const { makeSampler } = await import('../downbeat/studio/src/engine/audio.ts');
const { LOOKS } = await import('../downbeat/studio/src/engine/looks.ts');

const asked = (reqs) => reqs.filter((r) => r.path.startsWith('/api/frames/')).map((r) => {
  const u = new URL(r.url, 'http://studio');
  return `${u.pathname.split('/').pop()} ${u.searchParams.get('start')}+${u.searchParams.get('count')}`;
});

test('a clip time maps to the playback-copy frame on screen then', () => {
  assert.equal(frameIndex(0), 0);
  assert.equal(frameIndex(6.3333333), 190, 'a time that rounds just under a frame boundary still lands on it');
  assert.equal(frameIndex(6.35), 190);
  assert.equal(frameIndex(-1), 0);
});

test('frames come from the server a batch at a time, with the next batch already on its way', async () => {
  const reqs = stubFetch({ 'GET /api/frames/*': framesReply() });
  const f = new ClipFrames();
  const a = await f.get('a', 2);
  assert.deepEqual([a.idx, a.w, a.h, a.data.length], [60, 2, 2, 6]);
  assert.equal(a.data[0], (60 * 7 + 97) % 256, 'the bytes of frame 60');
  assert.deepEqual(asked(reqs), ['a 60+30', 'a 90+30']);
  for (let i = 61; i < 75; i++) await f.get('a', i / 30);
  assert.equal(asked(reqs).length, 2, 'the frames in hand cover these');
  await f.get('a', 75 / 30);
  assert.deepEqual(asked(reqs).at(-1), 'a 120+30', 'half way through a batch, the one after next is asked for');
  const again = await f.get('a', 2);
  assert.equal(again.sig, a.sig, 'the same frame twice is the same picture');
  assert.notEqual((await f.get('a', 61 / 30)).sig, a.sig);
  assert.equal(f.last('a'), 359);
});

test('a cut that runs backwards reads the frames before the one it needs', async () => {
  const reqs = stubFetch({ 'GET /api/frames/*': framesReply() });
  const f = new ClipFrames();
  await f.get('a', 200 / 30, 'a#rev');
  await f.get('a', 199 / 30, 'a#rev');
  assert.deepEqual(asked(reqs).slice(2), ['a 170+30', 'a 140+30'], 'once it sees the cut going backwards');
  assert.equal((await f.get('a', 180 / 30, 'a#rev')).idx, 180);
});

test('past the end of a clip its last frame holds', async () => {
  const reqs = stubFetch({ 'GET /api/frames/*': framesReply({ total: 100 }) });
  const f = new ClipFrames();
  assert.equal((await f.get('a', 50)).idx, 99, 'the server clamps the first request');
  assert.equal(f.last('a'), 99);
  assert.equal((await f.get('a', 40)).idx, 99, 'later requests are clamped here');
  const n = asked(reqs).length;
  for (let i = 0; i < 40; i++) assert.equal((await f.get('a', 40 + i / 30)).idx, 99);
  assert.equal(asked(reqs).length, n, 'and need nothing more from the server');
});

test('when the server sends fewer frames than asked, the rest are asked for again', async () => {
  const short = framesReply();
  const reqs = stubFetch({ 'GET /api/frames/*': (url) => short(url.replace(/count=\d+/, 'count=10')) });
  const f = new ClipFrames();
  assert.equal((await f.get('a', 0)).idx, 0);
  assert.equal((await f.get('a', 15 / 30)).idx, 15);
  assert.ok(asked(reqs).includes('a 10+10'), 'after a short reply it asks for that many');
});

test('checking a clip asks for one frame and leaves the batch size alone', async () => {
  const reqs = stubFetch({ 'GET /api/frames/*': framesReply() });
  const f = new ClipFrames();
  await f.check('a', 1);
  await f.get('a', 2);
  assert.deepEqual(asked(reqs), ['a 30+1', 'a 60+30', 'a 90+30']);
});

test('a frame the server cannot decode fails with the clip name and the reason', async () => {
  stubFetch({ 'GET /api/frames/*': () => new Response(JSON.stringify({ error: 'IMG_1.MOV: ffmpeg could not decode frames 0-29: moov atom not found' }), { status: 500 }) });
  const f = new ClipFrames((id) => `${id}.mov`);
  await assert.rejects(f.get('a', 0), /a\.mov: IMG_1\.MOV: ffmpeg could not decode frames 0-29: moov atom not found/);

  stubFetch({ 'GET /api/frames/*': () => new Response(new Uint8Array(5), { headers: { 'X-Frame-Start': '0', 'X-Frame-Count': '1', 'X-Frame-Total': '9', 'X-Frame-Width': '2', 'X-Frame-Height': '2' } }) });
  await assert.rejects(new ClipFrames().get('b', 0), /b: the server sent a broken frame batch/);
});

test('frames of clips not in use are let go once the kept frames pass the budget', async () => {
  stubFetch({ 'GET /api/frames/*': framesReply({ w: 2048, h: 2048 }) });
  const f = new ClipFrames();
  for (const id of ['a', 'b', 'c', 'd']) await f.get(id, 0);
  await tick();
  assert.ok(!f.cache.has('a'), 'the least recently used clip goes first');
  assert.ok(f.cache.has('d'));
});

test('malformed frame metadata cannot poison the decoder cache or trigger repeated requests', async () => {
  const valid = { Start: '0', Count: '1', Total: '9', Width: '2', Height: '2' };
  for (const patch of [{ Start: '-1' }, { Start: '1' }, { Count: '1.5' }, { Total: '0' }, { Total: 'NaN' }, { Width: '-2' }, { Width: '3' }, { Height: '0' }]) {
    const headers = Object.fromEntries(Object.entries({ ...valid, ...patch }).map(([key, value]) => [`X-Frame-${key}`, value]));
    const requests = stubFetch({ 'GET /api/frames/*': () => new Response(new Uint8Array(6), { headers }) });
    const frames = new ClipFrames();
    await assert.rejects(frames.check('a', 0), /broken frame batch/);
    assert.equal(requests.length, 1);
    assert.equal(frames.totals.size, 0);
  }
});

// -- the footage check ------------------------------------------------------------------------------

const clip = (name, o = {}) => () => ({ name, ...o });
// One cut of `n` frames: idx(i) is the clip frame asked for, sig(i) the picture, gpu(i) what landed.
const cut = (n, { vkey = 'a#0', from = 0, idx = (i) => i, sig = (i) => i + 1, gpu } = {}) =>
  Array.from({ length: n }, (_, i) => ({ frame: from + i, vkey, clipId: vkey.split('#')[0], idx: idx(i), sig: sig(i), gpu: (gpu || sig)(i) }));

test('footage that plays passes', () => {
  const r = checkFootage([...cut(48), ...cut(48, { vkey: 'b#1', from: 48 })], clip('IMG_1.MOV'));
  assert.deepEqual([r.level, r.cuts], ['ok', 2]);
  assert.equal(r.detail, 'checked 2 cuts: every clip plays');
});

test('a cut that asks for one frame the whole time fails and says why', () => {
  const n = Math.round(HOLD_LIMIT * 30);
  let r = checkFootage(cut(n, { idx: () => 1799, sig: () => 5 }), clip('IMG_1.MOV', { last: 1799 }));
  assert.equal(r.level, 'fail');
  assert.match(r.detail, /^0:00\.0 for 1\.5 s: starts or runs past the end of IMG_1\.MOV's footage \(1:00\.0\) and holds its last frame/);
  assert.match(r.detail, /pick an earlier start point/);

  r = checkFootage(cut(n, { idx: () => 300, sig: () => 5 }), clip('IMG_1.MOV', { last: 1799 }));
  assert.match(r.detail, /holds frame 0:10\.0 of IMG_1\.MOV: the speed settings for this cut stop the footage/);
  r = checkFootage(cut(n, { idx: () => 0, sig: () => 5 }), clip('IMG_1.MOV'));
  assert.match(r.detail, /holds the first frame of IMG_1\.MOV: the cut runs backwards past the clip's start, or its speed stops the footage/);

  r = checkFootage(cut(n - 1, { idx: () => 300, sig: () => 5 }), clip('IMG_1.MOV'));
  assert.equal(r.level, 'ok', 'a shorter hold is a speed ramp doing its job');
});

test('new frames that never reach the GPU fail the export', () => {
  const r = checkFootage(cut(60, { gpu: () => 42 }), clip('IMG_4496.MOV'));
  assert.equal(r.level, 'fail');
  assert.equal(r.issues[0].clip, 'IMG_4496.MOV');
  assert.match(r.detail, /^0:00\.0 for 2\.0 s: 60 different frames of IMG_4496\.MOV were decoded, but the browser kept drawing the same picture$/);
});

test('footage that is itself still is a warning, and photos are left alone', () => {
  let r = checkFootage(cut(60, { from: 30, sig: () => 9 }), clip('screen.mov'));
  assert.equal(r.level, 'warn');
  assert.match(r.detail, /^0:01\.0 for 2\.0 s: screen\.mov itself doesn't change from 0:00\.0 to 0:02\.0$/);
  r = checkFootage(cut(60, { idx: () => 3, sig: () => 9 }), clip('cover.jpg', { still: true }));
  assert.equal(r.level, 'ok');
});

test('the detail names the first three problems and counts the rest', () => {
  const frozen = [0, 1, 2, 3, 4].flatMap((k) => cut(60, { vkey: `c${k}#${k}`, from: 60 * k, gpu: () => 7 }));
  const r = checkFootage(frozen, clip('x.mov'));
  assert.equal(r.issues.length, 5);
  assert.equal(r.detail.split('; ').length, 4);
  assert.match(r.detail, /; and 2 more$/);
});

// -- the exporter runs the check --------------------------------------------------------------------

function ctxOf(L, clips) {
  const beatDur = 0.5;
  const tl = planTimeline({ L, beatDur, clips, rhythm: 'bar', transitions: ['cut'], transBeats: 0, seed: 3 });
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur, seed: 1, L });
  const durs = new Map(clips.map((c) => [c.id, c.duration]));
  return { look: LOOKS[0], tl, sampler, clipDur: (id) => durs.get(id), L, beatDur, seed: 1 };
}

test('an export whose clip frames never reach the GPU reports the frozen cuts', async () => {
  const reqs = exportServer();
  const ctx = ctxOf(8, [{ id: 'a', duration: 30 }, { id: 'b', duration: 30 }]);
  const out = await exportLoop({ engine: fakeEngine(undefined, { stale: true }), frames: fakeFrames(), clips: (id) => ({ name: `${id}.mov` }), ctx, width: 8, height: 8, meta: {} });
  const stats = JSON.parse(reqs.at(-1).body).stats;
  assert.equal(stats.footage.level, 'fail');
  assert.match(stats.footage.detail, /different frames of (a|b)\.mov were decoded, but the browser kept drawing the same picture/);
  assert.equal(out.footage.issues.length, out.footage.cuts);

  exportServer();
  const ok = await exportLoop({ engine: fakeEngine(), frames: fakeFrames({ still: ['b'] }), clips: (id) => ({ name: `${id}.mov`, still: id === 'b' }), ctx, width: 8, height: 8, meta: {} });
  assert.equal(ok.footage.level, 'ok', 'a photo standing still is fine');
});

test('the frame hash samples the bytes it is told to', () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  assert.equal(fnv(a), fnv(new Uint8Array([1, 2, 3, 4])));
  assert.notEqual(fnv(a), fnv(new Uint8Array([1, 2, 3, 5])));
  assert.equal(fnv(a, 2), fnv(new Uint8Array([1, 9, 3, 9]), 2));
});
