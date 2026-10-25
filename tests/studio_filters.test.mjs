import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './fakes.mjs';
import { FILTER_MODULES } from '../downbeat/studio/src/engine/filterModules.ts';
import { FILTER_LOOKS } from '../downbeat/studio/src/engine/filterLooks.ts';
import { LOOK_STYLES, normalizeRollStyle } from '../downbeat/studio/src/engine/lookStyles.ts';
import { LOOKS, chaosLook, chooseRollStyle, cloneLook, mutate, randomLook } from '../downbeat/studio/src/engine/looks.ts';
import { MODULES } from '../downbeat/studio/src/engine/modules.ts';
import { ClipLookResolver } from '../downbeat/studio/src/state/clipLooks.ts';

installDom();
const { createStudioRuntime } = await import('../downbeat/studio/src/state/store.ts');
const { editFields } = await import('../downbeat/studio/src/state/historyController.ts');
const { toast } = await import('../downbeat/studio/src/lib/utils.ts');
after(() => toast('', 0));
const families = LOOK_STYLES.filter((style) => style.id !== 'experimental');

test('every new filter has ready-made looks in the six new collections', () => {
  for (const style of families) {
    const presets = FILTER_LOOKS.filter((look) => look.style === style.id);
    assert.ok(presets.length >= 5, style.name);
    for (const look of presets) {
      assert.ok(LOOKS.includes(look));
      assert.ok(look.layers.some((layer) => FILTER_MODULES[layer.m]), look.id);
      assert.equal(look.camera.mods.zoom.amt, 0, 'new looks do not pulse the camera by default');
    }
  }
  for (const id of Object.keys(FILTER_MODULES)) {
    assert.ok(FILTER_LOOKS.some((look) => look.layers.some((layer) => layer.m === id)), `${id} has a preset`);
  }
});

test('style-aware randomization keeps its medium, restrained stack and valid parameters', () => {
  for (const style of families) {
    const allowed = new Set(FILTER_LOOKS.filter((look) => look.style === style.id).flatMap((look) => look.layers.map((layer) => layer.m)));
    for (let seed = 1; seed <= 50; seed++) {
      for (const make of [randomLook, chaosLook]) {
        const look = make(seed, style.id);
        assert.deepEqual(look, make(seed, style.id), 'seeded output is repeatable');
        assert.equal(look.style, style.id);
        assert.ok(look.layers.length >= 1 && look.layers.length <= 3);
        assert.equal(look.camera.mods.zoom.amt, 0);
        for (const layer of look.layers) {
          assert.ok(allowed.has(layer.m), `${style.id} acquired ${layer.m}`);
          for (const param of MODULES[layer.m].params) {
            const value = layer.p[param.id] ?? param.def;
            assert.ok(Number.isFinite(value) && value >= param.min && value <= param.max, `${layer.m}.${param.id}`);
            if (param.opts) assert.equal(value, Math.round(value));
          }
          assert.deepEqual(layer.mods, {}, 'randomization does not add beat modulation to a quiet look');
          if (layer.m === 'monochrome') assert.equal(layer.p.mix, 1, 'a monochrome roll cannot leak the original color back in');
        }
      }
    }
  }
});

test('even wild variations of a photographic look preserve its chosen process and effects', () => {
  for (const look of FILTER_LOOKS) for (let seed = 1; seed < 8; seed++) {
    const variation = mutate(look, 1, seed);
    assert.deepEqual(variation.layers.map((layer) => layer.m), look.layers.map((layer) => layer.m));
    for (let i = 0; i < look.layers.length; i++) for (const param of MODULES[look.layers[i].m].params.filter((p) => p.opts || p.step >= 1)) {
      assert.equal(variation.layers[i].p[param.id], look.layers[i].p[param.id] ?? param.def, `${look.id} changed ${param.id}`);
    }
    assert.deepEqual(variation.cut, look.cut);
  }
});

test('Balanced covers each family evenly while Experimental retains dense stacks', () => {
  const counts = new Map(LOOK_STYLES.map((style) => [style.id, 0]));
  for (let seed = 1; seed <= 1400; seed++) {
    const style = chooseRollStyle(seed);
    counts.set(style, counts.get(style) + 1);
    assert.equal(randomLook(seed, 'balanced').style, style);
  }
  for (const [style, count] of counts) assert.ok(count > 140 && count < 260, `${style}: ${count}`);
  for (let seed = 1; seed < 30; seed++) {
    const look = chaosLook(seed, 'experimental');
    assert.equal(look.style, 'experimental');
    assert.ok(look.layers.length >= 4 && look.layers.length <= 6);
  }
  assert.equal(normalizeRollStyle('obsolete'), 'balanced');
});

