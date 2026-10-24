import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, stubFetch, tick } from './fakes.mjs';

const dom = installDom();
const { useStudioStore: S } = await import('../downbeat/studio/src/state/store.ts');
const history = await import('../downbeat/studio/src/state/historyController.ts');
const media = await import('../downbeat/studio/src/state/mediaActions.ts');
const { LOOKS, cloneLook } = await import('../downbeat/studio/src/engine/looks.ts');
const { MODULES } = await import('../downbeat/studio/src/engine/modules.ts');
const { RHYTHMS } = await import('../downbeat/studio/src/engine/timeline.ts');
const { TRANSITIONS } = await import('../downbeat/studio/src/engine/shaders.ts');
const { toast } = await import('../downbeat/studio/src/lib/utils.ts');
const { defaultEnv, defaultSeq, defaultLfos } = await import('../downbeat/studio/src/engine/audio.ts');

// The last toast's hide timer would keep Node running for up to four seconds.
after(() => toast('', 0));

const CLIPS = [
  { id: 'a', name: '1 sunrise.mp4', duration: 12, width: 1080, height: 1920 },
  { id: 'b', name: 'city.mp4', duration: 9, width: 1920, height: 1080 },
  { id: 'c', name: 'cover.still.mp4', duration: 20, width: 1080, height: 1080, still: true },
];
// A 3-minute song at 120 BPM: a bar every 2 s, the first downbeat at 1.5 s.
const SONG = {
  id: 't1',
  duration: 180,
  fps: 30,
  bpm: 120,
  downbeats: Array.from({ length: 89 }, (_, i) => 1.5 + i * 2),
  loops: [{ start: 33.5 }, { start: 65.5 }],
  loop_bars: 4,
  curves: { kick: Array.from({ length: 5400 }, (_, i) => (i % 15 === 0 ? 1 : 0)), snare: [], energy: Array(5400).fill(0.5) },
  peaks: Array(200).fill(0.4),
};
const FAKE_BUFFER = { duration: 180 };

const lastToast = () => dom.toasts.at(-1);
const st = () => S.getState();

function fresh(over = {}) {
  st().transport.unload();
  S.setState({
    clips: CLIPS.map((c) => ({ ...c })),
    tracks: [],
    selected: ['a', 'b', 'c'],
    look: cloneLook(LOOKS[0]),
    lookId: LOOKS[0].id,
    saved: [],
    features: null,
    trackId: '',
    bars: 4,
    loopStart: 0,
    bpmManual: 120,
    bpmOverride: {},
    gridNudge: {},
    seed: 2026,
    direction: 'forward',
    lockEdit: false,
    intensity: 1,
    rebound: false,
    fitAll: true,
    clipMode: 'one',
    evolveCuts: false,
    clipLooks: {},
    editClip: null,
    blocks: null,
    legacyEdit: null,
    selectedBlock: null,
    snap: 1,
    clipFrame: {},
    palettes: {},
    rollOpts: { look: true, edit: true, perClip: true, clips: false, loop: false },
    exportOpts: { size: 'master', withSong: false, format: 'spotify', promo: 0, autoSave: true },
    ...over,
  });
  st().rebuild();
}

const withSong = (over = {}) => fresh({ features: structuredClone(SONG), trackId: 't1', ...over });

test('without a song a loop can be any whole number of bars up to ten minutes', () => {
  fresh();
  assert.equal(st().barDur(), 2);
  assert.equal(st().maxBars(), 300);
  for (const [asked, got] of [[100000, 300], [0, 1], [-3, 1], [2.6, 3], [NaN, 1], [37, 37]]) {
    st().setBars(asked);
    assert.equal(st().bars, got, `asked for ${asked}`);
    assert.equal(st().loopLen(), got * 2);
    assert.equal(st().ctx.L, got * 2);
  }
  const { tl } = st().ctx;
  assert.equal(tl.segs[0].t0, 0);
  assert.ok(Math.abs(tl.segs.at(-1).t1 - 74) < 1e-9);
});

test('setting a length clears hand-placed cuts, and a stored bar count is clamped when read', () => {
  fresh({ legacyEdit: { customCuts: [1, 2.5], segOverrides: {} } });
  assert.equal(st().ctx.tl.segs.length, 3);
  st().setBars(2);
  assert.equal(st().blocks, null);
  S.setState({ bars: 5000 });
  assert.equal(st().loopLen(), 600);
});

test('Spotify-length presets depend on the tempo and are cached per bar length', () => {
  fresh();
  assert.deepEqual(st().canvasBars(), [2, 4]); // 4 s and 8 s at 120 BPM
  assert.equal(st().canvasBars(), st().canvasBars());
  S.setState({ bpmManual: 60 });
  assert.deepEqual(st().canvasBars(), [1, 2]);
  S.setState({ bpmManual: 180 });
  assert.deepEqual(st().canvasBars(), [4]); // 2 bars are 2.67 s, 8 bars 10.67 s
});

test('with a song the longest loop runs from the first downbeat to the end', () => {
  withSong();
  assert.equal(st().bpm(), 120);
  assert.equal(st().maxBars(), 89);
  st().wholeSong();
  assert.equal(st().loopStart, 1.5);
  assert.equal(st().bars, 89);
  assert.equal(st().ctx.L, 178);
  assert.equal(st().transport.start, 1.5);
  assert.equal(st().transport.len, 178);
  S.setState({ features: { ...SONG, duration: undefined } });
  assert.equal(st().maxBars(), 300);
});

test('a long loop that would run past the end of the song moves back to the last downbeat that fits', () => {
  withSong({ loopStart: 151.5 });
  st().setBars(20); // 40 s
  assert.equal(st().loopStart, 139.5);
  assert.ok(st().loopStart + st().loopLen() <= SONG.duration);
  assert.equal(st().transport.start, 139.5);
  // a loop that fits stays where it is
  withSong({ loopStart: 33.5 });
  st().setBars(8);
  assert.equal(st().loopStart, 33.5);
});

test('the beat-grid nudge shifts the audio, stays within a quarter second and resets', () => {
  fresh();
  st().nudgeGrid(0.1);
  assert.deepEqual(st().gridNudge, {}, 'no song, nothing to nudge');
  withSong({ loopStart: 33.5 });
  st().nudgeGrid(0.01);
  st().nudgeGrid(0.01);
  assert.equal(st().gridNudge.t1, 0.02);
  assert.equal(st().audioStart(), 33.52);
  assert.equal(st().transport.start, 33.52);
  for (let i = 0; i < 40; i++) st().nudgeGrid(0.01);
  assert.equal(st().gridNudge.t1, 0.25);
  st().nudgeGrid(null);
  assert.equal(st().audioStart(), 33.5);
});

