import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { MediaPanel } from '../../downbeat/studio/src/components/MediaPanel.tsx';
import { TrackPicker } from '../../downbeat/studio/src/components/TrackPicker.tsx';
import { METERS } from '../../downbeat/studio/src/lib/utils.ts';
import { CLIPS, LOOKS, SONG, TRACKS, posted, renderStudio, resetStudio, screen, serve, st, toastText, update, withSong } from './studio.tsx';

const clipEls = () => Array.from(document.querySelectorAll<HTMLElement>('#clips .clip'));
const clipEl = (name: string) => clipEls().find((c) => c.querySelector('.cap')!.textContent!.includes(name)) as HTMLElement;
const caps = () => clipEls().map((c) => c.querySelector('.cap')!.textContent);
const nums = () => clipEls().map((c) => c.querySelector('.num')?.textContent || '-');

describe('clips', () => {
  test('picked clips come first, numbered in order, then the rest', () => {
    resetStudio({ selected: ['c', 'a'] });
    renderStudio(<MediaPanel />);
    expect(caps()).toEqual(['Still · cover', '12.0s · 1 sunrise.mp4', '9.0s · city.mp4']);
    expect(nums()).toEqual(['1', '2', '-']);
    expect(clipEls().map((c) => c.className)).toEqual(['clip on', 'clip on', 'clip off']);
    expect(document.getElementById('clipCount')!.textContent).toBe('2 of 3');
  });

  test('clicking a clip takes it out of the edit or adds it at the end', () => {
    resetStudio();
    renderStudio(<MediaPanel />);
    fireEvent.click(clipEl('city'));
    expect(st().selected).toEqual(['a', 'c']);
    expect(caps().at(-1)).toBe('9.0s · city.mp4');
    fireEvent.click(clipEl('city'));
    expect(st().selected).toEqual(['a', 'c', 'b']);
    expect(nums()).toEqual(['1', '2', '3']);
  });

  test('All, Solo, Reverse and Shuffle reorder the sequence', () => {
    resetStudio({ selected: ['b'] });
    renderStudio(<MediaPanel />);
    fireEvent.click(screen.getByText('All'));
    expect(st().selected).toEqual(['b', 'a', 'c']);
    fireEvent.click(screen.getByText('Reverse'));
    expect(st().selected).toEqual(['c', 'a', 'b']);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fireEvent.click(document.getElementById('btnShuffle')!);
    expect(st().selected).toEqual(['a', 'b', 'c']);
    fireEvent.click(screen.getByText('Solo'));
    expect(st().selected).toEqual(['a']);
    expect(nums()).toEqual(['1', '-', '-']);
  });

  test('a video that is not loaded is dimmed and offers + Add, which puts it in the edit', () => {
    resetStudio({ clips: [...CLIPS, { id: 'd', name: 'beach.mp4', duration: 30, proxy: 'none' }] as any, selected: ['a'] });
    renderStudio(<MediaPanel />);
    const beach = clipEl('beach.mp4');
    expect(beach.className).toBe('clip off idle');
    expect(beach.querySelector('.add-hint')!.textContent).toBe('+ Add');
    expect(beach.title).toContain('Not loaded yet');
    expect(clipEl('city.mp4').className, 'a loaded clip out of the edit is only dimmed').toBe('clip off');
    expect(clipEl('city.mp4').querySelector('.add-hint')).toBeNull();
    fireEvent.click(beach);
    expect(st().selected).toEqual(['a', 'd']);
    expect(clipEl('beach.mp4').className).toBe('clip on');
  });

  test('dragging a picked clip onto another moves it there', () => {
    resetStudio();
    renderStudio(<MediaPanel />);
    const dataTransfer = { effectAllowed: '' };
    fireEvent.dragStart(clipEl('cover'), { dataTransfer });
    fireEvent.dragOver(clipEl('sunrise'), { dataTransfer });
    expect(clipEl('sunrise').className).toContain('drag-over');
    fireEvent.drop(clipEl('sunrise'), { dataTransfer });
    expect(st().selected).toEqual(['c', 'a', 'b']);
    expect(clipEl('sunrise').className).not.toContain('drag-over');
  });

  test('a clip dragged to the right lands where it is dropped, not one past it', () => {
    resetStudio();
    renderStudio(<MediaPanel />);
    const dataTransfer = { effectAllowed: '' };
    const drag = (from: string, to: string) => {
      fireEvent.dragStart(clipEl(from), { dataTransfer });
      fireEvent.dragOver(clipEl(to), { dataTransfer });
      fireEvent.drop(clipEl(to), { dataTransfer });
    };
    drag('sunrise', 'city.mp4');
    expect(st().selected).toEqual(['b', 'a', 'c']);
    drag('city.mp4', 'cover');
    expect(st().selected).toEqual(['a', 'c', 'b']);
  });

  test('a clip drag that ends off the grid is forgotten, so a later drop on a clip does nothing', () => {
    resetStudio();
    renderStudio(<MediaPanel />);
    const dataTransfer = { effectAllowed: '' };
    fireEvent.dragStart(clipEl('cover'), { dataTransfer });
    fireEvent.dragEnd(clipEl('cover'), { dataTransfer });
    fireEvent.dragOver(clipEl('sunrise'), { dataTransfer });
    expect(clipEl('sunrise').className).not.toContain('drag-over');
    fireEvent.drop(clipEl('sunrise'), { dataTransfer });
    expect(st().selected).toEqual(['a', 'b', 'c']);
  });

  test('removing a clip takes two clicks, and the first one is forgotten after 3 s', async () => {
    const fetch = serve({ 'POST /api/clip/remove': () => ({ ok: true, deleted: false }) });
    resetStudio();
    renderStudio(<MediaPanel />);
    vi.useFakeTimers();
    const rm = () => clipEl('city').querySelector('.rm') as HTMLButtonElement;
    fireEvent.click(rm());
    expect(rm().textContent).toBe('Remove?');
    expect(st().selected, 'the click does not reach the clip').toEqual(['a', 'b', 'c']);
    act(() => vi.advanceTimersByTime(3000));
    expect(rm().textContent).toBe('✕');
    fireEvent.click(rm());
    fireEvent.click(rm());
    vi.useRealTimers();
    await waitFor(() => expect(st().clips.map((c) => c.id)).toEqual(['a', 'c']));
    expect(posted(fetch, '/api/clip/remove')).toEqual([{ id: 'b' }]);
    expect(caps()).toEqual(['12.0s · 1 sunrise.mp4', 'Still · cover']);
    expect(toastText()).toBe('Removed city.mp4. The file is still in its folder.');
  });

  test('a clip whose playback copy is still building shows that', () => {
    resetStudio({ clips: [{ id: 'a', name: 'a.mp4', duration: 4, proxy: 'building' }] as any, selected: ['a'] });
    renderStudio(<MediaPanel />);
    expect(clipEls()[0].querySelector('.busy')).toBeTruthy();
  });

  test('with per-clip looks, each picked clip shows its look and opens it for editing', () => {
    resetStudio({ clipMode: 'custom', clipLooks: { b: { ...structuredClone(LOOKS[4]) } } });
    renderStudio(<MediaPanel />);
    const tags = clipEls().map((c) => c.querySelector('.lk')?.textContent);
    expect(tags).toEqual(['Main', LOOKS[4].name, 'Main']);
    fireEvent.click(clipEl('cover').querySelector('.lk')!);
    expect(st().editClip).toBe('c');
    expect(st().tab).toBe('layers');
    expect(st().selected, 'the click does not toggle the clip').toEqual(['a', 'b', 'c']);
  });

  test('picking files uploads them', async () => {
    const fetch = serve({
      'POST /api/upload': () => ({ ok: true, kind: 'video', id: 'new' }),
      '/api/state': () => ({ clips: [...st().clips, { id: 'new', name: 'new.mp4', duration: 5 }], tracks: [], renders: [] }),
    });
    resetStudio();
    renderStudio(<MediaPanel />);
    const input = document.getElementById('fileInput') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'new.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(st().selected).toEqual(['a', 'b', 'c', 'new']));
    const [, init] = fetch.mock.calls.find(([u]) => u === '/api/upload')!;
    expect(decodeURIComponent((init!.headers as any)['X-Filename'])).toBe('new.mp4');
    expect(toastText()).toBe('Added 1 file');
  });
});

