// Edits to the blocks on the video lane: split, delete, repeat, insert and trim. Each takes the blocks and
// the plan they resolve to, and returns new blocks, or null when the edit can't be made. A split is a
// through edit: the footage, the camera and a framing move all carry on across the new cut, so nothing
// changes on screen until one half is changed.
import { footageUsed, frameAt, moveAt, rng } from './timeline.ts';
import type { Block, BlockPatch, Segment, SegmentFrame, TimelinePlan } from './types.ts';

/** The shortest block an edit leaves, in beats. */
export const MIN_BEATS = 1 / 8;

/** Lines per beat a cut snaps to: every beat, half or quarter beat, or 0 for anywhere. */
export type SnapDiv = 0 | 1 | 2 | 4;
export const SNAPS: [SnapDiv, string][] = [[1, 'Beat'], [2, '½'], [4, '¼'], [0, 'Off']];

export const snapBeat = (beat: number, div: SnapDiv): number => (div ? Math.round(beat * div) / div : beat);

/** A new block id, h1, h2…, one past the highest in use. Rolled blocks are g0, g1… */
export function newId(blocks: Block[]): string {
  let n = 0;
  for (const b of blocks) {
    const m = /^h(\d+)$/.exec(b.id);
    if (m) n = Math.max(n, +m[1]);
  }
  return `h${n + 1}`;
}

const byAt = (blocks: Block[]): Block[] => [...blocks].sort((a, b) => a.at - b.at);
// drops the keys set to undefined, so a cleared setting is gone rather than saved as a hole
const tidy = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

/** The segment playing at loop time t. */
export function segAt(tl: TimelinePlan, t: number): Segment | undefined {
  const x = ((t % tl.L) + tl.L) % tl.L;
  return tl.segs.find((s) => x >= s.t0 - 1e-9 && x < s.t1 - 1e-9) || tl.segs.at(-1);
}

/** In-points for the two halves of a segment split `local` seconds in, so the right half starts on the
 * footage frame the left half stops on. Ramps carry on too, since their phase follows the loop's beats. */
export function splitIn(seg: Segment, local: number): [number, number] {
  if (seg.pp) return [seg.in, seg.in]; // a ping-pong is back at its in-point at the cut, and each half bounces on its own
  const used = footageUsed(seg, local) * seg.speed;
  if (seg.rev) return [seg.in + footageUsed(seg, seg.dur) * seg.speed - used, seg.in];
  return [seg.in, seg.in + used];
}

/** A framing split m of the way through its move: each half keeps its part of the move. */
export function splitFrame(f: SegmentFrame | undefined, m: number): [SegmentFrame | undefined, SegmentFrame | undefined] {
  if (!f?.b) return [f, f];
  const mid = frameAt(f, m);
  return [tidy({ a: f.a, b: mid, ease: f.ease }), tidy({ a: mid, b: f.b, ease: f.ease })];
}

// The two halves of block b (playing as seg) split `local` seconds in. The right half is a hard cut that
// plays on with the same clip, ramp, direction, seed and slot.
function halves(b: Block, seg: Segment, local: number, id: string): [Block, Block] {
  const [inL, inR] = splitIn(seg, local);
  const [fL, fR] = splitFrame(seg.frame, moveAt(seg, local));
  const [u0, u1] = seg.span;
  const mid = u0 + ((u1 - u0) * local) / seg.dur;
  const left = tidy<Block>({ ...b, clipId: seg.clipId, in: inL, span: [u0, mid], frame: fL });
  const right = tidy<Block>({
    id,
    at: Math.round(((seg.t0 + local) / seg.bd) * 1e6) / 1e6,
    clipId: seg.clipId,
    in: inR,
    seed: b.seed,
    slot: b.slot ?? seg.i,
    span: [mid, u1],
    trans: 'cut',
    vel: b.vel,
    dir: b.dir,
    frame: fR,
  });
  return [left, right];
}