test('every edit to a look bumps the version, so panels that read the look redraw', () => {
  // The bug behind "nothing happens when I click": looks are edited in place, and panels only
  // re-render when version changes.
  const actions = {
    rebuild: () => st().rebuild(),
    setBars: () => st().setBars(2),
    setLook: () => st().setLook(LOOKS[3]),
    applyLook: () => st().applyLook(LOOKS[4]),
    stepLook: () => st().stepLook(1),
    setClipMode: () => st().setClipMode('evolve'),
    editClipLook: () => st().editClipLook('b'),
    toggleClip: () => st().toggleClip('c'),
    reorderClips: () => st().reorderClips('reverse'),
    nudgeGrid: () => st().nudgeGrid(0.01),
    surprise: () => st().surprise(),
    rollAll: () => st().rollAll(),
    undoRoll: () => st().undoRoll(),
    rollClips: () => st().rollClips(),
  };
  for (const [name, run] of Object.entries(actions)) {
    withSong();
    const v = st().version;
    run();
    assert.ok(st().version > v, `${name} did not bump the version`);
  }
});

test('setLook works on a copy, and keeps the edit only when the edit is locked', () => {
  fresh({ legacyEdit: { customCuts: [1], segOverrides: { 0: { trans: 'zoom' } } } });
  assert.equal(st().blocks.length, 2);
  st().setLook(LOOKS[2]);
  assert.equal(st().lookId, LOOKS[2].id);
  assert.notEqual(st().look, LOOKS[2]);
  st().look.layers[0].p.x = 99;
  assert.equal(LOOKS[2].layers[0].p.x, undefined, 'editing the look must not change the preset');
  assert.equal(st().blocks, null);

  const cut = { ...st().look.cut, rhythm: 'eighth' };
  st().look.cut = cut;
  S.setState({ lockEdit: true });
  st().setLook(LOOKS[5]);
  assert.equal(st().look.cut, cut);
  S.setState({ lockEdit: false });
  st().setLook(LOOKS[6], { keepEdit: true });
  assert.equal(st().look.cut, cut);
  st().setLook(LOOKS[6]);
  assert.deepEqual(st().look.cut, LOOKS[6].cut);
});

test('stepping through looks goes through your saved looks first and wraps around', () => {
  fresh();
  const mine = { ...cloneLook(LOOKS[1]), id: 'mine-1', name: 'Mine' };
  S.setState({ saved: [mine], lookId: 'mine-1' });
  st().stepLook(-1);
  assert.equal(st().lookId, LOOKS.at(-1).id);
  st().stepLook(1);
  assert.equal(st().lookId, 'mine-1');
  st().stepLook(1);
  assert.equal(st().lookId, LOOKS[0].id);
  assert.equal(lastToast(), LOOKS[0].name);
});

test('per-clip looks: same, evolve, look per clip and custom', () => {
  fresh();
  assert.equal(st().ctx.clipLook, null);
  for (const id of ['a', 'b', 'c']) assert.equal(st().clipLookOf(id), st().look);

  st().setClipMode('evolve');
  const evolved = ['a', 'b', 'c'].map((id) => st().clipLookOf(id));
  assert.equal(evolved[0], st().look, 'the first clip keeps the main look');
  assert.notDeepEqual(evolved[1].layers, st().look.layers);
  assert.notDeepEqual(evolved[1].layers, evolved[2].layers);
  assert.equal(st().clipLookOf('b'), evolved[1], 'cached until something changes');
  assert.deepEqual(st().ctx.clipLook('b'), evolved[1]);

  st().setClipMode('cycle');
  const cycled = ['b', 'c'].map((id) => st().clipLookOf(id));
  for (const l of cycled) {
    assert.notEqual(l.id, st().lookId);
    assert.notEqual(l.id, 'clean');
  }
  assert.notEqual(cycled[0].id, cycled[1].id);

  // switching to custom keeps what each clip had
  st().setClipMode('custom');
  assert.deepEqual(Object.keys(st().clipLooks).sort(), ['b', 'c']);
  assert.equal(st().clipLooks.b.id, cycled[0].id);
  assert.notEqual(st().clipLooks.b, cycled[0], 'custom looks are copies');
  assert.equal(st().clipLookOf('a'), st().look);
});

test('Evolve per cut gives every cut after the first its own mutation', () => {
  fresh({ clipMode: 'evolve', evolveCuts: true });
  const segs = st().ctx.tl.segs;
  assert.ok(segs.length > 3);
  const looks = segs.map((seg) => st().clipLookOf(seg.clipId, seg));
  assert.equal(looks[0], st().look, 'the first cut keeps the main look');
  for (const l of looks.slice(1)) assert.notDeepEqual(l.layers, st().look.layers);
  const again = segs.findIndex((seg, i) => i > 0 && seg.clipId === segs[1].clipId && seg.i !== segs[1].i);
  if (again > 0) assert.notDeepEqual(looks[again].layers, looks[1].layers, 'the same clip changes from cut to cut');
  assert.equal(st().clipLookOf(segs[2].clipId, segs[2]), looks[2], 'cached until something changes');
  assert.equal(st().ctx.clipLook(segs[2].clipId, segs[2]), looks[2]);
  assert.equal(st().clipLookOf('b'), st().look, 'with no cut to go by, the main look');

  // switched off, it goes back to one mutation per clip
  S.setState({ evolveCuts: false });
  st().touch();
  assert.equal(st().clipLookOf(segs[2].clipId, segs[2]), st().clipLookOf(segs[2].clipId));
});

test('ctx.clipLook reads live state instead of the state it was built from', () => {
  fresh({ clipMode: 'custom' });
  const fn = st().ctx.clipLook;
  const special = cloneLook(LOOKS[7]);
  S.setState({ clipLooks: { b: special } });
  st().touch();
  assert.equal(fn('b'), special);
  assert.equal(st().ctx.clipDur('a'), 12);
  assert.equal(st().ctx.clipDur('unknown'), 10);
});

test('rebuilding the edit releases stale clip-duration entries', () => {
  fresh();
  assert.equal(st().clipDur.size, 3);
  S.setState({ clips: CLIPS.filter((clip) => clip.id !== 'b'), selected: ['a', 'c'] });
  st().rebuild();
  assert.equal(st().clipDur.size, 2);
  assert.equal(st().clipDur.has('b'), false);
  assert.equal(st().ctx.clipDur('a'), 12);
});

