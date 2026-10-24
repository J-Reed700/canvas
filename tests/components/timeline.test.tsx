import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { TimelinePanel } from '../../downbeat/studio/src/components/TimelinePanel.tsx';
import { RHYTHMS, VELOCITY } from '../../downbeat/studio/src/engine/timeline.ts';
import { TRANSITIONS } from '../../downbeat/studio/src/engine/shaders.ts';
import { S, pop, popButton, renderStudio, resetStudio, screen, st, update, withSong } from './studio.tsx';

const lane = () => document.getElementById('lane') as HTMLCanvasElement;
const overview = () => document.getElementById('overview') as HTMLCanvasElement;
const rect = (el: HTMLElement, width: number, height = 60) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() {} });
const info = () => document.getElementById('tlInfo')!.textContent;
const rhythmSeg = () => document.getElementById('rhythmSeg') as HTMLElement;

/** Bar cuts in an 8 s loop (cuts at 2, 4 and 6 s) on a 400 px lane: 50 px a second. */
function barEdit(over = {}) {
  resetStudio(over);
  update(() => { st().look!.cut.rhythm = 'bar'; st().look!.cut.transitions = ['dissolve']; st().rebuild(); });
  renderStudio(<TimelinePanel />);
  rect(lane(), 400);
  lane().setPointerCapture = () => {};
}

describe('timeline header', () => {
  test('counts the cuts and, with a song, says where the loop starts', () => {
    barEdit();
    expect(info()).toBe('4 cuts');
    withSong({ loopStart: 65.5 });
    expect(info()).toMatch(/^\d+ cuts · from 1:05$/);
    resetStudio({ selected: [] });
    expect(info()).toBe('Select clips to build the edit');
  });

  test('names the clip whose own stack is open', () => {
    barEdit();
    update(() => st().editClipLook('b'));
    expect(info()).toBe("4 cuts · highlighted: #2, whose own FX you're editing");
  });

  test('rhythm buttons set the cut rhythm, and dragged cuts show as Custom', () => {
    barEdit();
    expect(within(rhythmSeg()).getAllByRole('button').map((b) => b.textContent)).toEqual(Object.values(RHYTHMS).map((r) => r.short));
    expect(within(rhythmSeg()).getByText('Bar').className).toBe('on');
    fireEvent.click(within(rhythmSeg()).getByText('½ bar'));
    expect(st().look!.cut.rhythm).toBe('half');
    expect(info()).toBe('8 cuts');
    update(() => { S.setState({ customCuts: [3] }); st().rebuild(); });
    expect(within(rhythmSeg()).getByText('Custom').className).toBe('on');
    fireEvent.click(within(rhythmSeg()).getByText('Bar'));
    expect(st().customCuts).toBe(null);
  });

  test("the song's loop suggestions are chips that move the loop", () => {
    withSong();
    renderStudio(<TimelinePanel />);
    const chips = document.getElementById('loopChips') as HTMLElement;
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['Drop', 'Peak']);
    expect(within(chips).getByText('Drop').className).toBe('on');
    fireEvent.click(within(chips).getByText('Peak'));
    expect(st().loopStart).toBe(65.5);
    expect(within(chips).getByText('Peak').className).toBe('on');
    expect(st().transport.start).toBe(65.5);
  });

  test('the timeline is redrawn whenever the edit changes', () => {
    resetStudio();
    const draw = vi.fn();
    update(() => S.setState({ drawTimeline: draw }));
    renderStudio(<TimelinePanel />);
    const n = draw.mock.calls.length;
    expect(n).toBeGreaterThan(0);
    update(() => st().setBars(2));
    expect(draw.mock.calls.length).toBeGreaterThan(n);
  });
});

