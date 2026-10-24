import type { ClipMeta } from '../engine/types.ts';

// Library arrays are replaced on change. Weak keys keep old snapshots collectible after undo,
// import or proxy polling, while repeated playback lookups share the same index.
const indices = new WeakMap<readonly ClipMeta[], ReadonlyMap<string, ClipMeta>>();
export function clipIndex(clips: readonly ClipMeta[]): ReadonlyMap<string, ClipMeta> {
  let index = indices.get(clips);
  if (!index) {
    index = new Map(clips.map((clip) => [clip.id, clip]));
    indices.set(clips, index);
  }
  return index;
}