test('opening one clip for editing gives it its own copy and applies looks to that clip only', () => {
  fresh();
  st().editClipLook('b');
  assert.equal(st().clipMode, 'custom');
  assert.equal(st().tab, 'layers');
  assert.equal(st().editClip, 'b');
  assert.deepEqual(st().clipLooks.b, st().look);
  assert.notEqual(st().clipLooks.b, st().look);
  assert.equal(st().editLook(), st().clipLooks.b);

  const main = st().look;
  st().applyLook(LOOKS[9]);
  assert.equal(st().look, main, 'the main look is untouched');
  assert.equal(st().clipLooks.b.id, LOOKS[9].id);
  assert.equal(lastToast(), `Clip 2 → ${LOOKS[9].name}`);

  st().editClipLook(null);
  assert.equal(st().editLook(), st().look);
  st().applyLook(LOOKS[10]);
  assert.equal(st().lookId, LOOKS[10].id);
  st().setClipMode('one');
  assert.equal(st().editClip, null);
});

test("an older session's per-cut settings and dragged cuts open as blocks, looking the way they did", () => {
  fresh();
  const plain = st().ctx.tl.segs;
  fresh({ legacyEdit: { customCuts: null, segOverrides: { 1: { clipId: 'c', trans: 'zoom', vel: 'surge', in: 500 }, 2: { clipId: 'not-selected' }, 99: { trans: 'zoom' } } } });
  assert.equal(st().legacyEdit, null, 'read once');
  assert.equal(st().blocks.length, plain.length);
  const seg = st().ctx.tl.segs[1];
  assert.equal(seg.clipId, 'c');
  assert.equal(seg.trans, 'zoom');
  assert.equal(seg.vel, 'surge');
  assert.ok(Math.abs(seg.in - (20 - seg.dur - 0.1)) < 1e-9, 'the in-point is held where the footage still fills the segment');
  assert.equal(st().ctx.tl.segs[2].clipId, plain[2].clipId, 'an unselected clip is ignored');
  assert.deepEqual(st().ctx.tl.segs.filter((x) => x.i !== 1).map((x) => [x.t0, x.trans, x.in]), plain.filter((x) => x.i !== 1).map((x) => [x.t0, x.trans, x.in]));
  assert.equal(st().ctx.tl.handCut, false);

  fresh({ legacyEdit: { customCuts: [1, 2.5], segOverrides: { 1: { trans: 'zoom' } } } });
  assert.deepEqual(st().ctx.tl.segs.map((x) => [x.t0, x.trans === 'zoom']), [[0, false], [1, true], [2.5, false]]);
  assert.equal(st().ctx.tl.handCut, true);

  fresh({ trackId: 't1', legacyEdit: { customCuts: [1], segOverrides: {} } });
  assert.ok(st().legacyEdit, 'cut lines in seconds wait for the song and its tempo');
});

test('the first block edit keeps the edit as it played, and the edit goes back to the rhythm when nothing is left', () => {
  fresh();
  const before = st().ctx.tl.segs;
  st().transport.seek(3.1);
  st().splitAtPlayhead();
  assert.equal(lastToast(), 'Split segment 2');
  const after = st().ctx.tl.segs;
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.filter((x) => x.id !== 'h1'), before.map((x) => (x.id === 'g1' ? { ...x, t1: 3, dur: 1, span: [0, 0.5] } : { ...x, i: x.i > 1 ? x.i + 1 : x.i })));
  assert.equal(st().selectedBlock, 'h1', 'the new segment is selected');
  assert.equal(st().ctx.tl.handCut, true);
  st().deleteBlock();
  assert.equal(lastToast(), 'Deleted segment 3. Segment 2 plays on to the next cut.');
  assert.equal(st().blocks.length, before.length, 'the left half keeps its shorter drift path, so it is still a block of its own');
  st().setBlock('g1', { trans: 'zoom' });
  st().clearBlock('g1');
  assert.ok(st().blocks.find((b) => b.id === 'g1').span);
  st().transport.seek(2.1); // snaps to beat 4, where segment 2 starts
  st().splitAtPlayhead();
  assert.equal(lastToast(), "There's already a cut here");
});

test('a hand-cut edit keeps through tempo, speed, direction, transitions and a look-only roll, but not a new rhythm, length or clip list', () => {
  const cut = () => {
    fresh();
    st().transport.seek(3);
    st().splitAtPlayhead();
    return st().blocks;
  };
  const blocks = cut();
  S.setState({ bpmManual: 100, direction: 'reverse' });
  st().look.camera.p.speed = 1.5;
  st().look.cut.transitions = ['zoom'];
  st().look.cut.beats = 2;
  st().rebuild();
  assert.equal(st().blocks, blocks);
  assert.deepEqual(st().ctx.tl.segs.map((x) => x.t0 / st().ctx.beatDur), [0, 4, 6, 8, 12], 'still on their beats at the new tempo');
  assert.ok(st().ctx.tl.segs.slice(1).every((x) => x.rev && (x.trans === 'zoom' || x.id === 'h1')));
  S.setState({ rollOpts: { look: true, edit: false, perClip: false, clips: false, loop: false } });
  st().rollAll();
  assert.equal(st().blocks, blocks, 'a roll of the look alone');

  for (const change of [
    () => { st().look.cut.rhythm = 'beat'; S.setState({ blocks: null }); st().rebuild(); }, // as the rhythm buttons do
    () => st().setBars(2),
    () => st().toggleClip('b'),
    () => { S.setState({ rollOpts: { look: true, edit: true, perClip: false, clips: false, loop: false } }); st().rollAll(); },
  ]) {
    cut();
    change();
    assert.equal(st().blocks, null);
  }
  // the two rolls go back off the roll history, which later tests start empty
  st().undoRoll();
  st().undoRoll();
  st().undoRoll();
  assert.equal(lastToast(), 'Nothing to undo');
});

test('block edits each make one undo step, and a dragged cut settles into one', async (t) => {
  await tick(400);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fresh();
  const settle = () => { st().save(); t.mock.timers.tick(400); };
  settle();
  st().transport.seek(3);
  st().splitAtPlayhead();
  settle();
  for (const beat of [7, 7.5, 9, 10]) st().trimCut('g2', beat, 2);
  settle();
  assert.equal(st().ctx.tl.segs[3].t0, 5);
  st().undo();
  assert.equal(st().ctx.tl.segs[3].t0, 4, 'the whole drag goes back at once');
  st().undo();
  assert.equal(st().blocks, null);
  st().redo();
  st().redo();
  assert.equal(st().ctx.tl.segs[3].t0, 5);
});

