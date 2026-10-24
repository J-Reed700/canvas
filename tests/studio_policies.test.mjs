import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOKS, cloneLook } from '../downbeat/studio/src/engine/looks.ts';
import { ClipLookResolver, editingLook } from '../downbeat/studio/src/state/clipLooks.ts';
import { clipIndex } from '../downbeat/studio/src/state/mediaIndex.ts';

const state = (patch = {}) => ({ version: 1, look: LOOKS[0], lookId: LOOKS[0].id, saved: [], selected: ['a', 'b', 'c'], clipMode: 'cycle', evolveCuts: false, evolveAmt: .5, seed: 17, clipLooks: {}, editClip: null, ...patch });

test('clip look policies accept a catalog independently of the studio runtime', () => {
  const alternate = cloneLook(LOOKS[3]);
  const resolver = new ClipLookResolver([LOOKS[0], alternate]);
  const edit = state();
  assert.equal(resolver.resolve(edit, 'a'), edit.look);
  assert.equal(resolver.resolve(edit, 'b'), alternate);
  assert.equal(resolver.resolve(edit, 'c'), alternate);
  assert.equal(new ClipLookResolver([]).resolve(edit, 'b'), edit.look, 'an empty collection keeps the main look');
  const custom = state({ version: 2, clipMode: 'custom', editClip: 'b', clipLooks: { b: alternate } });
  assert.equal(resolver.resolve(custom, 'b'), alternate);
  assert.equal(editingLook(custom), alternate);
  assert.equal(editingLook({ ...custom, selected: ['a'] }), custom.look);
  assert.equal(editingLook({ ...custom, look: null }), LOOKS[0]);
  assert.equal(resolver.resolve({ ...custom, look: null }, 'b'), LOOKS[0]);
});

test('library indices are reused for a snapshot and rebuilt when the library changes', () => {
  let reads = 0;
  const clips = Array.from({ length: 5000 }, (_, i) => ({ get id() { reads++; return `c${i}`; }, duration: 10 }));
  const original = clipIndex(clips);
  assert.equal(reads, 5000);
  for (let i = 0; i < 10000; i++) assert.equal(clipIndex(clips).get(`c${i % 5000}`), clips[i % 5000]);
  assert.equal(reads, 5000, 'playback lookups do not repeatedly scan the library');
  const added = { id: 'new', duration: 4 };
  const next = clipIndex([...clips, added]);
  assert.equal(next.get('new'), added);
  assert.equal(original.has('new'), false, 'old snapshots stay stable');
});