test('Remix, Surprise, per-clip rolls, cycle and snapshots share the chosen style', () => {
  const runtime = createStudioRuntime({ storage: null });
  const store = runtime.store;
  store.setState({ clips: ['a', 'b', 'c'].map((id) => ({ id, duration: 20 })), selected: ['a', 'b', 'c'], look: cloneLook(LOOKS[0]), lookId: LOOKS[0].id });
  try {
    for (const { id: style } of families) {
      store.setState({ rollStyle: style });
      for (let i = 0; i < 12; i++) {
        store.getState().rollAll();
        const state = store.getState();
        assert.equal(state.look.style, style);
        assert.ok(state.look.cut.transitions.every((name) => ['cut', 'dissolve', 'luma'].includes(name)));
        assert.equal(state.direction, 'forward');
        assert.equal(state.rebound, false);
        assert.equal(state.intensity, 1);
        for (const clip of state.selected) assert.equal(state.clipLookOf(clip).style, style);
      }
      store.getState().rollClips();
      assert.ok(Object.values(store.getState().clipLooks).every((look) => look.style === style));
      store.getState().surprise();
      assert.equal(store.getState().look.style, style);
      const snap = store.getState().snapshot();
      store.setState({ rollStyle: 'experimental' });
      store.getState().applySnapshot(snap);
      assert.equal(store.getState().rollStyle, style);
      assert.equal(editFields(JSON.parse(snap), store.getState().clips, []).rollStyle, style);
    }
    assert.equal(editFields({}, [], []).rollStyle, 'balanced', 'older sessions get a balanced default');
    assert.equal(editFields({ rollStyle: 'invalid' }, [], []).rollStyle, 'balanced');
    const main = FILTER_LOOKS.find((look) => look.style === 'monochrome');
    const resolver = new ClipLookResolver();
    const state = { ...store.getState(), look: main, lookId: main.id, rollStyle: 'balanced', clipMode: 'cycle' };
    assert.equal(resolver.resolve(state, 'b').style, 'monochrome', 'cycle keeps the rolled family in Balanced');
  } finally {
    runtime.dispose();
  }
});

test('a look-only Remix reaches an appearance with its own look while preserving its timing and framing', () => {
  const runtime = createStudioRuntime({ storage: null });
  const store = runtime.store;
  const own = cloneLook(FILTER_LOOKS.find((look) => look.id === 'monochrome-noir'));
  store.setState({ clips: [{ id: 'a', duration: 20 }], selected: ['a'], look: cloneLook(LOOKS[0]), lookId: LOOKS[0].id,
    rollStyle: 'film', rollOpts: { look: true, edit: false, perClip: false, clips: false, loop: false },
    blocks: [{ id: 'own', at: 0, clipId: 'a', in: 2, seed: 1, look: own, trans: 'cut', overrides: { camera: { speed: 0.8, shake: 0.4 }, finish: { saturation: 0 } },
      frame: { a: [0.5, 0.5, 1.2] } }], editBlock: 'own' });
  try {
    store.getState().rebuild();
    const before = store.getState().snapshot();
    store.getState().rollAll();
    const block = store.getState().blocks[0];
    assert.equal(block.look, undefined, 'the previous appearance look must not hide Remix');
    assert.deepEqual(block.overrides, { camera: { speed: 0.8 } }, 'only timing overrides survive the visual roll');
    assert.deepEqual([block.id, block.at, block.clipId, block.in, block.trans], ['own', 0, 'a', 2, 'cut']);
    assert.deepEqual(block.frame, JSON.parse(before).blocks[0].frame);
    assert.equal(store.getState().editBlock, null, 'Remix leaves the inspector on the look it just generated');
    store.getState().undoRoll();
    assert.deepEqual(store.getState().blocks, JSON.parse(before).blocks, 'Undo recovers the original appearance treatment');
  } finally { runtime.dispose(); }
});

test('consecutive Balanced Remixes change families and a chosen family avoids the previous recipe', () => {
  let previous = cloneLook(FILTER_LOOKS[0]);
  for (let seed = 1; seed <= 100; seed++) {
    const look = chaosLook(seed, 'balanced', previous);
    assert.notEqual(look.style, previous.style, 'Balanced must not deal the same family twice in a row');
    previous = look;
  }
  for (const { id } of families) {
    previous = cloneLook(FILTER_LOOKS.find((look) => look.style === id));
    for (let seed = 1; seed <= 20; seed++) {
      const look = chaosLook(seed, id, previous);
      assert.notEqual(look.name, previous.name, `${id} repeated its previous recipe`);
      previous = look;
    }
  }
});

test('a roll with visual options off keeps appearance treatments', () => {
  const runtime = createStudioRuntime({ storage: null });
  const store = runtime.store;
  const blocks = [{ id: 'own', at: 0, clipId: 'a', in: 0, seed: 1, look: cloneLook(FILTER_LOOKS[0]) }];
  store.setState({ clips: [{ id: 'a', duration: 20 }], selected: ['a'], look: cloneLook(LOOKS[0]), blocks,
    rollOpts: { look: false, edit: false, perClip: false, clips: false, loop: false } });
  try {
    store.getState().rebuild();
    store.getState().rollAll();
    assert.equal(store.getState().blocks, blocks);
  } finally { runtime.dispose(); }
});
