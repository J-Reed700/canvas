import { useStudioStore } from './store.ts';
import { toast } from '../lib/utils.ts';
import { LOOKS, cloneLook } from '../engine/looks.ts';
import { MODULES } from '../engine/modules.ts';
import { defaultEnv, defaultLfos, defaultSeq } from '../engine/audio.ts';
import type { Look } from '../engine/types.ts';

const KEY = 'downbeat.studio.v1';
// Saved before the Canvas Forge → Downbeat rename; read once so nobody loses their session.
const LEGACY_KEY = 'canvasforge.studio.v1';

const histList: string[] = [];
const futList: string[] = [];
let histLastSnap: string | null = null;
let histTimerId: ReturnType<typeof setTimeout> | undefined;
let histMutedFlag = false;

// The undo and redo buttons follow the history through useSyncExternalStore, like the play button follows the transport.
const histListeners = new Set<() => void>();
let histDepth = { undo: 0, redo: 0 };

function histChanged() {
  if (histDepth.undo === histList.length && histDepth.redo === futList.length) return;
  histDepth = { undo: histList.length, redo: futList.length };
  histListeners.forEach((fn) => fn());
}

export function subscribeHistory(fn: () => void): () => void {
  histListeners.add(fn);
  return () => histListeners.delete(fn);
}

/** How many steps undo and redo can take. The same object until one of them changes. */
export const historyDepth = (): { undo: number; redo: number } => histDepth;

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function writeSession() {
  saveTimer = undefined;
  const s = useStudioStore.getState();
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        trackId: s.trackId,
        selected: s.selected,
        look: s.look,
        lookId: s.lookId,
        saved: s.saved,
        bars: s.bars,
        loopStart: s.loopStart,
        bpmManual: s.bpmManual,
        bpmOverride: s.bpmOverride,
        seed: s.seed,
        direction: s.direction,
        lockEdit: s.lockEdit,
        blocks: s.blocks,
        // an older session's cuts that haven't been turned into blocks yet, kept until they are
        ...(s.legacyEdit || {}),
        snap: s.snap,
        hud: s.hud,
        safe: s.safe,
        muted: s.muted,
        tab: s.tab,
        mode: s.transport.mode,
        exportOpts: s.exportOpts,
        intensity: s.intensity,
        clipMode: s.clipMode,
        clipLooks: s.clipLooks,
        evolveAmt: s.evolveAmt,
        evolveCuts: s.evolveCuts,
        rebound: s.rebound,
        fitAll: s.fitAll,
        rollOpts: s.rollOpts,
        clipFrame: s.clipFrame,
        gridNudge: s.gridNudge,
      }),
    );
  } catch {
    /* session storage only */
  }
}

function flushSession() {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  writeSession();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSession();
  });
}

export function save() {
  markEdited();
  const s = useStudioStore.getState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSession, 300);
  if (!histMutedFlag && s.look) {
    clearTimeout(histTimerId);
    histTimerId = setTimeout(commitHistory, 350);
  }
}

// An edit becomes an undo step 350 ms after it settles, so a slider drag is one step, not hundreds.
function commitHistory() {
  histTimerId = undefined;
  const snap = snapshot();
  if (histLastSnap !== null && snap !== histLastSnap) {
    histList.push(histLastSnap);
    if (histList.length > 100) histList.shift();
    futList.length = 0;
  }
  histLastSnap = snap;
  histChanged();
}

/** Starts the undo history over at the current state. */
export function resetHistory() {
  clearTimeout(histTimerId);
  histTimerId = undefined;
  histList.length = 0;
  futList.length = 0;
  histLastSnap = snapshot();
  histChanged();
}

/** Undo and redo right after an edit should see it, so they commit a pending step first. */
function flushHistory() {
  if (histTimerId === undefined) return;
  clearTimeout(histTimerId);
  commitHistory();
}

