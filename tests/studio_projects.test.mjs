// Saved projects in the studio: the edit that projects, undo, the session and exports share, the open
// project's autosave, and opening, starting, renaming and deleting projects. The server is a fetch stub.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, stubFetch, tick } from './fakes.mjs';

const dom = installDom();
const { useStudioStore: S } = await import('../downbeat/studio/src/state/store.ts');
const history = await import('../downbeat/studio/src/state/historyController.ts');
const P = await import('../downbeat/studio/src/state/projectController.ts');
const { LOOKS, cloneLook } = await import('../downbeat/studio/src/engine/looks.ts');
const { toast } = await import('../downbeat/studio/src/lib/utils.ts');

after(() => toast('', 0));

const CLIPS = [
  { id: 'a', name: '1 sunrise.mp4', duration: 12, is_stock: true },
  { id: 'b', name: 'city.mp4', duration: 9 },
  { id: 'c', name: 'cover.still.mp4', duration: 20 },
];
const TRACKS = [{ id: 't1', name: 'Night Drive.wav' }, { id: 't2', name: 'Sunrise.mp3' }];
const SONG = { duration: 180, fps: 30, bpm: 120, downbeats: Array.from({ length: 89 }, (_, i) => 1.5 + i * 2), loops: [{ start: 33.5 }], loop_bars: 4 };
const KEY = 'downbeat.project.v1';
const st = () => S.getState();
const lastToast = () => dom.toasts.at(-1);
const ref = () => JSON.parse(dom.storage.get(KEY) || 'null');
const posts = (reqs, path) => reqs.filter((r) => r.method === 'POST' && r.path === path).map((r) => JSON.parse(r.body));

function fresh(over = {}) {
  st().transport.unload();
  st().transport.decode = async () => ({ duration: 180 });
  S.setState({
    clips: CLIPS.map((c) => ({ ...c })),
    tracks: TRACKS.map((t) => ({ ...t })),
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
    intensity: 1,
    clipMode: 'one',
    clipLooks: {},
    editClip: null,
    blocks: null,
    legacyEdit: null,
    projects: [],
    project: null,
    projectSync: 'saved',
    projectsOpen: false,
    libraryOpen: false,
    ...over,
  });
  st().rebuild();
  // settle the session write the rebuild started, with no project open
  history.flushSave();
}

/** A server that keeps projects in memory, like out/projects/. */
function server(extra = {}) {
  const files = new Map();
  let clock = 1000;
  let n = 0;
  const summary = (p) => ({ id: p.id, name: p.name, updated: p.updated, clips: p.data.selected?.length || 0, look: p.data.look?.name });
  const defaults = {
    'GET /api/projects': () => ({ ok: true, projects: [...files.values()].map(summary).reverse() }),
    'GET /api/projects/*': (u) => {
      const id = decodeURIComponent(u.split('/api/projects/')[1]);
      return files.has(id) ? { ok: true, project: files.get(id) } : new Response('{"ok":false}', { status: 404 });
    },
    'POST /api/projects/create': (_u, init) => {
      const b = JSON.parse(init.body);
      const p = { id: `p${++n}`.padEnd(12, '0'), name: b.name, updated: ++clock, data: b.data };
      files.set(p.id, p);
      return { ok: true, project: summary(p) };
    },
    'POST /api/projects/save': (_u, init) => {
      const b = JSON.parse(init.body);
      const p = files.get(b.id);
      if (!p) return new Response('{"ok":false,"error":"That project has been deleted"}', { status: 404 });
      Object.assign(p, { data: b.data, updated: ++clock });
      return { ok: true, project: summary(p) };
    },
    'POST /api/projects/rename': (_u, init) => {
      const b = JSON.parse(init.body);
      const p = files.get(b.id);
      p.name = b.name.trim();
      return { ok: true, project: summary(p) };
    },
    'POST /api/projects/delete': (_u, init) => {
      files.delete(JSON.parse(init.body).id);
      return { ok: true };
    },
    'GET /api/features/t1': () => ({ ...SONG }),
    'GET /api/features/t2': () => ({ ...SONG, bpm: 90 }),
  };
  // a test's own routes come first, so its wildcards are tried before these
  const routes = { ...extra };
  for (const [k, v] of Object.entries(defaults)) if (!(k in routes)) routes[k] = v;
  const reqs = stubFetch(routes);
  return { reqs, files };
}

