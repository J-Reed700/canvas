import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { ExportsSection, ExportsLibrary } from '../../downbeat/studio/src/components/Exports.tsx';
import { posted, renderStudio, resetStudio, screen, serve, st, toastText } from './studio.tsx';

const NOW = Math.floor(Date.now() / 1000);
const render_ = (i: number, o: Record<string, unknown> = {}) => ({
  filename: `canvas-look-${i}-120bpm-8.0s-1080x1920-2026102${i % 10}.mp4`,
  url: `/out/look-${i}.mp4`,
  look: `Look ${i}`,
  format: 'spotify',
  resolution: '1080x1920',
  duration: 8,
  size_mb: i,
  bpm: 120,
  created_at: NOW - i * 60,
  checks: [{ id: 'len', label: 'Length', level: 'ok', detail: '8 s' }],
  ...o,
});
const MIXED = [
  render_(1),
  render_(2, { format: 'youtube_16_9', resolution: '1920x1080', look: 'Neon Tide', audio_url: '/out/2-audio.mp4', promo_url: '/out/2-promo.mp4' }),
  render_(3, { format: 'apple_tall', resolution: '2048x2732', checks: [{ id: 'len', label: 'Length', level: 'fail', detail: '40 s' }] }),
  render_(4, { cover_url: '/out/4-cover.jpg' }),
  render_(5),
];
const sideRows = () => Array.from(document.querySelectorAll<HTMLElement>('#exports .exp'));
const sideTitles = () => sideRows().map((r) => r.querySelector('.n')!.textContent);

