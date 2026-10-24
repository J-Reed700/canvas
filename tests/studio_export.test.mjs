import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeElement, stubFetch, fakeEngine, framesReply, FakeEncoder, FakeFrame } from './fakes.mjs';

const dom = installDom();
const form = new FakeElement('div');
const status = new FakeElement('div');
dom.byId.set('exportForm', form);
dom.byId.set('exportStatus', status);

const { useStudioStore: S } = await import('../downbeat/studio/src/state/store.ts');
const X = await import('../downbeat/studio/src/state/exportController.ts');
const { LOOKS, cloneLook } = await import('../downbeat/studio/src/engine/looks.ts');
const { toast } = await import('../downbeat/studio/src/lib/utils.ts');

after(() => toast('', 0));

const CLIPS = [
  { id: 'a', name: 'a.mp4', duration: 12, proxy: 'ready' },
  { id: 'b', name: 'b.mp4', duration: 9, proxy: 'ready' },
];
const SONG = { duration: 180, fps: 30, bpm: 120, downbeats: Array.from({ length: 89 }, (_, i) => 1.5 + i * 2), loops: [{ start: 33.5 }], loop_bars: 4 };
const st = () => S.getState();
const lastToast = () => dom.toasts.at(-1);
const downloads = [];
const append = document.body.append.bind(document.body);
document.body.append = (el) => { if (el.tagName === 'A') downloads.push({ ...el.attributes }); append(el); };

function fresh(over = {}) {
  st().transport.pause();
  S.setState({
    clips: CLIPS.map((c) => ({ ...c })),
    selected: ['a', 'b'],
    look: cloneLook(LOOKS[0]),
    lookId: LOOKS[0].id,
    features: null,
    trackId: '',
    tracks: [],
    renders: [],
    bars: 4,
    loopStart: 0,
    bpmManual: 120,
    clipMode: 'one',
    exporting: false,
    exportOpen: false,
    exportOpts: { size: 'master', audio: true, format: 'spotify', promo: 0, autoSave: true },
    engine: fakeEngine(),
    bank: { get: () => ({}) },
    ...over,
  });
  st().rebuild();
  downloads.length = 0;
}

const withSong = (over = {}) => fresh({ features: structuredClone(SONG), trackId: 't1', loopStart: 33.5, ...over });

const server = (o = {}) => stubFetch({
  'GET /api/frames/*': framesReply(),
  'POST /api/export/raw/begin': () => ({ ok: true, sid: 's1' }),
  'POST /api/export/raw/frames': o.frames || (() => ({ ok: true })),
  'POST /api/export/raw/abort': () => ({ ok: true }),
  'POST /api/export/raw/end': o.end || ((_u, init) => ({ ok: true, render: { filename: 'canvas-neon.mp4', url: '/out/canvas-neon.mp4', size_mb: 2.5, format: 'spotify', checks: [{ id: 'len', label: 'Length', level: 'ok', detail: '8 s' }], stats: JSON.parse(init.body).stats } })),
  ...o.routes,
});
const begins = (reqs) => reqs.filter((r) => r.path === '/api/export/raw/begin').map((r) => JSON.parse(r.body));
const button = (label) => status.find((c) => c.tagName === 'BUTTON' && c.text === label);
const within = (pred, el = status, out = []) => { for (const c of el.children) { if (pred(c)) out.push(c); within(pred, c, out); } return out; };
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test('the export sheet only opens when every selected clip is ready', () => {
  fresh({ selected: [] });
  X.openExport();
  assert.equal(lastToast(), 'Select at least one clip first');
  assert.equal(st().exportOpen, false);

  fresh({ clips: [{ ...CLIPS[0], proxy: 'building' }, { ...CLIPS[1], proxy: 'building' }] });
  X.openExport();
  assert.equal(lastToast(), 'Still preparing 2 clips for playback. Try again in a moment.');
  fresh({ clips: [{ ...CLIPS[0], proxy: 'error' }, CLIPS[1]] });
  X.openExport();
  assert.equal(lastToast(), "One of the selected clips couldn't be converted. Deselect it to export.");
  assert.equal(st().exportOpen, false);

  fresh({ exporting: true });
  X.openExport();
  assert.equal(st().exportOpen, false, 'no second sheet while one export runs');

  fresh();
  status.append(new FakeElement('h2'));
  form.hidden = true;
  X.openExport();
  assert.equal(st().exportOpen, true);
  assert.equal(form.hidden, false, 'the form is back after an earlier result');
  assert.equal(status.children.length, 0);
});

