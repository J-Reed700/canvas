// The whole studio, rendered together. Each control is also tested in its own file; this checks
// they still update once they sit inside the real layout, which is where clicks used to go nowhere.
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { App } from '../../downbeat/studio/src/App.tsx';
import { MODULES } from '../../downbeat/studio/src/engine/modules.ts';
import { LOOKS, S, SONG, resetStudio, screen, serve, st, toastText, update, withSong } from './studio.tsx';

// The GPU engine can't start here, so initStudio is stubbed and the tests set the state themselves.
function renderApp() {
  const initStudio = vi.fn();
  update(() => S.setState({ initStudio } as any));
  const r = render(<App />);
  return { ...r, initStudio };
}
const press = (key: string, o: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key, ...o });
const tab = (name: string) => fireEvent.click(within(document.getElementById('tabs')!).getByText(name));
const cardFor = (title: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.card')).find((c) => c.querySelector('.ct')?.firstChild?.textContent === title) as HTMLElement;

describe('the whole studio', () => {
  test('renders every panel and starts the engine with the preview canvas and video bank', () => {
    resetStudio({ tab: 'looks' });
    const { initStudio } = renderApp();
    for (const sel of ['header.top', 'aside.media', 'main.stage', 'section.timeline', 'aside.inspector', '#exportSheet', '#libraryModal', '#pop', '#toast']) {
      expect(document.querySelector(sel), sel).toBeTruthy();
    }
    expect(initStudio).toHaveBeenCalledWith(document.getElementById('view'), document.getElementById('videoBank'), document.getElementById('ambient'));
  });

  test('Layers controls respond inside the full layout', () => {
    serve({ '/api/palette/a': () => ({ ok: true, colors: [{ hex: '#e04a2f', rgb: [224, 74, 47], hue: 0.025, role: 'accent' }], css_gradient: '' }) });
    resetStudio({ tab: 'looks' });
    renderApp();
    tab('Layers');
    const step = () => document.querySelectorAll<HTMLButtonElement>('.seqgrid button')[5];
    fireEvent.click(step());
    expect(step().className).toBe('on');
    fireEvent.click(within(cardFor('Bloom')).getByTitle('Enable / bypass'));
    expect(cardFor('Bloom').className).toContain('off');
    fireEvent.click(screen.getByText('+ Add effect'));
    fireEvent.click(Array.from(document.getElementById('pop')!.querySelectorAll('button')).find((b) => b.textContent!.startsWith(MODULES.trails.name))!);
    expect(cardFor(MODULES.trails.name)).toBeTruthy();
    expect(document.getElementById('layerCount')!.textContent).toBe('4');
    const macro = Array.from(document.querySelectorAll<HTMLElement>('.prm')).find((r) => r.querySelector('label')?.textContent === 'Macro A')!;
    fireEvent.change(macro.querySelector('input')!, { target: { value: '0.7' } });
    expect(macro.querySelector('output')!.textContent).toBe('70%');
    return waitFor(() => expect(document.querySelector('.pal-row')).toBeTruthy()).then(() => {
      fireEvent.click(document.querySelector('.pal-row')!);
      expect(document.querySelector('.pal-row')!.className).toContain('on');
    });
  });

  test('a look picked in the grid shows up in the top bar and the Layers tab', () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    fireEvent.click(document.querySelector('[data-look-id="halftone"]')!);
    const name = LOOKS.find((l) => l.id === 'halftone')!.name;
    expect(within(document.getElementById('chips')!).getByText(name)).toBeTruthy();
    tab('Layers');
    expect(Array.from(document.querySelectorAll('.card .ct')).some((c) => c.firstChild?.textContent === MODULES[st().look!.layers[0].m].name)).toBe(true);
  });

  test('changing the loop length in Edit updates the transport, top bar and timeline', () => {
    resetStudio({ tab: 'edit' });
    renderApp();
    fireEvent.click(within(document.querySelector('#pane-edit .seg') as HTMLElement).getByText('8 bars'));
    expect(within(document.getElementById('barsSeg')!).getByText('8').className).toBe('on');
    expect(document.getElementById('chips')!.textContent).toContain('16.00s 8 bars loop');
    expect(document.getElementById('tlInfo')!.textContent).toMatch(/^\d+ cuts/);
  });
});