test('the edit reacts to song hits when the cut rhythm is "On hits"', () => {
  withSong({ loopStart: 1.5 });
  st().look.cut.rhythm = 'hits';
  st().rebuild();
  const { segs } = st().ctx.tl;
  assert.ok(segs.length >= 3, 'at least one cut per clip');
  for (const s of segs) assert.ok(Math.abs(s.t0 / 0.5 - Math.round(s.t0 / 0.5)) < 1e-9, 'hits land on beats');
});

test('changing the tempo validates it, stores it per song and re-analyzes', async () => {
  fresh();
  await st().setTempo(128);
  assert.deepEqual(st().bpmOverride, {}, 'no song, no tempo override');
  const reqs = stubFetch({ 'GET /api/features/t1': (u) => ({ ...SONG, bpm: u.includes('bpm=') ? +u.split('bpm=')[1] : 120 }) });
  withSong({ loopStart: 33.5, bars: 8 });
  st().transport.buffer = FAKE_BUFFER;
  st().transport.trackId = 't1';
  for (const bad of [30, 300, NaN, Infinity]) await st().setTempo(bad);
  assert.equal(reqs.length, 0);
  await st().setTempo(127.456);
  assert.deepEqual(st().bpmOverride, { t1: 127.46 });
  assert.match(reqs.at(-1).url, /\/api\/features\/t1\?bpm=127.46$/);
  assert.equal(st().bpm(), 127.46);
  assert.match(lastToast(), /^Tempo 127.46 BPM/);
  await st().setTempo(null);
  assert.deepEqual(st().bpmOverride, {});
  assert.equal(reqs.at(-1).url, '/api/features/t1');
});

test('picking a song loads its analysis and suggested loop, and ignores a slower earlier pick', async () => {
  fresh();
  let release;
  const slow = new Promise((r) => { release = r; });
  stubFetch({
    'GET /api/features/t1': async () => { await slow; return { ...SONG, id: 't1' }; },
    'GET /api/features/t2': () => ({ ...SONG, id: 't2', bpm: 90, loops: [{ start: 9.5 }], loop_bars: 2 }),
    'GET /api/features/bad': () => new Response('boom', { status: 500 }),
  });
  st().transport.decode = async () => FAKE_BUFFER;
  const first = st().selectTrack('t1');
  assert.equal(st().trackStateText, 'Analyzing…');
  await tick();
  assert.equal(st().transport.buffer, FAKE_BUFFER, 'the song can be heard before its analysis is in');
  assert.equal(st().transport.trackId, 't1');
  await st().selectTrack('t2');
  release();
  await first;
  assert.equal(st().trackId, 't2');
  assert.equal(st().features.id, 't2');
  assert.equal(st().loopStart, 9.5);
  assert.equal(st().bars, 2);
  assert.equal(st().trackStateText, '');
  assert.equal(st().transport.trackId, 't2');

  const err = console.error;
  console.error = () => {};
  try {
    await st().selectTrack('bad');
  } finally {
    console.error = err;
  }
  assert.equal(st().trackStateText, 'Analysis failed');
  assert.equal(st().features, null);

  await st().selectTrack('');
  assert.equal(st().features, null);
  assert.equal(st().loopStart, 0);
  assert.equal(st().transport.buffer, null);
});

test('a slower failed song selection cannot erase a newer successful selection', async () => {
  fresh();
  let fail;
  const old = new Promise((_, reject) => { fail = reject; });
  stubFetch({
    'GET /api/features/t1': () => old,
    'GET /api/features/t2': () => ({ ...SONG, id: 't2', bpm: 90 }),
  });
  st().transport.decode = async () => FAKE_BUFFER;
  const first = st().selectTrack('t1');
  await st().selectTrack('t2');
  const current = st().features;
  const version = st().version;
  fail(new Error('the earlier analysis failed'));
  await first;
  assert.equal(st().features, current);
  assert.equal(st().trackStateText, '');
  assert.equal(st().version, version, 'a stale failure cannot rebuild the new edit');
});

test('opening a saved song edit at zero keeps its loop length and hand cuts', async () => {
  fresh({ trackId: 't1', loopStart: 0, bars: 2 });
  stubFetch({ 'GET /api/features/t1': () => ({ ...SONG, loops: [{ start: 33.5 }], loop_bars: 4 }) });
  st().transport.decode = async () => FAKE_BUFFER;
  st().setBlock(st().ctx.tl.segs[0].id, { in: 0.25 });
  const blocks = st().blocks;
  assert.ok(blocks);
  await st().selectTrack('t1', { initial: true });
  assert.equal(st().loopStart, 0);
  assert.equal(st().bars, 2);
  assert.equal(st().blocks, blocks);
});

test('tap tempo needs four taps, sets the tempo without a song and starts over after a pause', (t) => {
  fresh();
  let now = 1000;
  const real = performance.now;
  performance.now = () => now;
  t.after(() => { performance.now = real; });
  for (let i = 0; i < 3; i++) { st().tapTempo(); now += 500; }
  assert.equal(lastToast(), 'Tap 1 more…');
  st().tapTempo();
  assert.equal(st().bpmManual, 120);
  assert.equal(lastToast(), '120 BPM');
  now += 5000;
  st().tapTempo();
  assert.equal(lastToast(), 'Tap 3 more…');
});

test('the session is saved shortly after a change and read back on the next start', async (t) => {
  await tick(400); // let timers from earlier tests run out
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fresh({ bars: 6, seed: 77, tab: 'edit' });
  dom.storage.clear();
  st().save();
  t.mock.timers.tick(299);
  assert.equal(dom.storage.size, 0, 'slider ticks are batched');
  t.mock.timers.tick(5);
  const saved = JSON.parse(dom.storage.get('downbeat.studio.v1'));
  assert.equal(saved.bars, 6);
  assert.equal(saved.seed, 77);
  assert.equal(saved.tab, 'edit');
  assert.deepEqual(saved.selected, ['a', 'b', 'c']);
  assert.equal(saved.look.id, LOOKS[0].id);
  assert.deepEqual(st().restore(), saved);

  dom.storage.clear();
  dom.storage.set('canvasforge.studio.v1', JSON.stringify({ bars: 3 }));
  assert.deepEqual(st().restore(), { bars: 3 }, 'sessions saved before the rename still load');
  dom.storage.set('downbeat.studio.v1', '{not json');
  assert.deepEqual(st().restore(), {});
});