/** Saves the session now and waits for the project write it starts. */
async function settle() {
  history.flushSave();
  await P.syncProject();
}

test('undo, the session, projects and exports all save the same edit', () => {
  fresh({ editClip: 'b', tab: 'edit', hud: false });
  const edit = history.editState();
  assert.deepEqual(Object.keys(edit).sort(), [
    'bars', 'blocks', 'bpmManual', 'bpmOverride', 'clipFrame', 'clipLooks', 'clipMode', 'direction', 'evolveAmt', 'evolveCuts',
    'exportOpts', 'fitAll', 'gridNudge', 'intensity', 'lockEdit', 'look', 'lookId', 'loopStart', 'rebound', 'seed', 'selected', 'trackId',
  ]);
  assert.deepEqual(JSON.parse(st().snapshot()), JSON.parse(JSON.stringify({ ...edit, editClip: 'b' })), 'undo also keeps which clip is being edited');
  history.save();
  history.flushSave();
  const session = JSON.parse(dom.storage.get('downbeat.studio.v1'));
  assert.deepEqual({ ...session, saved: undefined, snap: undefined, hud: undefined, safe: undefined, muted: undefined, tab: undefined, mode: undefined, rollOpts: undefined },
    { ...JSON.parse(JSON.stringify(edit)), saved: undefined, snap: undefined, hud: undefined, safe: undefined, muted: undefined, tab: undefined, mode: undefined, rollOpts: undefined });
  assert.deepEqual([session.tab, session.hud], ['edit', false], 'the studio settings stay in the browser session');
});

test('an edit read back keeps its clips, song and cuts, and fills in what it lacks', () => {
  fresh({ trackId: 't2', bars: 8, seed: 7, rebound: true, selected: ['c', 'a'] });
  const edit = JSON.parse(JSON.stringify(history.editState()));
  const back = history.editFields(edit, CLIPS, TRACKS);
  for (const k of Object.keys(edit)) assert.deepEqual(back[k], edit[k], k);

  const gone = history.editFields({ ...edit, selected: ['zz', 'a'], trackId: 'gone' }, CLIPS, TRACKS);
  assert.deepEqual([gone.selected, gone.trackId], [['a'], ''], 'a missing clip drops out and a missing song leaves the BPM clock');
  assert.deepEqual(history.editFields({ selected: ['zz'] }, CLIPS, TRACKS).selected, ['a', 'b', 'c'], 'with no clips left it starts on a few');
  assert.equal(history.editFields({ trackId: '' }, CLIPS, TRACKS).trackId, '', 'an edit saved with no song stays without one');

  const blank = history.editFields({}, CLIPS, TRACKS);
  assert.deepEqual(
    [blank.trackId, blank.look.id, blank.lookId, blank.bars, blank.bpmManual, blank.seed, blank.fitAll, blank.rebound, blank.blocks, blank.exportOpts.format],
    ['t1', LOOKS[0].id, LOOKS[0].id, 4, 128, 2026, true, false, null, 'spotify'],
  );
  assert.notEqual(blank.look, LOOKS[0], 'a copy of the first look, not the look itself');
  const legacy = history.editFields({ customCuts: [1, 2] }, CLIPS, TRACKS);
  assert.deepEqual(legacy.legacyEdit, { customCuts: [1, 2], segOverrides: {} }, 'an old session\'s cuts wait for the song');
});

