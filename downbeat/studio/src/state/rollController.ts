import { useStudioStore } from './store.ts';
import { LOOKS, cloneLook, chaosLook, randomLook } from '../engine/looks.ts';
import { rng, RHYTHMS } from '../engine/timeline.ts';
import { TRANSITIONS } from '../engine/shaders.ts';
import { shuffle, CLIP_MODES, toast } from '../lib/utils.ts';
import { rememberLook } from './historyController.ts';

const rollStack: string[] = [];
let rollSeedVal = (Date.now() % 1e9) >>> 0;
let surpriseSeedVal = Date.now() % 1e6;

export function surprise() {
  surpriseSeedVal = (surpriseSeedVal + 1) % 1e6;
  const l = randomLook(surpriseSeedVal);
  useStudioStore.getState().setLook(l);
  toast(`Surprise: ${l.name}`);
}

export function rollClips() {
  const s = useStudioStore.getState();
  const base = (Date.now() % 1e6) | 0;
  const nextLooks = Object.fromEntries(s.selected.map((id, i) => [id, chaosLook(base + i * 7919)]));
  Object.values(nextLooks).forEach(rememberLook);
  useStudioStore.setState({ clipLooks: nextLooks, clipMode: 'custom', editClip: null });
  if (s.engine?.main) s.engine.main.reset();
  s.rebuild();
  s.save();
  toast(`Rolled a separate stack for each of the ${s.selected.length} clips`);
}

export function rollAll() {
  const s = useStudioStore.getState();
  if (!s.selected.length) {
    toast('Pick a few clips first');
    return;
  }
  rollStack.push(s.snapshot());
  if (rollStack.length > 40) rollStack.shift();

  rollSeedVal = (Math.imul(rollSeedVal ^ (rollSeedVal >>> 13), 1103515245) + 12345) >>> 0;
  const seed = rollSeedVal % 1000000007;
  const r = rng(seed);
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
  const o = s.rollOpts;
  const prev = s.look || LOOKS[0];
  const l = o.look ? chaosLook(seed) : cloneLook(prev);

  let nextDirection = s.direction;
  let nextSeed = s.seed;
  let nextIntensity = s.intensity;
  let nextLoopStart = s.loopStart;
  let nextBars = s.bars;
  let nextClipMode = s.clipMode;
  let nextClipLooks = { ...s.clipLooks };
  let nextEvolveAmt = s.evolveAmt;

  if (o.edit) {
    const ids = shuffle(
      Object.keys(TRANSITIONS).filter((k) => k !== 'cut'),
      r,
    );
    const pool = ids.slice(0, 3 + Math.floor(r() * 4));
    if (r() < 0.3) pool.push('cut');
    l.cut = {
      rhythm: pick(['hits', 'hits', 'beat', 'half', 'half', 'bar', 'bar', 'bar2', 'sync', 'build', 'varied', 'even', 'twice', 'eighth']),
      transitions: pool,
      beats: pick([0.25, 0.5, 0.5, 1, 1, 2]),
      order: pick(['cycle', 'random', 'random']),
      velocity: pick(['none', 'none', 'none', 'none', 'surge', 'surge', 'swell', 'hold', 'wave', 'ramp']),
    };
    nextDirection = pick(['forward', 'forward', 'forward', 'alternate', 'reverse', 'pingpong', 'random']);
    l.camera.p.speed = pick([0.6, 0.8, 1, 1, 1, 1.25, 1.5]);
    nextSeed = Math.floor(r() * 1e6);
    nextIntensity = pick([0.85, 1, 1, 1.1, 1.25, 1.4]);
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
      nextClipLooks = Object.fromEntries(nextSelected.slice(1).map((id, i) => [id, chaosLook(seed + (i + 1) * 7919)]));
    }
    if (nextClipMode === 'evolve') nextEvolveAmt = pick([0.3, 0.45, 0.6, 0.8]);
  }

  rememberLook(l);
  Object.values(nextClipLooks).forEach(rememberLook);
  useStudioStore.setState({
    look: l,
    lookId: l.id,
    direction: nextDirection,
    seed: nextSeed,
    intensity: nextIntensity,
    loopStart: nextLoopStart,
    bars: nextBars,
    selected: nextSelected,
    clipMode: nextClipMode,
    clipLooks: nextClipLooks,
    evolveAmt: nextEvolveAmt,
    editClip: null,
    customCuts: null,
    segOverrides: {},
  });

  if (s.engine?.main) s.engine.main.reset();
  s.rebuild();

  const modeLabel = CLIP_MODES.find(([k]) => k === nextClipMode)?.[1].toLowerCase() || 'same look';
  toast(
    `Rolled ${l.name} · ${l.layers.length} layers · ${RHYTHMS[l.cut.rhythm]?.name || 'custom'} cuts${nextClipMode === 'one' ? '' : ` · ${modeLabel}`}`,
    3200,
  );
}

export function undoRoll() {
  const snap = rollStack.pop();
  if (!snap) {
    toast('Nothing to undo');
    return;
  }
  const data = JSON.parse(snap);
  useStudioStore.setState(data);
  const s = useStudioStore.getState();
  if (s.engine?.main) s.engine.main.reset();
  s.rebuild();
  toast(`↶ Back to ${s.look?.name || 'edit'}`);
}