function cutAt(blocks: Block[], tl: TimelinePlan, id: string, at: number, make: (left: Block, right: Block) => [Block, Block]): Block[] | null {
  const seg = tl.segs.find((s) => s.id === id);
  const b = blocks.find((x) => x.id === id);
  if (!seg || !b) return null;
  const local = at * tl.beatDur - seg.t0;
  const min = MIN_BEATS * tl.beatDur - 1e-9;
  if (local < min || seg.dur - local < min) return null;
  const [left, right] = make(...halves(b, seg, local, newId(blocks)));
  return byAt([...blocks.filter((x) => x !== b), left, right]);
}

/** Splits a block at a beat. */
export function splitBlock(blocks: Block[], tl: TimelinePlan, id: string, at: number): Block[] | null {
  return cutAt(blocks, tl, id, at, (l, r) => [l, r]);
}

/** Splits a block in half and plays its first half twice: a stutter on the beat. */
export function repeatBlock(blocks: Block[], tl: TimelinePlan, id: string): Block[] | null {
  const seg = tl.segs.find((s) => s.id === id);
  if (!seg) return null;
  return cutAt(blocks, tl, id, (seg.t0 + seg.dur / 2) / tl.beatDur, (l, r) => [l, tidy<Block>({ ...r, in: l.in, span: l.span, frame: l.frame })]);
}

/** Puts a clip in from a beat to the end of the block it lands in. It takes the next transition in the
 * pool and follows the look, like a rolled block. */
export function insertBlock(blocks: Block[], tl: TimelinePlan, id: string, at: number, clipId: string, inPt: number): Block[] | null {
  return cutAt(blocks, tl, id, at, (l, r) => [
    l,
    { id: r.id, at: r.at, clipId, in: inPt, seed: Math.floor(rng(l.seed * 31 + 7)() * 1e6), slot: (r.slot ?? 0) + 1 },
  ]);
}

/** Deletes a block. The one before it plays on to the next cut, so the loop keeps its length and every
 * other cut stays on its beat. Deleting the first block makes the next one start the loop. */
export function removeBlock(blocks: Block[], id: string): Block[] | null {
  if (blocks.length < 2) return null;
  const list = byAt(blocks);
  const k = list.findIndex((b) => b.id === id);
  if (k < 0) return null;
  list.splice(k, 1);
  if (k === 0) list[0] = { ...list[0], at: 0 };
  return list;
}

/** Moves the cut at the start of a block, snapped to `div` lines a beat and kept a step from the cuts
 * either side. The loop seam doesn't move. Returns the same array when the cut stays where it is. */
export function moveCut(blocks: Block[], id: string, at: number, div: SnapDiv, endBeats: number): Block[] | null {
  const list = byAt(blocks);
  const k = list.findIndex((b) => b.id === id);
  if (k <= 0) return null;
  const step = div ? 1 / div : MIN_BEATS;
  const lo = list[k - 1].at + step;
  const hi = (k + 1 < list.length ? list[k + 1].at : endBeats) - step;
  if (lo > hi + 1e-9) return blocks;
  const next = Math.round(Math.min(hi, Math.max(lo, snapBeat(at, div))) * 1e6) / 1e6;
  if (Math.abs(next - list[k].at) < 1e-9) return blocks;
  return blocks.map((b) => (b.id === id ? { ...b, at: next } : b));
}

/** Sets or clears (with undefined) what one block does. */
export function patchBlock(blocks: Block[], id: string, patch: BlockPatch): Block[] {
  return blocks.map((b) => (b.id === id ? tidy({ ...b, ...patch }) : b));
}

/** What `patchBlock` can set that the look would otherwise decide. Clip and in-point aren't in it: once
 * the edit is in blocks they are each block's own. */
export const OWN: (keyof BlockPatch)[] = ['trans', 'transBeats', 'vel', 'dir', 'frame'];

/** Hands a block's transition, length, ramp, direction and framing back to the look. */
export function autoBlock(blocks: Block[], id: string): Block[] {
  return patchBlock(blocks, id, Object.fromEntries(OWN.map((k) => [k, undefined])));
}