test('saving an edit as a project makes the file and the open project follows each change', async () => {
  const { reqs, files } = server();
  fresh();
  assert.equal(await P.saveAs('Night Drive'), true);
  const id = st().project.id;
  assert.deepEqual([st().project.name, st().projectSync, lastToast()], ['Night Drive', 'saved', 'Saved as Night Drive']);
  assert.deepEqual(files.get(id).data, JSON.parse(JSON.stringify(history.editState())));
  assert.deepEqual(ref(), { id, name: 'Night Drive', updated: files.get(id).updated }, 'the browser remembers the project for the next start');
  assert.deepEqual(st().projects.map((p) => p.name), ['Night Drive']);

  st().setBars(8);
  await settle();
  assert.equal(posts(reqs, '/api/projects/save').length, 1);
  assert.equal(files.get(id).data.bars, 8);
  assert.equal(ref().updated, files.get(id).updated);

  await settle();
  assert.equal(posts(reqs, '/api/projects/save').length, 1, 'nothing changed, nothing sent');
});

test('one write at a time: a change made while one is out goes in the next', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { reqs, files } = server();
  fresh();
  await P.saveAs('Slow');
  // the first save waits until the test lets it through
  const orig = globalThis.fetch;
  let held = false;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === '/api/projects/save' && !held) {
      held = true;
      await gate;
    }
    return orig(url, init);
  };
  st().setBars(2);
  history.flushSave();
  const first = P.syncProject();
  await tick();
  assert.equal(st().projectSync, 'saving');
  st().setBars(6);
  history.flushSave();
  st().setBars(3);
  history.flushSave();
  release();
  await first;
  assert.deepEqual(posts(reqs, '/api/projects/save').map((b) => b.data.bars), [2, 3], 'the edits in between collapse into one write');
  assert.equal(files.get(st().project.id).data.bars, 3);
  assert.equal(st().projectSync, 'saved');
});

test('a failed write is tried again on the next change, and a deleted project lets go of the edit', async () => {
  server({ 'POST /api/projects/save': () => new Response('{"ok":false}', { status: 500 }) });
  fresh();
  await P.saveAs('Flaky');
  const id = st().project.id;
  st().setBars(2);
  await settle();
  assert.equal(st().projectSync, 'failed');
  assert.equal(st().project.id, id, 'still open; the next change tries again');

  server(); // a server that doesn't have the project any more
  st().setBars(3);
  await settle();
  assert.equal(st().project, null);
  assert.equal(ref(), null);
  assert.match(lastToast(), /^Flaky has been deleted, so this edit isn't saved to a project now/);
});

test('at startup the session wins unless the project was saved somewhere else since', async () => {
  const { files } = server();
  fresh();
  await P.saveAs('Shared');
  const id = st().project.id;
  const session = { bars: 6, hud: false };
  assert.equal(await P.startingEdit(session), session, 'this browser wrote it last, so its session is newest');
  assert.equal(st().project.id, id);
  assert.deepEqual(st().projects.map((p) => p.id), [id]);

  // another tab saves the project
  Object.assign(files.get(id), { updated: files.get(id).updated + 5, data: { ...files.get(id).data, bars: 2 } });
  const started = await P.startingEdit(session);
  assert.deepEqual([started.bars, started.hud], [2, false], 'the file\'s edit, with this browser\'s settings');
  assert.equal(ref().updated, files.get(id).updated);

  files.delete(id);
  assert.equal(await P.startingEdit(session), session);
  assert.deepEqual([st().project, ref()], [null, null]);
  assert.match(lastToast(), /^Shared has been deleted/);

  dom.storage.set(KEY, JSON.stringify({ id: 'abcdefabcdef', name: 'Offline', updated: 1 }));
  stubFetch({});
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await P.startingEdit(session), session);
  assert.deepEqual(st().project, { id: 'abcdefabcdef', name: 'Offline', updated: 1 }, 'a server that is down keeps the project open');
  dom.storage.delete(KEY);
  assert.equal(await P.startingEdit(session), session);
  assert.equal(st().project, null);
});

