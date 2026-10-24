// Block editing on the timeline: the toolbar, the keys, the drag handles and the segment menu's actions.
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { App } from '../../downbeat/studio/src/App.tsx';
import { TimelinePanel } from '../../downbeat/studio/src/components/TimelinePanel.tsx';
import { S, pop, popButton, renderStudio, resetStudio, st, toastText, update } from './studio.tsx';

const lane = () => document.getElementById('lane') as HTMLCanvasElement;
const tools = () => document.getElementById('blockTools') as HTMLElement;
const tool = (text: string) => within(tools()).getByText(text) as HTMLButtonElement;
const t0s = () => st().ctx!.tl.segs.map((s) => +s.t0.toFixed(6));
const clips = () => st().ctx!.tl.segs.map((s) => s.clipId);
const rect = (el: HTMLElement, width: number, height = 60) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() {} });

/** Bar cuts in an 8 s loop at 120 BPM (cuts at 2, 4 and 6 s, a beat every 0.5 s) on a 400 px lane: 50 px a second. */
function barEdit(over = {}) {
  resetStudio(over);
  update(() => {
    Object.assign(st().look!.cut, { rhythm: 'bar', transitions: ['dissolve'], beats: 1 });
    st().rebuild();
  });
}
function laneEdit(over = {}) {
  barEdit(over);
  renderStudio(<TimelinePanel />);
  rect(lane(), 400);
  lane().setPointerCapture = () => {};
}
const seek = (t: number) => update(() => st().transport.seek(t));

describe('block toolbar', () => {
  test('splits at the playhead on the beat, repeats, deletes and puts a clip in, all without a keyboard', () => {
    laneEdit();
    seek(3.1);
    fireEvent.click(tool('✂ Split'));
    expect(t0s(), 'on the nearest beat').toEqual([0, 2, 3, 4, 6]);
    expect(toastText()).toBe('Split segment 2');
    expect(st().selectedBlock).toBe('h1');

    fireEvent.click(tool('Repeat'));
    expect(t0s()).toEqual([0, 2, 3, 3.5, 4, 6]);
    expect(toastText()).toBe('Segment 3 plays its first half twice');
    const [a, b] = [st().ctx!.tl.segs[2], st().ctx!.tl.segs[3]];
    expect([b.clipId, b.in, b.trans]).toEqual([a.clipId, a.in, 'cut']);

    fireEvent.click(tool('Delete'));
    expect(t0s(), 'the selected segment goes, and the one before plays on').toEqual([0, 2, 3.5, 4, 6]);
    expect(toastText()).toBe('Deleted segment 3. Segment 2 plays on to the next cut.');

    fireEvent.click(tool('Put a clip in'));
    expect(pop().className).toContain('clip-pick');
    fireEvent.click(pop().querySelector('.seg-clip[title="#3 cover"]')!);
    expect(t0s()).toEqual([0, 2, 3, 3.5, 4, 6]);
    expect(clips()[2]).toBe('c');
    expect(st().ctx!.tl.segs[2].trans, 'a clip put in takes a transition from the pool').toBe('dissolve');
    expect(toastText()).toBe('Put clip 3 in segment 2');
    expect(pop().classList.contains('on')).toBe(false);
  });

  test('splitting where there is already a cut says so, and the last segment cannot be deleted', () => {
    laneEdit();
    seek(1.9);
    fireEvent.click(tool('✂ Split'));
    expect(toastText()).toBe("There's already a cut here");
    expect(t0s()).toEqual([0, 2, 4, 6]);
    for (const t of [6.5, 4.5, 2.5]) {
      seek(t);
      update(() => st().selectBlock(null));
      fireEvent.click(tool('Delete'));
    }
    expect(t0s()).toEqual([0]);
    expect(tool('Delete').disabled).toBe(true);
    update(() => st().deleteBlock());
    expect(toastText()).toBe('The loop needs at least one segment');
  });

  test('the snap buttons set what cuts snap to, and say so', () => {
    laneEdit();
    const snap = within(tools()).getByText('Snap').parentElement as HTMLElement;
    expect(within(snap).getAllByRole('button').map((x) => x.textContent)).toEqual(['Beat', '½', '¼', 'Off']);
    expect(within(snap).getByText('Beat').className).toBe('on');
    fireEvent.click(within(snap).getByText('½'));
    expect(st().snap).toBe(2);
    expect(toastText()).toBe('Cuts snap to half beats');
    seek(3.3);
    fireEvent.click(tool('✂ Split'));
    expect(t0s(), 'the blade snaps too, to the half beat at 3.25 s').toEqual([0, 2, 3.25, 4, 6]);
  });
});

