import { createStore, type StoreApi } from 'zustand/vanilla';
import { browserStorage } from '../lib/storage.ts';

export const DEFAULT_LAYOUT = { library: 264, inspector: 344, timeline: 264 };
export type PanelSize = keyof typeof DEFAULT_LAYOUT;
export const PANEL_LIMITS: Record<PanelSize, [number, number]> = {
  library: [220, 400], inspector: [304, 460], timeline: [236, 440],
};
const STORAGE_KEY = 'downbeat.workspace.v1';
const bounded = (key: PanelSize, value: unknown) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(PANEL_LIMITS[key][0], Math.min(PANEL_LIMITS[key][1], value)) : DEFAULT_LAYOUT[key];

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;

function readLayout(storage: LayoutStorage | null) {
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
    return Object.fromEntries(Object.keys(DEFAULT_LAYOUT).map((key) => [key, bounded(key as PanelSize, saved?.[key])])) as typeof DEFAULT_LAYOUT;
  } catch { return { ...DEFAULT_LAYOUT }; }
}

export interface Workspace {
  layout: typeof DEFAULT_LAYOUT;
  focus: boolean;
  commands: boolean;
  resize: (panel: PanelSize, value: number, persist?: boolean) => void;
  resetLayout: () => void;
  toggleFocus: () => void;
  setCommands: (open: boolean) => void;
}

/** Workspace preferences stay separate from creative edits and undo history. */
export function createWorkspaceStore(storage: LayoutStorage | null = browserStorage()) {
  const persistLayout = (layout: typeof DEFAULT_LAYOUT) => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* Layout remains usable when storage is full. */ }
  };
  return createStore<Workspace>((set, get) => ({
    layout: readLayout(storage), focus: false, commands: false,
    resize: (panel, value, persist = true) => {
      const layout = { ...get().layout, [panel]: bounded(panel, value) };
      set({ layout });
      if (persist) persistLayout(layout);
    },
    resetLayout: () => { const layout = { ...DEFAULT_LAYOUT }; set({ layout, focus: false }); persistLayout(layout); },
    toggleFocus: () => set((s) => ({ focus: !s.focus })),
    setCommands: (commands) => set({ commands }),
  }));
}

export type WorkspaceStore = StoreApi<Workspace>;
export const workspaceStore = createWorkspaceStore();
