import { useStudioStore } from './store.ts';
import { toast } from './utils.ts';
import { LOOKS, cloneLook } from '../looks.ts';
import { MODULES } from '../modules.ts';
import type { Look } from '../types.ts';

const KEY = 'downbeat.studio.v1';
// Saved before the Canvas Forge → Downbeat rename; read once so nobody loses their session.
const LEGACY_KEY = 'canvasforge.studio.v1';

const histList: string[] = [];
const futList: string[] = [];
let histLastSnap: string | null = null;
let histTimerId: ReturnType<typeof setTimeout> | undefined;
let histMutedFlag = false;

export function save() {
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
        customCuts: s.customCuts,
        segOverrides: s.segOverrides,
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
        rollOpts: s.rollOpts,
        clipFrame: s.clipFrame,
        gridNudge: s.gridNudge,
      }),
    );
  } catch {
    /* session storage only */
  }
  if (!histMutedFlag && s.look) {
    clearTimeout(histTimerId);
    histTimerId = setTimeout(() => {
      const snap = snapshot();
      if (histLastSnap !== null && snap !== histLastSnap) {
        histList.push(histLastSnap);
        if (histList.length > 100) histList.shift();
        futList.length = 0;
      }
      histLastSnap = snap;
    }, 350);
  }
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
    selected: s.selected,
    loopStart: s.loopStart,
    bars: s.bars,
    customCuts: s.customCuts,
    segOverrides: s.segOverrides,
    clipFrame: s.clipFrame,
  });
}

export function applySnapshot(snap: string) {
  histMutedFlag = true;
  const data = JSON.parse(snap);
  useStudioStore.setState(data);
  const s = useStudioStore.getState();
  if (s.engine?.main) s.engine.main.reset();
  s.rebuild();
  histMutedFlag = false;
  histLastSnap = snap;
}

export function undo() {
  const s = useStudioStore.getState();
  const snap = snapshot();
  if (!histList.length) {
    toast('Nothing to undo');
    return;
  }
  futList.push(snap);
  const prev = histList.pop()!;
  applySnapshot(prev);
  toast('↶ Undo');
}

export function redo() {
  const s = useStudioStore.getState();
  const snap = snapshot();
  if (!futList.length) {
    toast('Nothing to redo');
    return;
  }
  histList.push(snap);
  const next = futList.pop()!;
  applySnapshot(next);
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
