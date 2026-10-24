import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fakeCanvas, recordingContext, stubFetch, FakeElement } from './fakes.mjs';

const dom = installDom();
const U = await import('../downbeat/studio/src/lib/utils.ts');
const V = await import('../downbeat/studio/src/lib/exportsView.ts');
const { TRANSITIONS } = await import('../downbeat/studio/src/engine/shaders.ts');
const { SEQ_STEPS, ENV_POINTS } = await import('../downbeat/studio/src/engine/audio.ts');
const { rng } = await import('../downbeat/studio/src/engine/timeline.ts');

test('times read as m:ss, and loop lengths switch from seconds to m:ss at one minute', () => {
  assert.equal(U.fmt(0), '0:00');
  assert.equal(U.fmt(59.9), '0:59');
  assert.equal(U.fmt(61), '1:01');
  assert.equal(U.fmt(600), '10:00');
  assert.equal(U.fmtLength(6.4), '6.40s');
  assert.equal(U.fmtLength(59.99), '59.99s');
  assert.equal(U.fmtLength(60), '1:00');
  assert.equal(U.fmtLength(178.6), '2:58');
});

test('typed loop lengths accept m:ss, seconds and minutes', () => {
  const cases = { '2:30': 150, '150': 150, '150s': 150, '150 s': 150, '2.5m': 150, '3 min': 180, ' 8.5 ': 8.5, '1:05.5': 65.5, '0:08': 8, '2:30s': 150, '10M': 600 };
  for (const [text, want] of Object.entries(cases)) assert.equal(U.parseLength(text), want, text);
  for (const bad of ['', 'abc', '-5', '2:30:00', '1.2.3', 'm', '5 bars']) assert.ok(Number.isNaN(U.parseLength(bad)), bad);
  // whatever the length field shows can be typed back in
  for (const s of [3.2, 6.4, 59.5, 60, 150, 599]) assert.ok(Math.abs(U.parseLength(U.fmtLength(s)) - s) < 1, `${s}`);
});

test('shuffle is a permutation and repeats exactly for the same random source', () => {
  const a = U.shuffle([...Array(20).keys()], rng(5));
  const b = U.shuffle([...Array(20).keys()], rng(5));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), [...Array(20).keys()]);
  assert.notDeepEqual(a, [...Array(20).keys()]);
  assert.deepEqual(U.shuffle([]), []);
  assert.deepEqual(U.shuffle([7]), [7]);
});

test('transition pools, loop presets and roll options only name things that exist', () => {
  for (const [pool, ids] of Object.entries(U.POOLS)) {
    assert.ok(ids.length, pool);
    for (const id of ids) assert.ok(id === 'cut' || TRANSITIONS[id], `${pool}: ${id}`);
  }
  assert.ok(!U.POOLS.All.includes('cut'));
  assert.deepEqual(U.BAR_CHOICES, [1, 2, 4, 8]);
  assert.equal(U.MAX_LOOP_SECONDS, 600);
  assert.deepEqual(U.CLIP_MODES.map(([k]) => k), ['one', 'evolve', 'cycle', 'custom']);
  assert.deepEqual(U.ROLL_OPTS.map(([k]) => k).sort(), ['clips', 'edit', 'look', 'loop', 'perClip']);
  assert.deepEqual(U.TRANS_BEATS.map(([b]) => b), [0, 0.25, 0.5, 1, 2]);
  for (const [w, h] of Object.values(U.SIZES)) assert.ok(Math.abs(w / h - 9 / 16) < 0.01);
});

test('every export format has a label and a kind in the exports browser', () => {
  const kinds = new Set(V.EXPORT_KINDS.map(([k]) => k));
  for (const [fmt, f] of Object.entries(U.FORMATS)) {
    assert.ok(f.name && f.short && f.sub, fmt);
    const r = { filename: 'x.mp4', url: '', format: fmt };
    assert.ok(kinds.has(V.kindOf(r)), fmt);
    if (fmt !== 'spotify') assert.notEqual(V.formatLabel(r), 'Spotify Canvas', fmt);
  }
  assert.equal(V.kindOf({ filename: 'x.mp4', url: '', format: 'made_up' }), 'spotify');
  assert.equal(V.formatLabel({ filename: 'x.mp4', url: '' }), 'Spotify Canvas');
});

