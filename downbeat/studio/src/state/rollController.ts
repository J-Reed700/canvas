import type { StudioState, StudioStore } from './storeTypes.ts';
import { LOOKS, cloneLook, chaosLook, chooseRollStyle, randomLook } from '../engine/looks.ts';
import { footageUsed, rng, RHYTHMS } from '../engine/timeline.ts';
import { TRANSITIONS } from '../engine/shaders.ts';
import { shuffle, CLIP_MODES, toast } from '../lib/utils.ts';
import type { Block, BlockPatch, Look } from '../engine/types.ts';

/** What Remix rolls: the inspector's target, so a selected segment or one clip can be remixed on its own. */
export type RemixTarget =
  | { kind: 'segment'; id: string; segNo: number; clipId: string; clipNo: number }
  | { kind: 'clip'; clipId: string; clipNo: number }
  | { kind: 'all' };

/** Follows the inspector's scope: This appearance, All uses, or Whole edit. */
export function remixTarget(s: Pick<StudioState, 'ctx' | 'editBlock' | 'editClip' | 'selected'>): RemixTarget {
  const seg = s.editBlock ? s.ctx?.tl.segs.find((x) => x.id === s.editBlock) : null;
  if (seg) return { kind: 'segment', id: seg.id, segNo: seg.i + 1, clipId: seg.clipId, clipNo: s.selected.indexOf(seg.clipId) + 1 };
  if (s.editClip && s.selected.includes(s.editClip)) return { kind: 'clip', clipId: s.editClip, clipNo: s.selected.indexOf(s.editClip) + 1 };
  return { kind: 'all' };
}

/** A visual roll must reach appearances that previously owned a look, without moving their cuts. With a
 * clip, only that clip's appearances are reached. */
function inheritRolledLook(blocks: Block[] | null, clipId?: string): Block[] | null {
  if (!blocks) return blocks;
  let changed = false;
  const next = blocks.map((block) => {
    const own = block.overrides;
    if (clipId && block.clipId !== clipId) return block;
    if (!block.look && !own?.layers && !own?.finish && !own?.macro &&
      !Object.keys(own?.camera || {}).some((key) => key !== 'speed')) return block;
    changed = true;
    const { look: _look, overrides: _overrides, ...timing } = block;
    const speed = own?.camera?.speed;
    return speed === undefined ? timing : { ...timing, overrides: { camera: { speed } } };
  });
  return changed ? next : blocks;
}

