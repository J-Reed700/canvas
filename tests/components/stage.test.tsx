import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, within } from '@testing-library/react';
import { StagePanel } from '../../downbeat/studio/src/components/StagePanel.tsx';
import { TopBar } from '../../downbeat/studio/src/components/TopBar.tsx';
import { LOOKS, S, pop, popButton, popButtons, renderStudio, resetStudio, screen, st, toastText, update, withSong } from './studio.tsx';

// The preview reframes whichever clip is on screen, which the render loop reports.
const onScreen = vi.hoisted(() => ({ frame: null as any }));
vi.mock('../../downbeat/studio/src/canvas/renderLoop.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLastFrame: () => onScreen.frame,
}));

const barsSeg = () => document.getElementById('barsSeg') as HTMLElement;
const view = () => document.getElementById('view') as HTMLCanvasElement;

describe('transport', () => {
  test('play and pause follow the transport, whoever starts it', () => {
    resetStudio();
    renderStudio(<StagePanel />);
    const btn = document.getElementById('btnPlay') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('Play');
    fireEvent.click(btn);
    expect(st().transport.playing).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Pause');
    act(() => st().transport.pause());
    expect(btn.getAttribute('aria-label')).toBe('Play');
    fireEvent.click(screen.getByLabelText('Play', { selector: '.pp' }));
    expect(st().transport.playing).toBe(true);
    act(() => st().transport.pause());

    resetStudio({ exporting: true });
    fireEvent.click(btn);
    expect(st().transport.playing, 'no playback during an export').toBe(false);
  });

  test('bar presets set the length; a typed length gets its own button that opens Edit', () => {
    resetStudio();
    renderStudio(<StagePanel />);
    expect(within(barsSeg()).getAllByRole('button').map((b) => b.textContent)).toEqual(['1 bar', '2', '4', '8']);
    expect(within(barsSeg()).getByText('4').className).toBe('on');
    fireEvent.click(within(barsSeg()).getByText('8'));
    expect(st().bars).toBe(8);
    expect(within(barsSeg()).getByText('8').getAttribute('title')).toBe('16.00 s');
    update(() => st().setBars(37));
    const custom = within(barsSeg()).getByText('37 · 1:14');
    expect(custom.className).toBe('on');
    fireEvent.click(custom);
    expect(st().tab).toBe('edit');
  });

  test('presets longer than the song are off', () => {
    withSong({ features: { duration: 12, bpm: 120, downbeats: [1.5, 3.5, 5.5, 7.5, 9.5], loops: [] } as any, loopStart: 1.5 });
    renderStudio(<StagePanel />);
    expect((within(barsSeg()).getByText('8') as HTMLButtonElement).disabled).toBe(true);
    expect((within(barsSeg()).getByText('4') as HTMLButtonElement).disabled).toBe(false);
  });

  test('Loop and Listener only show with a song; Off-sync only while listening', () => {
    resetStudio();
    renderStudio(<StagePanel />);
    expect(document.getElementById('modeSeg')!.style.display).toBe('none');
    expect(document.getElementById('tMute')!.style.display).toBe('none');
    withSong();
    expect(document.getElementById('modeSeg')!.style.display).toBe('');
    expect(document.getElementById('tOffSync')!.style.display).toBe('none');
    fireEvent.click(screen.getByText('Listener'));
    expect(st().transport.mode).toBe('listen');
    expect(screen.getByText('Listener').className).toBe('on');
    const off = document.getElementById('tOffSync')!;
    expect(off.style.display).toBe('');
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    fireEvent.click(off);
    expect(st().transport.phase).toBe(2);
    expect(off.textContent).toBe('Off-sync +2.00s');
    expect(toastText()).toBe('Canvas offset by 2.00 s from the song');
    fireEvent.click(off);
    expect(st().transport.phase).toBe(0);
    expect(toastText()).toBe('Canvas back in step with the song');
    fireEvent.click(screen.getByText('Loop'));
    expect(st().transport.mode).toBe('loop');
  });

  test('Player UI, Safe zones and Sound toggle their overlays and the audio', () => {
    withSong();
    renderStudio(<StagePanel />);
    fireEvent.click(screen.getByText('Player UI'));
    expect(st().hud).toBe(false);
    expect(document.getElementById('hud')!.className).toContain('hidden');
    fireEvent.click(screen.getByText('Safe zones'));
    expect(st().safe).toBe(true);
    expect(document.getElementById('safe')!.className).toContain('on');
    expect(screen.getByText('Safe zones').className).toContain('on');
    fireEvent.click(screen.getByText('Sound'));
    expect(st().muted).toBe(true);
    expect(st().transport.muted).toBe(true);
    expect(screen.getByText('Sound').className).not.toContain('on');
  });

  test('the screen menu changes the device and picks an export format of its shape', () => {
    resetStudio();
    renderStudio(<StagePanel />);
    const phone = document.getElementById('phone')!;
    const btn = document.getElementById('tScreen') as HTMLButtonElement;
    const pick = (name: string) => {
      fireEvent.click(btn);
      fireEvent.click(popButton(new RegExp(`^${name}`)));
    };
    expect(phone.dataset.screen).toBe('phone');
    expect(btn.getAttribute('aria-label')).toBe('Screen: Phone 9:16');
    fireEvent.click(btn);
    expect(pop().className).toContain('on');
    expect(popButtons()).toEqual([
      'PhoneSpotify Canvas9:16',
      'LandscapeYouTube visualizer16:9',
      'TabletApple Music motion art3:4',
      'SquareSocial feeds, Apple square art, cover art1:1',
    ]);
    expect(popButton(/^Phone/).className).toContain('on');
    fireEvent.click(popButton(/^Landscape/));
    expect(pop().className, 'picking closes the menu').not.toContain('on');
    expect(st().exportOpts.format).toBe('youtube_16_9');
    expect(phone.dataset.screen).toBe('landscape');
    expect(btn.getAttribute('aria-label')).toBe('Screen: Landscape 16:9');
    expect(toastText()).toBe('Landscape · exports as YouTube 16:9');
    pick('Tablet');
    expect(st().exportOpts.format).toBe('apple_tall');
    pick('Square');
    expect(st().exportOpts.format).toBe('social_square');
    update(() => S.setState({ exportOpts: { ...st().exportOpts, format: 'cover_art' } }));
    pick('Square');
    expect(st().exportOpts.format, 'a square format stays picked').toBe('cover_art');
    pick('Phone');
    expect(st().exportOpts.format).toBe('spotify');
    expect(phone.dataset.screen).toBe('phone');

    resetStudio({ exporting: true });
    expect(btn.disabled, 'no switching during an export').toBe(true);
  });

  test('safe zones are for the Spotify phone, so other screens turn them off', () => {
    resetStudio({ safe: true });
    renderStudio(<StagePanel />);
    const btn = screen.getByText('Safe zones') as HTMLButtonElement;
    expect(document.getElementById('safe')!.className).toContain('on');
    update(() => st().setScreen('tablet'));
    expect(document.getElementById('safe')!.className).not.toContain('on');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/9:16 phone/);
    update(() => st().setScreen('phone'));
    expect(document.getElementById('safe')!.className, 'and back on the phone').toContain('on');
  });

  test('the phone shows the song title, and a hint when no clips are picked', () => {
    withSong();
    renderStudio(<StagePanel />);
    expect(document.getElementById('hudTitle')!.textContent).toBe('Night Drive');
    expect((document.getElementById('emptyStage') as HTMLElement).hidden).toBe(true);
    resetStudio({ selected: [] });
    expect(document.getElementById('hudTitle')!.textContent).toBe('Downbeat');
    expect((document.getElementById('emptyStage') as HTMLElement).hidden).toBe(false);
  });
});

