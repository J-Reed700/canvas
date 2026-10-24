import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeElement, fakeCanvas, recordingContext, stubFetch, tick, fakeEngine, fakeBank, exportServer, FakeEncoder, FakeFrame } from './fakes.mjs';

const dom = installDom();
const { Transport, makeSampler, envAt, ENV_POINTS } = await import('../downbeat/studio/src/engine/audio.ts');
const { VideoBank, waitReady, resolveParams, layerStack } = await import('../downbeat/studio/src/engine/composer.ts');
const { exportLoop } = await import('../downbeat/studio/src/engine/exporter.ts');
const { planTimeline, sampleTimeline } = await import('../downbeat/studio/src/engine/timeline.ts');
const { LOOKS, cloneLook, insertAtStage, STAGE } = await import('../downbeat/studio/src/engine/looks.ts');
const { MODULES } = await import('../downbeat/studio/src/engine/modules.ts');
const { drawLane, drawOverview } = await import('../downbeat/studio/src/canvas/timelineCanvas.ts');

const FPS = 30;
const clips = [{ id: 'a', duration: 12 }, { id: 'b', duration: 9 }, { id: 'c', duration: 20 }];

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.baseLatency = 0.01;
    this.outputLatency = 0.02;
    this.destination = {};
    this.nodes = [];
    FakeAudioContext.last = this;
  }
  createGain() { return { gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, connect() {} }; }
  resume() {}
  createBufferSource() {
    const n = { connect() {}, disconnect() { n.disconnected = true; }, stop() { n.stopped = true; }, start(when, offset) { n.offset = offset; } };
    this.nodes.push(n);
    return n;
  }
  decodeAudioData(data) { return Promise.resolve({ duration: 10, bytes: data.byteLength }); }
}

function withAudio(t) {
  globalThis.window = { AudioContext: FakeAudioContext };
  t.after(() => { delete globalThis.window; });
}

test('without a song the transport keeps time on the clock and wraps it at the loop length', (t) => {
  let now = 100;
  const real = performance.now;
  performance.now = () => now * 1000;
  t.after(() => { performance.now = real; });
  const tr = new Transport();
  const heard = [];
  const off = tr.subscribe(() => heard.push(tr.playing));
  tr.setLoop(0, 4);
  tr.play();
  tr.play();
  now += 5;
  assert.equal(tr.elapsed(), 5);
  assert.equal(tr.loopTime(), 1);
  assert.equal(tr.songTime(), 1);
  tr.toggle();
  now += 3;
  assert.equal(tr.loopTime(), 1, 'paused time stands still');
  off();
  tr.toggle();
  assert.deepEqual(heard, [true, false], 'one notice per change, none after unsubscribing');

  tr.setLoop(0, 4); // unchanged: nothing restarts
  now += 1;
  tr.setLoop(10, 1.5);
  assert.ok(Math.abs(tr.loopTime() - 0.5) < 1e-9, 'the position carries over into the new length');
  assert.ok(Math.abs(tr.songTime() - 10.5) < 1e-9);
  tr.pause();
  tr.seek(1.2);
  assert.ok(Math.abs(tr.loopTime() - 1.2) < 1e-9);
  tr.seek(-3);
  assert.equal(tr.loopTime(), 0);
});

test('listen mode plays through the song from the loop start, offset by its phase', () => {
  const tr = new Transport();
  tr.setLoop(20, 8);
  tr.setMode('listen');
  tr.phase = 2;
  tr.seek(5);
  assert.ok(Math.abs(tr.loopTime() - 5) < 1e-9);
  assert.equal(tr.offset, 3);
  assert.equal(tr.songTime(), 23);
});

test('a looping song is scheduled between the loop points and never past the end of the song', async (t) => {
  withAudio(t);
  const tr = new Transport();
  stubFetch({ '/api/track_audio/t1': () => new Response(new Uint8Array(32)) });
  const buf = await tr.decode('/api/track_audio/t1');
  assert.equal(buf.bytes, 32);
  tr.setBuffer(buf); // 10 s of audio
  tr.setLoop(6, 8);
  tr.offset = 1;
  tr.play();
  const ac = FakeAudioContext.last;
  let node = ac.nodes.at(-1);
  assert.equal(node.loop, true);
  assert.equal(node.loopStart, 6);
  assert.equal(node.loopEnd, 10, 'the audio loop ends where the song does');
  assert.equal(node.offset, 7);
  ac.currentTime = 2;
  assert.ok(Math.abs(tr.elapsed() - (2 + 1 - 0.03)) < 1e-9, 'output latency is taken off');

  tr.setBuffer({ duration: 30 });
  assert.equal(node.stopped, true, 'a new song replaces the playing one');
  node = ac.nodes.at(-1);
  assert.equal(node.loopEnd, 14);

  tr.setMuted(true);
  assert.equal(tr.gain.gain.value, 0);
  tr.setMode('listen');
  node = ac.nodes.at(-1);
  assert.equal(node.loop, undefined);
  tr.pause();
  assert.equal(node.disconnected, true);
  tr.unload();
  assert.equal(tr.buffer, null);
  assert.equal(tr.trackId, null);
});

