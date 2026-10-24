import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { Modals } from '../../downbeat/studio/src/components/Modals.tsx';
import { FORMATS } from '../../downbeat/studio/src/lib/utils.ts';
import { MODULES } from '../../downbeat/studio/src/engine/modules.ts';
import { LOOKS, S, TRACKS, resetStudio, screen, st, update, withSong } from './studio.tsx';

const sheet = () => document.getElementById('exportForm') as HTMLElement;
const summary = () => {
  const cells = Array.from(sheet().querySelectorAll('.summary > *')).map((e) => e.textContent);
  return Object.fromEntries(cells.flatMap((c, i) => (i % 2 ? [] : [[c, cells[i + 1]]])));
};
const fmtButton = (short: string) => within(sheet().querySelector('.fmt-seg') as HTMLElement).getByText(short);
const warnings = () => Array.from(sheet().querySelectorAll('.warn-note')).map((w) => w.textContent);

// Exporting needs the GPU, so these tests swap the store's export actions for spies.
function stubActions() {
  const spies = { runExport: vi.fn(), runBatch: vi.fn(), exportCompanion: vi.fn() };
  update(() => S.setState(spies as any));
  return spies;
}

describe('export sheet', () => {
  test('lists every format, and the summary describes the render', () => {
    withSong();
    render(<Modals />);
    expect(Array.from(sheet().querySelectorAll('.fmt-seg button')).map((b) => b.textContent)).toEqual(Object.values(FORMATS).map((f) => f.short));
    expect(fmtButton('Spotify 9:16').className).toBe('on');
    expect(summary()).toEqual({
      Look: LOOKS[0].name,
      Size: '1080 × 1920 · Spotify Canvas',
      Length: '8.000 s · 240 frames @ 30 fps',
      Tempo: '120.00 BPM · 4 bars',
      Edit: `${st().ctx!.tl.segs.length} cuts · 3 clips`,
      Audio: '0:33 → 0:41',
    });
  });

  test('picking a format changes its note, its size and which options show', () => {
    withSong();
    render(<Modals />);
    expect(screen.getByText('1080 × 1920 · Master')).toBeTruthy();
    fireEvent.click(screen.getByText('720 × 1280 · Lite'));
    expect(st().exportOpts.size).toBe('lite');
    expect(summary().Size).toBe('720 × 1280 · Spotify Canvas');

    fireEvent.click(fmtButton('YouTube 16:9'));
    expect(st().exportOpts.format).toBe('youtube_16_9');
    expect(sheet().querySelector('.note')!.textContent).toMatch(/^YouTube visualizer: 1920 × 1080/);
    expect(summary().Size).toBe('1920 × 1080 · YouTube Visualizer · 16:9');
    expect(screen.queryByText('720 × 1280 · Lite'), 'size choices are for Spotify only').toBeNull();

    fireEvent.click(fmtButton('Apple 1:1'));
    expect(summary().Size).toBe('3840 × 3840 (rendered at 2048)');
    expect(screen.queryByText(/Promo copy with the song/), 'Apple motion art is silent').toBeNull();

    fireEvent.click(fmtButton('Cover 3000²'));
    expect(sheet().querySelector('.note')!.textContent).toMatch(/^Album cover art: a 3000 × 3000 sRGB JPEG/);
  });

  test('loops outside a format\'s length rule get a warning; long loops offer a copy with the song', () => {
    withSong({ bars: 20 }); // 40 s
    render(<Modals />);
    expect(warnings()[0]).toMatch(/^This loop is 40\.00s, and Spotify only takes a Canvas of 3 to 8 s/);
    expect(screen.getByText('Also save a copy with the song')).toBeTruthy();
    fireEvent.click(fmtButton('YouTube 16:9'));
    expect(warnings()).toEqual([]);
    fireEvent.click(fmtButton('Apple 3:4'));
    expect(warnings()[0]).toMatch(/^This loop is 40\.00s, and Apple Music motion art can be at most 35 s/);
    update(() => st().setBars(4));
    expect(warnings()).toEqual([]);
    update(() => st().setBars(1));
    fireEvent.click(fmtButton('Spotify 9:16'));
    expect(warnings()[0]).toMatch(/^This loop is 2\.00s/);
    update(() => st().setBars(75));
    expect(summary().Length).toBe('2:30 · 4500 frames @ 30 fps');
  });

  test('rapid cuts are flagged for Spotify only', () => {
    withSong();
    update(() => { st().look!.cut.rhythm = 'eighth'; st().rebuild(); });
    render(<Modals />);
    expect(warnings().some((w) => w!.startsWith('⚠ Rapid cuts. The shortest segment is 0.25 s.'))).toBe(true);
    fireEvent.click(fmtButton('Social 1:1'));
    expect(warnings().some((w) => w!.includes('Rapid cuts'))).toBe(false);
  });

  test('the audio, promo and auto-save options are saved with the export settings', () => {
    withSong();
    render(<Modals />);
    fireEvent.click(screen.getByLabelText('Also save a copy with the audio slice'));
    expect(st().exportOpts.audio).toBe(false);
    fireEvent.click(within(sheet().querySelector('.field .seg') as HTMLElement).getByText('15 s'));
    expect(st().exportOpts.promo).toBe(15);
    fireEvent.click(screen.getByLabelText("Save to my Downloads folder when it's done"));
    expect(st().exportOpts.autoSave).toBe(false);
  });

  test('without a song there is no audio to add', () => {
    resetStudio();
    render(<Modals />);
    expect(screen.queryByText(/Also save a copy/)).toBeNull();
    expect(summary().Audio).toBe('none (silent canvas)');
  });

  test('Render & verify starts the export; Cancel and ✕ close the sheet', () => {
    withSong({ exportOpen: true });
    const spies = stubActions();
    render(<Modals />);
    expect(document.getElementById('exportSheet')!.className).toContain('on');
    fireEvent.click(screen.getByText('Render & verify'));
    expect(spies.runExport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Cancel'));
    expect(st().exportOpen).toBe(false);
    update(() => S.setState({ exportOpen: true }));
    fireEvent.click(within(sheet()).getByText('✕'));
    expect(st().exportOpen).toBe(false);
  });

  test('cover and banner buttons export from the first clip; teasers from the latest render', () => {
    withSong();
    const spies = stubActions();
    render(<Modals />);
    expect(screen.queryByText('GIF Loop')).toBeNull();
    fireEvent.click(screen.getByText('Cover 3000×3000'));
    fireEvent.click(screen.getByText('Spotify Header 2660×1140'));
    expect(spies.exportCompanion.mock.calls.map(([o]) => o)).toEqual([
      { clip_id: 'a', kind: 'cover' },
      { clip_id: 'a', kind: 'spotify_header' },
    ]);
    update(() => S.setState({ renders: [{ filename: 'canvas-x.mp4', url: '/out/canvas-x.mp4' }] }));
    fireEvent.click(screen.getByText('WebP Loop'));
    expect(spies.exportCompanion).toHaveBeenLastCalledWith({ filename: 'canvas-x.mp4', kind: 'webp' });
    update(() => S.setState({ selected: [] }));
    expect((screen.getByText('Cover 3000×3000') as HTMLButtonElement).disabled).toBe(true);
  });

  test('batch buttons close the sheet and start the batch; the song batch names the folder', () => {
    withSong({ exportOpen: true, tracks: [...TRACKS, { ...TRACKS[1], id: 't9', name: 'Other.mp3', source: '/Users/me/Music' }] as any });
    const spies = stubActions();
    render(<Modals />);
    fireEvent.click(screen.getByText('🎲 Export 4 rolls'));
    expect(spies.runBatch).toHaveBeenCalledWith('rolls');
    expect(st().exportOpen).toBe(false);
    fireEvent.click(screen.getByText('This look on 2 songs in Canvas'));
    expect(spies.runBatch).toHaveBeenLastCalledWith('tracks');
  });

  test('the song batch is offered only when the folder has more than one song', () => {
    withSong({ tracks: [TRACKS[0]] as any });
    render(<Modals />);
    expect(screen.queryByText(/This look on/)).toBeNull();
  });
});

describe('variations', () => {
  const varCards = () => Array.from(document.querySelectorAll<HTMLElement>('#vars .look'));

  test('six mutations of the look are shown, and clicking one keeps it and the edit', () => {
    resetStudio({ varOpen: true, mutAmt: 0.45, varSeed: 1 });
    render(<Modals />);
    expect(document.getElementById('varModal')!.className).toContain('on');
    expect(varCards()).toHaveLength(6);
    expect(document.getElementById('varSub')!.textContent).toBe(`Mutations of ${LOOKS[0].name}, playing on your footage. Click one to keep it.`);
    const names = varCards().map((c) => c.querySelector('b')!.textContent);
    const stacks = varCards().map((c) => c.querySelector('span')!.textContent!);
    expect(new Set(stacks).size).toBeGreaterThan(1);
    for (const s of stacks) for (const n of s.split(' + ')) expect(Object.values(MODULES).some((m) => m.name === n), n).toBe(true);
    expect(st().varJobs).toHaveLength(6);
    const cut = st().look!.cut;
    fireEvent.click(varCards()[2]);
    expect(st().look!.name).toBe(names[2]);
    expect(st().look!.cut, 'the edit stays').toEqual(cut);
    expect(st().varOpen).toBe(false);
    expect(st().varJobs).toEqual([]);
  });

  test('variations take the shape of the screen', () => {
    resetStudio({ varOpen: true });
    update(() => st().setScreen('landscape'));
    render(<Modals />);
    const cv = document.querySelector<HTMLCanvasElement>('#vars canvas')!;
    expect([cv.width, cv.height]).toEqual([384, 216]);
    expect(document.getElementById('vars')!.dataset.screen).toBe('landscape');
  });

  test('Mutate again and the amount slider make new variations', () => {
    resetStudio({ varOpen: true, mutAmt: 0.45, varSeed: 1 });
    render(<Modals />);
    const stacks = () => varCards().map((c) => c.querySelector('span')!.textContent).join('|');
    const first = stacks();
    fireEvent.click(screen.getByText('⟳ Mutate again'));
    expect(st().varSeed).toBe(2);
    expect(stacks()).not.toBe(first);
    fireEvent.change(document.getElementById('mutAmt')!, { target: { value: '1' } });
    expect(st().mutAmt).toBe(1);
  });

  test('the backdrop and ✕ close it, and Escape-style closing clears every dialog', () => {
    resetStudio({ varOpen: true });
    render(<Modals />);
    fireEvent.click(document.getElementById('varModal')!);
    expect(st().varOpen).toBe(false);
    update(() => S.setState({ varOpen: true, helpOpen: true }));
    fireEvent.click(within(document.getElementById('varModal')!).getByTitle('Close (Esc)'));
    expect([st().varOpen, st().helpOpen]).toEqual([false, false]);
  });
});

describe('shortcuts', () => {
  test('the help dialog lists the keyboard shortcuts', () => {
    resetStudio({ helpOpen: true });
    render(<Modals />);
    const keys = Array.from(document.querySelectorAll('#helpModal .keys .kbd')).map((k) => k.textContent);
    expect(keys).toEqual(['Space', '← →', 'M', 'D', '⇧ D', 'R', 'E', '[ ]', '1–4', 'H', 'S', 'O', 'L', 'T', 'B', '⌘ D', 'Delete', 'N', '⌘ Z', '?', 'Esc', 'Drag', '⇧ Drag', '⌥ Drag', 'Dbl-click']);
    fireEvent.click(within(document.getElementById('helpModal')!).getByTitle('Close (Esc)'));
    expect(st().helpOpen).toBe(false);
  });
});
