import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { createStudioRuntime, type StudioOptions, type StudioRuntime } from '../../downbeat/studio/src/state/store.ts';
import { createWorkspaceStore } from '../../downbeat/studio/src/state/workspaceStore.ts';
import { StudioProvider, useStudioApi, useStudioElements, useStudioStore, useWorkspaceStore } from '../../downbeat/studio/src/state/StudioContext.tsx';
import { useStudioLifecycle } from '../../downbeat/studio/src/hooks/useStudioLifecycle.ts';
import { useWindowEvent } from '../../downbeat/studio/src/hooks/useWindowEvent.ts';
import { CommandMenu } from '../../downbeat/studio/src/components/CommandMenu/CommandMenu.tsx';
import { ParamRow } from '../../downbeat/studio/src/components/ParamRow/ParamRow.tsx';
import { SliderRow } from '../../downbeat/studio/src/components/SliderRow/SliderRow.tsx';
import { usePage } from '../../downbeat/studio/src/hooks/usePage.ts';
import { WorkspaceLayout } from '../../downbeat/studio/src/components/WorkspaceLayout/WorkspaceLayout.tsx';
import { LOOKS, cloneLook } from '../../downbeat/studio/src/engine/looks.ts';
import { CAMERA } from '../../downbeat/studio/src/engine/modules.ts';
import type { Engine } from '../../downbeat/studio/src/engine/engine.ts';
import type { VideoBank } from '../../downbeat/studio/src/engine/composer.ts';
import { CLIPS, serve } from './studio.tsx';

const runtimes: StudioRuntime[] = [];
function studio(options: StudioOptions = {}) {
  const runtime = createStudioRuntime({ storage: null, ...options });
  runtimes.push(runtime);
  runtime.store.setState({ clips: CLIPS, selected: ['a', 'b'], look: cloneLook(LOOKS[0]), lookId: LOOKS[0].id });
  runtime.store.getState().rebuild();
  runtime.history.resetHistory();
  return runtime;
}

afterEach(() => {
  cleanup();
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
});

function Counter({ name, rendered }: { name: string; rendered?: () => void }) {
  const store = useStudioApi();
  const bars = useStudioStore((s) => s.bars);
  const focus = useWorkspaceStore((s) => s.focus);
  rendered?.();
  return <button aria-label={name} onClick={() => store.getState().setBars(bars + 1)}>{bars}:{String(focus)}</button>;
}

test('providers isolate state and actions, and selectors skip unrelated updates', () => {
  const first = studio(), second = studio();
  const firstWorkspace = createWorkspaceStore(null), secondWorkspace = createWorkspaceStore(null);
  const rendered = vi.fn();
  render(<>
    <StudioProvider runtime={first} workspace={firstWorkspace}><Counter name="First studio" rendered={rendered} /></StudioProvider>
    <StudioProvider runtime={second} workspace={secondWorkspace}><Counter name="Second studio" /></StudioProvider>
  </>);
  const initialRenders = rendered.mock.calls.length;
  act(() => first.store.setState({ helpOpen: true }));
  expect(rendered).toHaveBeenCalledTimes(initialRenders);
  fireEvent.click(screen.getByLabelText('First studio'));
  act(() => secondWorkspace.getState().toggleFocus());
  expect(screen.getByLabelText('First studio').textContent).toBe('5:false');
  expect(screen.getByLabelText('Second studio').textContent).toBe('4:true');
  expect(second.store.getState().bars).toBe(4);
});

test('resizing the workspace updates its container without re-rendering unchanged panels', () => {
  const runtime = studio(), workspace = createWorkspaceStore(null);
  const rendered = vi.fn();
  const view = render(<StudioProvider runtime={runtime} workspace={workspace}><WorkspaceLayout><Counter name="Panel" rendered={rendered} /></WorkspaceLayout></StudioProvider>);
  const initialRenders = rendered.mock.calls.length;
  act(() => workspace.getState().resize('library', 320));
  expect(view.container.querySelector<HTMLElement>('.app')!.style.getPropertyValue('--library-width')).toBe('320px');
  expect(rendered).toHaveBeenCalledTimes(initialRenders);
});

