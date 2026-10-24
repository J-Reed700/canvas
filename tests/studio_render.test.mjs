import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeElement, fakeCanvas, stubFetch } from './fakes.mjs';

const dom = installDom();
const { useStudioStore: S } = await import('../downbeat/studio/src/store.ts');
const R = await import('../downbeat/studio/src/renderLoop.ts');
const { LOOKS, cloneLook } = await import('../downbeat/studio/looks.ts');
const { METERS } = await import('../downbeat/studio/src/utils.ts');
const { MODULES } = await import('../downbeat/studio/modules.ts');

const el = (id) => { const e = new FakeElement('div'); dom.byId.set(id, e); return e; };
const ids = Object.fromEntries(['fps', 'lane', 'stageBadge', 'timeNow', 'timeLen', 'bbt', 'playhead', 'hudProg'].map((id) => [id, el(id)]));
ids.lane.clientWidth = 400;
const meters = METERS.map((m, i) => {
  const bar = new FakeElement('i');
  new FakeElement('div').append(bar); // connected
  dom.queries.set(`#meters .meter:nth-child(${i + 1}) .bar i`, bar);
  return bar;
});

function fakeEngine() {
  const eng = {
    main: { w: 720, reset() {} },
    frames: [],
    thumbs: [],
    resized: [],
    presentOk: true,
    resize(w, h) { eng.resized.push([w, h]); },
    present: () => eng.presentOk,
    video: (vkey) => ({ vkey }),
    renderMain(fr) { eng.frames.push(fr); },
    renderThumb(id) { eng.thumbs.push(id); },
  };
  return eng;
}

function fakeBank() {
  const b = { synced: [], primed: [], ready: 4, sync(needs, playing) { b.synced.push({ needs, playing }); }, prime(needs) { b.primed.push(needs); }, get: () => ({ readyState: b.ready }) };
  return b;
}

const CLIPS = [{ id: 'a', name: 'a.mp4', duration: 12 }, { id: 'b', name: 'b.mp4', duration: 9 }];
const st = () => S.getState();

let now = 0;
performance.now = () => now;
globalThis.window = { devicePixelRatio: 2 };
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };

function fresh(over = {}) {
  st().transport.pause();
  st().transport.seek(0);
  S.setState({
    clips: CLIPS,
    selected: ['a', 'b'],
    look: cloneLook(LOOKS[0]),
    lookId: LOOKS[0].id,
    features: null,
    bars: 2,
    bpmManual: 120,
    tab: 'looks',
    varOpen: false,
    lookJobs: [],
    varJobs: [],
    ghosts: [],
    modUI: null,
    exporting: false,
    engine: fakeEngine(),
    bank: fakeBank(),
    ...over,
  });
  st().rebuild();
}

const view = fakeCanvas(360, 640);
fresh();
R.startRenderLoop(view);
R.startRenderLoop(view); // a second start is ignored
assert.equal(frames.length, 1);
let lastTick = frames[0];
const frame = (dt = 16) => { now += dt; const f = frames.pop(); f(now); lastTick = f; return st().engine; };
// seek the transport to a loop time, then draw a frame
const at = (t, dt) => { st().transport.seek(t); return frame(dt); };

test('the preview canvas matches the screen density, capped at 1080 wide and at least 400 tall', () => {
  const eng = fakeEngine();
  R.fitView(fakeCanvas(360, 640), eng);
  assert.deepEqual(eng.resized, [[720, 1280]]);
  R.fitView(fakeCanvas(720, 1280), eng);
  assert.deepEqual(eng.resized.at(-1), [1080, 1920]);
  R.fitView(fakeCanvas(90, 160), eng);
  assert.deepEqual(eng.resized.at(-1), [225, 400]);
  const same = Object.assign(fakeCanvas(360, 640), { width: 720, height: 1280 });
  R.fitView(same, eng);
  assert.equal(eng.resized.length, 3, 'no resize when nothing changed');
  R.fitView(same, eng, true);
  assert.equal(eng.resized.length, 4);
  R.fitView(fakeCanvas(0, 0), eng);
  assert.equal(eng.resized.length, 4);
});

test('a frame draws once per frame position and again whenever a look changes', () => {
  fresh();
  let eng = at(1.0);
  assert.equal(eng.frames.length, 1);
  assert.equal(eng.frames[0].sources.length, eng.frames[0].needs.length);
  assert.equal(R.getLastFrame().needs, st().bank.synced.at(-1).needs, 'the frame on screen is the one the videos were synced to');
  eng = frame();
  assert.equal(eng.frames.length, 1, 'same time, same version: nothing to redraw');
  st().look.layers[0].p.strength = 0.9;
  st().touch();
  frame();
  assert.equal(eng.frames.length, 2, 'an edit shows up in the preview straight away');
  eng.presentOk = false;
  frame();
  assert.equal(eng.frames.length, 3, 'a lost canvas is redrawn');
});

