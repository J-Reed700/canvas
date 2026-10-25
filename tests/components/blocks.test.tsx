// Block editing on the timeline: the toolbar, the keys, the drag handles and the inspector's segment panel.
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, within } from '@testing-library/react';
import { App } from '../../downbeat/studio/src/components/App/App.tsx';
import { TimelinePanel } from '../../downbeat/studio/src/components/TimelinePanel/TimelinePanel.tsx';
import { EditPane } from '../../downbeat/studio/src/components/EditPane/EditPane.tsx';
import { beatName, stepBeat } from '../../downbeat/studio/src/components/SegmentMenu/segTiming.ts';
import { render, S, pop, renderStudio, resetStudio, screen, segButton, segPanel, st, toastText, update } from './studio.tsx';

const lane = () => document.getElementById('lane') as HTMLCanvasElement;
const tools = () => document.getElementById('blockTools') as HTMLElement;
const tool = (text: string) => within(tools()).getByText(text) as HTMLButtonElement;
const t0s = () => st().ctx!.tl.segs.map((s) => +s.t0.toFixed(6));
const clips = () => st().ctx!.tl.segs.map((s) => s.clipId);
/** Which segment the inspector is editing, as "Segment n of m". */
const editing = () => {
  const segs = st().ctx!.tl.segs;
  return `Segment ${segs.findIndex((x) => x.id === st().editBlock) + 1} of ${segs.length}`;
};
const where = () => segPanel().querySelector('.seg-where')!.textContent;
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
  renderStudio(<><TimelinePanel /><EditPane /></>);
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
    const length = Array.from(segPanel().querySelectorAll('.seg-f')).find((f) => f.querySelector('.seg-l span')?.textContent === 'Transition length') as HTMLElement;
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
    fireEvent.click(within(segPanel()).getByRole('button', { name: 'Choose transition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use Hard Cut' }));
    const length = Array.from(segPanel().querySelectorAll('.seg-f')).find((f) => f.querySelector('.seg-l span')?.textContent === 'Transition length') as HTMLElement;
    expect(length.querySelector('.seg-note')!.textContent).toBe('A hard cut has no length.');
    expect(st().ctx!.tl.segs[1].transDur).toBe(0);
  });
});