test('sequencer and envelope presets fill every step with values in range', () => {
  for (const [name, make] of Object.entries(U.SEQ_PRESETS)) {
    const seq = make();
    assert.equal(seq.length, SEQ_STEPS, name);
    assert.ok(seq.every((v) => v === 0 || v === 1), name);
    assert.ok(seq.includes(1), `${name} has at least one hit`);
    assert.notEqual(make(), make(), `${name} must hand out a fresh array each time`);
  }
  for (const [name, make] of Object.entries(U.ENV_PRESETS)) {
    const env = make();
    assert.equal(env.length, ENV_POINTS, name);
    assert.ok(env.every((v) => v >= 0 && v <= 1), name);
  }
  assert.equal(U.ENV_PRESETS.Ramp()[0], 0);
  assert.equal(U.ENV_PRESETS.Ramp().at(-1), 1);
});

test('h() builds elements with classes, styles, listeners, attributes and children', () => {
  let clicks = 0;
  const kid = new FakeElement('span');
  const e = U.h('button', { class: 'chip on', style: 'color: red', onclick: () => clicks++, disabled: true, hidden: false, title: 'Go', 'data-n': 3, skip: null }, 'Play', [kid, null, false], 0);
  assert.equal(e.tagName, 'BUTTON');
  assert.equal(e.className, 'chip on');
  assert.equal(e.style.cssText, 'color: red');
  assert.deepEqual(e.attributes, { disabled: '', title: 'Go', 'data-n': '3' });
  assert.deepEqual(e.children.map((c) => c.textContent || c.tagName), ['Play', 'SPAN', '0']);
  e.click();
  assert.equal(clicks, 1);
});

test('toast shows a message and hides it after its time, restarting for a new one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = dom.byId.get('toast');
  U.toast('Saved', 1000);
  assert.equal(el.textContent, 'Saved');
  assert.ok(el.classList.contains('on'));
  t.mock.timers.tick(900);
  U.toast('Saved again', 1000);
  t.mock.timers.tick(900);
  assert.ok(el.classList.contains('on'), 'the second toast keeps it up');
  t.mock.timers.tick(200);
  assert.ok(!el.classList.contains('on'));
});

test('popovers stay inside the window, flip above when there is no room, and close on an outside click', () => {
  const pop = new FakeElement('div');
  dom.byId.set('pop', pop);
  globalThis.window = { innerWidth: 400, innerHeight: 300 };
  try {
    const anchor = new FakeElement('button');
    anchor.rect = { left: 350, right: 390, top: 20, bottom: 40 };
    U.openPop(anchor, (p) => { p.offsetWidth = 200; p.offsetHeight = 100; }, 'menu');
    assert.equal(pop.className, 'pop on menu');
    assert.equal(pop.style.left, '190px'); // right-aligned to the anchor
    assert.equal(pop.style.top, '46px');

    anchor.rect = { left: 5, right: 60, top: 260, bottom: 280 };
    U.openPop(anchor, (p) => { p.offsetWidth = 200; p.offsetHeight = 100; });
    assert.equal(pop.style.left, '8px');
    assert.equal(pop.style.top, '154px'); // above the anchor

    const [onDown] = document.listeners.pointerdown;
    const inside = new FakeElement('a');
    pop.append(inside);
    onDown({ target: inside });
    assert.ok(pop.className.includes('on'));
    onDown({ target: new FakeElement('div') });
    assert.equal(pop.className, 'pop');
  } finally {
    delete globalThis.window;
  }
});

test('canvases are sized for the screen density and only resized when that changes', () => {
  globalThis.devicePixelRatio = 2;
  try {
    const c = fakeCanvas(300, 60);
    assert.deepEqual(U.sizeCanvas(c), [600, 120, 2]);
    assert.equal(c.width, 600);
    let writes = 0;
    Object.defineProperty(c, 'width', { get: () => 600, set: () => { writes++; } });
    U.sizeCanvas(c);
    assert.equal(writes, 0);
  } finally {
    delete globalThis.devicePixelRatio;
  }
  assert.deepEqual(U.sizeCanvas(fakeCanvas(0, 0)), [1, 1, 1]);
});

