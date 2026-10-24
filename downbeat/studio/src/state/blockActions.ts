// Store actions for the block edits on the video lane. The edits themselves are pure (engine/blocks.ts):
// these apply one to the edit as it plays now, keep the result and rebuild, which also makes it an undo
// step. The first one turns the rolled edit into blocks of the session's own.
import { useStudioStore } from './store.ts';
import { toast } from '../lib/utils.ts';
import { MIN_BEATS, autoBlock, insertBlock, moveCut, patchBlock, removeBlock, repeatBlock, segAt, snapBeat, splitBlock } from '../engine/blocks.ts';
import type { SnapDiv } from '../engine/blocks.ts';
import type { Block, BlockPatch, TimelinePlan } from '../engine/types.ts';

const st = () => useStudioStore.getState();
const same = (a: Block[], b: Block[]) => a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

/** Applies a block edit. When the result is just the rolled edit again, the edit goes back to following
 * the rhythm. Returns false when the edit can't be made. */
export function editBlocks(fn: (blocks: Block[], tl: TimelinePlan) => Block[] | null): boolean {
  const s = st();
  const tl = s.ctx?.tl;
  if (!tl) return false;
  const cur = s.blocks ?? tl.blocks;
  const next = fn(cur, tl);
  if (!next) return false;
  if (next === cur) return true;
  useStudioStore.setState({ blocks: same(next, tl.rolled) ? null : next });
  s.rebuild();
  return true;
}

/** The block the toolbar and the keys act on: the selected one, or else the one under the playhead. */
export function targetBlock(): string | null {
  const s = st();
  const tl = s.ctx?.tl;
  if (!tl) return null;
  if (s.selectedBlock && tl.segs.some((x) => x.id === s.selectedBlock)) return s.selectedBlock;
  return segAt(tl, s.transport.loopTime())?.id ?? null;
}

const numberOf = (id: string) => (st().ctx?.tl.segs.findIndex((x) => x.id === id) ?? -1) + 1;

export function selectBlock(id: string | null) {
  useStudioStore.setState({ selectedBlock: id });
  st().drawLane();
}

/** Splits the segment under the playhead, on the nearest snap line. */
export function splitAtPlayhead() {
  const s = st();
  const tl = s.ctx?.tl;
  if (!tl) return;
  const beat = snapBeat(s.transport.loopTime() / tl.beatDur, s.snap);
  const seg = segAt(tl, beat * tl.beatDur);
  if (seg) splitBlockAt(seg.id, beat);
}

/** Splits a segment at a beat: the playhead's when it's in the segment, else the middle. */
export function splitBlockAt(id: string, beat?: number) {
  const s = st();
  const tl = s.ctx?.tl;
  const seg = tl?.segs.find((x) => x.id === id);
  if (!tl || !seg) return;
  if (beat == null) {
    const t = s.transport.loopTime();
    beat = t >= seg.t0 && t < seg.t1 ? snapBeat(t / tl.beatDur, s.snap) : (seg.t0 + seg.dur / 2) / tl.beatDur;
  }
  const at = beat;
  const n = seg.i + 1;
  if (editBlocks((blocks, plan) => splitBlock(blocks, plan, seg.id, at))) {
    const right = st().ctx?.tl.segs[seg.i + 1];
    if (right) selectBlock(right.id);
    toast(`Split segment ${n}`);
    return;
  }
  const near = [seg.t0, seg.t1].some((t) => Math.abs(t / tl.beatDur - at) < MIN_BEATS - 1e-9);
  toast(near ? "There's already a cut here" : 'Too short to split here');
}

/** Deletes a segment. The one before it plays on to the next cut. */
export function deleteBlock(id = targetBlock()) {
  const tl = st().ctx?.tl;
  if (!tl || !id) return;
  if (tl.segs.length < 2) {
    toast('The loop needs at least one segment');
    return;
  }
  const k = numberOf(id) - 1;
  if (k < 0 || !editBlocks((blocks) => removeBlock(blocks, id))) return;
  // the selection moves to the segment that took the time
  selectBlock(k === 0 ? (st().ctx?.tl.segs[0]?.id ?? null) : tl.segs[k - 1].id);
  toast(k === 0 ? 'Deleted segment 1. Segment 2 starts the loop now.' : `Deleted segment ${k + 1}. Segment ${k} plays on to the next cut.`);
}

/** Plays a segment's first half twice. */
export function repeatSegment(id = targetBlock()) {
  if (!id) return;
  const n = numberOf(id);
  if (editBlocks((blocks, tl) => repeatBlock(blocks, tl, id))) toast(`Segment ${n} plays its first half twice`);
  else toast('Too short to repeat');
}

/** Puts a clip in at the playhead, up to the next cut, or in the second half of a segment. Footage it
 * hasn't shown yet in the edit is used when the clip has some left. */
export function insertClip(clipId: string, where: { id?: string } = {}) {
  const s = st();
  const tl = s.ctx?.tl;
  if (!tl) return;
  const bd = tl.beatDur;
  let beat = snapBeat(s.transport.loopTime() / bd, s.snap);
  let seg = where.id ? tl.segs.find((x) => x.id === where.id) : segAt(tl, beat * bd);
  if (!seg) return;
  const room = (b: number) => b - seg!.t0 / bd >= MIN_BEATS - 1e-9 && seg!.t1 / bd - b >= MIN_BEATS - 1e-9;
  if (where.id || !room(beat)) beat = (seg.t0 + seg.dur / 2) / bd; // at a cut, the clip takes the second half
  const len = seg.t1 - beat * bd;
  const used = tl.segs.filter((x) => x.clipId === clipId).map((x) => x.in + x.dur * x.speed);
  const dur = s.clipDur.get(clipId) || 10;
  const fresh = used.length ? Math.max(...used) + 0.5 : 0;
  const inPt = fresh + len * (s.look?.camera.p.speed ?? 1) + 0.1 <= dur ? fresh : 0;
  const n = seg.i + 1;
  const no = s.selected.indexOf(clipId) + 1;
  if (editBlocks((blocks, plan) => insertBlock(blocks, plan, seg!.id, beat, clipId, inPt))) {
    const added = st().ctx?.tl.segs[seg.i + 1];
    if (added) selectBlock(added.id);
    toast(`Put clip ${no} in segment ${n}`);
  } else toast('Too short to put a clip in here');
}

/** Moves the cut at the start of a block, while its line is dragged. */
export function trimCut(id: string, beat: number, div: SnapDiv) {
  const tl = st().ctx?.tl;
  if (tl) editBlocks((blocks) => moveCut(blocks, id, beat, div, tl.L / tl.beatDur));
}

export function setBlock(id: string, patch: BlockPatch) {
  editBlocks((blocks) => patchBlock(blocks, id, patch));
}

/** Hands a block back to the look, and a rolled block gets its rolled clip and in-point back. */
export function clearBlock(id: string) {
  editBlocks((blocks, tl) => {
    const auto = autoBlock(blocks, id);
    const twin = tl.rolled.find((b) => b.id === id);
    return twin ? patchBlock(auto, id, { clipId: twin.clipId, in: twin.in }) : auto;
  });
}

const SNAP_NAMES: Record<SnapDiv, string> = { 1: 'the beat', 2: 'half beats', 4: 'quarter beats', 0: 'off' };

export function setSnap(div: SnapDiv) {
  useStudioStore.setState({ snap: div });
  st().save();
  toast(div ? `Cuts snap to ${SNAP_NAMES[div]}` : 'Snap off: cuts go anywhere');
}