function bank(onDrop) {
  const root = new FakeElement('div');
  const b = new VideoBank(root, (id) => `/api/proxy/${id}`, onDrop);
  return { root, b };
}

test('the video bank makes one muted element per clip slot and reuses it', () => {
  const { root, b } = bank();
  const e = b.get('a#0');
  assert.equal(b.get('a#0'), e);
  assert.notEqual(b.get('a#1', 'a'), e);
  assert.equal(e.src, '/api/proxy/a');
  assert.equal(e.muted, true);
  assert.equal(e.playsInline, true);
  assert.equal(e.preload, 'auto');
  assert.equal(root.children.length, 2);
});

test('a clip whose proxy is still building is retried a few times', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { b } = bank();
  const e = b.get('a#0');
  e.dispatch('error');
  t.mock.timers.tick(1999);
  assert.equal(e.src, '/api/proxy/a');
  t.mock.timers.tick(1);
  assert.equal(e.src, '/api/proxy/a?retry=1');
  for (let i = 2; i <= 8; i++) { e.dispatch('error'); t.mock.timers.tick(2000 * i); }
  assert.equal(e.src, '/api/proxy/a?retry=6');
});

const need = (vkey, time, o = {}) => ({ vkey, clipId: vkey.split('#')[0], time, rate: 1, rev: false, cam: {}, ...o });

test('preview sync seeks paused video, plays at the clip rate and pauses what is off screen', async () => {
  const { b } = bank();
  const a = b.get('a#0');
  const c = b.get('c#2');
  c.paused = false;
  b.sync([need('a#0', 1)], false);
  assert.deepEqual(a.seeks, [1]);
  assert.equal(c.paused, true, 'clips not on screen stop decoding');
  await tick();

  b.sync([need('a#0', 1.01)], false);
  assert.deepEqual(a.seeks, [1], 'tiny drift is left alone');

  b.sync([need('a#0', 1.5, { rate: 1.5 })], true);
  assert.equal(a.paused, false);
  assert.equal(a.playbackRate, 1.5);
  assert.deepEqual(a.seeks, [1, 1.5]);
  await tick();
  a._t = 1.6;
  b.sync([need('a#0', 1.5, { rate: 1.5 })], true);
  assert.equal(a.seeks.length, 2, 'playing video can drift a little');
  a._t = 2;
  b.sync([need('a#0', 1.5, { rate: 1.5 })], true);
  assert.equal(a.seeks.at(-1), 1.54, 'big drift jumps slightly ahead to catch up');
  await tick();

  b.sync([need('a#0', 0.5, { rev: true })], true);
  assert.equal(a.paused, true, 'reversed clips are stepped by seeking');
  assert.equal(a.seeks.at(-1), 0.5);

  const fresh = b.get('b#1');
  fresh.readyState = 0;
  b.sync([need('b#1', 3)], true);
  assert.deepEqual(fresh.seeks, [], 'nothing to do until the clip has loaded');
  assert.equal(fresh.plays, 0);
});

test('priming parks upcoming clips on their first frame', async () => {
  const { b } = bank();
  const e = b.get('a#3');
  b.prime([need('a#3', 4)]);
  assert.deepEqual(e.seeks, [4]);
  await tick();
  b.prime([need('a#3', 4.01)]);
  assert.deepEqual(e.seeks, [4]);
});

