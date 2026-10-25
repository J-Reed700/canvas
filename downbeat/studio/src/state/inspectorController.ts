import type { StudioStore } from './storeTypes.ts';
import { cloneLook } from '../engine/looks.ts';
import { lookWithOverrides } from '../engine/composer.ts';
import { editingLook } from './clipLooks.ts';
import type { Block, Look } from '../engine/types.ts';

/** Owns inspector state for one studio instance. */
export function createInspectorController(store: StudioStore) {

  let cached: { version: number; block: Block; main: Look; base: Look; look: Look } | null = null;

  /** Reads the effective appearance without creating an override just by selecting it. */
  function inspectorLook(): Look {
    const s = store.getState();
    const seg = s.editBlock ? s.ctx?.tl.segs.find((x) => x.id === s.editBlock) : null;
    const block = seg && (s.blocks ?? s.ctx?.tl.blocks)?.find((x) => x.id === seg.id);
    if (!seg || !block || !s.look) return editingLook(s);
    const visualOverrides = block.overrides && (block.overrides.layers || block.overrides.macro || block.overrides.finish || Object.keys(block.overrides.camera || {}).some((key) => key !== 'speed'));
    if (block.look && !visualOverrides) return block.look;
    const base = block.look || s.clipLookOf(seg.clipId, seg);
    if (base === s.look && !block.overrides) return base;
    if (cached?.version === s.version && cached.block === block && cached.main === s.look && cached.base === base) return cached.look;
    const look = lookWithOverrides(block.look || { ...base, camera: s.look.camera, finish: s.look.finish }, block.overrides);
    cached = { version: s.version, block, main: s.look, base, look };
    return look;
  }

  /** The first edit copies the inherited treatment. Existing clip and main looks stay untouched. */
  function writableLook(): Look {
    const s = store.getState();
    const look = s.editLook();
    if (!s.editBlock || !s.ctx?.tl.segs.some((seg) => seg.id === s.editBlock)) return look;
    const block = (s.blocks ?? s.ctx.tl.blocks).find((b) => b.id === s.editBlock);
    if (block?.look === look) return look;
    const copy = cloneLook(look);
    const speed = block?.overrides?.camera?.speed;
    s.setBlock(s.editBlock, { look: copy, overrides: speed === undefined ? undefined : { camera: { speed } } });
    return copy;
  }

  function editBlockLook(id: string | null) {
    const s = store.getState();
    const exists = !!id && s.ctx?.tl.segs.some((seg) => seg.id === id);
    store.setState({ editBlock: exists ? id : null, editClip: null });
  }

  function resetBlockLook() {
    const s = store.getState();
    if (!s.editBlock) return;
    const block = (s.blocks ?? s.ctx?.tl.blocks)?.find((b) => b.id === s.editBlock);
    // Speed belongs to the edit; returning to the clip look must not change the footage's timing.
    const speed = block?.overrides?.camera?.speed;
    s.setBlock(s.editBlock, { look: undefined, overrides: speed === undefined ? undefined : { camera: { speed } } });
  }

  return { inspectorLook, writableLook, editBlockLook, resetBlockLook };
}

export type InspectorController = ReturnType<typeof createInspectorController>;