test('opening a project saves the one being left and loads the other edit, with undo starting over', async () => {
  const { reqs, files } = server();
  fresh();
  await P.saveAs('First');
  const first = st().project.id;
  await P.newProject();
  assert.equal(st().project, null);
  assert.deepEqual([st().selected, st().trackId, st().look.id], [['a', 'b', 'c'], 't1', LOOKS[0].id], 'a new edit starts on the defaults and the newest song');
  assert.equal(lastToast(), 'New edit. Name it in Projects to save it');
  st().setBars(2);
  await P.saveAs('Second');
  const second = st().project.id;
  st().setBars(1);
  await tick(400); // long enough for the change to become an undo step
  assert.equal(history.historyDepth().undo, 1);
  assert.equal(await P.openProject(first), true);
  assert.equal(files.get(second).data.bars, 1, 'the project being left got its last change');
  assert.deepEqual([st().project.name, st().trackId, st().bars], ['First', '', 4]);
  assert.equal(lastToast(), 'Opened First');
  assert.deepEqual(history.historyDepth(), { undo: 0, redo: 0 });
  await settle();
  assert.equal(posts(reqs, '/api/projects/save').filter((b) => b.id === first).length, 0, 'opening alone doesn\'t write the file');

  files.delete(second);
  assert.equal(await P.openProject(second), false);
  assert.equal(lastToast(), 'That project has been deleted');
  assert.equal(st().project.id, first);
});

test('renaming and deleting projects', async () => {
  server();
  fresh();
  await P.saveAs('Draft');
  const id = st().project.id;
  assert.equal(await P.renameProject(id, '  Final cut '), true);
  assert.deepEqual([st().project.name, ref().name, st().projects[0].name], ['Final cut', 'Final cut', 'Final cut']);
  await P.newProject();
  await P.saveAs('Other');
  await P.deleteProject(id);
  assert.equal(lastToast(), 'Deleted Final cut');
  assert.deepEqual(st().projects.map((p) => p.name), ['Other']);
  await P.deleteProject(st().project.id);
  assert.equal(st().project, null);
  assert.equal(lastToast(), 'Deleted Other. Its edit is still open here, but not saved to a project');
  assert.deepEqual(st().projects, []);
});

test('Save now writes the open project or asks for a name', async () => {
  server();
  fresh();
  await P.saveNow();
  assert.equal(st().projectsOpen, true, 'an edit with no project opens Projects to name it');
  S.setState({ projectsOpen: false });
  await P.saveAs('Keep');
  st().setBars(2);
  await P.saveNow();
  assert.equal(lastToast(), 'Saved Keep');
  assert.equal(st().projectsOpen, false);
});

test('an export\'s edit opens outside any project', async () => {
  const edit = { ...JSON.parse(JSON.stringify((fresh(), history.editState()))), bars: 2, seed: 99, selected: ['b'] };
  server({ 'GET /api/projects/exports/*': (u) => (u.endsWith('canvas-x.mp4') ? { ok: true, data: edit } : new Response('{}', { status: 404 })) });
  fresh();
  await P.saveAs('Mine');
  S.setState({ libraryOpen: true, libraryItem: 'canvas-x.mp4' });
  assert.equal(await P.openExportEdit('canvas-x.mp4', 'Neon'), true);
  assert.deepEqual([st().project, st().bars, st().seed, st().selected], [null, 2, 99, ['b']]);
  assert.deepEqual([st().libraryOpen, st().libraryItem], [false, null]);
  assert.equal(lastToast(), 'Opened the edit of Neon. Save it as a project to keep your changes');
  assert.equal(await P.openExportEdit('canvas-y.mp4', 'Old'), false);
  assert.equal(lastToast(), "This export doesn't have its edit saved with it");
});
