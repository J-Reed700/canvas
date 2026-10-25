import { createContext, useContext, useMemo, useEffect, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createSegmentMenu } from '../components/SegmentMenu/segmentMenu.ts';
import type { StudioRuntime } from './store.ts';
import type { StudioState } from './storeTypes.ts';
import type { Workspace, WorkspaceStore } from './workspaceStore.ts';

interface StudioDependencies {
  runtime: StudioRuntime;
  workspace: WorkspaceStore;
}

function useCreateStudioElements() {
  const view = useRef<HTMLCanvasElement>(null);
  const videoBank = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  return useMemo(() => ({ view, videoBank, fileInput }), []);
}

const StudioContext = createContext<(StudioDependencies & {
  menus: ReturnType<typeof createSegmentMenu>;
  elements: ReturnType<typeof useCreateStudioElements>;
}) | null>(null);

/** Inject stable store and service instances; state subscriptions stay in selector hooks. */
export function StudioProvider({ runtime, workspace, children }: StudioDependencies & { children: ReactNode }) {
  const elements = useCreateStudioElements();
  const menus = useMemo(() => createSegmentMenu(runtime.store, runtime.preview), [runtime]);
  useEffect(() => () => menus.dispose(), [menus]);
  const value = useMemo(() => ({ runtime, workspace, menus, elements }), [runtime, workspace, menus, elements]);
  return <StudioContext value={value}>{children}</StudioContext>;
}

function useStudioDependencies() {
  const dependencies = useContext(StudioContext);
  if (!dependencies) throw new Error('Studio components must be rendered inside a StudioProvider.');
  return dependencies;
}

export const useStudioRuntime = () => useStudioDependencies().runtime;
export const useStudioApi = () => useStudioRuntime().store;
export const useWorkspaceApi = () => useStudioDependencies().workspace;

export function useStudioStore<T>(selector: (state: StudioState) => T) {
  return useStore(useStudioApi(), selector);
}

export function useWorkspaceStore<T>(selector: (state: Workspace) => T) {
  return useStore(useWorkspaceApi(), selector);
}

// The renderer reads mutable look data every frame; touch() publishes those edits to React.
export const useVersion = () => useStudioStore((state) => state.version);

export const useSegmentMenu = () => useStudioDependencies().menus;
export const useStudioElements = () => useStudioDependencies().elements;
