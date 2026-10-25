import React from 'react';
import { describe, expect, test } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { ClipsLibrary } from '../../downbeat/studio/src/components/ClipsLibrary/ClipsLibrary.tsx';
import { MediaPanel } from '../../downbeat/studio/src/components/MediaPanel/MediaPanel.tsx';
import { CLIPS, posted, renderStudio, resetStudio, screen, serve, st, toastText } from './studio.tsx';

const FOLDERED = [
  { ...CLIPS[0], source: '/Users/me/Movies/Canvas', dir: 'Summer', path: '/Users/me/Movies/Canvas/Summer/1 sunrise.mp4', fps: 30 },
  { ...CLIPS[1], source: '/Users/me/Movies/Canvas', dir: '', path: '/Users/me/Movies/Canvas/city.mp4', fps: 24 },
  { ...CLIPS[2], source: 'added', dir: '', path: '/tmp/out/uploads/cover.still.mp4' },
];
const caps = () => Array.from(document.querySelectorAll('#clips .clip .cap')).map((c) => c.textContent);
const search = () => document.querySelector('.clip-find input') as HTMLInputElement;
const chip = (label: RegExp) => within(document.querySelector('.clip-find .exp-kinds') as HTMLElement).getByText(label);

describe('clips panel', () => {
  test('search narrows the clips shown, Escape clears it, and the count says how many are shown', () => {
    resetStudio({ clips: FOLDERED as any, selected: ['a', 'b'] });
    renderStudio(<MediaPanel />);
    expect(caps()).toHaveLength(3);
    const poster = document.querySelector<HTMLElement>('#clips .clip .clip-media')!;
    expect(poster.dataset.thumb).toBe('/api/thumb/a?w=320');
    expect(document.querySelector('#clips .clip')!.getAttribute('role')).toBe('group');
    fireEvent.change(search(), { target: { value: 'summer' } });
    expect(caps()).toEqual(['12.0s · 1 sunrise.mp4']);
    expect(document.getElementById('clipCount')!.textContent).toBe('1 of 3 shown');
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(st().clipFilter.q).toBe('');
    expect(document.getElementById('clipCount')!.textContent).toBe('2 of 3 in the edit');
  });

  test('chips pick the clips in the edit or the stills, and a search with no match offers to clear it', () => {
    resetStudio({ clips: FOLDERED as any, selected: ['b'] });
    renderStudio(<MediaPanel />);
    const chips = Array.from(document.querySelectorAll('.clip-find .exp-kinds button')).map((b) => b.textContent);
    expect(chips).toEqual(['All 3', 'In the edit 1', 'Videos 2', 'Stills 1']);
    fireEvent.click(chip(/^In the edit/));
    expect(caps()).toEqual(['9.0s · city.mp4']);
    fireEvent.click(chip(/^Stills/));
    expect(caps()).toEqual(['Still · cover']);
    fireEvent.change(search(), { target: { value: 'nothing like this' } });
    expect(screen.getByText(/No clips match/)).toBeTruthy();
    fireEvent.click(screen.getByText('Clear search'));
    expect(caps()).toHaveLength(3);
    expect(st().clipFilter).toEqual({ q: '', kind: 'all', sort: 'folder' });
  });

  test('the panel keeps the edit order whatever the browser sorts by', () => {
    resetStudio({ clips: FOLDERED as any, selected: ['c', 'a'], clipFilter: { q: '', kind: 'all', sort: 'name' } });
    renderStudio(<MediaPanel />);
    expect(caps()).toEqual(['Still · cover', '12.0s · 1 sunrise.mp4', '9.0s · city.mp4']);
  });

  test('Browse opens the clips browser; with no clips there is nothing to search or browse', () => {
    resetStudio({ clips: FOLDERED as any });
    renderStudio(<MediaPanel />);
    fireEvent.click(document.getElementById('btnBrowseClips')!);
    expect([st().clipsOpen, st().clipsItem]).toEqual([true, null]);
    resetStudio({ clips: [], selected: [] });
    renderStudio(<MediaPanel />);
    expect(document.getElementById('btnBrowseClips')).toBeNull();
    expect(document.querySelector('.clip-find')).toBeNull();
  });
});