test('export seeks land exactly or fail with a reason', async () => {
  const { b } = bank();
  await b.exact([need('a#0', 2.5), need('b#1', 1)]);
  assert.equal(b.get('a#0').currentTime, 2.5);
  assert.equal(b.get('b#1').currentTime, 1);

  const off = b.get('c#2');
  off.land = (t) => t + 0.5;
  await assert.rejects(b.exact([need('c#2', 3)]), /landed at 3.500s instead of 3.000s/);

  const loading = b.get('c#3');
  loading.readyState = 0;
  const done = waitReady(loading);
  loading.readyState = 2;
  loading.dispatch('loadeddata');
  await done;

  const broken = document.createElement('video'); // outside the bank, which would schedule a retry
  broken.readyState = 0;
  const failed = waitReady(broken);
  broken.dispatch('error');
  await assert.rejects(failed, /Loading clip: the clip could not be decoded/);
});

test('waiting for a clip gives up after its time limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { b } = bank();
  const e = b.get('a#0');
  e.readyState = 0;
  const p = waitReady(e, 1000);
  t.mock.timers.tick(1000);
  await assert.rejects(p, /Loading clip: timed out/);
});

test('the bank keeps at most twenty elements, dropping the least recently used ones that are not on screen', async () => {
  const dropped = [];
  const { root, b } = bank((k) => dropped.push(k));
  let now = 0;
  const real = performance.now;
  performance.now = () => ++now;
  try {
    for (let i = 0; i < 25; i++) b.get(`a#${i}`);
    b.get('a#0'); // used again: now the newest
    await b.exact([need('a#1', 0), need('a#2', 0)]);
  } finally {
    performance.now = real;
  }
  assert.equal(b.els.size, 20);
  assert.equal(root.children.length, 20);
  assert.deepEqual(dropped, ['a#3', 'a#4', 'a#5', 'a#6', 'a#7']);
  for (const k of ['a#0', 'a#1', 'a#2', 'a#24']) assert.ok(b.els.has(k), k);

  const gone = [...b.els.values()];
  b.clear();
  assert.equal(b.els.size, 0);
  assert.equal(root.children.length, 0);
  assert.ok(gone.every((e) => e.loads === 1 && e.src === ''), 'each element lets go of its file');
  assert.equal(dropped.length, 25);
});

function exportCtx(L, look = LOOKS[0]) {
  const beatDur = 0.25;
  const tl = planTimeline({ L, beatDur, clips, rhythm: 'beat', transitions: ['dissolve'], transBeats: 0.5, seed: 3 });
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur, seed: 1, L });
  const durs = new Map(clips.map((c) => [c.id, c.duration]));
  return { look, tl, sampler, clipDur: (id) => durs.get(id), L, beatDur, seed: 1 };
}

test('without WebCodecs every frame streams to the server as raw RGBA after a short warm-up', async () => {
  const reqs = exportServer();
  const ctx = exportCtx(1);
  const eng = fakeEngine();
  const b = fakeBank();
  const progress = [];
  const out = await exportLoop({ engine: eng, bank: b, ctx, width: 72, height: 128, meta: { look: 'Neon', duration: 1 }, onProgress: (p) => progress.push(p) });

  const begin = JSON.parse(reqs[0].body);
  assert.deepEqual(begin, { look: 'Neon', duration: 1, width: 72, height: 128, fps: 30, codec: 'raw-rgba', stream: 'rgba' });
  const frames = reqs.filter((r) => r.path === '/api/export/raw/frames');
  assert.equal(frames.length, 30, 'one request per frame, none for the warm-up');
  assert.equal(frames[0].url, '/api/export/raw/frames?sid=canvas-x.mp4');
  assert.equal(eng.renders, 30 + 12);
  assert.deepEqual(eng.size, [72, 128]);
  assert.equal(eng.resets, 1);
  // every clip is checked once before any frame is sent
  const firstChecks = b.calls.slice(0, 3).map((n) => n[0].clipId).sort();
  assert.deepEqual(firstChecks, ['a', 'b', 'c']);
  const end = JSON.parse(reqs.at(-1).body);
  assert.equal(reqs.at(-1).path, '/api/export/raw/end');
  assert.deepEqual(Object.keys(end.stats).sort(), ['max_flashes_per_sec', 'mean_luminance', 'seam_ratio']);
  assert.equal(out.filename, 'canvas-x.mp4');
  assert.equal(out.codec, 'raw-rgba');
  assert.deepEqual(progress.at(-1).frame, 30);
  assert.equal(progress.at(-1).total, 30);
});