test('undo and redo step through settled changes', async (t) => {
  await tick(400);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fresh();
  const settle = () => { st().save(); t.mock.timers.tick(400); };
  settle();
  st().setLook(LOOKS[2]);
  settle();
  S.setState({ seed: 5 });
  settle();
  st().undo();
  assert.equal(st().seed, 2026);
  assert.equal(st().lookId, LOOKS[2].id);
  assert.equal(lastToast(), '↶ Undo');
  st().undo();
  assert.equal(st().lookId, LOOKS[0].id);
  st().redo();
  assert.equal(st().lookId, LOOKS[2].id);
  st().redo();
  assert.equal(st().seed, 5);
  st().redo();
  assert.equal(lastToast(), 'Nothing to redo');
  // a new change after undoing drops the redo history
  st().undo();
  S.setState({ bars: 2 });
  settle();
  st().redo();
  assert.equal(lastToast(), 'Nothing to redo');
});

test('snapshots carry the look and edit, and applying one rebuilds the timeline', () => {
  fresh();
  const overrides = { macro: { a: 0.8 }, camera: { shake: 0.4 }, finish: { exposure: 1 }, layers: { 0: { m: 'glass', p: { scale: 5 } } } };
  st().setBlock('g1', { overrides });
  const snap = st().snapshot();
  st().setLook(LOOKS[8]);
  S.setState({ bars: 2, selected: ['b'] });
  st().applySnapshot(snap);
  assert.equal(st().lookId, LOOKS[0].id);
  assert.equal(st().bars, 4);
  assert.deepEqual(st().selected, ['a', 'b', 'c']);
  assert.deepEqual(st().blocks.find((b) => b.id === 'g1').overrides, overrides);
  assert.deepEqual(st().ctx.tl.segs[1].overrides, overrides);
  assert.equal(st().ctx.L, 8);
  assert.deepEqual(Object.keys(JSON.parse(snap)).sort(), [
    'bars', 'blocks', 'bpmManual', 'bpmOverride', 'clipFrame', 'clipLooks', 'clipMode', 'direction', 'editClip', 'evolveAmt',
    'evolveCuts', 'exportOpts', 'fitAll', 'gridNudge', 'intensity', 'lockEdit', 'look', 'lookId', 'loopStart', 'rebound', 'seed',
    'selected', 'trackId',
  ]);
});

test('restoring a snapshot removes damaged LUTs before the render loop sees them', () => {
  fresh();
  const data = JSON.parse(st().snapshot());
  const broken = { name: 'Broken', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: '' };
  data.look.finish.lut = broken;
  data.clipLooks = { a: cloneLook(LOOKS[1]) };
  data.clipLooks.a.finish.lut = broken;
  st().applySnapshot(JSON.stringify(data));
  assert.equal(st().look.finish.lut, undefined);
  assert.equal(st().clipLooks.a.finish.lut, undefined);
});

