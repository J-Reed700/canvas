import type { StudioStore } from './storeTypes.ts';
import type { StudioStorage } from '../lib/storage.ts';
import { toast } from '../lib/utils.ts';
import { LOOKS, cloneLook } from '../engine/looks.ts';
import { MODULES } from '../engine/modules.ts';
import { normalizeRollStyle } from '../engine/lookStyles.ts';
import { defaultEnv, defaultLfos, defaultSeq } from '../engine/audio.ts';
import { lutValues } from '../engine/lut.ts';
import { firstClips } from './mediaActions.ts';
import type { Block, ClipMeta, Look, TrackMeta } from '../engine/types.ts';

let warnedInvalidLut = false;
export function sanitizeLutLook(look: Look): Look {
  const lut = look?.finish?.lut;
  if (!lut) return look;
  try {
    lutValues(lut);
    return look;
  } catch {
    const finish = { ...look.finish };
    delete finish.lut;
    if (!warnedInvalidLut) {
      warnedInvalidLut = true;
      toast('A damaged saved LUT was removed from the edit.', 5000);
    }
    return { ...look, finish };
  }
}

export const sanitizeLutLooks = (looks: Look[]): Look[] => looks.map(sanitizeLutLook);

const sanitizeBlockLooks = (blocks: Block[] | null): Block[] | null => Array.isArray(blocks) ? blocks.map((block) => {
  if (!block.look) return block;
  const { look, ...rest } = block;
  return Array.isArray(look.layers) ? { ...rest, look: sanitizeLutLook(look) } : rest;
}) : null;

/** The store fields for an edit read back from the session, a project or an export, with defaults for what it
 * doesn't have. Clips that are gone leave the sequence, which starts on a few clips if none are left, and a
 * song that's gone leaves the edit on the BPM clock. */
export function editFields(saved: any, clips: ClipMeta[], tracks: TrackMeta[]) {
  const kept: string[] = Array.isArray(saved.selected) ? saved.selected.filter((id: string) => clips.some((c) => c.id === id)) : [];
  // an edit saved with no song stays on the BPM clock; one that never had the choice starts on the newest song
  let trackId: string = typeof saved.trackId === 'string' ? saved.trackId : tracks[0]?.id || '';
  if (trackId && !tracks.some((t) => t.id === trackId)) trackId = '';
  // `audio` is the old name of withSong, which was on by default. Leaving it behind starts that copy unchecked.
  const { audio: _oldAudio, ...exportOpts } = saved.exportOpts || { size: 'master', withSong: false, format: 'spotify', promo: 0, autoSave: true };
  return {
    selected: kept.length ? kept : firstClips(clips),
    trackId,
    look: sanitizeLutLook(saved.look && Array.isArray(saved.look.layers) ? (saved.look as Look) : cloneLook(LOOKS[0])),
    lookId: (saved.lookId as string) || LOOKS[0].id,
    bars: saved.bars ?? 4,
    loopStart: saved.loopStart ?? 0,
    bpmManual: saved.bpmManual ?? 128,
    bpmOverride: saved.bpmOverride || {},
    seed: saved.seed ?? 2026,
    direction: saved.direction || 'forward',
    lockEdit: saved.lockEdit ?? false,
    intensity: saved.intensity ?? 1,
    clipMode: saved.clipMode || 'one',
    rollStyle: normalizeRollStyle(saved.rollStyle),
    clipLooks: Object.fromEntries(Object.entries(saved.clipLooks || {}).map(([id, look]) => [id, sanitizeLutLook(look as Look)])),
    editClip: null,
    editBlock: null,
    evolveAmt: saved.evolveAmt ?? 0.45,
    evolveCuts: !!saved.evolveCuts,
    rebound: !!saved.rebound,
    fitAll: saved.fitAll ?? true,
    blocks: sanitizeBlockLooks(saved.blocks),
    legacyEdit:
      !saved.blocks && (saved.customCuts?.length || Object.keys(saved.segOverrides || {}).length)
        ? { customCuts: saved.customCuts || null, segOverrides: saved.segOverrides || {} }
        : null,
    selectedBlock: null,
    clipFrame: saved.clipFrame || {},
    gridNudge: saved.gridNudge || {},
    exportOpts,
  };
}