describe('track tools', () => {
  const songServer = () =>
    serve({ '/api/features/*': (u) => ({ ...SONG, bpm: u.includes('bpm=') ? +u.split('bpm=')[1] : 120 }) });

  test('without a song the panel says the visuals follow a steady beat', () => {
    resetStudio();
    renderStudio(<MediaPanel />);
    expect(document.getElementById('trackMeta')!.textContent).toBe('Visuals follow a synthetic beat at the tempo set in Edit');
    expect(Array.from(document.querySelectorAll('#meters .meter')).map((m) => m.getAttribute('title'))).toHaveLength(METERS.length);
  });

  test('half and double tempo, typing a tempo and auto all re-analyze the song', async () => {
    const fetch = songServer();
    withSong();
    st().transport.decode = async () => ({ duration: 180 }) as any;
    renderStudio(<MediaPanel />);
    const meta = () => document.getElementById('trackMeta') as HTMLElement;
    expect(meta().querySelector('b')!.textContent).toBe('120');
    expect(within(meta()).queryByText('auto')).toBeNull();

    fireEvent.click(within(meta()).getByText('½×'));
    await waitFor(() => expect(st().bpm()).toBe(60));
    expect(String(fetch.mock.calls.at(-1)![0])).toBe('/api/features/t1?bpm=60');
    expect(meta().querySelector('b')!.textContent).toBe('60');

    const bpm = meta().querySelector('b') as HTMLElement;
    bpm.textContent = '128.5';
    fireEvent.blur(bpm);
    await waitFor(() => expect(st().bpm()).toBe(128.5));
    expect(meta().querySelector('b')!.textContent).toBe('128.50');

    fireEvent.click(within(meta()).getByText('auto'));
    await waitFor(() => expect(st().bpmOverride).toEqual({}));
    expect(String(fetch.mock.calls.at(-1)![0])).toBe('/api/features/t1');
  });

  test('2× past 220 BPM is turned off, and Tap asks for more taps', async () => {
    const fetch = songServer();
    withSong({ features: { ...SONG, bpm: 128 } as any });
    renderStudio(<MediaPanel />);
    expect((screen.getByText('2×') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('½×') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('2×'));
    expect(st().bpmOverride).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Tap'));
    expect(toastText()).toMatch(/^Tap \d more…$/);
  });

  test('the beat grid nudges by 10 ms, or 1 ms with Shift, and resets on click', () => {
    withSong();
    renderStudio(<MediaPanel />);
    const nudge = () => document.querySelector('.nudge') as HTMLElement;
    fireEvent.click(screen.getByTitle('Later by 10 ms (Shift: 1 ms)'));
    fireEvent.click(screen.getByTitle('Later by 10 ms (Shift: 1 ms)'), { shiftKey: true });
    expect(st().gridNudge.t1).toBe(0.011);
    expect(nudge().textContent).toBe('+11 ms');
    expect(st().audioStart()).toBeCloseTo(33.511, 9);
    fireEvent.click(screen.getByTitle('Earlier by 10 ms (Shift: 1 ms)'));
    fireEvent.click(screen.getByTitle('Earlier by 10 ms (Shift: 1 ms)'));
    expect(nudge().textContent).toBe('-9 ms');
    fireEvent.click(nudge());
    expect(nudge().textContent).toBe('0 ms');
  });
});

describe('track picker', () => {
  const LIB = {
    ok: true,
    tracks: [...TRACKS, { id: 't3', name: 'Intro.flac', path: '/Users/me/Music/Album/Intro.flac', source: '/Users/me/Music', dir: 'Album', mtime: 1 }],
    clips: CLIPS,
    folders: ['/Users/me/Movies/Canvas', '/Users/me/Music'],
    suggestions: ['/Users/me/Dropbox/Songs'],
    can_pick: false,
  };
  const open = () => fireEvent.click(document.getElementById('trackSelect')!);
  const panel = () => document.querySelector('.tp-panel') as HTMLElement;
  const rows = () => Array.from(panel().querySelectorAll('.tp-row .tp-name')).map((n) => n.textContent);

  test('opening rescans the library and lists every song by where it was found', async () => {
    const fetch = serve({ '/api/tracks': () => LIB });
    resetStudio();
    renderStudio(<TrackPicker onAddSong={() => {}} />);
    expect(document.getElementById('trackSelect')!.textContent).toBe('⏱  No track (BPM clock)');
    open();
    await waitFor(() => expect(rows()).toEqual(['⏱ No track', 'Night Drive', 'Sunrise', 'Intro']));
    expect(fetch).toHaveBeenCalledWith('/api/tracks', undefined);
    expect(Array.from(panel().querySelectorAll('.tp-gh span')).map((s) => s.textContent)).toEqual(['Canvas', 'Music']);
    expect(st().tracks).toHaveLength(3);
    expect(panel().querySelector('.tp-sub:not(:first-child)')).toBeTruthy();
  });

  test('search narrows the list, and the keyboard picks a song', async () => {
    serve({ '/api/tracks': () => LIB, '/api/features/*': () => ({ ...SONG, id: 't2' }) });
    resetStudio();
    st().transport.decode = async () => ({ duration: 180 }) as any;
    renderStudio(<TrackPicker onAddSong={() => {}} />);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const search = panel().querySelector('input') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'album' } });
    expect(rows()).toEqual(['Intro']);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(panel().textContent).toContain('No songs match "zzz"');
    fireEvent.change(search, { target: { value: 'sun' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(panel()).toBeNull();
    await waitFor(() => expect(st().trackId).toBe('t2'));
    expect(document.getElementById('trackSelect')!.textContent).toBe('Sunrise');
  });

  test('arrow keys move the highlight and Escape clears the search, then closes', async () => {
    serve({ '/api/tracks': () => LIB });
    resetStudio({ tracks: LIB.tracks as any });
    renderStudio(<TrackPicker onAddSong={() => {}} />);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const search = panel().querySelector('input') as HTMLInputElement;
    const hi = () => panel().querySelector('.tp-row.hi .tp-name')!.textContent;
    expect(hi()).toBe('⏱ No track');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(hi()).toBe('Sunrise');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(hi()).toBe('Night Drive');
    fireEvent.change(search, { target: { value: 'night' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((panel().querySelector('input') as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(panel().querySelector('input')!, { key: 'Escape' });
    expect(panel()).toBeNull();
  });

  test('a folder can be added by path, removed, or picked from the suggestions', async () => {
    const fetch = serve({
      '/api/tracks': () => LIB,
      'POST /api/library/folders': (_u, init) => {
        const b = JSON.parse(String(init.body));
        return b.add === '/nope'
          ? new Response(JSON.stringify({ ok: false, error: 'No folder at /nope' }), { status: 400 })
          : { ...LIB, folders: b.remove ? [] : [...LIB.folders, b.add], added: b.add || null };
      },
    });
    resetStudio();
    renderStudio(<TrackPicker onAddSong={() => {}} />);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(within(panel()).getByText('+ Add a folder'));
    const path = panel().querySelector('.tp-path input') as HTMLInputElement;
    fireEvent.change(path, { target: { value: '/nope' } });
    fireEvent.submit(panel().querySelector('.tp-path')!);
    await waitFor(() => expect(panel().querySelector('.tp-err')!.textContent).toBe('No folder at /nope'));
    fireEvent.change(path, { target: { value: '/Users/me/Beats' } });
    fireEvent.submit(panel().querySelector('.tp-path')!);
    await waitFor(() => expect(toastText()).toBe('Added the Beats folder. It has no videos or songs yet'));
    expect(panel().querySelector('.tp-path'), 'the path box closes once the folder is added').toBeNull();

    fireEvent.click(within(panel()).getByText('+ ~/Dropbox/Songs'));
    await waitFor(() => expect(posted(fetch, '/api/library/folders').at(-1)).toEqual({ add: '/Users/me/Dropbox/Songs' }));
    fireEvent.click(within(panel()).getByTitle(/Stop listing videos and songs from ~\/Music/));
    await waitFor(() => expect(posted(fetch, '/api/library/folders').at(-1)).toEqual({ remove: '/Users/me/Music' }));
  });

  test('+ Add a song closes the picker and opens the file chooser; a click outside closes it too', async () => {
    serve({ '/api/tracks': () => LIB });
    const onAddSong = vi.fn();
    resetStudio();
    renderStudio(<TrackPicker onAddSong={onAddSong} />);
    open();
    await waitFor(() => expect(panel()).toBeTruthy());
    fireEvent.click(within(panel()).getByText('+ Add a song'));
    expect(onAddSong).toHaveBeenCalledOnce();
    expect(panel()).toBeNull();
    open();
    await waitFor(() => expect(panel()).toBeTruthy());
    fireEvent.pointerDown(document.body);
    expect(panel()).toBeNull();
  });

  test('picking No track drops the song', async () => {
    serve({ '/api/tracks': () => LIB });
    withSong();
    renderStudio(<TrackPicker onAddSong={() => {}} />);
    expect(document.getElementById('trackSelect')!.textContent).toBe('Night Drive');
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(within(panel()).getByText('⏱ No track'));
    await waitFor(() => expect(st().trackId).toBe(''));
    expect(st().features).toBe(null);
    update(() => {});
  });
});