const render = async (opts, over = {}) => {
  const reqs = server();
  (over.song ? withSong : fresh)({ exportOpts: { size: 'master', audio: true, format: 'spotify', promo: 0, autoSave: false, ...opts }, ...over.state });
  if (over.bars) st().setBars(over.bars);
  await X.renderOnce();
  return { meta: begins(reqs)[0], bitrate: FakeEncoder.last?.cfg.bitrate };
};

test('what an export asks the server for depends on the format, the song and the length', async (t) => {
  globalThis.window = { VideoEncoder: FakeEncoder, VideoFrame: FakeFrame };
  t.after(() => { delete globalThis.window; });

  let r = await render({}, { song: true });
  assert.deepEqual(
    { w: r.meta.width, h: r.meta.height, fmt: r.meta.format, audio: r.meta.with_audio, promo: r.meta.promo_seconds, track: r.meta.track_id, start: r.meta.audio_start, dur: r.meta.duration, bpm: r.meta.bpm, look: r.meta.look },
    { w: 1080, h: 1920, fmt: 'spotify', audio: true, promo: 0, track: 't1', start: 33.5, dur: 8, bpm: 120, look: LOOKS[0].name },
  );
  assert.equal(r.bitrate, 16_000_000, 'Spotify uses the encoder default for its size');
  // the edit goes with it, so Exports can open it again
  assert.deepEqual([r.meta.edit.trackId, r.meta.edit.selected, r.meta.edit.loopStart, r.meta.edit.look.name], ['t1', ['a', 'b'], 33.5, LOOKS[0].name]);

  r = await render({ size: 'lite', audio: false }, { song: true });
  assert.deepEqual([r.meta.width, r.meta.height, r.meta.with_audio], [720, 1280, false]);

  r = await render({ format: 'youtube_16_9', audio: false }, { song: true });
  assert.deepEqual([r.meta.width, r.meta.height, r.meta.with_audio, r.meta.promo_seconds], [1920, 1080, false, 0], 'the sheet\'s choices hold for YouTube too');
  assert.equal(r.bitrate, 50_000_000);

  r = await render({ format: 'youtube_16_9', promo: 30 }, { song: true });
  assert.deepEqual([r.meta.with_audio, r.meta.promo_seconds], [true, 30]);
  r = await render({ format: 'youtube_16_9' }, { song: true, bars: 40 });
  assert.equal(r.bitrate, 20_000_000, 'past a minute the bitrate drops to keep files manageable');
  assert.equal(r.meta.duration, 80);

  r = await render({ format: 'social_square', promo: 15 }, { song: true });
  assert.deepEqual([r.meta.width, r.meta.height, r.meta.promo_seconds], [1080, 1080, 15]);

  r = await render({ format: 'apple_tall', promo: 15 }, { song: true });
  assert.deepEqual([r.meta.width, r.meta.height, r.meta.with_audio, r.meta.promo_seconds], [2048, 2732, false, 0]);

  r = await render({ format: 'youtube_16_9' });
  assert.deepEqual([r.meta.with_audio, r.meta.promo_seconds, r.meta.track_id], [false, 0, null], 'no song, no audio');
});