test('history, per-segment looks and session persistence belong to their runtime', () => {
  const firstStorage = new Map<string, string>(), secondStorage = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  const first = studio({ storage: storage(firstStorage) }), second = studio({ storage: storage(secondStorage) });
  const segment = first.store.getState().ctx!.tl.segs[0];
  first.inspector.editBlockLook(segment.id);
  first.store.getState().writableLook().name = 'Only in the first studio';
  first.store.getState().setBars(8);
  first.history.flushSave();
  second.history.flushSave();
  expect(first.history.restore().bars).toBe(8);
  expect(second.history.restore().bars).toBe(4);
  first.history.undo();
  expect(first.store.getState().bars).toBe(4);
  expect(first.history.historyDepth().redo).toBe(1);
  expect(second.history.historyDepth()).toEqual({ undo: 0, redo: 0 });
  expect(second.store.getState().look!.name).toBe(LOOKS[0].name);
  expect(second.store.getState().blocks).toBeNull();
});

test('event subscriptions read the latest callback and release it on unmount', () => {
  const seen = vi.fn();
  function Listener({ value }: { value: number }) {
    useWindowEvent('keydown', () => seen(value));
    return null;
  }
  const view = render(<StrictMode><Listener value={1} /></StrictMode>);
  fireEvent.keyDown(window, { key: 'a' });
  view.rerender(<StrictMode><Listener value={2} /></StrictMode>);
  fireEvent.keyDown(window, { key: 'b' });
  view.unmount();
  fireEvent.keyDown(window, { key: 'c' });
  expect(seen.mock.calls).toEqual([[1], [2]]);
});

function StudioHost() {
  const elements = useStudioElements();
  useStudioLifecycle();
  return <><canvas ref={elements.view} /><div ref={elements.videoBank} /></>;
}

test('Strict Mode startup uses owned DOM refs and cleans up each initialization', async () => {
  const runtime = studio();
  const initStudio = vi.fn(async () => {});
  const disposeStudio = vi.fn(runtime.store.getState().disposeStudio);
  runtime.store.setState({ initStudio, disposeStudio });
  const view = render(<StrictMode><StudioProvider runtime={runtime} workspace={createWorkspaceStore(null)}><StudioHost /></StudioProvider></StrictMode>);
  await act(async () => {});
  expect(initStudio).toHaveBeenCalledTimes(2);
  expect(initStudio.mock.calls[0]).toEqual([view.container.querySelector('canvas'), view.container.querySelector('div')]);
  expect(disposeStudio).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(disposeStudio).toHaveBeenCalledTimes(2);
});

function browserResources() {
  const engine = { warmup: vi.fn(), dispose: vi.fn(), main: { reset: vi.fn() } };
  const bank = { clear: vi.fn(), sync: vi.fn() };
  return { engine, bank, options: {
    createEngine: () => engine as unknown as Engine,
    createVideoBank: () => bank as unknown as VideoBank,
  } };
}

test('stopping during startup discards late server data and releases GPU and video resources', async () => {
  const resources = browserResources();
  const runtime = studio(resources.options);
  let finish!: (value: unknown) => void;
  serve({ '/api/state': () => new Promise((resolve) => { finish = resolve; }) });
  const renderLoop = vi.spyOn(runtime.preview, 'startRenderLoop');
  const opening = runtime.store.getState().initStudio(document.createElement('canvas'), document.createElement('div'));
  runtime.store.getState().disposeStudio();
  finish({ clips: [], tracks: [], renders: [] });
  await opening;
  expect(resources.engine.dispose).toHaveBeenCalledOnce();
  expect(resources.bank.clear).toHaveBeenCalledOnce();
  expect(runtime.store.getState().engine).toBeNull();
  expect(runtime.store.getState().clips).toBe(CLIPS);
  expect(renderLoop).not.toHaveBeenCalled();
});

test('completed startup releases rendering, polling, persistence listeners and store subscriptions', async () => {
  const resources = browserResources();
  const runtime = studio(resources.options);
  serve({ '/api/state': () => ({ clips: CLIPS, tracks: [], renders: [] }), '/api/projects': () => ({ projects: [] }) });
  const stopRendering = vi.fn(), stopPolling = vi.fn(), stopPersistence = vi.fn();
  vi.spyOn(runtime.preview, 'startRenderLoop').mockReturnValue(stopRendering);
  vi.spyOn(runtime.preview, 'pollProxies').mockReturnValue(stopPolling);
  vi.spyOn(runtime.history, 'connectPersistence').mockReturnValue(stopPersistence);
  const requestProxies = vi.spyOn(runtime.media, 'requestProxies').mockResolvedValue();
  await runtime.store.getState().initStudio(document.createElement('canvas'), document.createElement('div'));
  runtime.store.setState({ selected: ['b'] });
  expect(requestProxies).toHaveBeenCalledTimes(2);
  runtime.store.getState().disposeStudio();
  runtime.store.setState({ selected: ['a'] });
  expect(requestProxies).toHaveBeenCalledTimes(2);
  expect(stopRendering).toHaveBeenCalledOnce();
  expect(stopPolling).toHaveBeenCalledOnce();
  expect(stopPersistence).toHaveBeenCalledOnce();
});