test('looks with feedback warm up on the end of the loop so the first frame matches the last', async () => {
  exportServer();
  const fb = cloneLook(LOOKS[0]);
  fb.layers.push({ m: 'trails', on: true, p: {}, mods: {} });
  assert.ok(MODULES.trails.feedback);
  const eng = fakeEngine();
  await exportLoop({ engine: eng, bank: fakeBank(), ctx: exportCtx(1, fb), width: 8, height: 8, meta: {} });
  assert.equal(eng.renders, 60, 'a one-second loop warms up for the whole loop');
  const long = fakeEngine();
  await exportLoop({ engine: long, bank: fakeBank(), ctx: exportCtx(12, fb), width: 8, height: 8, meta: {} });
  assert.equal(long.renders, 360 + 300, 'long loops warm up for ten seconds, not the whole video');
});

test('the export stats measure luminance, flashes and the loop seam', async () => {
  let reqs = exportServer();
  await exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(1), width: 8, height: 8, meta: {} });
  let stats = JSON.parse(reqs.at(-1).body).stats;
  assert.equal(stats.seam_ratio, 0);
  assert.equal(stats.max_flashes_per_sec, 0);
  assert.ok(Math.abs(stats.mean_luminance - 0.216) < 0.002, `${stats.mean_luminance}`);

  reqs = exportServer();
  await exportLoop({ engine: fakeEngine((i) => (Math.floor(i / 3) % 2 ? 1 : 0)), bank: fakeBank(), ctx: exportCtx(1), width: 8, height: 8, meta: {} });
  stats = JSON.parse(reqs.at(-1).body).stats;
  assert.ok(stats.max_flashes_per_sec >= 4, `${stats.max_flashes_per_sec} flashes a second`);
  assert.equal(stats.mean_luminance, 0.5);
});

test('cancelling or a server error stops the export and tells the server to throw the file away', async () => {
  let reqs = exportServer();
  const ac = new AbortController();
  await assert.rejects(
    exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(1), width: 8, height: 8, meta: {}, signal: ac.signal, onProgress: (p) => { if (p.frame === 5) ac.abort(); } }),
    (e) => e.name === 'AbortError',
  );
  await tick();
  assert.equal(reqs.at(-1).url, '/api/export/raw/abort?sid=canvas-x.mp4');
  assert.equal(reqs.filter((r) => r.path === '/api/export/raw/frames').length, 5);

  reqs = exportServer({ frames: () => new Response(JSON.stringify({ ok: false, error: 'encoder stopped: disk full' }), { status: 500 }) });
  await assert.rejects(exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(1), width: 8, height: 8, meta: {} }), /disk full/);
  await tick();
  assert.equal(reqs.at(-1).path, '/api/export/raw/abort');

  exportServer({ end: () => ({ ok: false, error: 'checks failed' }) });
  await assert.rejects(exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(1), width: 8, height: 8, meta: {} }), /checks failed/);

  const bad = fakeBank();
  bad.exact = async () => { throw new Error('Seeking clip: timed out'); };
  reqs = exportServer();
  await assert.rejects(exportLoop({ engine: fakeEngine(), bank: bad, ctx: exportCtx(1), width: 8, height: 8, meta: {} }), /Seeking clip/);
  assert.equal(reqs.filter((r) => r.path === '/api/export/raw/frames').length, 0, 'a broken clip fails before any frame is sent');
});

function withEncoder(t) {
  globalThis.window = { VideoEncoder: FakeEncoder, VideoFrame: FakeFrame };
  FakeEncoder.failAt = 0;
  t.after(() => { delete globalThis.window; });
}

test('with WebCodecs the browser encodes H.264 and uploads about a second of it at a time', async (t) => {
  withEncoder(t);
  const reqs = exportServer();
  const out = await exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(2.5), width: 72, height: 128, bitrate: 20_000_000, meta: {} });
  const begin = JSON.parse(reqs[0].body);
  assert.equal(begin.codec, 'avc1.640033', 'falls back to the first codec the machine supports');
  assert.equal(begin.stream, 'h264');
  const enc = FakeEncoder.last;
  assert.equal(enc.cfg.bitrate, 20_000_000);
  assert.deepEqual(enc.cfg.avc, { format: 'annexb' });
  assert.equal(enc.state, 'closed');
  assert.equal(enc.frames.length, 75);
  assert.deepEqual(enc.frames.filter((f) => f.key).map((f) => f.ts), [0, 1e6, 2e6]);
  assert.equal(enc.frames[1].ts, 33333);
  const uploads = reqs.filter((r) => r.path === '/api/export/raw/frames');
  assert.equal(uploads.length, 3, 'two full seconds, then the rest after the flush');
  assert.deepEqual(uploads.map((r) => r.body.size), [30 * 6, 30 * 6, 15 * 6]);
  assert.equal(out.codec, 'avc1.640033');
});