export function restore(): any {
  try {
    return JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function snapshot(): string {
  const s = useStudioStore.getState();
  return JSON.stringify({
    look: s.look,
    lookId: s.lookId,
    direction: s.direction,
    seed: s.seed,
    intensity: s.intensity,
    clipMode: s.clipMode,
    clipLooks: s.clipLooks,
    editClip: s.editClip,
    evolveAmt: s.evolveAmt,
    evolveCuts: s.evolveCuts,
    rebound: s.rebound,
    fitAll: s.fitAll,
    selected: s.selected,
    loopStart: s.loopStart,
    bars: s.bars,
    blocks: s.blocks,
    clipFrame: s.clipFrame,
    trackId: s.trackId,
    bpmOverride: s.bpmOverride,
    bpmManual: s.bpmManual,
    gridNudge: s.gridNudge,
    lockEdit: s.lockEdit,
    exportOpts: s.exportOpts,
  });
}

export function applySnapshot(snap: string) {
  histMutedFlag = true;
  const data = JSON.parse(snap);
  const before = useStudioStore.getState();
  // Another song, or another tempo for this one, means analysing the song again.
  const reanalyze = data.trackId !== before.trackId || data.bpmOverride?.[data.trackId] !== before.bpmOverride[data.trackId];
  useStudioStore.setState(data);
  const s = useStudioStore.getState();
  if (s.engine?.main) s.engine.main.reset();
  s.rebuild();
  histMutedFlag = false;
  histLastSnap = snap;
  if (reanalyze) void reloadSong(data);
}

// Loading a song picks its own loop, so the snapshot's loop goes back on once the analysis is in.
async function reloadSong(data: { trackId: string; loopStart: number; bars: number; blocks: any }) {
  await useStudioStore.getState().selectTrack(data.trackId, { keepLoop: true });
  const s = useStudioStore.getState();
  if (s.trackId !== data.trackId) return; // another song was picked meanwhile
  histMutedFlag = true;
  useStudioStore.setState({ loopStart: data.loopStart, bars: data.bars, blocks: data.blocks });
  s.rebuild();
  histMutedFlag = false;
}

export function undo() {
  flushHistory();
  const snap = snapshot();
  if (!histList.length) {
    toast('Nothing to undo');
    return;
  }
  futList.push(snap);
  const prev = histList.pop()!;
  applySnapshot(prev);
  histChanged();
  toast('↶ Undo');
}

export function redo() {
  flushHistory();
  const snap = snapshot();
  if (!futList.length) {
    toast('Nothing to redo');
    return;
  }
  histList.push(snap);
  const next = futList.pop()!;
  applySnapshot(next);
  histChanged();
  toast('↷ Redo');
}

// Rolled, random and variation looks aren't in LOOKS, so Revert needs the copy they started as.
const originals = new Map<string, string>();

export function rememberLook(l: Look) {
  if (originals.has(l.id)) return;
  originals.set(l.id, JSON.stringify(l));
  if (originals.size > 200) originals.delete(originals.keys().next().value!);
}

export function originalLook(id: string): Look | null {
  const s = useStudioStore.getState();
  const base = id.replace(/^edit:/, '');
  const known = [...s.saved, ...LOOKS].find((l) => l.id === base);
  if (known) return known;
  const json = originals.get(base);
  return json ? JSON.parse(json) : null;
}

// What the gallery compares: the look's layers, camera, grade and modulators, but not its cut settings,
// which the Edit tab changes without changing the look. The Layers tab fills in the default envelope,
// steps and LFOs when it shows them, which doesn't count as an edit.
const visuals = (l: Look) =>
  JSON.stringify([l.layers, l.camera, l.finish, l.env ?? defaultEnv(), l.seq ?? defaultSeq(), l.lfos ?? defaultLfos(), l.macro ?? { a: 0, b: 0 }]);

/** Once the main look no longer matches the one picked in the gallery, the gallery stops showing that
 * look as the current one (Revert picks it again). */
function markEdited() {
  const s = useStudioStore.getState();
  if (!s.look || !s.lookId || s.lookId.startsWith('edit:')) return;
  const base = originalLook(s.lookId);
  if (base && visuals(base) !== visuals(s.look)) useStudioStore.setState({ lookId: `edit:${s.lookId}` });
}

export function saveLook(name?: string) {
  const s = useStudioStore.getState();
  const target = s.editLook();
  if (!target) return;
  const lookName = name || target.name;
  const l = cloneLook(target);
  if (target !== s.look && s.look) {
    l.camera = JSON.parse(JSON.stringify(s.look.camera));
    l.finish = JSON.parse(JSON.stringify(s.look.finish));
    l.cut = JSON.parse(JSON.stringify(s.look.cut));
  }
  l.id = `mine-${Date.now()}`;
  l.name = lookName;
  l.vibe = l.layers.map((x) => MODULES[x.m]?.name).filter(Boolean).join(' + ') || 'Clean grade';
  l.mine = true;
  useStudioStore.setState((prev) => ({ saved: [l, ...prev.saved] }));
  s.save();
  toast(`Saved ${lookName} to Your looks`);
}