/** Owns roll state for one studio instance. */
export function createRollController(store: StudioStore, rememberLook: (look: Look) => void) {

  const rollStack: string[] = [];
  let rollSeedVal = (Date.now() % 1e9) >>> 0;
  let surpriseSeedVal = Date.now() % 1e6;

  function surprise() {
    surpriseSeedVal = (surpriseSeedVal + 1) % 1e6;
    const s = store.getState();
    const l = randomLook(surpriseSeedVal, s.rollStyle);
    const t = remixTarget(s);
    const where = t.kind === 'segment' ? ` · Seg ${t.segNo}` : t.kind === 'clip' ? ` · Clip ${t.clipNo}` : '';
    s.applyLook(l);
    toast(`Surprise: ${l.name}${where}`);
  }

  function rollClips() {
    const s = store.getState();
    const base = (Date.now() % 1e6) | 0;
    const style = chooseRollStyle(base, s.rollStyle, s.look?.style);
    const nextLooks = Object.fromEntries(s.selected.map((id, i) => [id, chaosLook(base + i * 7919, style, s.clipLookOf(id))]));
    Object.values(nextLooks).forEach(rememberLook);
    store.setState({ clipLooks: nextLooks, clipMode: 'custom', editClip: null, editBlock: null, blocks: inheritRolledLook(s.blocks) });
    if (s.engine?.main) s.engine.main.reset();
    s.rebuild();
    s.save();
    toast(`Rolled a separate stack for each of the ${s.selected.length} clips`);
  }

  /** Shift+D steps back through rolls of any target. */
  function keepForUndo(s: StudioState) {
    rollStack.push(s.snapshot());
    if (rollStack.length > 40) rollStack.shift();
  }

  function rollSeed(): number {
    rollSeedVal = (Math.imul(rollSeedVal ^ (rollSeedVal >>> 13), 1103515245) + 12345) >>> 0;
    return rollSeedVal % 1000000007;
  }

  /** Rolls one appearance: its own look and, with Edit on, its transition in, the moment of the clip it
   * plays, its direction and its speed ramp. The cuts and every other segment stay as they are. */
  function rollSegment(id: string) {
    const s = store.getState();
    const tl = s.ctx?.tl;
    const seg = tl?.segs.find((x) => x.id === id);
    if (!tl || !seg || !s.look) return;
    const o = s.rollOpts;
    if (!o.look && !o.edit) {
      toast('Turn on Look & layers or Edit in the Remix menu to remix one segment');
      return;
    }
    keepForUndo(s);
    const seed = rollSeed();
    const r = rng(seed);
    const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
    const block = (s.blocks ?? tl.blocks).find((b) => b.id === id);
    const prev = block?.look || s.clipLookOf(seg.clipId, seg);
    const l = o.look ? chaosLook(seed, chooseRollStyle(seed, s.rollStyle, prev.style), prev) : null;
    const style = (l || prev).style;
    const restrained = !!style && style !== 'experimental';
    const patch: BlockPatch = {};
    if (l) {
      rememberLook(l);
      // speed belongs to the edit, so the new look leaves the footage's timing alone
      const speed = block?.overrides?.camera?.speed;
      patch.look = l;
      patch.overrides = speed === undefined ? undefined : { camera: { speed } };
    }
    if (o.edit) {
      const pool = (restrained ? ['dissolve', 'luma', 'cut'] : Object.keys(TRANSITIONS)).filter((k) => k !== seg.trans);
      patch.trans = pick(pool);
      if (!restrained) {
        patch.dir = pick(['forward', 'forward', 'reverse', 'pingpong'] as const);
        patch.vel = pick(['none', 'none', 'none', 'surge', 'swell', 'hold', 'wave', 'ramp']);
      }
      // a ramp can run ahead of constant speed, so the new moment leaves room for the footage it uses
      const used = footageUsed({ ...seg, vel: patch.vel ?? seg.vel }, seg.dur) * seg.speed;
      const maxIn = Math.max(0, (s.clipDur.get(seg.clipId) ?? 0) - used - 0.1);
      if (maxIn > 0.05) patch.in = Math.round(r() * maxIn * 100) / 100;
    }
    s.setBlock(id, patch);
    s.engine?.main?.reset();
    const parts = [`Remixed segment ${seg.i + 1}`];
    if (l) parts.push(`${l.name} · ${l.layers.length} layers`);
    if (patch.trans) parts.push(`${TRANSITIONS[patch.trans]?.name || patch.trans} in`);
    toast(parts.join(' · '), 3200);
  }

  /** Rolls one clip's own look, which every appearance of it shows. The other clips keep the looks they show now. */
  function rollClip(clipId: string) {
    const s = store.getState();
    const no = s.selected.indexOf(clipId) + 1;
    if (!s.look || !no) return;
    if (!s.rollOpts.look) {
      toast('Turn on Look & layers in the Remix menu to remix one clip');
      return;
    }
    keepForUndo(s);
    const seed = rollSeed();
    const prev = s.clipLookOf(clipId);
    const l = chaosLook(seed, chooseRollStyle(seed, s.rollStyle, prev.style), prev);
    rememberLook(l);
    // Evolve and Cycle become custom looks as they show now; the same look on every clip leaves only this one apart.
    const kept = s.clipMode === 'custom' ? s.clipLooks : s.clipMode === 'one' ? {} : Object.fromEntries(
      s.selected
        .map((id) => [id, s.clipLookOf(id)] as [string, Look])
        .filter(([, look]) => look !== s.look)
        .map(([id, look]) => [id, cloneLook(look)]),
    );
    store.setState({ clipLooks: { ...kept, [clipId]: l }, clipMode: 'custom', blocks: inheritRolledLook(s.blocks, clipId) });
    s.engine?.main?.reset();
    s.rebuild();
    const uses = store.getState().ctx?.tl.segs.filter((x) => x.clipId === clipId).length ?? 0;
    toast(`Remixed clip ${no} · ${l.name} · ${l.layers.length} layers · ${uses === 1 ? 'its 1 appearance' : `all ${uses} appearances`}`, 3200);
  }

  /** D and the Remix button: rolls whatever the inspector targets. */
  function remix() {
    const target = remixTarget(store.getState());
    if (target.kind === 'segment') rollSegment(target.id);
    else if (target.kind === 'clip') rollClip(target.clipId);
    else rollAll();
  }

  function rollAll() {
    const s = store.getState();
    if (!s.selected.length) {
      toast('Pick a few clips first');
      return;
    }
    keepForUndo(s);

    const seed = rollSeed();
    const r = rng(seed);
    const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
    const o = s.rollOpts;
    const prev = s.look || LOOKS[0];
    const style = !o.look && s.rollStyle === 'balanced' ? prev.style || 'experimental' : chooseRollStyle(seed, s.rollStyle, prev.style);
    const l = o.look ? chaosLook(seed, style, prev) : cloneLook(prev);
    const restrained = !!l.style && l.style !== 'experimental';

    let nextDirection = s.direction;
    let nextSeed = s.seed;
    let nextIntensity = s.intensity;
    let nextLoopStart = s.loopStart;
    let nextBars = s.bars;
    let nextClipMode = s.clipMode;
    let nextClipLooks = { ...s.clipLooks };
    let nextEvolveAmt = s.evolveAmt;
    let nextRebound = s.rebound;
    let nextBpm = s.bpmManual;

    if (o.edit) {
      const ids = shuffle(
        restrained ? ['dissolve', 'luma'] : Object.keys(TRANSITIONS).filter((k) => k !== 'cut'),
        r,
      );
      const pool = ids.slice(0, 3 + Math.floor(r() * 4));
      if (restrained || r() < 0.3) pool.push('cut');
      l.cut = {
        rhythm: pick(restrained ? ['bar', 'bar2', 'bar2'] : ['hits', 'hits', 'beat', 'half', 'half', 'bar', 'bar', 'bar2', 'sync', 'build', 'varied', 'even', 'twice', 'eighth']),
        transitions: pool,
        beats: pick([0.25, 0.5, 0.5, 1, 1, 2]),
        order: pick(['cycle', 'random', 'random']),
        velocity: restrained ? 'none' : pick(['none', 'none', 'none', 'none', 'surge', 'surge', 'swell', 'hold', 'wave', 'ramp']),
      };
      nextDirection = restrained ? 'forward' : pick(['forward', 'forward', 'forward', 'alternate', 'reverse', 'pingpong', 'random']);
      l.camera.p.speed = restrained ? 1 : pick([0.6, 0.8, 1, 1, 1, 1.25, 1.5]);
      nextSeed = Math.floor(r() * 1e6);
      nextIntensity = restrained ? 1 : pick([0.85, 1, 1, 1.1, 1.25, 1.4, 1.6, 1.75]);
      nextRebound = !restrained && r() < 0.2;
      // without a song the tempo is part of the edit, but a loop of Canvas length stays within 3 to 8 s
      if (!s.trackId) {
        const L = s.loopLen();
        const fits = (bpm: number) => {
          const len = (L * s.bpmManual) / bpm;
          return L > 8 + 1e-6 || (len <= 8 + 1e-6 && (len >= 3 - 1e-6 || L < 3 - 1e-6));
        };
        const tempos = [92, 108, 120, 126, 132, 140, 152].filter(fits);
        if (tempos.length) nextBpm = pick(tempos);
      }
    } else {
      l.cut = JSON.parse(JSON.stringify(prev.cut));
      l.camera.p.speed = prev.camera.p.speed;
    }

    const nextSelected = [...s.selected];
    if (o.clips && nextSelected.length > 1) shuffle(nextSelected, r);

    if (o.loop && s.features?.loops?.length) {
      nextLoopStart = pick(s.features.loops).start;
      // Only Canvas-length loops get a new length: a roll shouldn't cut a long visualizer down to 4 bars.
      const vb = s.canvasBars();
      if (vb.length && s.loopLen() <= 8 + 1e-6) nextBars = pick(vb);
    }

    if (o.perClip) {
      nextClipMode = nextSelected.length > 1 ? pick(['one', 'one', 'evolve', 'cycle', 'custom', 'custom']) : 'one';
      if (nextClipMode === 'custom') {
        nextClipLooks = Object.fromEntries(nextSelected.slice(1).map((id, i) => [id, chaosLook(seed + (i + 1) * 7919, style)]));
      }
      if (nextClipMode === 'evolve') nextEvolveAmt = pick(restrained ? [0.2, 0.3, 0.4] : [0.3, 0.45, 0.6, 0.8]);
    }

    rememberLook(l);
    Object.values(nextClipLooks).forEach(rememberLook);
    store.setState({
      look: l,
      lookId: l.id,
      direction: nextDirection,
      seed: nextSeed,
      intensity: nextIntensity,
      rebound: nextRebound,
      bpmManual: nextBpm,
      loopStart: nextLoopStart,
      bars: nextBars,
      selected: nextSelected,
      clipMode: nextClipMode,
      clipLooks: nextClipLooks,
      evolveAmt: nextEvolveAmt,
      editClip: null,
      editBlock: null,
      // a roll that leaves the cut, the clips and the loop alone leaves a hand-cut edit alone too
      blocks: o.edit || nextSelected.join() !== s.selected.join() || nextLoopStart !== s.loopStart || nextBars !== s.bars ? null :
        o.look || o.perClip ? inheritRolledLook(s.blocks) : s.blocks,
    });

    if (s.engine?.main) s.engine.main.reset();
    s.rebuild();

    const modeLabel = CLIP_MODES.find(([k]) => k === nextClipMode)?.[1].toLowerCase() || 'same look';
    toast(
      `Rolled ${l.name} · ${l.layers.length} layers · ${RHYTHMS[l.cut.rhythm]?.name || 'custom'} cuts${nextRebound ? ' · Rebound' : ''}${nextClipMode === 'one' ? '' : ` · ${modeLabel}`}${nextBpm !== s.bpmManual ? ` · ${nextBpm} BPM` : ''}`,
      3200,
    );
  }

  function undoRoll() {
    const snap = rollStack.pop();
    if (!snap) {
      toast('Nothing to undo');
      return;
    }
    const data = JSON.parse(snap);
    store.setState(data);
    const s = store.getState();
    if (s.engine?.main) s.engine.main.reset();
    s.rebuild();
    toast(`↶ Back to ${s.look?.name || 'edit'}`);
  }

  return { surprise, rollClips, rollAll, rollSegment, rollClip, remix, undoRoll };
}

export type RollController = ReturnType<typeof createRollController>;