test('the default bitrate depends on the frame size, and an encoder error aborts the export', async (t) => {
  withEncoder(t);
  exportServer();
  await exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(1), width: 1080, height: 1920, meta: {} });
  assert.equal(FakeEncoder.last.cfg.bitrate, 16_000_000);
  await exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(1), width: 720, height: 1280, meta: {} });
  assert.equal(FakeEncoder.last.cfg.bitrate, 9_000_000);

  FakeEncoder.failAt = 10;
  const reqs = exportServer();
  await assert.rejects(exportLoop({ engine: fakeEngine(), bank: fakeBank(), ctx: exportCtx(1), width: 8, height: 8, meta: {} }), /encoder crashed/);
  await tick();
  assert.equal(FakeEncoder.last.state, 'closed');
  assert.equal(reqs.at(-1).path, '/api/export/raw/abort');
  assert.ok(!reqs.some((r) => r.path === '/api/export/raw/end'));
});

class FakeImage {
  constructor() { this.complete = false; this.naturalWidth = 0; FakeImage.made.push(this); }
  static made = [];
}
globalThis.Image = FakeImage;
after(() => { delete globalThis.Image; });

function laneState(L, beatDur, over = {}) {
  const look = cloneLook(LOOKS[0]);
  const tl = planTimeline({ L, beatDur, clips, rhythm: 'bar', transitions: ['dissolve', 'cut'], transBeats: 1, seed: 4 });
  const sampler = makeSampler({ features: null, loopStart: 0, beatDur, seed: 1, L });
  return { ctx: { L, beatDur, tl, sampler }, selected: ['a', 'b', 'c'], editClip: null, look, editLook: () => look, drawLane() {}, ...over };
}

function lane(width) {
  const x = recordingContext();
  dom.byId.set('lane', fakeCanvas(width, 90, x));
  return x;
}

const labels = (x) => x.calls.filter((c) => c.fn === 'fillText').map((c) => c.args[0]);

test('the lane numbers every bar of a short loop and shows a thumbnail per cut', () => {
  FakeImage.made = [];
  const x = lane(800);
  const s = laneState(8, 0.5);
  drawLane(s);
  const text = labels(x);
  assert.deepEqual(text.filter((t) => /^\d+$/.test(t)), ['1', '2', '3', '4']);
  assert.deepEqual(text.filter((t) => t.startsWith('#')), ['#1', '#2', '#3', '#1']);
  assert.equal(FakeImage.made.length, 4);
  assert.match(FakeImage.made[0].src, /^\/api\/thumb\/a\?w=200&t=\d+\.\d\d$/);
  assert.equal(x.calls.filter((c) => c.fn === 'rotate').length, 4, 'a marker on every cut');

  // drawing again reuses the thumbnails, and a loaded one is drawn
  FakeImage.made[0].complete = true;
  FakeImage.made[0].naturalWidth = 320;
  FakeImage.made[0].naturalHeight = 180;
  const again = lane(800);
  drawLane(s);
  assert.equal(FakeImage.made.length, 4);
  assert.ok(again.calls.some((c) => c.fn === 'drawImage'));
});