describe('clips browser', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `clip ${i + 1}.mp4`, duration: i + 1, width: 1920, height: 1080, proxy: 'ready' }));
  const cards = () => Array.from(document.querySelectorAll<HTMLElement>('.clip-card'));
  const names = () => cards().map((c) => c.querySelector('.lib-cap b')!.textContent);
  const viewer = () => document.querySelector('.lib-view') as HTMLElement;
  const summary = () => Array.from(viewer().querySelectorAll('.summary b')).map((b) => b.textContent);
  const key = (k: string, target: EventTarget = window) => fireEvent.keyDown(target, { key: k });

  test('shows 24 clips a page, each with its length, size and folder', () => {
    resetStudio({ clips: many as any, selected: ['m1'], clipsOpen: true });
    renderStudio(<ClipsLibrary />);
    expect(cards()).toHaveLength(24);
    expect(document.querySelector('.lib-foot .muted')!.textContent).toBe('1–24 of 30');
    expect(document.querySelector('.modal.lib .sub')!.textContent).toBe('30 clips · 1 in the edit');
    expect(Array.from(cards()[1].querySelectorAll('.lib-cap span')).map((s) => s.textContent)).toEqual(['2.0 s · 1920×1080', 'Landscape']);
    expect(cards()[1].querySelector('.num')!.textContent).toBe('1');
    expect(cards()[0].querySelector('.num')).toBeNull();
    key('ArrowRight');
    expect(cards()).toHaveLength(6);
  });

  test('+ adds a clip to the edit and ✓ takes it out, and the card stays where it is', () => {
    resetStudio({ clips: FOLDERED as any, selected: ['b'], clipsOpen: true });
    renderStudio(<ClipsLibrary />);
    expect(names()).toEqual(['1 sunrise.mp4', 'city.mp4', 'cover']);
    expect(Array.from(cards()[0].querySelectorAll('.lib-cap span')).map((s) => s.textContent)).toEqual(['12.0 s · 1080×1920 · 30 fps', 'Canvas › Summer']);
    fireEvent.click(screen.getByLabelText('Add cover to the edit'));
    expect(st().selected).toEqual(['b', 'c']);
    expect(names(), 'folder order').toEqual(['1 sunrise.mp4', 'city.mp4', 'cover']);
    expect(cards()[2].querySelector('.num')!.textContent).toBe('2');
    fireEvent.click(screen.getByLabelText('Take city.mp4 out of the edit'));
    expect(st().selected).toEqual(['c']);
    expect(st().clipsItem, 'the toggle does not open the clip').toBeNull();
  });

  test('sorting and search change the grid, and the search is the one the panel uses', () => {
    resetStudio({ clips: FOLDERED as any, selected: ['c', 'a'], clipsOpen: true });
    renderStudio(<ClipsLibrary />);
    fireEvent.change(document.querySelector('.lib-bar select')!, { target: { value: 'edit' } });
    expect(names()).toEqual(['cover', '1 sunrise.mp4', 'city.mp4']);
    fireEvent.change(document.querySelector('.lib-bar select')!, { target: { value: 'short' } });
    expect(names()).toEqual(['city.mp4', '1 sunrise.mp4', 'cover']);
    fireEvent.change(document.querySelector('.lib-bar input')!, { target: { value: 'added' } });
    expect(names()).toEqual(['cover']);
    expect(st().clipFilter.q).toBe('added');
  });

  test('the viewer shows a clip with its details and steps through the list', () => {
    resetStudio({ clips: FOLDERED as any, selected: ['b'], clipsOpen: true });
    renderStudio(<ClipsLibrary />);
    fireEvent.click(cards()[0].querySelector('.lib-open')!);
    expect(viewer().querySelector('h3')!.textContent).toBe('1 sunrise.mp4');
    expect(viewer().querySelector('video')!.getAttribute('src')).toBe('/api/proxy/a');
    expect(summary()).toEqual(['Video', '1080 × 1920 · Vertical', '12.0 s · 30 fps', 'Canvas › Summer', 'No']);
    expect(viewer().querySelector('.lib-file')!.textContent).toBe('~/Movies/Canvas/Summer/1 sunrise.mp4');
    key('ArrowRight');
    expect(viewer().querySelector('h3')!.textContent).toBe('city.mp4');
    expect(summary(), 'one look for every clip, so no look row').toEqual(['Video', '1920 × 1080 · Landscape', '9.0 s · 24 fps', 'Canvas', 'Clip 1 of 1']);
    key('ArrowRight');
    expect(summary()).toEqual(['Still image', '1080 × 1080 · Square', 'Added in the studio', 'No']);
    expect((screen.getByTitle('Next clip (→)') as HTMLButtonElement).disabled).toBe(true);
    key('Escape');
    expect(viewer()).toBeNull();
    expect(st().clipsOpen).toBe(true);
    key('Escape');
    expect(st().clipsOpen).toBe(false);
  });

  test('a clip without a playback copy shows its first frame until it is added', () => {
    resetStudio({ clips: [{ id: 'd', name: 'beach.mp4', duration: 30, width: 1920, height: 1080, proxy: 'none' }] as any, selected: [], clipsOpen: true, clipsItem: 'd' });
    renderStudio(<ClipsLibrary />);
    expect(viewer().querySelector('video')).toBeNull();
    expect(viewer().querySelector('img')!.getAttribute('src')).toBe('/api/thumb/d?w=720');
    expect(within(viewer()).getByText('Add it to the edit to play it here')).toBeTruthy();
    fireEvent.click(within(viewer()).getByText('+ Add to the edit'));
    expect(st().selected).toEqual(['d']);
    expect(within(viewer()).getByText('Take out of the edit')).toBeTruthy();
  });

  test('Edit its effects opens the clip look and closes the browser', () => {
    resetStudio({ clips: FOLDERED as any, clipMode: 'custom', clipsOpen: true, clipsItem: 'b' });
    renderStudio(<ClipsLibrary />);
    expect(summary().at(-1)).toBe('The main look');
    fireEvent.click(within(viewer()).getByText('Edit its effects'));
    expect([st().editClip, st().tab, st().clipsOpen]).toEqual(['b', 'layers', false]);
  });

  test('reveal asks the server for the clip, and remove takes two clicks and goes back to the grid', async () => {
    const fetch = serve({ 'POST /api/reveal': () => ({ ok: false, path: '' }), 'POST /api/clip/remove': () => ({ ok: true, deleted: false }) });
    resetStudio({ clips: FOLDERED as any, clipsOpen: true, clipsItem: 'b' });
    renderStudio(<ClipsLibrary />);
    fireEvent.click(within(viewer()).getByText(/Reveal in Finder/));
    await waitFor(() => expect(posted(fetch, '/api/reveal')).toEqual([{ clip_id: 'b' }]));
    await waitFor(() => expect(toastText()).toBe('The file is at ~/Movies/Canvas/city.mp4'));
    fireEvent.click(within(viewer()).getByText(/Remove/));
    expect(within(viewer()).getByText('Click again to remove')).toBeTruthy();
    fireEvent.click(within(viewer()).getByText('Click again to remove'));
    await waitFor(() => expect(viewer()).toBeNull());
    expect(posted(fetch, '/api/clip/remove')).toEqual([{ id: 'b' }]);
    expect(names()).toEqual(['1 sunrise.mp4', 'cover']);
  });

  test('typing in the search is not taken as a shortcut, / jumps to it, and Escape clears it first', () => {
    resetStudio({ clips: many as any, clipsOpen: true });
    renderStudio(<ClipsLibrary />);
    const input = document.querySelector('.lib-bar input') as HTMLInputElement;
    input.blur();
    key('/');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'clip 30' } });
    key('ArrowRight', input);
    expect(document.querySelector('.lib-foot .muted')!.textContent).toBe('1–1 of 1');
    key('Escape', input);
    expect(st().clipsOpen).toBe(true);
  });
});
