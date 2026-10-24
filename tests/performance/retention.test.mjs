// Run with --expose-gc. Retired render contexts must be collectible while the studio stays open.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installDom } from '../fakes.mjs';
installDom();
const { useStudioStore: store } = await import('../../downbeat/studio/src/state/store.ts');
const { LOOKS, cloneLook } = await import('../../downbeat/studio/src/engine/looks.ts');
const { resetHistory, flushSave } = await import('../../downbeat/studio/src/state/historyController.ts');
const { toast } = await import('../../downbeat/studio/src/lib/utils.ts');
after(() => { resetHistory(); flushSave(); toast('', 0); });

function retireContext(mode) {
  store.setState({ clips: [{ id: 'a', duration: 10 }, { id: 'b', duration: 10 }], selected: ['a', 'b'], look: cloneLook(LOOKS[0]), lookId: LOOKS[0].id, clipMode: mode, clipLooks: { b: cloneLook(LOOKS[1]) }, features: null, trackId: '', bars: 4, bpmManual: 120 });
  store.getState().rebuild();
  const old = new WeakRef(store.getState().ctx);
  for (let i = 0; i < 30; i++) {
    store.getState().ctx.sampler(.5);
    store.getState().rebuild();
  }
  return old;
}

for (const mode of ['one', 'custom']) {
  test(`replaced ${mode} render contexts are released during an active editing session`, async () => {
    assert.equal(typeof global.gc, 'function', 'Run this check with node --expose-gc');
    const reference = retireContext(mode);
    for (let i = 0; i < 5; i++) { await setImmediate(); global.gc(); }
    assert.equal(reference.deref(), undefined, 'A live context retains a retired context and its audio tables');
    assert.ok(store.getState().ctx, 'the current preview remains available');
    assert.equal(store.getState().ctx.clipDur('a'), 10);
  });
}