describe('keyboard shortcuts', () => {
  test('Space plays and pauses; arrows step through looks', () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    press(' ');
    expect(st().transport.playing).toBe(true);
    press(' ');
    expect(st().transport.playing).toBe(false);
    press('ArrowRight');
    expect(st().lookId).toBe(LOOKS[1].id);
    press('ArrowLeft');
    press('ArrowLeft');
    expect(st().lookId).toBe(LOOKS.at(-1)!.id);
  });

  test('the arrows keep the current look in view in the gallery', () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    const seen: string[] = [];
    const scroll = vi.fn(function (this: HTMLElement) { seen.push(this.dataset.lookId!); });
    for (const el of document.querySelectorAll<HTMLElement>('[data-look-id]')) el.scrollIntoView = scroll;
    press('ArrowLeft');
    expect(seen.at(-1)).toBe(LOOKS.at(-1)!.id);
    press('ArrowRight');
    press('ArrowRight');
    expect(seen.at(-1)).toBe(LOOKS[1].id);
  });

  test('M, ?, E and Escape open and close the dialogs', () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    press('m');
    expect(st().varOpen).toBe(true);
    // pressed again it mutates again, like the button
    const seed = st().varSeed;
    press('m');
    expect([st().varOpen, st().varSeed]).toEqual([true, seed + 1]);
    press('?');
    expect(st().helpOpen).toBe(true);
    press('Escape');
    expect([st().varOpen, st().helpOpen]).toEqual([false, false]);
    press('e');
    expect(st().exportOpen).toBe(true);
    press('Escape');
    expect(st().exportOpen).toBe(false);
  });

  test('D rolls, Shift+D undoes it, R surprises', () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    press('d');
    expect(st().lookId).not.toBe(LOOKS[0].id);
    press('D');
    expect(st().lookId).toBe(LOOKS[0].id);
    press('r');
    expect(toastText()).toMatch(/^Surprise: /);
  });

  test('H, S and L toggle the overlay, safe zones and listener mode; T taps the tempo', () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    press('h');
    expect(st().hud).toBe(false);
    press('s');
    expect(st().safe).toBe(true);
    press('l');
    expect(st().transport.mode).toBe('listen');
    press('l');
    expect(st().transport.mode).toBe('loop');
    press('t');
    expect(toastText()).toMatch(/^Tap \d more…$/);
  });

  test('O steps through the screens, and the look thumbnails follow', () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    const thumb = () => document.querySelector<HTMLCanvasElement>('#looks canvas')!;
    expect([thumb().width, thumb().height]).toEqual([144, 256]);
    press('o');
    expect(st().exportOpts.format).toBe('youtube_16_9');
    expect(document.getElementById('phone')!.dataset.screen).toBe('landscape');
    expect([thumb().width, thumb().height]).toEqual([256, 144]);
    press('O');
    press('o');
    expect(st().exportOpts.format).toBe('social_square');
    press('o');
    expect(st().exportOpts.format).toBe('spotify');
  });

  test('1 to 4 pick a length when the song is long enough; [ and ] step through loop suggestions', () => {
    withSong({ tab: 'looks', features: { ...SONG, duration: 12, downbeats: [1.5, 3.5, 5.5, 7.5, 9.5] } as any, loopStart: 1.5 });
    renderApp();
    press('2');
    expect(st().bars).toBe(2);
    press('4');
    expect(st().bars, '8 bars would not fit a 12 s song').toBe(2);
    withSong({ tab: 'looks' });
    press(']');
    expect(st().loopStart).toBe(65.5);
    expect(toastText()).toBe('Loop: Peak');
    press(']');
    expect(st().loopStart).toBe(33.5);
    press('[');
    expect(st().loopStart).toBe(65.5);
  });

  test('⌘Z undoes and ⇧⌘Z redoes', async () => {
    resetStudio({ tab: 'looks' });
    renderApp();
    await act(async () => { st().save(); await new Promise((r) => setTimeout(r, 400)); });
    update(() => st().setLook(LOOKS[3]));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    press('z', { metaKey: true });
    expect(st().lookId).toBe(LOOKS[0].id);
    press('z', { metaKey: true, shiftKey: true });
    expect(st().lookId).toBe(LOOKS[3].id);
  });

  test('typing in a field, an export in progress or the exports browser keeps keys to themselves', () => {
    resetStudio({ tab: 'edit' });
    renderApp();
    const seed = document.querySelector('#pane-edit input[type=number]') as HTMLInputElement;
    fireEvent.keyDown(seed, { key: 'd' });
    fireEvent.keyDown(seed, { key: ' ' });
    expect(st().lookId).toBe(LOOKS[0].id);
    expect(st().transport.playing).toBe(false);
    update(() => S.setState({ exporting: true }));
    press(' ');
    press('z', { metaKey: true });
    expect(st().transport.playing).toBe(false);
    update(() => S.setState({ exporting: false, libraryOpen: true }));
    press('d');
    expect(st().lookId).toBe(LOOKS[0].id);
  });
});

describe('dropping files', () => {
  test('dragging files over the window highlights it, and dropping uploads them', async () => {
    const fetch = serve({
      'POST /api/upload': () => ({ ok: true, kind: 'video', id: 'dropped' }),
      '/api/state': () => ({ clips: [...st().clips, { id: 'dropped', name: 'dropped.mp4', duration: 5 }], tracks: [], renders: [] }),
    });
    resetStudio({ tab: 'looks' });
    renderApp();
    const file = new File(['x'], 'dropped.mp4', { type: 'video/mp4' });
    fireEvent.dragOver(window, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(document.body.classList.contains('dropping')).toBe(true);
    fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(document.body.classList.contains('dropping')).toBe(false);
    await waitFor(() => expect(st().selected).toContain('dropped'));
    expect(fetch.mock.calls.some(([u]) => u === '/api/upload')).toBe(true);
    expect(within(document.getElementById('clips')!).getByText('5.0s · dropped.mp4')).toBeTruthy();
  });
});