test('an export pauses playback, then resumes it and puts the studio back', async () => {
  server();
  fresh();
  const eng = st().engine;
  st().transport.play();
  const run = X.renderOnce();
  assert.equal(st().exporting, true);
  assert.ok(document.body.classList.contains('exporting'));
  assert.equal(st().transport.playing, false);
  await run;
  assert.equal(st().exporting, false);
  assert.ok(!document.body.classList.contains('exporting'));
  assert.equal(st().transport.playing, true);
  assert.equal(eng.resets, 2, 'reset before rendering and again for the preview');
  st().transport.pause();

  fresh({ look: null });
  await assert.rejects(X.renderOnce(), /No ctx or look/);
});

test('a finished export shows its checks and downloads, lists it first and saves it', async () => {
  const reqs = server();
  fresh({ renders: [{ filename: 'canvas-neon.mp4', url: 'old' }, { filename: 'older.mp4', url: '' }] });
  await X.runExport();
  assert.deepEqual(st().renders.map((r) => [r.filename, r.url]), [['canvas-neon.mp4', '/out/canvas-neon.mp4'], ['older.mp4', '']]);
  assert.equal(form.hidden, true);
  assert.equal(status.find((c) => c.tagName === 'H2').text, 'Ready for Spotify');
  assert.match(status.text, /canvas-neon\.mp4 · 2\.5 MB · rendered in \d+\.\d s \(raw-rgba\)/);
  assert.match(status.text, /✓ Length 8 s/);
  assert.equal(lastToast(), 'Exported canvas-neon.mp4');
  assert.deepEqual(downloads, [{ href: '/out/canvas-neon.mp4', download: 'canvas-neon.mp4' }]);
  assert.ok(reqs.some((r) => r.path === '/api/export/raw/end'));

  // closing the result and opening the sheet again shows the form, not the old result
  button('✕').click();
  assert.equal(st().exportOpen, false);
  X.openExport();
  assert.equal(form.hidden, false);
  assert.equal(status.children.length, 0);

  fresh({ exportOpts: { ...st().exportOpts, autoSave: false } });
  await X.runExport();
  assert.deepEqual(downloads, [], 'auto-save off');
});

test('the progress line counts frames and estimates the time left', async (t) => {
  const notes = [];
  server({ frames: () => { notes.push(status.find((c) => c.className === 'note').textContent); return { ok: true }; } });
  fresh();
  // each frame takes a tenth of a second: a third of real time
  let now = 0;
  const real = performance.now;
  performance.now = () => (now += 100);
  t.after(() => { performance.now = real; });
  await X.runExport();
  assert.equal(notes.length, 240);
  assert.equal(notes[0], 'Preparing clips…');
  assert.equal(notes[30], 'Frame 30 / 240 · 0.3× real-time · about 0:21 left');
  assert.equal(notes.at(-1), 'Frame 239 / 240 · 0.3× real-time', 'no estimate under a second');
});

test('cancelling and failures show what happened in the sheet', async () => {
  let n = 0;
  const reqs = server({ frames: () => { if (++n === 3) button('Cancel').click(); return { ok: true }; } });
  fresh();
  await quiet(() => X.runExport());
  assert.equal(status.find((c) => c.tagName === 'H2').text, 'Export cancelled');
  assert.equal(lastToast(), 'Export cancelled');
  assert.ok(reqs.some((r) => r.path === '/api/export/raw/abort'));
  assert.equal(st().renders.length, 0);

  server({ end: () => ({ ok: false, error: 'ffmpeg exited with status 1' }) });
  fresh();
  await quiet(() => X.runExport());
  assert.equal(status.find((c) => c.tagName === 'H2').text, 'Export failed');
  assert.match(status.text, /ffmpeg exited with status 1/);
  button('Close').click();
  assert.equal(st().exportOpen, false);
  assert.equal(form.hidden, false);
});