test('readouts follow the transport: time, length, bar.beat and the playhead', () => {
  fresh();
  at(2.5);
  assert.equal(ids.timeNow.textContent, '2.50');
  assert.equal(ids.timeLen.textContent, '4.00');
  assert.equal(ids.bbt.textContent, '2.2');
  assert.equal(ids.playhead.style.transform, 'translateX(250px)');
  assert.equal(ids.hudProg.style.width, '62.5%');
  at(0);
  assert.equal(ids.bbt.textContent, '1.1');
});

test('the frame rate readout updates about twice a second', () => {
  fresh();
  ids.fps.textContent = '';
  for (let i = 0; i < 60; i++) frame(20);
  assert.equal(ids.fps.textContent, '50 fps');
});

test('meters show the audio sources of the current frame', () => {
  fresh();
  at(0.02);
  const fr = R.getLastFrame();
  METERS.forEach((m, i) => assert.equal(meters[i].style.height, `${Math.min(1, Math.max(0, fr.mv[m] || 0)) * 100}%`, m));
  assert.notEqual(meters[0].style.height, '0%', 'a kick right on the beat');
});

test('playing primes the clips that are about to appear', () => {
  fresh();
  Object.assign(st().look.cut, { rhythm: 'beat', transitions: ['dissolve'], beats: 0.5 });
  st().rebuild();
  st().transport.play();
  at(1.55); // a cut at 2.0 is 0.35 s ahead
  const { synced, primed } = st().bank;
  assert.equal(synced.at(-1).playing, true);
  assert.ok(primed.length, 'the next cut is parked on its first frame');
  assert.ok(primed.at(-1).every((n) => !synced.at(-1).needs.some((m) => m.vkey === n.vkey)));
  st().transport.pause();
});

test('a clip that is still loading shows a badge and keeps redrawing', () => {
  fresh();
  st().bank.ready = 1;
  const eng = at(1);
  frame();
  assert.equal(ids.stageBadge.style.display, 'block');
  assert.equal(ids.stageBadge.textContent, 'Preparing clip…');
  assert.equal(eng.frames.length, 2);
  st().bank.ready = 4;
  frame();
  assert.equal(ids.stageBadge.style.display, 'none');
});

test('nothing is drawn while exporting or with no clips selected', () => {
  fresh({ exporting: true });
  assert.equal(at(1).frames.length, 0);
  fresh({ selected: [] });
  assert.equal(at(1).frames.length, 0);
  assert.equal(frames.length, 1, 'the loop keeps running');
});

test('slider markers follow the modulated value and are dropped once their slider is gone', () => {
  fresh();
  const marker = new FakeElement('span');
  new FakeElement('div').append(marker);
  const def = MODULES.glass.params.find((p) => p.id === 'strength');
  const gone = new FakeElement('span');
  S.setState({ ghosts: [{ el: marker, def, read: () => def.min + (def.max - def.min) * 0.25 }, { el: gone, def, read: () => 1 }] });
  at(0.5);
  assert.equal(marker.style.left, '25%');
  assert.equal(gone.style.left, undefined);
  for (let i = 0; i < 130; i++) frame();
  assert.equal(st().ghosts.length, 1);
});

test('the step grid lights the current sixteenth and the envelope playhead moves, on the Layers tab', () => {
  const grid = new FakeElement('div');
  new FakeElement('div').append(grid);
  for (let i = 0; i < 16; i++) grid.append(new FakeElement('button'));
  const env = [];
  fresh({ tab: 'layers', modUI: { grid, drawEnv: (u) => env.push(u) } });
  at(0.5); // beat 1 of 8: step 4
  const lit = () => grid.children.map((c, i) => (c.classList.contains('cur') ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(lit(), [4]);
  at(1.25);
  assert.deepEqual(lit(), [10]);
  env.length = 0;
  frame();
  frame();
  assert.ok(env.length >= 1);
  assert.ok(env.every((u) => Math.abs(u - 1.25 / 4) < 1e-9));
  S.setState({ tab: 'looks' });
  at(0);
  assert.deepEqual(lit(), [10], 'off the Layers tab the grid is left alone');
});

test('look thumbnails render a few per frame, taking turns', () => {
  const jobs = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, look: LOOKS[i], visible: i !== 4, ctx2d: {} }));
  fresh({ lookJobs: jobs });
  const eng = at(1);
  assert.deepEqual(eng.thumbs, ['t0', 't1', 't2']);
  frame();
  assert.deepEqual(eng.thumbs.slice(3), ['t3', 't0', 't1'], 'hidden tiles are skipped');
  S.setState({ tab: 'edit' });
  frame();
  assert.equal(eng.thumbs.length, 6);
});

test('proxy status is polled while clips are still converting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  stubFetch({ '/api/state': (u) => { polls++; assert.match(u, /only=clips$/); return { clips: [{ id: 'a', duration: 12, proxy: 'ready' }] }; } });
  S.setState({ clips: [{ id: 'a', duration: 12, proxy: 'building' }] });
  R.pollProxies();
  t.mock.timers.tick(2500);
  await new Promise((r) => setImmediate(r));
  assert.equal(polls, 1);
  assert.equal(st().clips[0].proxy, 'ready');
  t.mock.timers.tick(2500);
  await new Promise((r) => setImmediate(r));
  assert.equal(polls, 1, 'nothing left to wait for');
});