test('a long loop thins out bar numbers and draws narrow cuts as flat color', () => {
  FakeImage.made = [];
  const x = lane(600);
  drawLane(laneState(188 * 1.6, 0.4)); // 188 bars, about five minutes
  const nums = labels(x).filter((t) => /^\d+$/.test(t)).map(Number);
  assert.ok(nums.length <= 600 / 26, `${nums.length} labels in 600 px`);
  const step = nums[1] - nums[0];
  assert.ok(step > 1 && (step & (step - 1)) === 0, `labels every ${step} bars`);
  assert.ok(nums.every((n, i) => n === 1 + i * step));
  assert.equal(FakeImage.made.length, 0, 'no thumbnails for 3 px wide cuts');
  assert.ok(x.calls.some((c) => c.fn === 'fillRect' && /^hsl\(/.test(c.fillStyle)));
  assert.equal(x.calls.filter((c) => c.fn === 'rotate').length, 0, 'markers would overlap');
});

test('editing one clip dims the other clips in the lane and outlines its own', () => {
  const x = lane(800);
  const s = laneState(8, 0.5, { editClip: 'b' });
  s.editLook = () => cloneLook(LOOKS[2]);
  drawLane(s);
  const dims = x.calls.filter((c) => c.fn === 'fillRect' && c.fillStyle === 'rgba(10,10,14,0.62)');
  assert.equal(dims.length, 3);
  assert.equal(x.calls.filter((c) => c.fn === 'stroke').length, 1 + 2, 'one outline plus the two curves');

  const empty = lane(800);
  drawLane(laneState(8, 0.5, { ctx: null }));
  assert.deepEqual(empty.calls.map((c) => c.fn), ['clearRect']);
});

test('the song overview shows the loop, suggested loops and a playhead while listening', () => {
  const x = recordingContext();
  dom.byId.set('overview', fakeCanvas(400, 40, x));
  const s = { features: null, ctx: null, loopStart: 0, loopLen: () => 8, transport: { mode: 'loop', playing: false } };
  drawOverview(s);
  assert.deepEqual(labels(x), ['No track selected: canvas uses a synthetic beat clock']);

  const y = recordingContext();
  dom.byId.set('overview', fakeCanvas(400, 40, y));
  drawOverview({ ...s, features: { duration: 100, peaks: Array(50).fill(0.5), loops: [{ start: 10 }, { start: 50 }] }, loopStart: 25, transport: { mode: 'listen', playing: true, songTime: () => 75 } });
  const box = y.calls.find((c) => c.fn === 'strokeRect');
  assert.deepEqual(box.args.slice(0, 1).concat(box.args[2]), [100, 32]);
  assert.equal(y.calls.filter((c) => c.fn === 'fill').length, 2);
  assert.ok(y.calls.some((c) => c.fn === 'fillRect' && c.args[0] === 299 && c.args[2] === 2), 'playhead at 75 s');
});

test('the drawn envelope passes through its points, wraps smoothly and stays in range', () => {
  const env = [0, 1, 0.2, 0.9, 0.5, 0, 1, 0.3];
  env.forEach((v, i) => assert.ok(Math.abs(envAt(env, i / env.length) - v) < 1e-9, `point ${i}`));
  assert.equal(envAt(env, 1), envAt(env, 0));
  assert.ok(Math.abs(envAt(env, 0.999) - envAt(env, 0)) < 0.02);
  for (let u = 0; u < 1; u += 0.01) assert.ok(envAt([0, 1, 0, 1, 0, 1], u) >= 0 && envAt([0, 1, 0, 1, 0, 1], u) <= 1);
  assert.equal(ENV_POINTS, 16);
});

test('song curves are read between analysis frames and from the loop start', () => {
  const kick = Array(100).fill(0);
  kick[31] = 1;
  const s = makeSampler({ features: { curves: { kick }, fps: 30 }, loopStart: 1, beatDur: 0.5, seed: 1, L: 2 });
  assert.equal(s(0).kick, 0);
  assert.ok(Math.abs(s(0.5 / 30).kick - 0.5) < 1e-9);
  assert.ok(Math.abs(s(1 / 30).kick - 1) < 1e-9);
  assert.ok(Math.abs(s(2 + 1 / 30).kick - 1) < 1e-9, 'time wraps at the loop length');
  const past = makeSampler({ features: { curves: { kick: [0.3] }, fps: 30 }, loopStart: 50, beatDur: 0.5, seed: 1, L: 2 });
  assert.equal(past(1).kick, 0.3, 'reading past the end holds the last value');
});

test('stepped parameters ignore modulation, unknown sources are skipped and values stay in range', () => {
  const defs = [
    { id: 'mix', min: 0, max: 1, def: 0.5, step: 0.01 },
    { id: 'count', min: 1, max: 6, def: 3, step: 1 },
    { id: 'mode', min: 0, max: 2, def: 0, step: 1, opts: ['a', 'b', 'c'] },
  ];
  const mods = { mix: { src: 'kick', amt: 1 }, count: { src: 'kick', amt: 1 }, mode: { src: 'kick', amt: 1 } };
  assert.deepEqual(resolveParams(defs, { mix: 0.5 }, mods, { kick: 1 }), { p_mix: 1, p_count: 3, p_mode: 0 });
  assert.deepEqual(resolveParams(defs, { mix: 0.2 }, mods, { kick: 0.5 }, 0.5), { p_mix: 0.45, p_count: 3, p_mode: 0 });
  assert.deepEqual(resolveParams(defs, { mix: 0.2 }, { mix: { src: 'nope', amt: 1 } }, { kick: 1 }), { p_mix: 0.2, p_count: 3, p_mode: 0 });
  assert.deepEqual(resolveParams(defs, { mix: 7, count: -2 }), { p_mix: 1, p_count: 1, p_mode: 0 });
});

test('layer stacks skip layers that are off or unknown and key the rest by position', () => {
  const look = { ...cloneLook(LOOKS[0]), layers: [{ m: 'bloom', p: {}, mods: {} }, { m: 'glass', on: false, p: {}, mods: {} }, { m: 'gone', p: {}, mods: {} }, { m: 'chrome', p: {}, mods: {} }] };
  const out = layerStack(look, {}, { wet: 0.4, depth: 1 }, 'c:a:');
  assert.deepEqual(out.map((l) => l.key), ['c:a:0:bloom', 'c:a:3:chrome']);
  assert.equal(out[0].src, look.layers[0]);
  assert.equal(out[1].params.uWet, 0.4);
});

test('a new layer goes in at its pipeline stage', () => {
  const layers = [{ m: 'kaleido' }, { m: 'glass' }, { m: 'bloom' }];
  const cat = (m) => MODULES[m].cat;
  assert.deepEqual(layers.map((l) => cat(l.m)), ['space', 'warp', 'light']);
  const colorId = Object.keys(MODULES).find((k) => MODULES[k].cat === 'color');
  insertAtStage(layers, { m: colorId });
  assert.deepEqual(layers.map((l) => cat(l.m)), ['space', 'warp', 'color', 'light']);
  const spaceId = Object.keys(MODULES).find((k) => MODULES[k].cat === 'space' && k !== 'kaleido');
  insertAtStage(layers, { m: spaceId });
  assert.equal(layers[1].m, spaceId, 'after the existing space layer, before warp');
  insertAtStage(layers, { m: 'bloom' });
  assert.equal(layers.at(-1).m, 'bloom');
  assert.deepEqual(STAGE, ['space', 'warp', 'time', 'stylize', 'color', 'light']);
});

test('hand-placed cuts are sorted and ones hugging the loop ends are dropped', () => {
  const tl = planTimeline({ L: 8, beatDur: 0.5, clips, rhythm: 'custom', custom: [5, 2, 0.01, 7.99, 3.3], transitions: ['dissolve'], transBeats: 0.5, seed: 1 });
  assert.deepEqual(tl.segs.map((s) => s.t0), [0, 2, 3.3, 5]);
  assert.equal(tl.segs.at(-1).t1, 8);
});

test('random transition order never repeats a transition on back-to-back cuts', () => {
  const tl = planTimeline({ L: 16, beatDur: 0.5, clips, rhythm: 'beat', transitions: ['dissolve', 'zoom', 'whip'], transBeats: 0.5, seed: 9, order: 'random' });
  for (let i = 1; i < tl.segs.length; i++) assert.notEqual(tl.segs[i].trans, tl.segs[i - 1].trans, `cut ${i}`);
  assert.ok(new Set(tl.segs.map((s) => s.trans)).size === 3);
});

test('the same seed plans the same edit, and random direction mixes forward, reverse and ping-pong', () => {
  const opts = { L: 16, beatDur: 0.5, clips, rhythm: 'beat', transitions: ['dissolve', 'zoom'], transBeats: 0.5, seed: 12, direction: 'random' };
  assert.deepEqual(planTimeline(opts), planTimeline(opts));
  assert.notDeepEqual(planTimeline(opts).segs.map((s) => s.in), planTimeline({ ...opts, seed: 13 }).segs.map((s) => s.in));
  const segs = planTimeline(opts).segs;
  assert.ok(segs.some((s) => s.rev) && segs.some((s) => s.pp) && segs.some((s) => !s.rev && !s.pp));
});

test('sampling before zero or after the end wraps into the loop', () => {
  const tl = planTimeline({ L: 8, beatDur: 0.5, clips, rhythm: 'bar', transitions: ['cut'], transBeats: 0, seed: 1 });
  const key = (x) => `${x.a.key}@${x.a.local.toFixed(6)}`;
  assert.equal(key(sampleTimeline(tl, -0.25)), key(sampleTimeline(tl, 7.75)));
  assert.equal(key(sampleTimeline(tl, 8.25)), key(sampleTimeline(tl, 0.25)));
});