describe('exports panel', () => {
  test('says where exports will appear before there are any', () => {
    resetStudio();
    renderStudio(<ExportsSection />);
    expect(screen.getByText("Exports appear here, each checked against its format's spec.")).toBeTruthy();
    expect(screen.queryByText(/Browse/)).toBeNull();
  });

  test('lists four exports a page with their size, format, age and spec result', () => {
    resetStudio({ renders: MIXED });
    renderStudio(<ExportsSection />);
    expect(sideTitles()).toEqual(['Look 1', 'Neon Tide', 'Look 3', 'Look 4']);
    const first = sideRows()[0];
    expect(first.querySelectorAll('.m')[0].textContent).toBe('1080×1920 · 8.00 s · 1 MB');
    expect(first.querySelectorAll('.m')[1].textContent).toMatch(/^Spotify Canvas · (\d+ min ago|just now) ✓ spec$/);
    expect(sideRows()[2].querySelector('.badge.bad')!.textContent).toBe('✕ 1');
    expect(document.querySelector('.pager-of')!.textContent).toBe('1 / 2');
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(sideTitles()).toEqual(['Look 5']);
    expect(screen.getByLabelText('Next page').hasAttribute('disabled')).toBe(true);
  });

  test('search and kind chips filter the list, and Clear search brings everything back', () => {
    resetStudio({ renders: MIXED });
    renderStudio(<ExportsSection />);
    const chips = Array.from(document.querySelectorAll('.exp-kinds button')).map((b) => b.textContent);
    expect(chips).toEqual(['All 5', 'Canvas 3', 'Apple 1', 'YouTube 1']);
    fireEvent.click(within(document.querySelector('.exp-kinds') as HTMLElement).getByText(/^YouTube/));
    expect(sideTitles()).toEqual(['Neon Tide']);
    expect(document.getElementById('exportCount')!.textContent).toBe('1 of 5');
    fireEvent.click(within(document.querySelector('.exp-kinds') as HTMLElement).getByText(/^All/));
    fireEvent.change(document.querySelector('.exp-search input')!, { target: { value: 'LOOK 3' } });
    expect(sideTitles()).toEqual(['Look 3']);
    fireEvent.change(document.querySelector('.exp-search input')!, { target: { value: 'nothing like this' } });
    expect(screen.getByText(/No exports match/)).toBeTruthy();
    fireEvent.click(screen.getByText('Clear search'));
    expect(sideTitles()).toHaveLength(4);
    expect(st().exportFilter).toEqual({ q: '', kind: 'all', sort: 'new' });
  });

  test('deleting takes two clicks and removes the export from the list', async () => {
    const fetch = serve({ 'POST /api/export/delete': () => ({ ok: true, removed: [] }) });
    resetStudio({ renders: MIXED.slice(0, 2) });
    renderStudio(<ExportsSection />);
    const del = () => sideRows()[0].querySelector('.del') as HTMLButtonElement;
    fireEvent.click(del());
    expect(del().textContent).toBe('Delete?');
    expect(st().libraryOpen, 'the click stays on the button').toBe(false);
    fireEvent.click(del());
    await waitFor(() => expect(sideTitles()).toEqual(['Neon Tide']));
    expect(posted(fetch, '/api/export/delete')).toEqual([{ filename: MIXED[0].filename }]);
    expect(toastText()).toBe('Deleted Look 1');
  });

  test('a delete the server refuses keeps the export and says why', async () => {
    serve({ 'POST /api/export/delete': () => new Response(JSON.stringify({ ok: false, error: 'Permission denied' }), { status: 500 }) });
    resetStudio({ renders: MIXED.slice(0, 1) });
    renderStudio(<ExportsSection />);
    fireEvent.click(sideRows()[0].querySelector('.del')!);
    fireEvent.click(sideRows()[0].querySelector('.del')!);
    await waitFor(() => expect(toastText()).toBe('Permission denied'));
    expect(sideTitles()).toEqual(['Look 1']);
  });

  test('clicking an export opens it in the browser; Browse opens the grid; reveal asks the server', async () => {
    const fetch = serve({ 'POST /api/reveal': () => ({ ok: true }) });
    resetStudio({ renders: MIXED });
    renderStudio(<ExportsSection />);
    fireEvent.click(sideRows()[1]);
    expect([st().libraryOpen, st().libraryItem]).toEqual([true, MIXED[1].filename]);
    act(() => resetStudio({ renders: MIXED }));
    fireEvent.click(screen.getByText(/Browse/));
    expect([st().libraryOpen, st().libraryItem]).toEqual([true, null]);
    fireEvent.click(sideRows()[0].querySelector('[title="Reveal in Finder"]')!);
    await waitFor(() => expect(posted(fetch, '/api/reveal')).toEqual([{ filename: MIXED[0].filename }]));
  });
});