test('proxy polling ignores responses arriving after it stops', async () => {
  vi.useFakeTimers();
  const runtime = studio();
  runtime.store.setState({ clips: [{ ...CLIPS[0], proxy: 'building' }] });
  let finish!: (value: unknown) => void;
  serve({ '/api/state': () => new Promise((resolve) => { finish = resolve; }) });
  const stop = runtime.preview.pollProxies();
  act(() => vi.advanceTimersByTime(2500));
  stop();
  finish({ clips: [{ ...CLIPS[0], proxy: 'ready' }] });
  await act(async () => {});
  expect(runtime.store.getState().clips[0].proxy).toBe('building');
});

test('the open command menu follows selection, guides and undo history updates', () => {
  const runtime = studio(), workspace = createWorkspaceStore(null);
  workspace.getState().setCommands(true);
  render(<StudioProvider runtime={runtime} workspace={workspace}><CommandMenu /></StudioProvider>);
  const menu = within(screen.getByRole('dialog', { name: 'Command menu' }));
  expect(menu.getByRole('option', { name: /Undo edit/ }).getAttribute('aria-disabled')).toBe('true');
  act(() => {
    runtime.store.getState().setBars(8);
    runtime.history.undo();
    runtime.store.setState({ selected: [], safe: true });
  });
  expect(menu.getByRole('option', { name: /Redo edit/ }).getAttribute('aria-disabled')).toBe('false');
  expect(menu.getByRole('option', { name: /Export canvas/ }).getAttribute('aria-disabled')).toBe('true');
  expect(menu.getByRole('option', { name: /Hide safe zones/ })).toBeTruthy();
});

test('parameter markers release their readers when replaced or unmounted', () => {
  const runtime = studio(), workspace = createWorkspaceStore(null);
  const p = CAMERA.params.find((p) => !p.opts)!;
  const holder = { p: { [p.id]: p.def } };
  const renderRow = (value: number) => <StudioProvider runtime={runtime} workspace={workspace}><ParamRow p={p} holder={holder} readLive={() => value} /></StudioProvider>;
  const view = render(renderRow(1));
  expect(runtime.store.getState().ghosts).toHaveLength(1);
  view.rerender(renderRow(2));
  expect(runtime.store.getState().ghosts).toHaveLength(1);
  expect(runtime.store.getState().ghosts[0].read({} as never)).toBe(2);
  expect(holder).not.toHaveProperty('mods');
  view.unmount();
  expect(runtime.store.getState().ghosts).toHaveLength(0);
});

test('reusable slider rows have unique accessible labels and reset values', () => {
  const changed = vi.fn();
  const props = { min: 0, max: 1, step: 0.1, value: 0.5, def: 0.2, output: '50%', onChange: changed };
  render(<><SliderRow label="Intensity" {...props} /><SliderRow label="Mix" {...props} /></>);
  const intensity = screen.getByRole('slider', { name: 'Intensity' });
  const mix = screen.getByRole('slider', { name: 'Mix' });
  expect(intensity.id).not.toBe(mix.id);
  fireEvent.doubleClick(intensity);
  expect(changed).toHaveBeenCalledWith(0.2);
});

test('switching library filters resets pagination even when returning to a previous search', () => {
  function LibraryPages({ filter }: { filter: string }) {
    const [page, , setPage] = usePage(100, 10, filter);
    return <button onClick={() => setPage(3)}>Page {page + 1}</button>;
  }
  const view = render(<LibraryPages filter="all" />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('button').textContent).toBe('Page 4');
  view.rerender(<LibraryPages filter="video" />);
  expect(screen.getByRole('button').textContent).toBe('Page 1');
  view.rerender(<LibraryPages filter="all" />);
  expect(screen.getByRole('button').textContent).toBe('Page 1');
});
