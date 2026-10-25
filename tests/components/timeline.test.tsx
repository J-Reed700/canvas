import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { TimelinePanel } from '../../downbeat/studio/src/components/TimelinePanel/TimelinePanel.tsx';
import { EditPane } from '../../downbeat/studio/src/components/EditPane/EditPane.tsx';
import { RHYTHMS, VELOCITY } from '../../downbeat/studio/src/engine/timeline.ts';
import { compose } from '../../downbeat/studio/src/engine/composer.ts';
import { TRANSITIONS } from '../../downbeat/studio/src/engine/shaders.ts';
import { S, renderStudio, resetStudio, screen, segButton, segPanel, st, update, withSong } from './studio.tsx';
import { cropRect, room } from '../../downbeat/studio/src/lib/utils.ts';

const lane = () => document.getElementById('lane') as HTMLCanvasElement;
const overview = () => document.getElementById('overview') as HTMLCanvasElement;
const rect = (el: HTMLElement, width: number, height = 60) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() {} });
const info = () => document.getElementById('tlInfo')!.textContent;
const rhythmSeg = () => document.getElementById('rhythmSeg') as HTMLElement;
const block = (id: string) => st().blocks?.find((b) => b.id === id);

/** Bar cuts in an 8 s loop (cuts at 2, 4 and 6 s) on a 400 px lane: 50 px a second. */
function barEdit(over = {}) {
  resetStudio(over);
  update(() => { st().look!.cut.rhythm = 'bar'; st().look!.cut.transitions = ['dissolve']; st().rebuild(); });
  renderStudio(<><TimelinePanel /><EditPane /></>);
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
    update(() => { S.setState({ legacyEdit: { customCuts: [3], segOverrides: {} } }); st().rebuild(); });
    expect(within(rhythmSeg()).getByText('Custom').className).toBe('on');
    expect(within(rhythmSeg()).getByText('Bar').className, 'a hand-cut edit follows no rhythm').toBe('');
    fireEvent.click(within(rhythmSeg()).getByText('Bar'));
    expect(st().blocks).toBe(null);
    expect(within(rhythmSeg()).queryByText('Custom')).toBeNull();
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
  test('clicking the lane seeks the preview there and selects the segment', () => {
    barEdit();
    fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 1 });
    expect(st().transport.loopTime()).toBeCloseTo(2.5, 9);
    expect(st().selectedBlock).toBe('g1');
    expect(info()).toBe('4 cuts · segment 2 selected');
    expect(st().blocks, 'selecting changes nothing').toBe(null);
  });

  test('dragging a cut line moves it on the beat grid, between its neighbors', () => {
    barEdit();
    fireEvent.pointerMove(lane(), { clientX: 99, clientY: 30 });
    expect(lane().style.cursor).toBe('ew-resize');
    fireEvent.pointerDown(lane(), { clientX: 101, clientY: 30, pointerId: 1 });
    expect(st().blocks, 'nothing moves until the line does').toBe(null);
    fireEvent.pointerMove(lane(), { clientX: 140, clientY: 30, pointerId: 1 });
    expect(st().ctx!.tl.segs.map((s) => s.t0)).toEqual([0, 3, 4, 6]);
    expect(block('g1')!.at, 'in beats').toBe(6);
    fireEvent.pointerMove(lane(), { clientX: 300, clientY: 30, pointerId: 1 });
    expect(st().ctx!.tl.segs[1].t0, 'stops a beat before the next cut').toBe(3.5);
    fireEvent.pointerMove(lane(), { clientX: 136, clientY: 30, pointerId: 1, shiftKey: true });
    expect(st().ctx!.tl.segs[1].t0, 'Shift lets it off the grid').toBeCloseTo(2.72, 9);
    fireEvent.pointerUp(lane(), { pointerId: 1 });
    fireEvent.pointerMove(lane(), { clientX: 10, clientY: 30, pointerId: 1 });
    expect(st().ctx!.tl.segs[1].t0, 'released').toBeCloseTo(2.72, 9);
    expect(within(rhythmSeg()).getByText('Custom')).toBeTruthy();

    fireEvent.click(within(document.getElementById('blockTools')!).getByText('¼'));
    expect(st().snap).toBe(4);
    fireEvent.pointerDown(lane(), { clientX: 136, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(lane(), { clientX: 117, clientY: 30, pointerId: 1 });
    expect(st().ctx!.tl.segs[1].t0, 'on the quarter-beat grid').toBe(2.375);
    fireEvent.pointerUp(lane(), { pointerId: 1 });
  });

  test('Alt-dragging slips a segment to a different moment of its clip', () => {
    barEdit();
    const before = st().ctx!.tl.segs[1].in;
    fireEvent.pointerDown(lane(), { clientX: 125, clientY: 30, pointerId: 1, altKey: true });
    expect(lane().style.cursor).toBe('grabbing');
    fireEvent.pointerMove(lane(), { clientX: 100, clientY: 30, pointerId: 1 });
    expect(block('g1')!.in).toBeCloseTo(before + 0.5, 9);
    expect(st().ctx!.tl.segs[1].in).toBeCloseTo(before + 0.5, 9);
    fireEvent.pointerUp(lane(), { pointerId: 1 });
    expect(lane().style.cursor).toBe('');
  });

  test('double-clicking a segment selects it and brings its clip, in-point, speed ramp and transition into the Edit tab, which stays put', () => {
    barEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const tile = (title: string) => segPanel().querySelector<HTMLButtonElement>(`.seg-clip[title="${title}"]`)!;
    expect(st().selectedBlock).toBe('g1');
    expect(st().editBlock).toBe('g1');
    expect(st().tab).toBe('edit');
    expect(segPanel()).toBeTruthy();
    expect(segPanel().querySelector('.seg-where')!.textContent).toMatch(/^Bar 2, beat 1 · \d+\.\d\d s long$/);
    expect(Array.from(segPanel().querySelectorAll('.seg-family > summary')).map((l) => l.textContent)).toEqual(['Timing & transition', 'Source & playback', 'Framing']);
    const labels = Array.from(segPanel().querySelectorAll('.seg-l > span:first-child')).map((l) => l.textContent);
    expect(labels).toEqual(['Timing', 'Transition length', 'Transition in', 'Clip', 'In-point', 'Direction', 'Clip speed', 'Speed ramp', 'Framing', 'Motion', 'Quick moves']);
    expect(segPanel().querySelector('.seg-transition-picker')).toBeTruthy();

    expect(tile('#2 city.mp4').className).toContain('on');
    fireEvent.click(tile('#3 cover'));
    expect(block('g1')!.clipId).toBe('c');
    expect(st().ctx!.tl.segs[1].clipId).toBe('c');
    expect(st().editBlock, 'a pick keeps the segment in the Edit tab').toBe('g1');
    expect(tile('#3 cover').className).toContain('on');
    expect(tile('#2 city.mp4').className).not.toContain('on');
    expect(segPanel().querySelector('.seg-name')!.textContent).toBe('cover');

    fireEvent.click(segButton(VELOCITY.hold.name));
    expect(st().ctx!.tl.segs[1].vel).toBe('hold');
    expect(segButton(VELOCITY.hold.name).className).toBe('on');
    fireEvent.click(within(segPanel()).getByRole('button', { name: 'Choose transition' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search transitions' }), { target: { value: TRANSITIONS.zoom.name } });
    fireEvent.click(screen.getByRole('button', { name: `Use ${TRANSITIONS.zoom.name}` }));
    expect(st().ctx!.tl.segs[1].trans).toBe('zoom');
    expect(block('g1')).toMatchObject({ clipId: 'c', vel: 'hold', trans: 'zoom' });

    const slider = segPanel().querySelector('input[aria-label="In-point"]') as HTMLInputElement;
    fireEvent.input(slider, { target: { value: '1.5' } });
    expect(st().ctx!.tl.segs[1].in).toBe(1.5);
    expect(segPanel().querySelector('[aria-label="In-point"]')!.closest('.seg-f')!.querySelector('.seg-val')!.textContent).toBe('1.50 s');
    expect(st().transport.loopTime()).toBeCloseTo(2.25, 9);

    fireEvent.doubleClick(lane(), { clientX: 10, clientY: 30 });
    expect(st().editBlock).toBe(st().ctx!.tl.segs[0].id);
    expect(segPanel().textContent).toContain('joins the end of the loop');
  });

  test('clip speed changes only one segment, preserves its other settings, and can follow the edit again', () => {
    barEdit();
    update(() => st().setBlock('g1', { overrides: { camera: { zoom: 1.3 }, finish: { grain: 0.1 } } }));
    const cuts = st().ctx!.tl.segs.map((s) => [s.t0, s.t1]);
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const slider = within(segPanel()).getByLabelText('Clip speed');
    fireEvent.input(slider, { target: { value: '1.5' } });
    fireEvent.input(slider, { target: { value: '1.75' } });
    expect(within(segPanel()).getByLabelText('Clip speed'), 'a drag keeps its input mounted').toBe(slider);
    expect(st().ctx!.tl.segs.map((s) => s.speed)).toEqual([1, 1.75, 1, 1]);
    expect(segPanel().querySelector('.seg-speed')!.parentElement!.querySelector('.seg-val')!.textContent).toBe('1.75×');
    fireEvent.change(slider);
    expect(block('g1')!.overrides).toEqual({ camera: { zoom: 1.3, speed: 1.75 }, finish: { grain: 0.1 } });
    expect(st().ctx!.tl.segs.map((s) => [s.t0, s.t1])).toEqual(cuts);
    const before = compose(st().ctx!, 2.75).needs[0];
    const after = compose(st().ctx!, 2.85).needs[0];
    expect(before.rate).toBe(1.75);
    expect(after.time - before.time).toBeCloseTo(0.175, 9);
    fireEvent.click(within(segPanel().querySelector('.seg-speed')!).getByText('Auto'));
    expect(st().ctx!.tl.segs[1].speed).toBe(1);
    expect(block('g1')!.overrides).toEqual({ camera: { zoom: 1.3 }, finish: { grain: 0.1 } });
  });

  test('matching an 80 BPM clip to the song sets 1.5× at constant speed and survives undo and saved edits', () => {
    barEdit({ features: { bpm: 120 }, trackId: 't1' });
    update(() => { st().look!.cut.velocity = 'surge'; st().rebuild(); });
    const cuts = st().ctx!.tl.segs.map((s) => [s.t0, s.t1]);
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    fireEvent.input(within(segPanel()).getByLabelText('Original clip BPM'), { target: { value: '80' } });
    fireEvent.click(segButton('Match 120 BPM'));
    expect(st().ctx!.tl.segs.map((s) => s.speed)).toEqual([1, 1.5, 1, 1]);
    expect(st().ctx!.tl.segs[1].vel).toBe('none');
    expect(st().ctx!.tl.segs[0].vel).toBe('surge');
    expect(st().ctx!.tl.segs.map((s) => [s.t0, s.t1])).toEqual(cuts);
    expect(st().bpm()).toBe(120);
    expect(segPanel().querySelector('.seg-speed')!.textContent).toContain('80 → 120 BPM at 1.50×');
    const saved = st().snapshot();
    update(() => st().undo());
    expect(st().ctx!.tl.segs[1].speed).toBe(1);
    update(() => st().redo());
    expect(st().ctx!.tl.segs[1].speed).toBe(1.5);
    update(() => { st().clearBlock('g1'); st().applySnapshot(saved); });
    expect(st().ctx!.tl.segs[1].speed).toBe(1.5);
    expect(st().ctx!.tl.segs[1].vel).toBe('none');
  });

  test('BPM matching uses the BPM clock precisely and rejects missing, invalid and unsupported tempos', () => {
    barEdit({ bpmManual: 150 });
    fireEvent.doubleClick(lane(), { clientX: 100, clientY: 30 });
    const input = () => within(segPanel()).getByLabelText('Original clip BPM');
    for (const value of ['', '0', '-80', '1', '1000']) {
      fireEvent.input(input(), { target: { value } });
      expect(segButton('Match 150 BPM').disabled, value).toBe(true);
      fireEvent.submit(input().closest('form')!);
      expect(st().ctx!.tl.segs[1].speed, value).toBe(1);
    }
    for (const source of [75, 600, 97.3]) {
      fireEvent.input(input(), { target: { value: String(source) } });
      expect(segButton('Match 150 BPM').disabled).toBe(false);
      fireEvent.submit(input().closest('form')!);
      expect(st().ctx!.tl.segs[1].speed).toBeCloseTo(150 / source, 12);
    }
  });

  test('still images explain why speed does not apply, and short footage is flagged at the selected speed', () => {
    barEdit();
    update(() => { S.setState({ clips: st().clips.map((c) => c.id === 'b' ? { ...c, duration: 3 } : c) }); st().rebuild(); });
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    fireEvent.click(within(segPanel().querySelector('.seg-speed')!).getByText('2×'));
    expect(segPanel().querySelector('.seg-speed')!.textContent).toContain('too short to fill the segment at this speed');
    fireEvent.click(segPanel().querySelector('.seg-clip[title="#3 cover"]')!);
    expect(within(segPanel()).queryByLabelText('Clip speed')).toBeNull();
    expect(within(segPanel()).queryByLabelText('Original clip BPM')).toBeNull();
    expect(segPanel().textContent).toContain('Still images have no playback speed.');
  });

  test("the segment panel's arrows step between segments, wrapping around, its header counts them, and Done closes it", () => {
    barEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const where = () => segPanel().querySelector('.seg-where')!.textContent;
    const shown = () => st().ctx!.tl.segs.findIndex((x) => x.id === st().editBlock) + 1;
    fireEvent.click(segPanel().querySelector('[aria-label="Next segment"]')!);
    expect(shown()).toBe(3);
    expect(st().selectedBlock).toBe(st().editBlock);
    expect(where()).toMatch(/^Bar 3, beat 1 · /);
    expect(st().transport.loopTime(), 'the playhead moves onto it').toBeCloseTo(4.25, 9);
    fireEvent.click(segPanel().querySelector('[aria-label="Next segment"]')!);
    fireEvent.click(segPanel().querySelector('[aria-label="Next segment"]')!);
    expect(shown(), 'wraps around').toBe(1);
    expect(where()).toMatch(/^Bar 1, beat 1 · /);
    fireEvent.click(segPanel().querySelector('[aria-label="Previous segment"]')!);
    expect(shown()).toBe(4);
    expect(where()).toMatch(/^Bar 4, beat 1 · /);
    expect(segPanel().querySelector('.seg-identity h4')!.textContent, 'the header counts the segments').toBe('Segment 4 of 4');
    expect(segPanel().querySelector('.seg-identity .meta')!.textContent).toMatch(/^Clip \d · appearance \d of \d$/);
    fireEvent.click(segPanel().querySelector('[aria-label="Done"]')!);
    expect(st().editBlock, 'Done goes back to the whole edit').toBeNull();
    expect(segPanel()).toBeNull();
  });

  test('the in-point filmstrip, direction, the marks on what you set and Reset segment', () => {
    barEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    const marks = () => Array.from(segPanel().querySelectorAll('.seg-l > span:first-child')).filter((l) => l.querySelector('.seg-mine')).map((l) => l.textContent);
    const auto = () => segPanel().querySelector('.seg-auto') as HTMLButtonElement;
    expect(marks()).toEqual([]);
    expect(auto().disabled).toBe(true);

    const frames = Array.from(segPanel().querySelectorAll<HTMLButtonElement>('.seg-strip button'));
    expect(frames).toHaveLength(8);
    const max = +(segPanel().querySelector('input[aria-label="In-point"]') as HTMLInputElement).max;
    const t = +((max * 4.5) / 8).toFixed(2);
    expect(frames[4].dataset.thumb).toBe(`/api/thumb/b?w=120&t=${t.toFixed(2)}`); // shown once it has loaded
    fireEvent.click(frames[4]);
    expect(st().ctx!.tl.segs[1].in).toBeCloseTo(t, 9);
    expect(segPanel().querySelector('[aria-label="In-point"]')!.closest('.seg-f')!.querySelector('.seg-val')!.textContent).toBe(`${t.toFixed(2)} s`);
    expect(parseFloat((segPanel().querySelector('.seg-mark') as HTMLElement).style.left)).toBeCloseTo((t / max) * 100, 6);

    fireEvent.click(segButton('Reverse'));
    expect([st().ctx!.tl.segs[1].rev, st().ctx!.tl.segs[1].pp]).toEqual([true, false]);
    fireEvent.click(segButton('Ping-pong'));
    expect([st().ctx!.tl.segs[1].rev, st().ctx!.tl.segs[1].pp]).toEqual([false, true]);
    expect(segButton('Ping-pong').className).toBe('on');
    expect(marks()).toEqual(['In-point', 'Direction']);
    expect(auto().disabled).toBe(false);

    fireEvent.click(auto());
    expect(st().blocks, 'nothing set by hand is left, so the edit follows the rhythm again').toBe(null);
    expect([st().ctx!.tl.segs[1].rev, st().ctx!.tl.segs[1].pp]).toEqual([false, false]);
    expect(marks()).toEqual([]);
    expect(auto().disabled).toBe(true);
  });

  test('Play the cut starts a beat and half a transition before the segment', () => {
    barEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 });
    fireEvent.click(segButton('▶ Play the cut'));
    expect(st().transport.playing).toBe(true);
    expect(st().transport.loopTime()).toBeCloseTo(2 - st().ctx!.tl.segs[1].transDur / 2 - 0.5, 1);
    st().transport.pause();
    fireEvent.doubleClick(lane(), { clientX: 10, clientY: 30 });
    fireEvent.click(segButton('▶ Play the cut'));
    expect(st().transport.loopTime(), 'the seam starts from the end of the loop').toBeCloseTo(8 - st().ctx!.tl.segs[0].transDur / 2 - 0.5, 1);
    st().transport.pause();
  });
});

describe('segment framing', () => {
  const open = () => {
    barEdit();
    fireEvent.doubleClick(lane(), { clientX: 125, clientY: 30 }); // segment 2, city.mp4, a 16:9 clip in the 9:16 frame
  };
  const slider = (name: string) => segPanel().querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  const value = (name: string) => slider(name).parentElement!.querySelector('.seg-val')!.textContent;
  const frame = () => st().blocks?.find((b) => b.id === 'g1')?.frame;
  const seg = () => st().ctx!.tl.segs[1];
  const cz = () => st().look!.camera.p.zoom;
  const roomX = (z: number) => room({ width: 1920, height: 1080 }, cz() * z).room[0];
  const crop = () => segPanel().querySelector('.seg-crop') as HTMLElement;
  // the framing's Auto, not the transition length's
  const auto = () => within(segPanel().querySelector('.seg-framing') as HTMLElement).getByText('Auto');

  test('starts automatic, and X, Y and zoom set a still framing for the segment alone', () => {
    open();
    expect(auto().className).toBe('on');
    expect(segPanel().querySelectorAll('.seg-win')).toHaveLength(1);
    expect(value('X')).toBe('Center');
    expect(crop().dataset.thumb).toBe(`/api/thumb/b?w=320&t=${seg().in.toFixed(2)}`);

    fireEvent.input(slider('X'), { target: { value: '0.5' } });
    expect(frame()).toEqual({ a: [0.5 + 0.5 * roomX(1), 0.5, 1] });
    expect(seg().frame).toEqual(frame());
    expect(st().ctx!.tl.segs.filter((x) => x.frame), 'only this segment').toHaveLength(1);
    expect(value('X')).toBe('50% right');
    fireEvent.change(slider('X'));
    expect(segButton('Still').className).toBe('on');
    expect(Array.from(segPanel().querySelectorAll('.seg-l > span:first-child')).filter((l) => l.querySelector('.seg-mine')).map((l) => l.textContent)).toEqual(['Framing']);

    fireEvent.input(slider('Zoom'), { target: { value: '2' } });
    expect(frame()!.a[2]).toBe(2);
    expect(value('Zoom')).toBe('2.00×');
    // zoomed in, the crop has more room, so the same X sits a smaller share of the way to the edge
    expect(+slider('X').value).toBeCloseTo((0.5 * roomX(1)) / roomX(2), 9);
    fireEvent.input(slider('Y'), { target: { value: '-1' } });
    expect(frame()!.a[1]).toBeCloseTo(0.5 - room({ width: 1920, height: 1080 }, cz() * 2).room[1], 9);
    expect(value('Y')).toBe('100% down');

    // the box shows the crop where the shader puts it
    const [l, t, w, hh] = cropRect({ width: 1920, height: 1080 }, cz() * 2, ...(frame()!.a.slice(0, 2) as [number, number]));
    const win = segPanel().querySelector('.seg-win') as HTMLElement;
    expect([win.style.left, win.style.top, win.style.width, win.style.height].map(parseFloat).map((v) => +v.toFixed(6))).toEqual([l, t, w, hh].map((v) => +(v * 100).toFixed(6)));

    fireEvent.click(within(segPanel()).getByRole('button', { name: 'Choose transition' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search transitions' }), { target: { value: TRANSITIONS.zoom.name } });
    fireEvent.click(screen.getByRole('button', { name: `Use ${TRANSITIONS.zoom.name}` }));
    fireEvent.click(auto());
    expect(block('g1')!.trans, 'Auto forgets the framing and nothing else').toBe('zoom');
    expect(frame()).toBeUndefined();
    expect(seg().frame).toBeUndefined();
  });

  test("without room to move, a slider says so; the look's zoom counts", () => {
    open();
    update(() => { st().look!.camera.p.zoom = 1; st().rebuild(); });
    fireEvent.click(segPanel().querySelector('[aria-label="Next segment"]')!);
    fireEvent.click(segPanel().querySelector('[aria-label="Previous segment"]')!);
    expect(slider('Y').disabled).toBe(true);
    expect(value('Y')).toBe('No room');
    expect(slider('X').disabled).toBe(false);
    fireEvent.input(slider('Zoom'), { target: { value: '1.5' } });
    expect(slider('Y').disabled).toBe(false);
  });

  test('a move has a start and an end to adjust, a curve, and swaps', () => {
    open();
    fireEvent.click(segButton('Steady'));
    expect(frame()).toEqual({ a: [0.5, 0.5, 1], b: [0.5, 0.5, 1.25], ease: 'linear' });
    expect(segPanel().querySelectorAll('.seg-win:not(.live)')).toHaveLength(2);
    expect(segButton('End').className, 'the end is ready to adjust').toBe('on');
    const pad = Math.min(st().ctx!.tl.segs[seg().i + 1].transDur / 2 + 0.02, seg().dur * 0.3); // the transition out of it
    expect(st().transport.loopTime(), 'the preview shows the end').toBeCloseTo(seg().t1 - pad, 9);

    fireEvent.input(slider('X'), { target: { value: '-1' } });
    expect(frame()!.b![0]).toBeCloseTo(0.5 - roomX(1.25), 9);
    expect(frame()!.a).toEqual([0.5, 0.5, 1]);
    fireEvent.click(segButton('Start'));
    expect(st().transport.loopTime(), 'and then the start').toBeCloseTo(seg().t0 + pad, 9);
    fireEvent.input(slider('Zoom'), { target: { value: '1.1' } });
    expect(frame()!.a[2]).toBe(1.1);

    fireEvent.click(segButton('On the beat'));
    expect(frame()!.ease).toBe('beats');
    fireEvent.click(segButton('⇄ Swap'));
    expect(frame()!.a[2]).toBe(1.25);
    expect(frame()!.b![2]).toBe(1.1);
    fireEvent.click(segButton('Still'));
    expect(frame()).toEqual({ a: [frame()!.a[0], 0.5, 1.25] });
  });

  test('while the playhead is in the segment, a thin box follows the crop through the move', async () => {
    open();
    fireEvent.click(segButton('Pan →'));
    const live = () => segPanel().querySelector('.seg-win.live') as HTMLElement;
    const frame2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const left = (k: number) => parseFloat((segPanel().querySelectorAll('.seg-win')[k] as HTMLElement).style.left);
    st().transport.seek(seg().t0 + seg().dur / 2);
    await frame2();
    expect(live().hidden).toBe(false);
    expect(parseFloat(live().style.left)).toBeCloseTo((left(0) + left(1)) / 2, 6);
    st().transport.seek(seg().t1 + 0.1);
    await frame2();
    expect(live().hidden, 'outside the segment').toBe(true);
  });

  test('quick moves push in, pull out and pan across the room the clip has', () => {
    open();
    // a 16:9 clip fills the 9:16 frame top to bottom, so tilting zooms in first to make room
    fireEvent.click(segButton('Pan ↑'));
    const [a, b] = [frame()!.a, frame()!.b!];
    expect(a[2]).toBeCloseTo(1 / 0.76 / cz(), 9);
    expect(a[1]).toBeLessThan(0.5);
    expect(b[1]).toBeCloseTo(1 - a[1], 9);
    expect([a[0], b[0], b[2], frame()!.ease]).toEqual([0.5, 0.5, a[2], 'smooth']);

    fireEvent.click(auto());
    fireEvent.click(segButton('Push in'));
    expect(frame()).toEqual({ a: [0.5, 0.5, 1], b: [0.5, 0.5, 1.5], ease: 'smooth' });
    fireEvent.click(segButton('Pan →'));
    expect(frame()!.a[0], 'pans keep the start zoom').toBeCloseTo(0.5 - 0.9 * roomX(1), 9);
    expect(frame()!.b![0]).toBeCloseTo(0.5 + 0.9 * roomX(1), 9);
    fireEvent.input(slider('Zoom'), { target: { value: '2.5' } });
    fireEvent.click(segButton('Pull out'));
    expect(frame()!.a[2], 'near the top of the range it pulls from 3x to 2x').toBe(3);
    expect(frame()!.b![2]).toBe(2);
    expect(frame()!.a[0]).toBe(frame()!.b![0]);
  });

  test('dragging the box moves the crop, and a pinch on it zooms', () => {
    open();
    vi.spyOn(crop(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 160, height: 90, right: 160, bottom: 90, x: 0, y: 0, toJSON() {} });
    crop().setPointerCapture = () => {};
    fireEvent.pointerDown(crop(), { clientX: 80, clientY: 45, pointerId: 1 });
    expect(frame()!.a[0], 'a press inside the crop grabs it where it is').toBeCloseTo(0.5, 9);
    fireEvent.pointerMove(crop(), { clientX: 96, clientY: 45, pointerId: 1 });
    expect(frame()!.a[0]).toBeCloseTo(0.6, 9);
    fireEvent.pointerMove(crop(), { clientX: 400, clientY: 45, pointerId: 1 });
    expect(frame()!.a[0], 'stops at the edge of the clip').toBeCloseTo(0.5 + roomX(1), 9);
    fireEvent.pointerUp(crop(), { pointerId: 1 });

    vi.spyOn(crop(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 160, height: 90, right: 160, bottom: 90, x: 0, y: 0, toJSON() {} });
    crop().setPointerCapture = () => {};
    fireEvent.pointerDown(crop(), { clientX: 8, clientY: 45, pointerId: 1 });
    expect(frame()!.a[0], 'a press outside brings the crop to it').toBeCloseTo(0.5 - roomX(1), 9);
    fireEvent.pointerUp(crop(), { pointerId: 1 });

    const wheel = (init: WheelEventInit) => {
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
      // happy-dom leaves the modifier keys of a WheelEvent unset
      for (const k of ['ctrlKey', 'metaKey'] as const) Object.defineProperty(ev, k, { value: !!init[k] });
      crop().dispatchEvent(ev);
      return ev;
    };
    expect(wheel({ deltaY: -200 }).defaultPrevented, 'a plain scroll is left to scroll the inspector').toBe(false);
    expect(frame()!.a[2]).toBe(1);
    // a trackpad pinch arrives as a wheel with Ctrl held
    expect(wheel({ deltaY: -30, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(frame()!.a[2]).toBeCloseTo(Math.exp(0.3), 9);
    wheel({ deltaY: 100000, ctrlKey: true });
    expect(frame()!.a[2]).toBe(1);

    // Safari reports a pinch as gesture events
    const gesture = (type: string, scale = 1) => {
      const ev = new Event(type, { cancelable: true });
      Object.defineProperty(ev, 'scale', { value: scale });
      return fireEvent(crop(), ev);
    };
    gesture('gesturestart');
    expect(gesture('gesturechange', 2)).toBe(false);
    expect(frame()!.a[2]).toBeCloseTo(2, 9);
    gesture('gesturechange', 10);
    expect(frame()!.a[2], 'up to 3×').toBe(3);

    // ⌘ with a mouse wheel zooms too
    wheel({ deltaY: 100000, metaKey: true });
    wheel({ deltaY: -200, metaKey: true });
    expect(frame()!.a[2]).toBeCloseTo(Math.exp(0.3), 9);
    fireEvent.click(segButton('Smooth'));
    expect(frame()!.a[2], 'a pick after zooming keeps the zoom').toBeCloseTo(Math.exp(0.3), 9);
  });

  test('the panel folds into families that stay open or closed from one segment to the next', () => {
    open();
    const selected = st().editBlock;
    const family = (key: string) => segPanel().querySelector(`.seg-family[data-family="${key}"]`) as HTMLDetailsElement;
    const toggle = (key: string, on: boolean) => { family(key).open = on; fireEvent(family(key), new Event('toggle')); };
    expect(['timing', 'playback', 'framing'].map((k) => family(k).open), 'everything starts open, as on the old tabs').toEqual([true, true, true]);
    expect(segPanel().querySelectorAll('.seg-xyz input[type=range]'), 'X, Y and Zoom are in sight').toHaveLength(3);
    toggle('timing', false);
    toggle('playback', false);
    expect(st().editBlock, 'folding changes no selection').toBe(selected);
    fireEvent.click(segPanel().querySelector('[aria-label="Next segment"]')!);
    expect(st().editBlock).not.toBe(selected);
    expect(['timing', 'playback', 'framing'].map((k) => family(k).open)).toEqual([false, false, true]);
    // put them back for the tests after this one
    toggle('timing', true);
    toggle('playback', true);
    fireEvent.click(segPanel().querySelector('[aria-label="Previous segment"]')!);
    expect(['timing', 'playback', 'framing'].map((k) => family(k).open)).toEqual([true, true, true]);
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