test('roundRect traces one closed path with four rounded corners', () => {
  const x = recordingContext();
  U.roundRect(x, 0, 0, 100, 40, 6);
  assert.deepEqual(x.calls.map((c) => c.fn), ['beginPath', 'moveTo', 'arcTo', 'arcTo', 'arcTo', 'arcTo', 'closePath']);
});

test('framing room: wide clips can pan sideways in the 9:16 frame, matching ones cannot', () => {
  const wide = U.room({ width: 1920, height: 1080 }, 1);
  assert.ok(Math.abs(wide.frac[0] - (9 / 16) / (16 / 9)) < 1e-9);
  assert.equal(wide.frac[1], 1);
  assert.ok(wide.room[0] > 0.3 && wide.room[1] === 0);
  assert.deepEqual(U.room({ width: 1080, height: 1920 }, 1).room, [0, 0]);
  // zooming in gives a matching clip room on both axes
  const zoomed = U.room({ width: 1080, height: 1920 }, 2);
  assert.deepEqual(zoomed.room, [0.25, 0.25]);
  assert.deepEqual(U.room({}, 1).frac, [1, 1]);
});

test('fetchJSON throws on errors, postJSON keeps the server error and never throws', async () => {
  const reqs = stubFetch({
    '/api/ok': () => ({ a: 1 }),
    '/api/missing': () => new Response('nope', { status: 404 }),
    'POST /api/thing': (_u, init) => new Response(JSON.stringify({ ok: false, error: `bad ${JSON.parse(init.body).id}` }), { status: 400 }),
  });
  assert.deepEqual(await U.fetchJSON('/api/ok'), { a: 1 });
  await assert.rejects(U.fetchJSON('/api/missing'), /\/api\/missing: 404/);
  assert.deepEqual(await U.postJSON('/api/thing', { id: 7 }), { ok: false, error: 'bad 7' });
  assert.equal(reqs.at(-1).headers['Content-Type'], 'application/json');
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  const r = await U.postJSON('/api/thing', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /offline/);
  assert.equal(await U.detectSubject('clip'), null);
});

test('saveToDownloads clicks a temporary download link and removes it', () => {
  const seen = [];
  const append = document.body.append.bind(document.body);
  document.body.append = (a) => { a.addEventListener('click', () => seen.push({ ...a.attributes, attached: a.isConnected })); append(a); };
  try {
    U.saveToDownloads('/out/a.mp4', 'a.mp4');
  } finally {
    delete document.body.append;
  }
  assert.deepEqual(seen, [{ href: '/out/a.mp4', download: 'a.mp4', attached: true }]);
  assert.equal(document.body.children.length, 0);
});

test('song names, library sources and sibling songs for batch renders', () => {
  assert.equal(U.songTitle({ id: '1', name: 'My Song.final.mp3' }), 'My Song.final');
  assert.equal(U.sourceLabel('added'), 'Added in the studio');
  assert.equal(U.sourceLabel('downloads'), 'Downloads');
  assert.equal(U.sourceLabel('/Users/x/Music/'), 'Music');
  assert.equal(U.sourceLabel(), '');
  const t = (id, source, dir, mtime) => ({ id, name: `${id}.mp3`, source, dir, mtime });
  const tracks = [t('a', 'downloads', '', 1), t('b', 'downloads', '', 3), t('c', 'downloads', 'sub', 9), t('d', '/m', '', 5), t('e', 'downloads', '', 2)];
  assert.deepEqual(U.siblingTracks(tracks, 'a').map((x) => x.id), ['b', 'e', 'a']);
  assert.deepEqual(U.siblingTracks(tracks, 'a', 2).map((x) => x.id), ['b', 'e']);
  assert.deepEqual(U.siblingTracks(tracks, 'c').map((x) => x.id), ['c']);
  assert.deepEqual(U.siblingTracks(tracks, 'nope'), []);
});

const render = (o) => ({ filename: 'canvas-x-120bpm-6.4s-720x1280-20261023-120000.mp4', url: '/out/x.mp4', ...o });