describe('transition handles', () => {
  test("dragging a transition window's edge sets that cut's length, held to fit its neighbours", () => {
    laneEdit();
    // the window at 2 s is a beat long: 1.75 to 2.25 s, 87.5 to 112.5 px
    fireEvent.pointerMove(lane(), { clientX: 112, clientY: 30 });
    expect(lane().style.cursor).toBe('col-resize');
    fireEvent.pointerMove(lane(), { clientX: 101, clientY: 30 });
    expect(lane().style.cursor, 'the cut line wins close to the cut').toBe('ew-resize');
    fireEvent.pointerDown(lane(), { clientX: 112.5, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(lane(), { clientX: 125, clientY: 30, pointerId: 1 });
    expect(st().blocks!.find((b) => b.id === 'g1')!.transBeats, 'half a second each side: 2 beats').toBe(2);
    expect(st().ctx!.tl.segs[1].transDur).toBe(1);
    expect(st().ctx!.tl.segs[2].transDur, 'the other cuts keep theirs').toBe(0.5);
    fireEvent.pointerMove(lane(), { clientX: 175, clientY: 30, pointerId: 1 });
    expect(st().ctx!.tl.segs[1].transDur, '6 beats asked, 90% of the 2 s segments given').toBeCloseTo(1.8, 9);
    fireEvent.pointerUp(lane(), { pointerId: 1 });

    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const length = Array.from(pop().querySelectorAll('.seg-f')).find((f) => f.querySelector('.seg-l span')?.textContent === 'Transition length') as HTMLElement;
    expect(length.querySelector('.seg-val')!.textContent).toBe('3.6 beats');
    expect(length.querySelector('.seg-note')!.textContent).toBe('Shortened from 6 beats to fit the segments either side.');
    expect(length.querySelector('.seg-mine')).toBeTruthy();
    fireEvent.click(within(length).getByText('½'));
    expect(st().ctx!.tl.segs[1].transDur).toBe(0.25);
    fireEvent.click(within(length).getByText('Auto'));
    expect(st().ctx!.tl.segs[1].transDur).toBe(0.5);
    expect(st().blocks, 'back to the rolled edit').toBe(null);
  });

  test('a hard cut has no length to set', () => {
    laneEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    fireEvent.click(popButton('Hard Cut'));
    const length = Array.from(pop().querySelectorAll('.seg-f')).find((f) => f.querySelector('.seg-l span')?.textContent === 'Transition length') as HTMLElement;
    expect(length.querySelector('.seg-note')!.textContent).toBe('A hard cut has no length.');
    expect(st().ctx!.tl.segs[1].transDur).toBe(0);
  });
});

describe('segment menu actions', () => {
  test('the menu stays on its segment through a split, puts a clip in its second half, and moves on after a delete', () => {
    laneEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const head = () => pop().querySelector('h4')!.textContent;
    expect(head()).toBe('Segment 2 of 4');
    seek(5); // in another segment, so the split goes in the middle
    fireEvent.click(popButton('✂ Split'));
    expect(t0s()).toEqual([0, 2, 3, 4, 6]);
    expect(head()).toBe('Segment 2 of 5');

    fireEvent.click(popButton('Put a clip in'));
    expect(pop().querySelector('.seg-put small')!.textContent).toBe('Pick the clip for the second half');
    fireEvent.click(pop().querySelector('.seg-put .seg-clip[title="#1 1 sunrise.mp4"]')!);
    expect(t0s()).toEqual([0, 2, 2.5, 3, 4, 6]);
    expect(clips()[2]).toBe('a');
    expect(pop().querySelector('.seg-put'), 'the tiles close after a pick').toBeNull();

    fireEvent.click(pop().querySelector('[aria-label="Next segment"]')!);
    expect(head()).toBe('Segment 3 of 6');
    fireEvent.click(popButton('Delete'));
    expect(t0s()).toEqual([0, 2, 3, 4, 6]);
    expect(head(), 'onto the segment that took the time').toBe('Segment 2 of 5');
    expect(pop().querySelector('.seg-foot span')!.textContent).toBe('This edit is cut by hand. The rhythm buttons and the dice start the cuts over.');
  });

  test('the menu opens beside the preview when there is room, and shows a live copy of it when there is not', () => {
    laneEdit();
    const view = document.createElement('canvas');
    view.id = 'view';
    view.width = 540;
    view.height = 960;
    document.body.append(view);
    const box = (el: HTMLElement, left: number, top: number, width: number, height: number) =>
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
    const width = window.innerWidth;
    const peek = () => pop().querySelector('.seg-peek-wrap') as HTMLElement;
    try {
      Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
      box(view, 600, 80, 260, 462);
      fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
      expect([pop().style.left, pop().style.width], 'to the right of the preview').toEqual(['872px', '660px']);
      expect(peek().hidden, 'the preview is in sight, so no copy').toBe(true);

      Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });
      view.width = 1920; // a landscape preview, nearly as wide as the window
      view.height = 1080;
      box(view, 50, 80, 800, 450);
      box(pop(), 8, 8, 884, 800);
      fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
      expect(pop().style.width, 'no side has room for it').toBe('');
      expect(peek().hidden).toBe(false);
      const copy = pop().querySelector('.seg-peek') as HTMLCanvasElement;
      expect([copy.style.width, copy.style.height], 'in the shape of the preview, at most 300 by 200').toEqual(['300px', '169px']);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
      view.remove();
    }
  });

  test('a long press on a touch screen opens the menu, and moving cancels it', () => {
    vi.useFakeTimers();
    try {
      laneEdit();
      fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 1, pointerType: 'touch' });
      fireEvent.pointerMove(lane(), { clientX: 140, clientY: 30, pointerId: 1, pointerType: 'touch' });
      act(() => vi.advanceTimersByTime(600));
      expect(pop().classList.contains('on'), 'moved, so no menu').toBe(false);
      fireEvent.pointerUp(lane(), { pointerId: 1, pointerType: 'touch' });
      fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 2, pointerType: 'touch' });
      act(() => vi.advanceTimersByTime(500));
      expect(pop().className).toContain('seg-menu');
      expect(pop().querySelector('h4')!.textContent).toBe('Segment 2 of 4');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('block keys', () => {
  const press = (key: string, o: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key, ...o });
  function renderApp() {
    barEdit();
    update(() => S.setState({ initStudio: vi.fn() } as any));
    render(<App />);
  }

  test('B splits at the playhead, Delete removes the selected segment, ⌘D repeats it and N steps the snap', () => {
    renderApp();
    seek(4.9);
    press('b');
    expect(t0s()).toEqual([0, 2, 4, 5, 6]);
    press('Backspace');
    expect(t0s()).toEqual([0, 2, 4, 6]);
    const e = new KeyboardEvent('keydown', { key: 'd', metaKey: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented, 'the browser does not bookmark the page').toBe(true);
    expect(t0s(), 'segment 3 took the time and is selected, so it plays its first half twice').toEqual([0, 2, 4, 5, 6]);
    press('d', { ctrlKey: true });
    expect(st().ctx!.tl.segs).toHaveLength(6);
    expect(st().snap).toBe(1);
    press('n');
    press('n');
    expect(st().snap).toBe(4);
    press('n');
    press('n');
    expect(st().snap).toBe(1);
    press('Escape');
    expect(st().selectedBlock).toBe(null);
  });
});