describe('reframing on the preview', () => {
  const setup = () => {
    resetStudio();
    renderStudio(<StagePanel />);
    onScreen.frame = { needs: [{ clipId: 'b', cam: { zoom: 1 } }] };
    vi.spyOn(view(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 270, height: 480, right: 270, bottom: 480, x: 0, y: 0, toJSON() {} });
    view().setPointerCapture = () => {};
  };

  test('dragging moves the crop of the clip on screen, within the frame', () => {
    setup();
    fireEvent.pointerDown(view(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(view(), { clientX: 150, clientY: 100, pointerId: 1 });
    const [x, y, zoom] = st().clipFrame.b;
    const frac = (9 / 16) / (16 / 9); // a 16:9 clip in the 9:16 frame
    expect(x).toBeCloseTo(0.5 - (50 / 270) * frac, 9);
    expect([y, zoom]).toEqual([0.5, 1]);
    expect(st().ctx!.tl.segs.find((s) => s.clipId === 'b')!.focus).toEqual(st().clipFrame.b);
    fireEvent.pointerMove(view(), { clientX: 2000, clientY: 100, pointerId: 1 });
    expect(st().clipFrame.b[0]).toBeCloseTo(0.5 - (1 - frac) / 2, 9);
    fireEvent.pointerUp(view(), { pointerId: 1 });
    expect(toastText()).toBe('Reframed city.mp4 · double-click the preview to reset');
  });

  test('on a landscape screen a portrait clip pans up and down instead', () => {
    setup();
    update(() => st().setScreen('landscape'));
    onScreen.frame = { needs: [{ clipId: 'a', cam: { zoom: 1 } }] };
    vi.spyOn(view(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 480, height: 270, right: 480, bottom: 270, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(view(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(view(), { clientX: 100, clientY: 127, pointerId: 1 });
    const [x, y] = st().clipFrame.a;
    expect(x).toBe(0.5);
    expect(y).toBeCloseTo(0.5 + (27 / 270) * ((9 / 16) / (16 / 9)), 9);
    fireEvent.pointerUp(view(), { pointerId: 1 });
  });

  test('scrolling zooms between 1× and 3×, and double-click resets the framing', () => {
    setup();
    fireEvent.wheel(view(), { deltaY: -200 });
    expect(st().clipFrame.b[2]).toBeCloseTo(Math.exp(0.3), 9);
    fireEvent.wheel(view(), { deltaY: 100000 });
    expect(st().clipFrame.b[2]).toBe(1);
    fireEvent.doubleClick(view());
    expect(st().clipFrame.b).toBeUndefined();
    expect(toastText()).toBe('Framing reset for city.mp4');
  });

  test('a click without a drag changes nothing, and nothing happens before a frame is drawn', () => {
    setup();
    fireEvent.pointerDown(view(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(view(), { pointerId: 1 });
    expect(toastText()).toBe('');
    onScreen.frame = null;
    fireEvent.pointerDown(view(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(view(), { clientX: 200, clientY: 100, pointerId: 1 });
    expect(st().clipFrame).toEqual({});
  });
});

describe('top bar', () => {
  test('chips show the song, tempo, loop length, look and clip count', () => {
    resetStudio();
    renderStudio(<TopBar />);
    const chips = () => Array.from(document.querySelectorAll('#chips .chip')).map((c) => c.textContent);
    expect(chips()).toEqual(['No track · BPM clock', '120 BPM', '8.00s 4 bars loop', `Look ${LOOKS[0].name}`, '3 clips']);
    withSong({ bars: 75 });
    expect(chips()).toEqual(['Night Drive', '120 BPM', '2:30 75 bars loop', `Look ${LOOKS[0].name}`, '3 clips']);
    update(() => st().setBars(1));
    expect(chips()[2]).toBe('2.00s 1 bar loop');
  });

  test('Roll rolls everything, and the menu chooses what a roll changes and can undo it', () => {
    resetStudio();
    renderStudio(<TopBar />);
    fireEvent.click(document.getElementById('btnRoll')!);
    expect(st().lookId).not.toBe(LOOKS[0].id);
    expect(toastText()).toMatch(/^Rolled /);
    fireEvent.click(document.getElementById('btnRollOpts')!);
    const boxes = Array.from(pop().querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true, false, false]);
    fireEvent.click(boxes[4]);
    expect(st().rollOpts.loop).toBe(true);
    fireEvent.click(popButton(/Undo last roll/));
    expect(st().lookId).toBe(LOOKS[0].id);
    expect(pop().className).toBe('pop');
  });

  test('Undo and Redo step back and forward through edits, and are off with nothing to step to', () => {
    vi.useFakeTimers();
    resetStudio();
    renderStudio(<TopBar />);
    const undoBtn = document.getElementById('btnUndo') as HTMLButtonElement;
    const redoBtn = document.getElementById('btnRedo') as HTMLButtonElement;
    const edit = (bars: number) => {
      update(() => st().setBars(bars));
      act(() => vi.advanceTimersByTime(400)); // an edit becomes a step once it settles
    };
    expect([undoBtn.disabled, redoBtn.disabled]).toEqual([true, true]);
    edit(8);
    edit(2);
    expect([undoBtn.disabled, redoBtn.disabled]).toEqual([false, true]);
    fireEvent.click(undoBtn);
    expect(st().bars).toBe(8);
    expect(toastText()).toBe('↶ Undo');
    fireEvent.click(undoBtn);
    expect(st().bars).toBe(4);
    expect([undoBtn.disabled, redoBtn.disabled]).toEqual([true, false]);
    fireEvent.click(redoBtn);
    fireEvent.click(redoBtn);
    expect(st().bars).toBe(2);
    expect(toastText()).toBe('↷ Redo');
    expect([undoBtn.disabled, redoBtn.disabled]).toEqual([false, true]);

    fireEvent.click(undoBtn);
    edit(1);
    expect(redoBtn.disabled, 'a new edit drops the steps you undid').toBe(true);
    update(() => st().setBars(4));
    fireEvent.click(undoBtn);
    expect(st().bars, 'an edit made just now is undone too').toBe(1);

    update(() => S.setState({ exporting: true }));
    expect([undoBtn.disabled, redoBtn.disabled]).toEqual([true, true]);
    vi.useRealTimers();
  });

  test('Export opens the export sheet and ? opens the shortcuts', () => {
    resetStudio();
    renderStudio(<TopBar />);
    fireEvent.click(document.getElementById('btnExport')!);
    expect(st().exportOpen).toBe(true);
    fireEvent.click(document.getElementById('btnHelp')!);
    expect(st().helpOpen).toBe(true);
  });
});