describe('segment panel actions', () => {
  test('the panel stays on its segment through a split and a clip put in, and moves on after a delete', () => {
    laneEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    expect(editing()).toBe('Segment 2 of 4');
    expect(where()).toBe('Bar 2, beat 1 · 2.00 s long');
    seek(5); // in another segment, so the split goes in the middle
    fireEvent.click(segButton('✂ Split'));
    expect(t0s()).toEqual([0, 2, 3, 4, 6]);
    expect(editing(), 'the panel keeps the segment it was editing: its first half').toBe('Segment 2 of 5');
    expect(where()).toBe('Bar 2, beat 1 · 1.00 s long');

    fireEvent.click(segButton('Put a clip in'));
    expect(segPanel().querySelector('.seg-put small')!.textContent).toBe('Pick the clip for the second half');
    fireEvent.click(segPanel().querySelector('.seg-put .seg-clip[title="#1 1 sunrise.mp4"]')!);
    expect(t0s()).toEqual([0, 2, 2.5, 3, 4, 6]);
    expect(clips()[2]).toBe('a');
    expect(segPanel().querySelector('.seg-put'), 'the tiles close after a pick').toBeNull();
    expect(editing(), 'still on the segment the clip went into').toBe('Segment 2 of 6');

    fireEvent.click(segButton('Delete'));
    expect(t0s()).toEqual([0, 2.5, 3, 4, 6]);
    expect(editing(), 'onto the segment that took the time').toBe('Segment 1 of 5');
    expect(where()).toBe('Bar 1, beat 1 · 2.50 s long');
  });

  test('the panel sits in the inspector, not a popover, and keeps its open sections from one segment to the next', () => {
    laneEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    expect(pop().classList.contains('on'), 'no floating menu').toBe(false);
    expect(segPanel().closest('#pane-edit')).toBeTruthy();
    expect((segPanel().querySelector('.seg-peek-wrap') as HTMLElement).hidden, 'the preview is in sight, so its copy stays hidden').toBe(true);
    const family = (key: string) => segPanel().querySelector(`details[data-family="${key}"]`) as HTMLDetailsElement;
    expect(['timing', 'playback', 'framing'].map((k) => family(k).open)).toEqual([true, true, true]);
    family('playback').open = false;
    fireEvent(family('playback'), new Event('toggle'));
    fireEvent.click(segPanel().querySelector('[aria-label="Next segment"]')!);
    expect(editing()).toBe('Segment 3 of 4');
    expect(['timing', 'playback', 'framing'].map((k) => family(k).open)).toEqual([true, false, true]);
    family('playback').open = true;
    fireEvent(family('playback'), new Event('toggle'));
  });

  test('a long press on a touch screen shows the segment in the inspector, and moving cancels it', () => {
    vi.useFakeTimers();
    try {
      laneEdit();
      fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 1, pointerType: 'touch' });
      fireEvent.pointerMove(lane(), { clientX: 140, clientY: 30, pointerId: 1, pointerType: 'touch' });
      act(() => vi.advanceTimersByTime(600));
      expect(st().tab, 'moved, so the inspector stays where it was').toBe('layers');
      fireEvent.pointerUp(lane(), { pointerId: 1, pointerType: 'touch' });
      update(() => st().selectBlock(null));
      fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 2, pointerType: 'touch' });
      act(() => vi.advanceTimersByTime(500));
      expect(st().tab).toBe('edit');
      expect(editing()).toBe('Segment 2 of 4');
      expect(segPanel()).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('segment timing', () => {
  const timing = () => segPanel().querySelector('.seg-time') as HTMLElement;
  const cut = (label: string) => Array.from(timing().querySelectorAll('.seg-cut')).find((c) => c.querySelector('.lbl')!.textContent === label) as HTMLElement;
  const val = (label: string) => cut(label).querySelector('.seg-val')!.textContent;
  const later = (label: string) => within(cut(label)).getByLabelText(/later$/) as HTMLButtonElement;
  const earlier = (label: string) => within(cut(label)).getByLabelText(/earlier$/) as HTMLButtonElement;

  test('names beats by bar, beat and eighth, and steps along the snap grid', () => {
    expect([0, 4, 6.5, 7.25, 3.875, 5.33].map(beatName)).toEqual(['Bar 1, beat 1', 'Bar 2, beat 1', 'Bar 2, beat 3½', 'Bar 2, beat 4¼', 'Bar 1, beat 4⅞', 'Bar 2, beat 2.33']);
    expect([stepBeat(4, 1, 1), stepBeat(4.3, -1, 1), stepBeat(4.3, 1, 2), stepBeat(4, -1, 4), stepBeat(4, 1, 0)]).toEqual([5, 4, 4.5, 3.75, 4.125]);
  });

  test('the steppers move either cut of a segment along the grid, off the bar lines, and the seam stays put', () => {
    laneEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    expect([val('Starts'), val('Ends')]).toEqual(['Bar 2, beat 1', 'Bar 3, beat 1']);
    fireEvent.click(later('Starts'));
    expect(t0s(), 'a beat later').toEqual([0, 2.5, 4, 6]);
    expect(val('Starts')).toBe('Bar 2, beat 2');
    fireEvent.click(within(timing().querySelector('.seg-snap') as HTMLElement).getByText('¼'));
    expect(st().snap).toBe(4);
    fireEvent.click(earlier('Ends'));
    expect(t0s(), 'the end cut is the next segment\'s start').toEqual([0, 2.5, 3.875, 6]);
    expect(val('Ends')).toBe('Bar 2, beat 4¾');
    expect(timing().querySelector('.seg-len')!.textContent).toBe('1.38 s, 2.75 beats');
    expect(st().ctx!.tl.handCut).toBe(true);

    fireEvent.click(segPanel().querySelector('[aria-label="Previous segment"]')!);
    expect(val('Starts')).toBe('Start of the loop');
    expect(earlier('Starts').disabled && later('Starts').disabled, 'the loop seam').toBe(true);
  });

  test('in a Rebound loop the strip works in the edited half: cuts stay in it and the playhead follows the mirror', () => {
    // the cuts fill the first 4 s of the 8 s loop, and the second half plays them backward
    laneEdit({ rebound: true });
    const tl = () => st().ctx!.tl;
    expect(tl().L).toBe(4);
    seek(6); // plays the moment at 2 s of the edit, on the way back
    fireEvent.doubleClick(lane(), { clientX: 150, clientY: 30 });
    const last = tl().segs.at(-1)!;
    expect(editing()).toBe(`Segment ${tl().segs.length} of ${tl().segs.length}`);
    expect(val('Ends')).toBe('End of the loop');
    const head = timing().querySelector('.zhead') as HTMLElement;
    expect(head.hidden).toBe(false);
    for (let i = 0; i < 20 && !later('Starts').disabled; i++) fireEvent.click(later('Starts'));
    expect(later('Starts').disabled).toBe(true);
    const moved = tl().segs.find((x) => x.id === last.id)!;
    expect(moved.t0).toBeGreaterThan(last.t0);
    expect(moved.t0, 'short of the turn in the middle of the loop').toBeLessThan(4);
    expect(tl().segs.at(-1)!.t1).toBe(4);
  });

  test('on the strip, a cut line drags to anywhere with Shift, a band edge sets the length, and a double-click splits', () => {
    laneEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const zoom = () => timing().querySelector('.seg-zoom') as HTMLElement;
    // the strip shows 4 s around segment 2 (2 to 4 s), from 0 to 6 s: 400 px is 66.7 px a second
    rect(zoom(), 400);
    const px = (t: number) => (t / 6) * 400;
    expect(timing().querySelectorAll('.zcut')).toHaveLength(2);
    fireEvent.pointerDown(within(timing()).getByLabelText('The start cut'), { clientX: px(2), pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientX: px(2.3), shiftKey: true });
    fireEvent.pointerUp(window, {});
    expect(t0s()[1]).toBeCloseTo(2.3, 6);
    expect(val('Starts')).toBe('Bar 2, beat 1.60');

    // segment 2 now starts at 2.3 s, so the strip runs from 0.3 s
    const px2 = (t: number) => ((t - 0.3) / 5.7) * 400;
    rect(zoom(), 400);
    const band = st().ctx!.tl.segs[2]; // the end cut, at 4 s, a beat long
    fireEvent.pointerDown(timing().querySelectorAll('.zedge')[3], { clientX: px2(4.25), pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientX: px2(4.5) });
    fireEvent.pointerUp(window, {});
    expect(st().blocks!.find((b) => b.id === band.id)!.transBeats).toBe(2);

    rect(zoom(), 400);
    fireEvent.dblClick(zoom(), { clientX: px2(3.4) });
    expect(t0s().map((t) => +t.toFixed(3))).toEqual([0, 2.3, 3.5, 4, 6]);
  });
});

describe('showing a segment in the inspector', () => {
  test('right-click a block and the toolbar button both select it and switch the inspector to Edit', () => {
    laneEdit();
    const e = new MouseEvent('contextmenu', { clientX: 225, clientY: 30, bubbles: true, cancelable: true });
    act(() => void lane().dispatchEvent(e));
    expect(e.defaultPrevented, 'no browser menu').toBe(true);
    expect(editing()).toBe('Segment 3 of 4');
    expect(st().selectedBlock).toBe(st().ctx!.tl.segs[2].id);
    expect(st().tab).toBe('edit');
    expect(where()).toBe('Bar 3, beat 1 · 2.00 s long');
    expect(document.querySelector('.lane-edit'), 'no floating chip on the block').toBeNull();

    update(() => {
      st().selectBlock(null);
      st().setTab('layers');
    });
    seek(0.5);
    expect(segPanel(), 'nothing selected, so the whole edit').toBeNull();
    fireEvent.click(tool('✎ Edit segment'));
    expect(editing(), 'the one under the playhead').toBe('Segment 1 of 4');
    expect(st().tab).toBe('edit');
    expect(tool('✎ Edit segment 1')).toBeTruthy();
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

  test('← → step through the segments while one is showing in the Edit tab, and through the looks otherwise', () => {
    renderApp();
    const look = st().look!.id;
    press('ArrowRight');
    expect(st().look!.id, 'no segment showing: the next look').not.toBe(look);
    update(() => st().undo());
    seek(4.5);
    press('Enter');
    expect(editing()).toBe('Segment 3 of 4');
    press('ArrowRight');
    expect(editing()).toBe('Segment 4 of 4');
    press('ArrowRight');
    expect(editing(), 'wraps round the loop').toBe('Segment 1 of 4');
    press('ArrowLeft');
    expect(editing()).toBe('Segment 4 of 4');
    press('Escape');
    expect(st().editBlock, 'Esc goes back to the whole edit').toBeNull();
    expect(segPanel()).toBeNull();
  });

  test('Enter shows the segment under the playhead in the inspector, but not over a focused button', () => {
    renderApp();
    seek(4.5);
    const btn = document.createElement('button');
    document.body.append(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(st().tab).toBe('layers');
    expect(st().editBlock).toBe(null);
    btn.remove();
    press('Enter');
    expect(editing()).toBe('Segment 3 of 4');
    expect(st().tab).toBe('edit');
    expect(segPanel()).toBeTruthy();
  });
});