describe('lane', () => {
  test('clicking the lane seeks the preview there', () => {
    barEdit();
    fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 1 });
    expect(st().transport.loopTime()).toBeCloseTo(2.5, 9);
    expect(st().customCuts).toBe(null);
  });

  test('dragging a cut line moves it on the beat grid, between its neighbors', () => {
    barEdit();
    fireEvent.pointerMove(lane(), { clientX: 99, clientY: 30 });
    expect(lane().style.cursor).toBe('ew-resize');
    fireEvent.pointerDown(lane(), { clientX: 101, clientY: 30, pointerId: 1 });
    expect(st().customCuts).toEqual([2, 4, 6]);
    fireEvent.pointerMove(lane(), { clientX: 140, clientY: 30, pointerId: 1 });
    expect(st().customCuts).toEqual([3, 4, 6]);
    expect(st().ctx!.tl.segs.map((s) => s.t0)).toEqual([0, 3, 4, 6]);
    fireEvent.pointerMove(lane(), { clientX: 300, clientY: 30, pointerId: 1 });
    expect(st().customCuts, 'stops a beat before the next cut').toEqual([3.5, 4, 6]);
    fireEvent.pointerUp(lane(), { pointerId: 1 });
    fireEvent.pointerMove(lane(), { clientX: 10, clientY: 30, pointerId: 1 });
    expect(st().customCuts, 'released').toEqual([3.5, 4, 6]);
    expect(within(rhythmSeg()).getByText('Custom')).toBeTruthy();
  });

  test('Alt-dragging slips a segment to a different moment of its clip', () => {
    barEdit();
    const before = st().ctx!.tl.segs[1].in;
    fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 1, altKey: true });
    expect(lane().style.cursor).toBe('grabbing');
    fireEvent.pointerMove(lane(), { clientX: 100, clientY: 30, pointerId: 1 });
    expect(st().segOverrides[1].in).toBeCloseTo(before + 0.5, 9);
    expect(st().ctx!.tl.segs[1].in).toBeCloseTo(before + 0.5, 9);
    fireEvent.pointerUp(lane(), { pointerId: 1 });
    expect(lane().style.cursor).toBe('');
  });

  test('double-clicking a segment opens a menu for its clip, in-point, speed ramp and transition that stays open', () => {
    barEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const open = () => pop().classList.contains('on');
    const tile = (title: string) => pop().querySelector<HTMLButtonElement>(`.seg-clip[title="${title}"]`)!;
    expect(open()).toBe(true);
    expect(pop().className).toContain('seg-menu');
    expect(pop().querySelector('h4')!.textContent).toBe('Segment 2');
    expect(pop().querySelector('.seg-head .meta')!.textContent).toMatch(/^Bar 2 · \d+\.\d\d s long$/);
    const labels = Array.from(pop().querySelectorAll('.seg-l > span:first-child')).map((l) => l.textContent);
    expect(labels).toEqual(['Clip', 'In-point', 'Speed ramp', 'Transition in']);
    expect(Array.from(pop().querySelectorAll('.seg-group small')).map((g) => g.textContent)).toEqual(['Smooth', 'Kinetic', 'Glitch', 'Other']);

    expect(tile('#2 city.mp4').className).toContain('on');
    fireEvent.click(tile('#3 cover'));
    expect(st().segOverrides[1].clipId).toBe('c');
    expect(st().ctx!.tl.segs[1].clipId).toBe('c');
    expect(open(), 'a pick keeps the menu open').toBe(true);
    expect(tile('#3 cover').className).toContain('on');
    expect(tile('#2 city.mp4').className).not.toContain('on');
    expect(pop().querySelector('.seg-name')!.textContent).toBe('cover');

    fireEvent.click(popButton(VELOCITY.hold.name));
    expect(st().ctx!.tl.segs[1].vel).toBe('hold');
    expect(popButton(VELOCITY.hold.name).className).toBe('on');
    fireEvent.click(popButton(TRANSITIONS.zoom.name));
    expect(st().ctx!.tl.segs[1].trans).toBe('zoom');
    expect(st().segOverrides[1]).toEqual({ clipId: 'c', vel: 'hold', trans: 'zoom' });

    const slider = pop().querySelector('input[type=range]') as HTMLInputElement;
    fireEvent.input(slider, { target: { value: '1.5' } });
    expect(st().ctx!.tl.segs[1].in).toBe(1.5);
    expect(pop().querySelector('.seg-val')!.textContent).toBe('1.50 s');
    expect(st().transport.loopTime()).toBeCloseTo(2.25, 9);

    fireEvent.click(pop().querySelector('.seg-x')!);
    expect(open()).toBe(false);

    fireEvent.doubleClick(lane(), { clientX: 10, clientY: 30 });
    expect(pop().querySelector('.seg-note')!.textContent).toContain('loop seam');
  });
});

describe('song overview', () => {
  test('dragging on the overview moves the loop to a downbeat, keeping it inside the song', () => {
    withSong({ loopStart: 33.5 });
    renderStudio(<TimelinePanel />);
    rect(overview(), 360); // 2 px a second
    overview().setPointerCapture = () => {};
    fireEvent.pointerDown(overview(), { clientX: 200, clientY: 10, pointerId: 1 }); // 100 s, outside the loop
    expect(st().loopStart).toBe(95.5); // the downbeat nearest 100 - 8 / 2
    fireEvent.pointerMove(overview(), { clientX: 220, clientY: 10, pointerId: 1 });
    expect(st().loopStart).toBe(105.5);
    fireEvent.pointerMove(overview(), { clientX: 2000, clientY: 10, pointerId: 1 });
    expect(st().loopStart).toBe(171.5); // the last downbeat with 8 s of song left
    fireEvent.pointerUp(overview(), { pointerId: 1 });
    fireEvent.pointerMove(overview(), { clientX: 0, clientY: 10, pointerId: 1 });
    expect(st().loopStart).toBe(171.5);
  });

  test('grabbing inside the loop keeps its start until you drag', () => {
    withSong({ loopStart: 33.5 });
    renderStudio(<TimelinePanel />);
    rect(overview(), 360);
    overview().setPointerCapture = () => {};
    fireEvent.pointerDown(overview(), { clientX: 70, clientY: 10, pointerId: 1 }); // 35 s
    expect(st().loopStart).toBe(33.5);
  });

  test('without a song the overview does nothing', () => {
    resetStudio();
    renderStudio(<TimelinePanel />);
    rect(overview(), 360);
    fireEvent.pointerDown(overview(), { clientX: 200, clientY: 10, pointerId: 1 });
    expect(st().loopStart).toBe(0);
    expect(screen.queryByText('Drop')).toBeNull();
  });
});
