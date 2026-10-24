// Shared setup for the component tests: a known studio state, the page-level elements panels expect
// (#pop and #toast), and a small fetch router.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { useStudioStore } from '../../downbeat/studio/src/state/store.ts';
import { LOOKS, cloneLook } from '../../downbeat/studio/src/engine/looks.ts';
import type { StudioState } from '../../downbeat/studio/src/state/store.ts';

export const S = useStudioStore;
export const st = () => S.getState();
export { LOOKS, cloneLook };

export const CLIPS = [
  { id: 'a', name: '1 sunrise.mp4', duration: 12, width: 1080, height: 1920, proxy: 'ready' },
  { id: 'b', name: 'city.mp4', duration: 9, width: 1920, height: 1080, proxy: 'ready' },
  { id: 'c', name: 'cover.still.mp4', duration: 20, width: 1080, height: 1080, still: true, proxy: 'ready' },
];

// A 3-minute song at 120 BPM: a bar every 2 s, the first downbeat at 1.5 s.
export const SONG = {
  id: 't1',
  duration: 180,
  fps: 30,
  bpm: 120,
  bpm_source: 'detected',
  downbeats: Array.from({ length: 89 }, (_, i) => 1.5 + i * 2),
  loops: [
    { start: 33.5, label: 'Drop' },
    { start: 65.5, label: 'Peak' },
  ],
  loop_bars: 4,
  peaks: Array(100).fill(0.4),
};

export const TRACKS = [
  { id: 't1', name: 'Night Drive.wav', path: '/Users/me/Downloads/Night Drive.wav', source: 'downloads', dir: '', mtime: 3 },
  { id: 't2', name: 'Sunrise.mp3', path: '/Users/me/Downloads/Sunrise.mp3', source: 'downloads', dir: '', mtime: 2 },
];

/** Resets the store to three clips on the first studio look, no song, 4 bars at 120 BPM, then rebuilds. */
export function resetStudio(over: Partial<StudioState> = {}) {
  act(() => {
    st().transport.pause();
    S.setState({
      clips: CLIPS.map((c) => ({ ...c })),
      tracks: [],
      renders: [],
      selected: ['a', 'b', 'c'],
      look: cloneLook(LOOKS[0]),
      lookId: LOOKS[0].id,
      saved: [],
      features: null,
      trackId: '',
      bars: 4,
      loopStart: 0,
      bpmManual: 120,
      bpmOverride: {},
      gridNudge: {},
      seed: 2026,
      direction: 'forward',
      lockEdit: false,
      intensity: 1,
      clipMode: 'one',
      clipLooks: {},
      editClip: null,
      customCuts: null,
      segOverrides: {},
      clipFrame: {},
      palettes: {},
      tab: 'layers',
      hud: true,
      safe: false,
      muted: false,
      exporting: false,
      exportOpen: false,
      varOpen: false,
      helpOpen: false,
      libraryOpen: false,
      libraryItem: null,
      exportFilter: { q: '', kind: 'all', sort: 'new' },
      exportOpts: { size: 'master', audio: true, format: 'spotify', promo: 0, autoSave: true },
      rollOpts: { look: true, edit: true, perClip: true, clips: false, loop: false },
      ghosts: [],
      ...over,
    });
    st().rebuild();
  });
}

export const withSong = (over: Partial<StudioState> = {}) =>
  resetStudio({ features: structuredClone(SONG), trackId: 't1', tracks: TRACKS.map((t) => ({ ...t })), loopStart: 33.5, ...over });

/** Renders a panel with the popover and toast elements that the page normally provides. */
export function renderStudio(ui: React.ReactElement) {
  return render(
    <>
      {ui}
      <div className="pop" id="pop" />
      <div className="toast" id="toast" />
    </>,
  );
}

export const toastText = () => document.getElementById('toast')?.textContent || '';
export const pop = () => document.getElementById('pop') as HTMLElement;
export const popButtons = () => Array.from(pop().querySelectorAll('button')).map((b) => b.textContent || '');
export const popButton = (text: string | RegExp) =>
  Array.from(pop().querySelectorAll('button')).find((b) => (typeof text === 'string' ? b.textContent === text : text.test(b.textContent || ''))) as HTMLButtonElement;

/** Store changes made outside an event handler must be wrapped so React applies them. */
export const update = (fn: () => void) => act(fn);

type Handler = (url: string, init: RequestInit) => unknown;
/**
 * Routes fetch: keys are "METHOD /path", or "/path" for GET, and a trailing * matches a prefix.
 * Returns the mock so tests can look at the requests.
 */
export function serve(routes: Record<string, Handler>) {
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = String(url).split('?')[0];
    const key = `${method} ${path}`;
    const full = (k: string) => (/^[A-Z]+ /.test(k) ? k : `GET ${k}`);
    const handler =
      routes[key] || (method === 'GET' ? routes[path] : undefined) ||
      Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(full(k).slice(0, -1)))?.[1];
    if (!handler) return new Response(JSON.stringify({ ok: false, error: `no route for ${key}` }), { status: 404 });
    const out = await handler(String(url), init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The JSON bodies posted to a path. */
export const posted = (fn: ReturnType<typeof serve>, path: string) =>
  fn.mock.calls.filter(([u, i]) => String(u).split('?')[0] === path && (i?.method || 'GET') === 'POST').map(([, i]) => JSON.parse(String(i?.body)));

export { screen };