test('undo also covers the screen, the beat grid, the tempo and the song', async (t) => {
  await tick(400);
  const reqs = stubFetch({
    'GET /api/features/t1': (u) => ({ ...SONG, id: 't1', bpm: u.includes('bpm=') ? +u.split('bpm=')[1] : 120 }),
    'GET /api/features/t2': () => ({ ...SONG, id: 't2', bpm: 90, loops: [{ start: 9.5 }], loop_bars: 2 }),
  });
  st().transport.decode = async () => FAKE_BUFFER;
  withSong({ loopStart: 33.5, bars: 8 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  history.resetHistory();
  const settle = () => t.mock.timers.tick(400);

  st().setScreen('landscape');
  settle();
  st().nudgeGrid(0.02);
  settle();
  st().undo();
  assert.deepEqual(st().gridNudge, {});
  st().undo();
  assert.equal(st().exportOpts.format, 'spotify', 'the screen goes back to the phone');
  st().redo();
  assert.equal(st().exportOpts.format, 'youtube_16_9');

  t.mock.timers.reset();
  await st().setTempo(100);
  await tick(400);
  assert.deepEqual(st().bpmOverride, { t1: 100 });
  st().undo();
  await tick(0);
  assert.deepEqual(st().bpmOverride, {});
  assert.equal(reqs.at(-1).url, '/api/features/t1', 'the song is analysed again at its own tempo');
  assert.equal(st().bpm(), 120);
  assert.deepEqual([st().loopStart, st().bars], [33.5, 8], 'and the loop is put back');

  await st().selectTrack('t2');
  await tick(400);
  assert.equal(st().trackId, 't2');
  st().undo();
  await tick(0);
  assert.equal(st().trackId, 't1');
  assert.equal(st().features.id, 't1');
  assert.deepEqual([st().loopStart, st().bars], [33.5, 8]);
  st().redo();
  await tick(0);
  assert.equal(st().features.id, 't2');
  await tick(400);
  st().undo();
  await tick(0);
  assert.equal(st().trackId, 't1', 'redo still works after a reload settles');
});

test('saving a look adds it to Your looks, and a clip stack keeps the main camera and edit', () => {
  fresh();
  st().saveLook('Night drive');
  const [mine] = st().saved;
  assert.match(mine.id, /^mine-\d+$/);
  assert.equal(mine.name, 'Night drive');
  assert.equal(mine.mine, true);
  assert.equal(mine.vibe, st().look.layers.map((x) => MODULES[x.m].name).join(' + '));
  assert.notEqual(mine.layers, st().look.layers);
  assert.equal(lastToast(), 'Saved Night drive to Your looks');

  st().editClipLook('b');
  st().clipLooks.b = cloneLook(LOOKS[11]);
  st().touch();
  st().saveLook();
  const [clip] = st().saved;
  assert.equal(clip.name, LOOKS[11].name);
  assert.deepEqual(clip.layers, LOOKS[11].layers);
  assert.deepEqual(clip.camera, st().look.camera);
  assert.deepEqual(clip.cut, st().look.cut);
  assert.equal(st().saved.length, 2);

  S.setState({ look: { ...cloneLook(LOOKS[0]), layers: [] }, clipMode: 'one', editClip: null });
  st().saveLook('Plain');
  assert.equal(st().saved[0].vibe, 'Clean grade');
});

test('Revert finds the original of curated, saved and rolled looks', () => {
  fresh();
  assert.equal(history.originalLook(LOOKS[3].id), LOOKS[3]);
  assert.equal(history.originalLook(`edit:${LOOKS[3].id}`), LOOKS[3]);
  const rolled = { ...cloneLook(LOOKS[1]), id: 'roll-123', name: 'Rolled' };
  st().setLook(rolled);
  st().look.layers.pop();
  assert.deepEqual(history.originalLook('roll-123'), rolled);
  assert.equal(history.originalLook('never-seen'), null);
});

test('a full roll changes look, edit and per-clip mode, and undo puts it all back', () => {
  withSong();
  const before = st().snapshot();
  st().rollAll();
  const l = st().look;
  assert.notEqual(st().lookId, LOOKS[0].id);
  assert.ok(l.layers.length >= 1);
  for (const x of l.layers) assert.ok(MODULES[x.m], x.m);
  assert.ok(RHYTHMS[l.cut.rhythm], l.cut.rhythm);
  for (const tr of l.cut.transitions) assert.ok(tr === 'cut' || TRANSITIONS[tr], tr);
  assert.ok(['one', 'evolve', 'cycle', 'custom'].includes(st().clipMode));
  assert.match(lastToast(), /^Rolled .+ · \d+ layers · .+ cuts/);
  st().undoRoll();
  assert.equal(st().snapshot(), before);
  st().undoRoll();
  assert.equal(lastToast(), 'Nothing to undo');
});

test("an edited look stops being the gallery's current look until it's reverted", () => {
  fresh();
  const id = LOOKS[0].id;
  // the Layers tab fills in the default modulators when it shows them, which isn't an edit
  Object.assign(st().look, { env: defaultEnv(), seq: defaultSeq(), lfos: defaultLfos(), macro: { a: 0, b: 0 } });
  st().save();
  assert.equal(st().lookId, id);
  // nor is a change in the Edit tab
  st().look.cut.rhythm = 'beat';
  st().save();
  assert.equal(st().lookId, id);

  st().look.camera.p.zoom += 0.2;
  st().save();
  assert.equal(st().lookId, `edit:${id}`);
  st().save();
  assert.equal(st().lookId, `edit:${id}`, 'marked once');
  assert.equal(history.originalLook(st().lookId), LOOKS[0]);

  // the arrow keys step on from the look it was
  st().stepLook(1);
  assert.equal(st().lookId, LOOKS[1].id);
  st().look.layers.pop();
  st().save();
  assert.equal(st().lookId, `edit:${LOOKS[1].id}`);
  st().setLook(history.originalLook(st().lookId));
  st().save();
  assert.equal(st().lookId, LOOKS[1].id, 'Revert makes it current again');

  // a look from the last session has nothing to compare with
  S.setState({ lookId: 'roll-gone' });
  st().look.layers.pop();
  st().save();
  assert.equal(st().lookId, 'roll-gone');
});

test('a roll without a song picks a tempo too, keeping a Canvas loop within 3 to 8 seconds', () => {
  const edit = { rollOpts: { look: false, edit: true, perClip: false, clips: false, loop: false } };
  const tempos = new Set();
  for (let i = 0; i < 12; i++) {
    fresh(edit); // 4 bars at 120 BPM: 8 s, so a slower tempo would make it too long
    st().rollAll();
    assert.ok([120, 126, 132, 140, 152].includes(st().bpmManual), `${st().bpmManual}`);
    if (st().bpmManual !== 120) assert.match(lastToast(), new RegExp(` · ${st().bpmManual} BPM`));
    assert.equal(st().ctx.beatDur, 60 / st().bpmManual);
    assert.ok(st().loopLen() >= 3 && st().loopLen() <= 8, `${st().loopLen()} s`);
    tempos.add(st().bpmManual);
  }
  assert.ok(tempos.size > 2, [...tempos].join());

  // 2 bars at 160 BPM is 3 s, so only slower tempos keep it a Canvas
  for (let i = 0; i < 6; i++) {
    fresh({ ...edit, bars: 2, bpmManual: 160 });
    st().rollAll();
    assert.ok(st().bpmManual <= 160 && st().loopLen() >= 3 && st().loopLen() <= 8, `${st().bpmManual} BPM`);
  }
  // a visualizer-length loop can take any of them
  const long = new Set();
  for (let i = 0; i < 40; i++) {
    fresh({ ...edit, bars: 40 });
    st().rollAll();
    long.add(st().bpmManual);
  }
  assert.ok([...long].some((b) => b < 120), [...long].join());

  withSong({ rollOpts: { look: false, edit: true, perClip: false, clips: false, loop: false } });
  for (let i = 0; i < 5; i++) {
    st().rollAll();
    assert.equal(st().bpmManual, 120);
    assert.doesNotMatch(lastToast(), /BPM/);
  }
});

test('rolls sometimes pick a Rebound loop, and say so', () => {
  const seen = new Set();
  for (let i = 0; i < 40 && seen.size < 2; i++) {
    fresh({ rollOpts: { look: false, edit: true, perClip: false, clips: false, loop: false } });
    st().rollAll();
    seen.add(st().rebound);
    assert.equal(st().ctx.tl.rebound, st().rebound);
    assert.equal(/ · Rebound/.test(lastToast()), st().rebound);
  }
  assert.equal(seen.size, 2);
  S.setState({ rollOpts: { look: true, edit: false, perClip: false, clips: false, loop: false } });
  const r = st().rebound;
  for (let i = 0; i < 5; i++) st().rollAll();
  assert.equal(st().rebound, r, 'a look-only roll leaves the loop alone');
});

test('a Rebound loop plans the edit over half the loop, and the loop stays as long as before', () => {
  fresh({ rebound: true });
  const { tl, L } = st().ctx;
  assert.equal(L, 8);
  assert.equal(tl.L, 4);
  assert.equal(tl.rebound, true);
  assert.equal(tl.segs.at(-1).t1, 4);
  S.setState({ rebound: false });
  st().rebuild();
  assert.equal(st().ctx.tl.L, 8);
  assert.equal(st().ctx.tl.rebound, false);
});

test('roll options leave alone whatever is switched off', () => {
  withSong({ rollOpts: { look: false, edit: false, perClip: false, clips: false, loop: false }, direction: 'reverse', seed: 42 });
  const look = cloneLook(st().look);
  st().rollAll();
  assert.deepEqual(st().look.layers, look.layers);
  assert.deepEqual(st().look.cut, look.cut);
  assert.equal(st().direction, 'reverse');
  assert.equal(st().seed, 42);
  assert.equal(st().clipMode, 'one');
  assert.deepEqual(st().selected, ['a', 'b', 'c']);
  assert.equal(st().loopStart, 0);

  S.setState({ rollOpts: { look: false, edit: false, perClip: false, clips: true, loop: false }, selected: ['a', 'b', 'c', 'a2', 'b2', 'c2'] });
  st().rollAll();
  assert.deepEqual([...st().selected].sort(), ['a', 'a2', 'b', 'b2', 'c', 'c2']);
});

test('rolling the song section picks a suggested loop and only re-rolls Canvas-length loops', () => {
  withSong({ rollOpts: { look: false, edit: false, perClip: false, clips: false, loop: true } });
  for (let i = 0; i < 6; i++) {
    st().rollAll();
    assert.ok([33.5, 65.5].includes(st().loopStart), `${st().loopStart}`);
    assert.ok(st().canvasBars().includes(st().bars), `${st().bars} bars`);
  }
  st().setBars(40);
  st().rollAll();
  assert.equal(st().bars, 40, 'a long visualizer keeps its length');
});

test('rolling needs clips, and per-clip rolls give every clip its own valid stack', () => {
  fresh({ selected: [] });
  const v = st().version;
  st().rollAll();
  assert.equal(lastToast(), 'Pick a few clips first');
  assert.equal(st().version, v);

  fresh();
  st().rollClips();
  assert.equal(st().clipMode, 'custom');
  assert.deepEqual(Object.keys(st().clipLooks).sort(), ['a', 'b', 'c']);
  for (const l of Object.values(st().clipLooks)) for (const x of l.layers) assert.ok(MODULES[x.m], x.m);
  assert.equal(lastToast(), 'Rolled a separate stack for each of the 3 clips');

  st().surprise();
  assert.match(lastToast(), /^Surprise: /);
  assert.equal(st().lookId, st().look.id);
});

test('clip toggles and reordering update the selection and clear a hand-cut edit', () => {
  fresh({ blocks: [{ id: 'g0', at: 0, clipId: 'a', in: 0, seed: 1, trans: 'zoom' }] });
  st().toggleClip('b');
  assert.deepEqual(st().selected, ['a', 'c']);
  assert.equal(st().blocks, null);
  st().toggleClip('b');
  assert.deepEqual(st().selected, ['a', 'c', 'b']);

  st().reorderClips({ from: 2, to: 0 });
  assert.deepEqual(st().selected, ['b', 'a', 'c']);
  st().reorderClips('reverse');
  assert.deepEqual(st().selected, ['c', 'a', 'b']);
  st().reorderClips('solo');
  assert.deepEqual(st().selected, ['c']);
  assert.equal(st().ctx.tl.segs.every((s) => s.clipId === 'c'), true);
  st().reorderClips('all');
  assert.deepEqual(st().selected, ['c', 'a', 'b']);
  assert.equal(lastToast(), 'Using all 3 clips');
  st().reorderClips('shuffle');
  assert.deepEqual([...st().selected].sort(), ['a', 'b', 'c']);

  fresh({ selected: [] });
  st().reorderClips('reverse');
  assert.deepEqual(st().selected, []);
  assert.equal(st().ctx, null, 'no clips, nothing to play');
});

test('All with nothing picked starts on a few clips, and Stock picks the stock footage', () => {
  stubFetch({ 'POST /api/proxies': () => ({ ok: true }) });
  // a folder of videos that haven't been in an edit yet, two of them stock
  const library = Array.from({ length: 8 }, (_, i) => ({ id: `v${i}`, name: `v${i}.mp4`, duration: 10, width: 1080, height: 1920, proxy: 'none', is_stock: i >= 6 }));
  fresh({ clips: library, selected: [] });
  st().reorderClips('all');
  assert.deepEqual(st().selected, ['v6', 'v7', 'v0', 'v1', 'v2']);
  assert.equal(lastToast(), 'Using 5 clips to start. Click others to add them');
  assert.ok(st().ctx);

  st().reorderClips('stock');
  assert.deepEqual(st().selected, ['v6', 'v7']);
  assert.equal(lastToast(), 'Using 2 stock clips');
  S.setState({ selected: [] });
  st().reorderClips('stock');
  assert.deepEqual(st().selected, ['v6', 'v7'], 'works with nothing picked too');

  fresh();
  st().reorderClips('stock');
  assert.equal(lastToast(), 'There are no stock clips in the library');
  assert.deepEqual(st().selected, ['a', 'b', 'c']);

  fresh({ clips: [], selected: [] });
  st().reorderClips('all');
  assert.equal(lastToast(), 'No clips yet. Add videos or pick a folder first');
  assert.deepEqual(st().selected, []);
});

test('videos not in the edit stay unloaded until one is put in, which asks for its playback copy', async () => {
  const reqs = stubFetch({ 'POST /api/proxies': () => ({ ok: true, proxies: { b: 'building' } }) });
  fresh({ clips: CLIPS.map((c) => ({ ...c, proxy: c.id === 'a' ? 'ready' : 'none' })), selected: ['a'] });
  assert.deepEqual(st().clips.filter((c) => !media.isLoaded(c, st().selected)).map((c) => c.id), ['b', 'c']);
  st().reorderClips('all');
  assert.deepEqual(st().selected, ['a'], 'All leaves out the clips that are not loaded');
  assert.equal(lastToast(), 'Using the one loaded clip');
  await media.requestProxies();
  assert.equal(reqs.length, 0, 'nothing to ask for');

  st().toggleClip('b');
  const asking = media.requestProxies();
  assert.equal(st().clips.find((c) => c.id === 'b').proxy, 'queued', 'marked at once, so it is asked for once');
  await asking;
  assert.deepEqual(JSON.parse(reqs[0].body), { ids: ['b'] });
  assert.equal(st().clips.find((c) => c.id === 'b').proxy, 'building');
  await media.requestProxies();
  assert.equal(reqs.length, 1);
  st().toggleClip('b');
  assert.equal(media.isLoaded(st().clips.find((c) => c.id === 'b'), st().selected), true, 'taken out of the edit, it stays loaded');
});

test('proxy requests retain the edit order when it differs from library order', async () => {
  fresh({ clips: CLIPS.map((clip) => ({ ...clip, proxy: 'none' })), selected: ['c', 'a'] });
  const requests = stubFetch({ 'POST /api/proxies': () => ({ ok: true, proxies: { c: 'queued', a: 'queued' } }) });
  await media.requestProxies();
  assert.deepEqual(JSON.parse(requests[0].body).ids, ['c', 'a']);
});

test('removing a clip drops it everywhere, and the message says whether the file was deleted', async () => {
  let reply = { ok: true, deleted: true };
  const reqs = stubFetch({ 'POST /api/clip/remove': () => reply });
  fresh({ clipMode: 'custom', clipLooks: { c: cloneLook(LOOKS[1]) }, clipFrame: { c: [0.2, 0.3, 1] }, editClip: 'c', blocks: [{ id: 'g0', at: 0, clipId: 'c', in: 0, seed: 1 }] });
  await media.removeClip('c');
  assert.equal(st().blocks, null, 'blocks showing the clip go too');
  assert.deepEqual(JSON.parse(reqs[0].body), { id: 'c' });
  assert.deepEqual(st().clips.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(st().selected, ['a', 'b']);
  assert.deepEqual(st().clipLooks, {});
  assert.deepEqual(st().clipFrame, {});
  assert.equal(st().editClip, null);
  assert.equal(lastToast(), 'Removed cover and deleted its uploaded copy');

  reply = { ok: true, deleted: false };
  await media.removeClip('b');
  assert.equal(lastToast(), 'Removed city.mp4. The file is still in its folder.');

  reply = { ok: false, error: 'Disk is read-only' };
  await media.removeClip('a');
  assert.equal(lastToast(), 'Disk is read-only');
  assert.deepEqual(st().selected, ['a']);
});

test('auto-frame moves wide clips onto their subject and recenters the rest', async () => {
  fresh();
  await media.autoFrame();
  assert.equal(lastToast(), 'Could not analyze the clips', 'no server, nothing found');
  stubFetch({
    '/api/autoframe/a': () => ({ ok: true, method: 'center', focus: [0.5, 0.5] }),
    '/api/autoframe/b': () => ({ ok: true, method: 'subject', focus: [0.7, 0.4] }),
    '/api/autoframe/c': () => ({ ok: false }),
  });
  fresh({ clipFrame: { a: [0.1, 0.1, 1.3], b: [0.5, 0.5, 1.4] } });
  await media.autoFrame();
  assert.deepEqual(st().clipFrame, { b: [0.7, 0.6, 1.4] });
  assert.equal(lastToast(), 'Auto-framed 1 on the subject, 1 centered. Drag the preview to adjust.');
  assert.deepEqual(st().ctx.tl.segs.find((s) => s.clipId === 'b').focus, [0.7, 0.6, 1.4]);

  fresh({ selected: [] });
  await media.autoFrame();
  assert.equal(lastToast(), 'Pick a few clips first');
});

test('auto-frame preserves manual changes and removed clips while analysis is pending', async () => {
  fresh({ clipFrame: { b: [0.5, 0.5, 1.4] } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stubFetch({ 'GET /api/autoframe/*': async () => { await gate; return { ok: true, method: 'subject', focus: [0.7, 0.4] }; } });
  const pending = media.autoFrame();
  const manual = [0.2, 0.3, 1.6];
  st().clipFrame.b = manual;
  st().clipFrame.c = [0.4, 0.4, 1.2];
  S.setState({ clips: st().clips.filter((clip) => clip.id !== 'a'), selected: ['b', 'c'] });
  release();
  await pending;
  assert.deepEqual(st().clipFrame, { b: manual, c: [0.4, 0.4, 1.2] });
  assert.equal(lastToast(), 'Auto-frame finished. Newer framing changes were kept.');
});

test('a superseded auto-frame request cannot overwrite the latest result', async () => {
  fresh({ selected: ['a'] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stubFetch({ '/api/autoframe/a': async () => { await gate; return { ok: true, method: 'subject', focus: [0.1, 0.1] }; } });
  const first = media.autoFrame();
  stubFetch({ '/api/autoframe/a': () => ({ ok: true, method: 'subject', focus: [0.8, 0.3] }) });
  await media.autoFrame();
  release();
  await first;
  assert.deepEqual(st().clipFrame.a, [0.8, 0.7, 1]);
});

test('uploads add videos to the edit, switch images to an album-art look and pick up songs', async () => {
  const added = [];
  const requests = stubFetch({
    'POST /api/upload': (_u, init) => {
      const name = decodeURIComponent(init.headers['X-Filename']);
      if (name === 'broken.mov') return { ok: false };
      const r = name.endsWith('.wav') ? { ok: true, kind: 'audio', id: 'song1' } : { ok: true, kind: 'video', id: name, still: name.endsWith('.png') };
      added.push(r);
      return r;
    },
    '/api/state': () => ({ clips: [...CLIPS, ...added.filter((r) => r.kind === 'video').map((r) => ({ id: r.id, name: r.id, duration: 5 }))], tracks: [{ id: 'song1', name: 'new.wav' }], renders: [] }),
    '/api/features/song1': () => ({ ...SONG, id: 'song1' }),
  });
  fresh();
  st().transport.decode = async () => FAKE_BUFFER;
  await st().uploadFiles([new File(['x'], 'clip.mp4')]);
  assert.ok(st().selected.includes('clip.mp4'));
  assert.equal(lastToast(), 'Added 1 file');

  await st().uploadFiles([new File(['x'], 'cover.png'), new File(['x'], 'broken.mov'), new File(['x'], 'new.wav')]);
  assert.match(st().lookId, /^art-/);
  assert.ok(dom.toasts.includes('Could not add broken.mov'));
  assert.equal(st().trackId, 'song1');
  assert.equal(st().features.id, 'song1');
  assert.equal(lastToast(), 'Added 2 files. For images, try the Album art & stills looks.');
  assert.equal(requests.filter((r) => r.path === '/api/state').length, 2, 'one legacy refresh per batch, not per file');
});

test('metadata uploads update the library incrementally without full-library requests', async () => {
  fresh();
  st().transport.decode = async () => FAKE_BUFFER;
  const requests = stubFetch({
    'POST /api/upload': (_url, init) => {
      const name = decodeURIComponent(init.headers['X-Filename']);
      if (name === 'broken.mov') return new Response('not JSON', { status: 500 });
      if (name === 'song.wav') return { ok: true, kind: 'audio', id: 'new-song', track: { id: 'new-song', name, source: 'added' } };
      if (name === 'cover.png') assert.ok(st().clips.some((c) => c.id === 'new.mp4'), 'each completed upload appears immediately');
      return { ok: true, kind: 'video', id: name, still: name.endsWith('.png'), clip: { id: name, name, duration: 4, proxy: 'queued', still: name.endsWith('.png') } };
    },
    '/api/features/new-song': () => ({ ...SONG, id: 'new-song' }),
  });
  await st().uploadFiles(['new.mp4', 'cover.png', 'broken.mov', 'song.wav'].map((name) => new File(['x'], name)));
  assert.equal(requests.filter((r) => r.path === '/api/state').length, 0);
  assert.deepEqual(st().selected, ['a', 'b', 'c', 'new.mp4', 'cover.png']);
  assert.equal(st().clips.length, 5);
  assert.equal(st().trackId, 'new-song');
  assert.equal(st().tracks[0].name, 'song.wav');
  assert.match(st().lookId, /^art-/);
  assert.equal(lastToast(), 'Added 3 files. For images, try the Album art & stills looks.');
});

test('clip palettes are fetched once per clip', async () => {
  let calls = 0;
  stubFetch({ '/api/palette/b': () => { calls++; return { ok: true, colors: [{ hex: '#ff0000' }] }; }, '/api/palette/c': () => ({ ok: false }) });
  fresh();
  await st().fetchPalette('b');
  await st().fetchPalette('b');
  await st().fetchPalette('c');
  await st().fetchPalette('');
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(st().palettes), ['b']);
});
