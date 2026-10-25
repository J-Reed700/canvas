import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, fakeCanvas, installDom, stubFetch } from './fakes.mjs';

const dom = installDom();
globalThis.window = new FakeElement('window');
document.removeEventListener = (type, listener) => {
  document.listeners[type] = (document.listeners[type] || []).filter((item) => item !== listener);
};
const frames = new Map();
let nextFrame = 0;
globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);

const { createStudioRuntime } = await import('../downbeat/studio/src/state/store.ts');
const { LOOKS, cloneLook } = await import('../downbeat/studio/src/engine/looks.ts');
const { toast } = await import('../downbeat/studio/src/lib/utils.ts');
after(() => toast('', 0));

const clips = [{ id: 'a', duration: 12, proxy: 'ready' }, { id: 'b', duration: 10, proxy: 'ready' }];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

function seeded(storage = memory()) {
  const runtime = createStudioRuntime({ storage });
  runtime.store.setState({ clips: structuredClone(clips), selected: ['a', 'b'], look: cloneLook(LOOKS[0]), lookId: LOOKS[0].id, bpmManual: 120 });
  runtime.store.getState().rebuild();
  runtime.history.resetHistory();
  return runtime;
}

function browserRuntime(storage = memory()) {
  const engines = [], banks = [];
  const runtime = createStudioRuntime({
    storage,
    createEngine: (canvas) => {
      const engine = { canvas, disposed: false, warmup() {}, dispose() { this.disposed = true; }, main: { reset() {} } };
      engines.push(engine);
      return engine;
    },
    createVideoBank: () => {
      const bank = { cleared: false, clear() { this.cleared = true; } };
      banks.push(bank);
      return bank;
    },
  });
  return { runtime, engines, banks };
}

test('independent studios keep appearance edits, undo history, generated looks and saved projects isolated', async () => {
  let serial = 0;
  stubFetch({
    'POST /api/projects/create': (_url, init) => {
      const { name } = JSON.parse(init.body);
      return { ok: true, project: { id: `p${++serial}`, name, updated: serial } };
    },
  });
  const leftStorage = memory(), rightStorage = memory();
  const left = seeded(leftStorage), right = seeded(rightStorage);
  try {
    const state = left.store.getState();
    const id = state.ctx.tl.segs[1].id;
    state.selectBlock(id);
    const generated = { ...cloneLook(LOOKS[2]), id: 'generated-left', name: 'Left only' };
    state.applyLook(generated);
    assert.equal(right.store.getState().editBlock, null);
    assert.equal(right.store.getState().blocks, null);
    assert.equal(right.history.originalLook(generated.id), null);
    assert.equal(left.history.originalLook(generated.id).name, 'Left only');
    state.undo();
    assert.equal(left.store.getState().ctx.tl.segs.find((seg) => seg.id === id).look, undefined);
    assert.equal(right.history.historyDepth().undo, 0);
    state.redo();
    assert.equal(left.store.getState().ctx.tl.segs.find((seg) => seg.id === id).look.id, generated.id);
    assert.equal(await left.projects.saveAs('Left project'), true);
    assert.equal(await right.projects.saveAs('Right project'), true);
    assert.notEqual(left.store.getState().project.id, right.store.getState().project.id);
    assert.equal(JSON.parse(leftStorage.getItem('downbeat.project.v1')).name, 'Left project');
    assert.equal(JSON.parse(rightStorage.getItem('downbeat.project.v1')).name, 'Right project');
    left.history.flushSave();
    right.history.flushSave();
    assert.equal(left.history.restore().blocks.find((block) => block.id === id).look.id, generated.id);
    assert.equal(right.history.restore().blocks, null);
  } finally { left.dispose(); right.dispose(); }
});

test('a replaced startup cannot publish a stale library or restart disposed preview resources', async () => {
  const oldReply = deferred();
  let requests = 0;
  stubFetch({
    '/api/state': () => ++requests === 1 ? oldReply.promise : { clips, tracks: [], renders: [] },
    '/api/projects': () => ({ projects: [] }),
  });
  const { runtime, engines, banks } = browserRuntime();
  try {
    const stale = runtime.store.getState().initStudio(fakeCanvas(400, 700), new FakeElement());
    await runtime.store.getState().initStudio(fakeCanvas(400, 700), new FakeElement());
    const liveEngine = runtime.store.getState().engine;
    assert.equal(engines[0].disposed, true);
    assert.equal(banks[0].cleared, true);
    assert.equal(frames.size, 1, 'only the current preview schedules frames');
    oldReply.resolve({ clips: [{ id: 'stale', duration: 5 }], tracks: [], renders: [] });
    await stale;
    assert.equal(runtime.store.getState().engine, liveEngine);
    assert.deepEqual(runtime.store.getState().selected, ['a', 'b']);
    assert.equal(frames.size, 1);
    runtime.store.getState().disposeStudio();
    assert.equal(liveEngine.disposed, true);
    assert.equal(banks[1].cleared, true);
    assert.equal(frames.size, 0);
    assert.equal((window.listeners.pagehide || []).length, 0);
    assert.equal((document.listeners.visibilitychange || []).length, 0);
    assert.equal(runtime.store.getState().engine, null);
    assert.equal(runtime.store.getState().bank, null);
  } finally { runtime.dispose(); }
});

test('disposing a studio flushes pending session edits and releases persistence listeners', async () => {
  stubFetch({ '/api/state': () => ({ clips, tracks: [], renders: [] }), '/api/projects': () => ({ projects: [] }) });
  const storage = memory();
  const { runtime } = browserRuntime(storage);
  try {
    await runtime.store.getState().initStudio(fakeCanvas(400, 700), new FakeElement());
    assert.equal(window.listeners.pagehide.length, 1);
    assert.equal(document.listeners.visibilitychange.length, 1);
    runtime.store.getState().setBars(2);
    runtime.store.getState().disposeStudio();
    assert.equal(JSON.parse(storage.getItem('downbeat.studio.v1')).bars, 2);
    assert.equal(window.listeners.pagehide.length, 0);
    assert.equal(document.listeners.visibilitychange.length, 0);
    assert.equal(frames.size, 0);
    assert.equal(dom.toasts.some((message) => /too large/.test(message)), false);
  } finally { runtime.dispose(); }
});