test('result headers name the format, and failed checks say so', () => {
  const r = (o) => ({ filename: 'x.mp4', url: '/out/x.mp4', size_mb: 1, ...o });
  const header = (o) => { X.showResult(r(o)); return status.find((c) => c.tagName === 'H2').text; };
  assert.equal(header({ format: 'cover_art' }), 'Cover art and loop exported');
  assert.equal(header({ format: 'youtube_16_9' }), 'YouTube video exported');
  assert.equal(header({ format: 'social_square' }), 'Square video exported');
  assert.equal(header({ format: 'apple_square' }), 'Ready for Apple Music');
  assert.equal(header({ checks: [{ id: 'a', label: 'Size', level: 'fail' }] }), 'Exported, but some checks failed');
  X.showResult(r({ cover_url: '/out/c.jpg', audio_url: '/out/a.mp4', promo_url: '/out/p.mp4' }));
  const links = [];
  status.find((c) => { if (c.tagName === 'A') links.push(c.text); return false; });
  assert.deepEqual(links, ['↓ Download MP4', '↓ 3000×3000 Cover JPG', '↓ With audio', '↓ Promo with song']);
});

test('an export whose clips froze says so, says why, and is not downloaded', async () => {
  const frozen = { id: 'footage', label: 'Clips play, not stills', level: 'fail', detail: '0:01.6 for 1.6 s: 48 different frames of a.mp4 were decoded, but the browser kept drawing the same picture' };
  server({ end: () => ({ ok: true, render: { filename: 'canvas-neon.mp4', url: '/out/canvas-neon.mp4', size_mb: 2.5, format: 'spotify', checks: [{ id: 'len', label: 'Length', level: 'ok' }, frozen] } }) });
  fresh();
  await X.runExport();
  assert.equal(status.find((c) => c.tagName === 'H2').text, 'Export failed: the clips froze');
  assert.ok(status.find((c) => c.text === frozen.detail), 'the reason is in the sheet');
  assert.deepEqual(downloads, [], 'a frozen export is not saved to Downloads');
  assert.equal(lastToast(), 'Export failed: the clips froze. The reason is in the export sheet.');
  assert.equal(st().renders[0].filename, 'canvas-neon.mp4', 'it is still listed, with its failed check');
});

test('auto-save also downloads the promo and cover art, a moment apart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fresh();
  X.autoSave({ filename: 'x.mp4', url: '/out/x.mp4', promo_url: '/out/x-promo-30s.mp4', cover_url: '/out/x-cover.jpg' });
  assert.equal(downloads.length, 1);
  t.mock.timers.tick(400);
  assert.equal(downloads.length, 2);
  t.mock.timers.tick(400);
  assert.deepEqual(downloads.map((d) => d.href), ['/out/x.mp4', '/out/x-promo-30s.mp4', '/out/x-cover.jpg']);
});

// Batch exports wait 400 ms between renders; run those waits on a fake clock.
async function runOnFakeClock(t, start) {
  toast('', 0); // a real toast timer can't be cleared once the fake clock is on
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const promise = start();
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 100_000 && !settled; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(400);
  }
  await promise;
}