test('export titles, sizes, spec badges and meta lines', () => {
  assert.equal(V.titleOf(render({ look: 'Neon Tide' })), 'Neon Tide');
  assert.equal(V.titleOf(render({ filename: 'canvas-liquid-chrome-150bpm-6.4s-720x1280-1.mp4' })), 'Liquid Chrome');
  assert.equal(V.aspectOf(render({ resolution: '1920x1080' })), 1920 / 1080);
  assert.equal(V.aspectOf(render({ resolution: 'odd' })), 9 / 16);
  assert.equal(V.specOf(render({})), null);
  assert.equal(V.specOf(render({ checks: [{ id: 'a', label: '', level: 'ok' }] })), 'pass');
  assert.equal(V.specOf(render({ checks: [{ id: 'a', label: '', level: 'ok' }, { id: 'b', label: '', level: 'warn' }] })), 'warn');
  assert.equal(V.specOf(render({ checks: [{ id: 'b', label: '', level: 'warn' }, { id: 'c', label: '', level: 'fail' }] })), 'fail');
  assert.deepEqual(Object.keys(V.CHECK_ICONS).sort(), ['fail', 'ok', 'warn']);
  assert.equal(V.metaLine(render({ resolution: '1080x1920', duration: 6.4, size_mb: 3.25 })), '1080×1920 · 6.40 s · 3.25 MB');
  assert.equal(V.metaLine(render({ size_mb: 0 })), '0 MB');
  assert.equal(V.metaLine(render({})), '');
});

test('timeAgo counts minutes, hours and days, then shows a date', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const now = Date.now() / 1000;
  assert.equal(V.timeAgo(), '');
  assert.equal(V.timeAgo(now - 30), 'just now');
  assert.equal(V.timeAgo(now - 125), '2 min ago');
  assert.equal(V.timeAgo(now - 3 * 3600), '3 h ago');
  assert.equal(V.timeAgo(now - 2 * 86400), '2 d ago');
  assert.match(V.timeAgo(now - 30 * 86400), /\w+ \d+|\d+ \w+/);
});

test('the exports list filters by kind and every search word, and sorts four ways', () => {
  const rs = [
    render({ filename: 'a.mp4', look: 'Neon Tide', format: 'spotify', created_at: 3, size_mb: 2, bpm: 128 }),
    render({ filename: 'b.mp4', look: 'Liquid Chrome', format: 'youtube_16_9', created_at: 1, size_mb: 90, resolution: '1920x1080' }),
    render({ filename: 'c.mp4', look: 'Acid Bloom', format: 'apple_tall', created_at: 2, size_mb: 30 }),
  ];
  const f = (o) => V.filterExports(rs, { q: '', kind: 'all', sort: 'new', ...o }).map((r) => r.filename);
  assert.deepEqual(f({}), ['a.mp4', 'c.mp4', 'b.mp4']);
  assert.deepEqual(f({ sort: 'old' }), ['b.mp4', 'c.mp4', 'a.mp4']);
  assert.deepEqual(f({ sort: 'big' }), ['b.mp4', 'c.mp4', 'a.mp4']);
  assert.deepEqual(f({ sort: 'name' }), ['c.mp4', 'b.mp4', 'a.mp4']);
  assert.deepEqual(f({ sort: 'bogus' }), f({}));
  assert.deepEqual(f({ kind: 'youtube' }), ['b.mp4']);
  assert.deepEqual(f({ kind: 'apple' }), ['c.mp4']);
  assert.deepEqual(f({ q: 'NEON' }), ['a.mp4']);
  assert.deepEqual(f({ q: '128 bpm' }), ['a.mp4']);
  assert.deepEqual(f({ q: 'chrome 1920x1080' }), ['b.mp4']);
  assert.deepEqual(f({ q: 'chrome apple' }), []);
  assert.deepEqual(f({ q: '  youtube  ' }), ['b.mp4']);
  assert.deepEqual(f({ q: '4' }), ['c.mp4']);
  assert.deepEqual(f({ q: 'mp4' }), []);
});

test('page lists show every page up to seven, then the ends and neighbors with gaps', () => {
  assert.deepEqual(V.pageList(0, 1), [0]);
  assert.deepEqual(V.pageList(3, 7), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(V.pageList(0, 12), [0, 1, null, 11]);
  assert.deepEqual(V.pageList(5, 12), [0, null, 4, 5, 6, null, 11]);
  assert.deepEqual(V.pageList(11, 12), [0, null, 10, 11]);
  assert.deepEqual(V.pageList(2, 12), [0, 1, 2, 3, null, 11]);
});