describe('exports browser', () => {
  const many = Array.from({ length: 15 }, (_, i) => render_(i + 1));
  const cards = () => Array.from(document.querySelectorAll<HTMLElement>('.lib-card'));
  const viewer = () => document.querySelector('.lib-view') as HTMLElement;
  const key = (k: string, target: EventTarget = window) => fireEvent.keyDown(target, { key: k });

  test('shows twelve exports a page with numbered pages', () => {
    resetStudio({ renders: many, libraryOpen: true });
    renderStudio(<ExportsLibrary />);
    expect(cards()).toHaveLength(12);
    expect(document.querySelector('.lib-foot .muted')!.textContent).toBe('1–12 of 15');
    expect(document.querySelector('.modal.lib .sub')!.textContent).toBe('15 renders · 120.0 MB in out/');
    fireEvent.click(within(document.querySelector('.pager') as HTMLElement).getByText('2'));
    expect(cards()).toHaveLength(3);
    key('ArrowLeft');
    expect(cards()).toHaveLength(12);
  });

  test('sorting changes the order of the grid', () => {
    resetStudio({ renders: many.slice(0, 3), libraryOpen: true });
    renderStudio(<ExportsLibrary />);
    const titles = () => cards().map((c) => c.querySelector('b')!.textContent);
    expect(titles()).toEqual(['Look 1', 'Look 2', 'Look 3']);
    fireEvent.change(document.querySelector('.lib-bar select')!, { target: { value: 'big' } });
    expect(titles()).toEqual(['Look 3', 'Look 2', 'Look 1']);
  });

  test('the viewer shows an export with its downloads and checks, and steps through the list', () => {
    resetStudio({ renders: MIXED, libraryOpen: true });
    renderStudio(<ExportsLibrary />);
    fireEvent.click(cards()[1]);
    expect(viewer().querySelector('h3')!.textContent).toBe('Neon Tide');
    expect(within(viewer()).getByText('2 of 5')).toBeTruthy();
    const summary = Array.from(viewer().querySelectorAll('.summary b')).map((b) => b.textContent);
    expect(summary.slice(0, 5)).toEqual(['YouTube 16:9', '1920 × 1080', '8.000 s', '120.00 BPM', '2 MB']);
    expect(within(viewer()).getByText('With audio').getAttribute('href')).toBe('/out/2-audio.mp4');
    expect(within(viewer()).getByText('Promo with song')).toBeTruthy();
    expect(within(viewer()).queryByText('Cover JPG')).toBeNull();
    expect(viewer().querySelector('.ck.ok')!.textContent).toBe('✓Length8 s');
    key('ArrowRight');
    expect(viewer().querySelector('h3')!.textContent).toBe('Look 3');
    expect(viewer().querySelector('.ck.fail')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Previous export (←)'));
    fireEvent.click(screen.getByTitle('Previous export (←)'));
    expect(viewer().querySelector('h3')!.textContent).toBe('Look 1');
    expect((screen.getByTitle('Previous export (←)') as HTMLButtonElement).disabled).toBe(true);
    key('Escape');
    expect(viewer()).toBeNull();
    expect(st().libraryOpen).toBe(true);
    key('Escape');
    expect(st().libraryOpen).toBe(false);
  });

  test('typing in the search box is not taken as a shortcut, and / jumps to it', () => {
    resetStudio({ renders: many, libraryOpen: true });
    renderStudio(<ExportsLibrary />);
    const search = document.querySelector('.lib-bar input') as HTMLInputElement;
    search.blur();
    key('/');
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'look 15' } });
    key('ArrowRight', search);
    expect(document.querySelector('.lib-foot .muted')!.textContent).toBe('1–1 of 1');
    key('Escape', search);
    expect(st().libraryOpen, 'Escape in a search with text clears it before closing anything').toBe(true);
  });

  test('deleting from the viewer goes back to the grid; teasers ask the server', async () => {
    const fetch = serve({
      'POST /api/export/delete': () => ({ ok: true, removed: [] }),
      'POST /api/export/companion': () => ({ ok: true, url: '/out/t.gif', filename: 't.gif' }),
    });
    resetStudio({ renders: MIXED, libraryOpen: true, libraryItem: MIXED[3].filename });
    renderStudio(<ExportsLibrary />);
    expect(within(viewer()).getByText('Cover JPG').getAttribute('href')).toBe('/out/4-cover.jpg');
    fireEvent.click(within(viewer()).getByText('GIF teaser'));
    await waitFor(() => expect(posted(fetch, '/api/export/companion')).toEqual([{ filename: MIXED[3].filename, kind: 'gif' }]));
    fireEvent.click(viewer().querySelector('.del')!);
    expect(within(viewer()).getByText('Click again to delete')).toBeTruthy();
    fireEvent.click(viewer().querySelector('.del')!);
    await waitFor(() => expect(viewer()).toBeNull());
    expect(st().renders).toHaveLength(4);
    expect(cards()).toHaveLength(4);
  });

  test('clicking outside the dialog closes it', () => {
    resetStudio({ renders: MIXED, libraryOpen: true });
    renderStudio(<ExportsLibrary />);
    fireEvent.click(document.getElementById('libraryModal')!);
    expect(st().libraryOpen).toBe(false);
    expect(document.querySelector('.modal.lib')).toBeNull();
  });
});