test('a batch of rolls renders four variations and then restores the look', async (t) => {
  const reqs = server();
  fresh({ bars: 1 });
  const before = st().snapshot();
  await runOnFakeClock(t, () => quiet(() => X.runBatch('rolls')));
  assert.equal(begins(reqs).length, 4);
  assert.equal(new Set(begins(reqs).map((m) => m.look)).size > 1, true, 'each render is a different roll');
  assert.deepEqual(begins(reqs).map((m) => m.edit.look.name), begins(reqs).map((m) => m.look), 'each keeps the edit of its own roll');
  assert.equal(st().snapshot(), before);
  // the sheet ends on a summary with a link to each file
  assert.equal(status.find((c) => c.tagName === 'H2').text, 'Batch done');
  assert.match(status.text, /4 of 4 exported, and all of them passed every check\. They're in Exports, and the studio is back on your edit\./);
  assert.deepEqual(within((c) => c.tagName === 'A').map((a) => a.attributes.href), Array(4).fill('/out/canvas-neon.mp4'));
  assert.equal(lastToast(), 'Batch done: 4 of 4 exported');
});

test('a render that fails stops the batch, and the summary says where', async (t) => {
  let n = 0;
  const reqs = server({
    end: () => (++n === 2
      ? new Response(JSON.stringify({ ok: false, error: 'disk full' }), { status: 500 })
      : { ok: true, render: { filename: `r${n}.mp4`, url: `/out/r${n}.mp4`, size_mb: 1, checks: [{ id: 'len', level: n === 1 ? 'fail' : 'ok' }] } }),
  });
  fresh({ bars: 1 });
  await runOnFakeClock(t, () => quiet(() => X.runBatch('rolls')));
  assert.equal(begins(reqs).length, 2);
  assert.equal(status.find((c) => c.tagName === 'H2').text, 'Batch stopped');
  assert.match(status.text, /1 of 4 exported, and 0 passed every check/);
  assert.match(status.text, /It stopped at .+: disk full/);
  assert.equal(within((c) => c.tagName === 'A').length, 1);
  assert.equal(st().lookId, LOOKS[0].id, 'back on the edit from before the batch');
});

test('cancelling one render of a batch stops the rest', async (t) => {
  let n = 0;
  const reqs = server({ frames: () => { if (++n === 90) button('Cancel').click(); return { ok: true }; } });
  fresh({ bars: 1 }); // 60 frames a render: frame 90 is in the second one
  await runOnFakeClock(t, () => quiet(() => X.runBatch('rolls')));
  assert.equal(begins(reqs).length, 2);
  assert.equal(st().lookId, LOOKS[0].id);
  assert.equal(status.find((c) => c.tagName === 'H2').text, 'Batch cancelled');
  assert.match(status.text, /1 of 4 exported/);
});

test('a batch over songs renders each song in the folder and comes back to the first one', async (t) => {
  const tracks = [
    { id: 't1', name: 'one.mp3', source: '/Videos', dir: '', mtime: 3 },
    { id: 't2', name: 'two.mp3', source: '/Videos', dir: '', mtime: 2 },
    { id: 't3', name: 'other.mp3', source: '/Music', dir: '', mtime: 9 },
  ];
  const reqs = server({ routes: { 'GET /api/features/*': (u) => ({ ...SONG, id: u.split('/').pop().split('?')[0] }) } });
  withSong({ tracks });
  st().transport.decode = async () => ({ duration: 180 });
  await runOnFakeClock(t, () => quiet(() => X.runBatch('tracks')));
  assert.deepEqual(begins(reqs).map((m) => m.track_id), ['t1', 't2']);
  assert.ok(begins(reqs).every((m) => m.audio_start === 33.5), 'each song starts at its suggested loop');
  assert.equal(st().trackId, 't1');
});

test('reveal falls back to naming the file, and companion exports download or explain', async () => {
  stubFetch({
    'POST /api/reveal': () => ({ ok: false }),
    'POST /api/export/companion': (_u, init) => {
      const b = JSON.parse(init.body);
      return b.kind === 'gif' ? { ok: true, url: '/out/x-teaser.gif', filename: 'x-teaser.gif' } : new Response(JSON.stringify({ ok: false, error: `unsupported kind: ${b.kind}` }), { status: 400 });
    },
  });
  fresh();
  await X.reveal('x.mp4');
  assert.equal(lastToast(), 'Saved in out/x.mp4');
  await X.exportCompanion({ filename: 'x.mp4', kind: 'gif' });
  assert.equal(lastToast(), 'Downloaded x-teaser.gif');
  assert.deepEqual(downloads, [{ href: '/out/x-teaser.gif', download: 'x-teaser.gif' }]);
  await X.exportCompanion({ filename: 'x.mp4', kind: 'spotify_header' });
  assert.ok(dom.toasts.includes('Generating spotify header…'));
  assert.equal(lastToast(), 'unsupported kind: spotify_header');
});