/** Owns history state for one studio instance. */
export function createHistoryController(store: StudioStore, projects: { syncProject: () => Promise<void>; flushProject: () => void }, storage: StudioStorage | null) {
  const { syncProject, flushProject } = projects;

  const KEY = 'downbeat.studio.v1';
  // Saved before the Canvas Forge → Downbeat rename; read once so nobody loses their session.
  const LEGACY_KEY = 'canvasforge.studio.v1';

  const histList: string[] = [];
  const futList: string[] = [];
  const HISTORY_BYTES = 32 * 1024 * 1024;
  let histLastSnap: string | null = null;
  let histTimerId: ReturnType<typeof setTimeout> | undefined;
  let histMutedFlag = false;

  // JavaScript strings are UTF-16 in memory. Keep at least the newest step even when one unusually large
  // LUT makes that step exceed the normal history budget.
  const trimHistory = (list: string[]) => {
    let bytes = list.reduce((n, snap) => n + snap.length * 2, 0);
    while (list.length > 1 && (list.length > 100 || bytes > HISTORY_BYTES)) bytes -= list.shift()!.length * 2;
  };

  // The undo and redo buttons follow the history through useSyncExternalStore, like the play button follows the transport.
  const histListeners = new Set<() => void>();
  let histDepth = { undo: 0, redo: 0 };

  function histChanged() {
    if (histDepth.undo === histList.length && histDepth.redo === futList.length) return;
    histDepth = { undo: histList.length, redo: futList.length };
    histListeners.forEach((fn) => fn());
  }

  function subscribeHistory(fn: () => void): () => void {
    histListeners.add(fn);
    return () => histListeners.delete(fn);
  }

  /** How many steps undo and redo can take. The same object until one of them changes. */
  const historyDepth = (): { undo: number; redo: number } => histDepth;

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionSaveFailed = false;

  /** The edit itself, without the studio's own settings: what a project file, an export's copy of its edit,
   * undo and a batch export save and put back. */
  function editState() {
    const s = store.getState();
    return {
      trackId: s.trackId,
      selected: s.selected,
      look: s.look,
      lookId: s.lookId,
      bars: s.bars,
      loopStart: s.loopStart,
      bpmManual: s.bpmManual,
      bpmOverride: s.bpmOverride,
      seed: s.seed,
      direction: s.direction,
      lockEdit: s.lockEdit,
      blocks: s.blocks,
      intensity: s.intensity,
      clipMode: s.clipMode,
      rollStyle: s.rollStyle,
      clipLooks: s.clipLooks,
      evolveAmt: s.evolveAmt,
      evolveCuts: s.evolveCuts,
      rebound: s.rebound,
      fitAll: s.fitAll,
      clipFrame: s.clipFrame,
      gridNudge: s.gridNudge,
      exportOpts: s.exportOpts,
    };
  }

  function writeSession() {
    saveTimer = undefined;
    const s = store.getState();
    try {
      storage?.setItem(
        KEY,
        JSON.stringify({
          ...editState(),
          // an older session's cuts that haven't been turned into blocks yet, kept until they are
          ...(s.legacyEdit || {}),
          saved: s.saved,
          snap: s.snap,
          hud: s.hud,
          safe: s.safe,
          muted: s.muted,
          tab: s.tab,
          mode: s.transport.mode,
          rollOpts: s.rollOpts,
        }),
      );
      sessionSaveFailed = false;
    } catch {
      if (!sessionSaveFailed) toast('This edit is too large for browser session storage. Save it as a named project to keep it.', 6000);
      sessionSaveFailed = true;
    }
    // the open project's file follows the session
    void syncProject();
  }

  /** Writes a session save that's waiting on its timer now. */
  function flushSave() {
    if (saveTimer === undefined) return;
    clearTimeout(saveTimer);
    writeSession();
  }

  function flushSession() {
    flushSave();
    // the page is going away, so a project write still waiting on the one before it goes now
    flushProject();
  }

  /** Persist pending edits on page lifecycle events; the React owner releases both listeners. */
  function connectPersistence() {
    const onVisibilityChange = () => { if (document.visibilityState === 'hidden') flushSession(); };
    window.addEventListener('pagehide', flushSession);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushSession);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushSave();
      flushHistory();
    };
  }

  function dispose() {
    clearTimeout(saveTimer);
    clearTimeout(histTimerId);
    histListeners.clear();
  }

  function save() {
    markEdited();
    const s = store.getState();
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
      trimHistory(histList);
      futList.length = 0;
    }
    histLastSnap = snap;
    histChanged();
  }

  /** Starts the undo history over at the current state. */
  function resetHistory() {
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

  function restore(): any {
    try {
      return JSON.parse(storage?.getItem(KEY) || storage?.getItem(LEGACY_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function snapshot(): string {
    return JSON.stringify({ ...editState(), editClip: store.getState().editClip });
  }

  function applySnapshot(snap: string) {
    histMutedFlag = true;
    const data = JSON.parse(snap);
    if (data.blocks) data.blocks = sanitizeBlockLooks(data.blocks);
    if (data.look) data.look = sanitizeLutLook(data.look);
    if (data.clipLooks && typeof data.clipLooks === 'object') {
      data.clipLooks = Object.fromEntries(Object.entries(data.clipLooks).map(([id, look]) => [id, sanitizeLutLook(look as Look)]));
    }
    const before = store.getState();
    // Another song, or another tempo for this one, means analysing the song again.
    const reanalyze = data.trackId !== before.trackId || data.bpmOverride?.[data.trackId] !== before.bpmOverride[data.trackId];
    store.setState(data);
    const s = store.getState();
    if (s.engine?.main) s.engine.main.reset();
    s.rebuild();
    histMutedFlag = false;
    // Sanitizing damaged imported history changes the state we actually restored, so remember that
    // valid state rather than letting the rejected bytes become the base of the next undo step.
    histLastSnap = snapshot();
    if (reanalyze) void reloadSong(data);
  }

  // Loading a song picks its own loop, so the snapshot's loop goes back on once the analysis is in.
  async function reloadSong(data: { trackId: string; loopStart: number; bars: number; blocks: any }) {
    await store.getState().selectTrack(data.trackId, { keepLoop: true });
    const s = store.getState();
    if (s.trackId !== data.trackId) return; // another song was picked meanwhile
    histMutedFlag = true;
    store.setState({ loopStart: data.loopStart, bars: data.bars, blocks: data.blocks });
    s.rebuild();
    histMutedFlag = false;
  }

  function undo() {
    flushHistory();
    const snap = snapshot();
    if (!histList.length) {
      toast('Nothing to undo');
      return;
    }
    futList.push(snap);
    trimHistory(futList);
    const prev = histList.pop()!;
    applySnapshot(prev);
    histChanged();
    toast('↶ Undo');
  }

  function redo() {
    flushHistory();
    const snap = snapshot();
    if (!futList.length) {
      toast('Nothing to redo');
      return;
    }
    histList.push(snap);
    trimHistory(histList);
    const next = futList.pop()!;
    applySnapshot(next);
    histChanged();
    toast('↷ Redo');
  }

  // Rolled, random and variation looks aren't in LOOKS, so Revert needs the copy they started as.
  const originals = new Map<string, string>();

  function rememberLook(l: Look) {
    if (originals.has(l.id)) return;
    originals.set(l.id, JSON.stringify(l));
    if (originals.size > 200) originals.delete(originals.keys().next().value!);
  }

  function originalLook(id: string): Look | null {
    const s = store.getState();
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
    const s = store.getState();
    if (!s.look || !s.lookId || s.lookId.startsWith('edit:')) return;
    const base = originalLook(s.lookId);
    if (base && visuals(base) !== visuals(s.look)) store.setState({ lookId: `edit:${s.lookId}` });
  }

  function saveLook(name?: string) {
    const s = store.getState();
    const target = s.editLook();
    if (!target) return;
    const lookName = name || target.name;
    const l = cloneLook(target);
    if (target !== s.look && s.look && !s.editBlock) {
      l.camera = JSON.parse(JSON.stringify(s.look.camera));
      l.finish = JSON.parse(JSON.stringify(s.look.finish));
      l.cut = JSON.parse(JSON.stringify(s.look.cut));
    }
    l.id = `mine-${Date.now()}`;
    l.name = lookName;
    l.vibe = l.layers.map((x) => MODULES[x.m]?.name).filter(Boolean).join(' + ') || 'Clean grade';
    l.mine = true;
    store.setState((prev) => ({ saved: [l, ...prev.saved] }));
    s.save();
    toast(`Saved ${lookName} to Your looks`);
  }

  return { subscribeHistory, historyDepth, editState, flushSave, save, resetHistory, restore, snapshot, applySnapshot, undo, redo, rememberLook, originalLook, saveLook, connectPersistence, dispose };
}

export type HistoryController = ReturnType<typeof createHistoryController>;
