import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { EditPane } from '../../downbeat/studio/src/components/EditPane/EditPane.tsx';
import { RHYTHMS, DIRECTIONS, VELOCITY } from '../../downbeat/studio/src/engine/timeline.ts';
import { TRANSITIONS } from '../../downbeat/studio/src/engine/shaders.ts';
import { POOLS } from '../../downbeat/studio/src/lib/utils.ts';
import { LOOKS, SONG, cloneLook, renderStudio, resetStudio, screen, st, update, withSong } from './studio.tsx';

const field = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.field')).find((f) => f.querySelector(':scope > label')?.textContent === label) as HTMLElement;
const barsIn = () => screen.getByLabelText('Loop length in bars') as HTMLInputElement;
const lenIn = () => screen.getByLabelText('Loop length in minutes and seconds') as HTMLInputElement;
const typeInto = (el: HTMLInputElement, text: string) => {
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
};
const note = () => field('Loop length').querySelector(':scope > .note')!.textContent;

describe('loop and cuts', () => {
  test('Rebound plans the cuts over the first half and plays them back in the second', () => {
    resetStudio({ blocks: [{ id: 'g0', at: 0, clipId: 'a', in: 0, seed: 1, trans: 'zoom' }] });
    renderStudio(<EditPane />);
    const seg = field('Loop').querySelector('.seg') as HTMLElement;
    expect(within(seg).getByText('Repeat').className).toBe('on');
    fireEvent.click(within(seg).getByText('Rebound'));
    expect(st().rebound).toBe(true);
    expect(st().blocks).toBeNull();
    expect([st().ctx!.L, st().ctx!.tl.L, st().ctx!.tl.rebound]).toEqual([8, 4, true]);
    expect(within(seg).getByText('Rebound').className).toBe('on');
    expect(field('Loop').querySelector('.note')!.textContent).toMatch(/^The cuts fill the first half of the loop\./);
    fireEvent.click(within(seg).getByText('Repeat'));
    expect([st().rebound, st().ctx!.tl.L]).toEqual([false, 8]);
    expect(field('Loop').querySelector('.note')).toBeNull();
  });

  test('Show every clip splits cuts when there are more clips than cuts, and says who is left out when off', () => {
    resetStudio();
    update(() => {
      st().look!.cut.rhythm = 'bar';
      st().setBars(2);
    });
    renderStudio(<EditPane />);
    const clipsShown = () => new Set(st().ctx!.tl.segs.map((s) => s.clipId)).size;
    const box = screen.getByLabelText('Show every clip at least once') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(clipsShown()).toBe(3);
    fireEvent.click(box);
    expect(st().fitAll).toBe(false);
    expect(clipsShown()).toBe(2);
    expect(screen.getByText("1 of the 3 clips doesn't appear, because there are more clips than cuts.")).toBeTruthy();
    fireEvent.click(box);
    expect(clipsShown()).toBe(3);
    expect(screen.getByText(/the longest cuts are split in two until each clip has one/)).toBeTruthy();
  });
});

describe('block look overrides', () => {
  test('the selected block can own macros, camera, finish and indexed layer parameters, then follow the look again', () => {
    resetStudio();
    update(() => st().selectBlock(st().ctx!.tl.segs[1].id));
    renderStudio(<EditPane />);
    fireEvent.click(screen.getByLabelText('Override Block Macro A'));
    fireEvent.change(screen.getByLabelText('Block Macro A'), { target: { value: '0.7' } });
    fireEvent.click(screen.getByLabelText('Override Camera Shake'));
    fireEvent.change(screen.getByLabelText('Camera Shake'), { target: { value: '0.4' } });
    fireEvent.click(screen.getByLabelText('Override Finish Exposure'));
    fireEvent.change(screen.getByLabelText('Finish Exposure'), { target: { value: '1.2' } });
    fireEvent.click(screen.getByLabelText('Override Layer 1 Scale'));
    fireEvent.change(screen.getByLabelText('Layer 1 Scale'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('Override Layer 2 Metal'));
    fireEvent.change(screen.getByLabelText('Layer 2 Metal'), { target: { value: '2' } });
    const block = st().blocks!.find((b) => b.id === st().selectedBlock)!;
    expect(block.overrides).toEqual({
      macro: { a: 0.7 }, camera: { shake: 0.4 }, finish: { exposure: 1.2 },
      layers: { 0: { m: 'glass', p: { scale: 5 } }, 1: { m: 'chrome', p: { tint: 2 } } },
    });
    expect(st().ctx!.tl.segs[1].overrides).toEqual(block.overrides);
    fireEvent.click(screen.getByText('Use look for all'));
    expect(st().blocks, 'clearing the last hand setting returns the edit to its rolled blocks').toBeNull();
    expect(screen.queryByText('Use look for all')).toBeNull();
  });

  test('indexed controls follow the effect stack that the selected clip actually uses', () => {
    resetStudio({ clipMode: 'custom', clipLooks: { b: cloneLook(LOOKS[1]) } });
    update(() => st().selectBlock(st().ctx!.tl.segs.find((seg) => seg.clipId === 'b')!.id));
    renderStudio(<EditPane />);
    expect(screen.getByLabelText('Override Layer 1 Slices')).toBeTruthy();
    expect(screen.queryByLabelText('Override Layer 1 Refraction')).toBeNull();
  });
});

describe('loop length', () => {
  test('presets set the bar count and light up', () => {
    resetStudio();
    renderStudio(<EditPane />);
    const seg = field('Loop length').querySelector('.seg') as HTMLElement;
    expect(within(seg).getByText('4 bars').className).toBe('on');
    fireEvent.click(within(seg).getByText('2 bars'));
    expect(st().bars).toBe(2);
    expect(st().ctx!.L).toBe(4);
    expect(within(seg).getByText('2 bars').className).toBe('on');
    expect(barsIn().value).toBe('2');
    expect(lenIn().value).toBe('4.00s');
    expect(within(seg).queryByText('Whole song')).toBeNull();
  });

  test('typing bars or a time sets the length in whole bars, and nonsense puts the old value back', () => {
    resetStudio();
    renderStudio(<EditPane />);
    typeInto(barsIn(), '37');
    expect(st().bars).toBe(37);
    expect(lenIn().value).toBe('1:14');
    typeInto(lenIn(), '2:30');
    expect(st().bars).toBe(75);
    expect(barsIn().value).toBe('75');
    typeInto(lenIn(), '9s');
    expect(st().bars, '4.5 bars rounds to 5').toBe(5);
    typeInto(lenIn(), 'soon');
    expect(st().bars).toBe(5);
    expect(lenIn().value).toBe('10.00s');
    typeInto(barsIn(), '0');
    expect(barsIn().value).toBe('5');
    typeInto(barsIn(), '99999');
    expect(st().bars, 'ten minutes without a song').toBe(300);
  });

  test('Enter commits a typed length', () => {
    resetStudio();
    renderStudio(<EditPane />);
    const el = barsIn();
    el.focus();
    fireEvent.change(el, { target: { value: '12' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(st().bars).toBe(12);
  });

  test('the note says whether the loop fits a Spotify Canvas and what the longest is', () => {
    resetStudio({ bars: 1 });
    renderStudio(<EditPane />);
    expect(note()).toMatch(/^2\.00s at 120\.00 BPM\. Shorter than a Spotify Canvas/);
    expect(note()).toContain('Without a song the longest is 300 bars (10:00).');
    update(() => st().setBars(4));
    expect(note()).toContain('Fits a Spotify Canvas (3 to 8 s).');
    update(() => st().setBars(8));
    expect(note()).toContain('Longer than a Spotify Canvas (3 to 8 s), so export it as YouTube 16:9 or Social 1:1.');
  });

  test('with a song, Whole song runs from the first downbeat to the end, and longer presets are off', () => {
    withSong({ features: { ...SONG, duration: 12, downbeats: [1.5, 3.5, 5.5, 7.5, 9.5], loops: [] }, loopStart: 1.5 }); // a 12 s song
    renderStudio(<EditPane />);
    const seg = field('Loop length').querySelector('.seg') as HTMLElement;
    expect((within(seg).getByText('8 bars') as HTMLButtonElement).disabled).toBe(true);
    expect((within(seg).getByText('4 bars') as HTMLButtonElement).disabled).toBe(false);
    expect(note()).toContain('The longest is 5 bars (10.00s), the song from its first downbeat.');
    fireEvent.click(within(seg).getByText('Whole song'));
    expect(st().bars).toBe(5);
    expect(st().loopStart).toBe(1.5);
    expect(within(seg).getByText('Whole song').className).toBe('on');
    expect(within(seg).getByText('4 bars').className).toBe('');
  });
});

describe('cuts and transitions', () => {
  test('cut rhythm buttons set the rhythm and drop hand-placed cuts', () => {
    resetStudio({ legacyEdit: { customCuts: [1, 2.5], segOverrides: { 0: { trans: 'zoom' } } } });
    renderStudio(<EditPane />);
    const seg = field('Cut rhythm');
    expect(within(seg).getAllByRole('button')).toHaveLength(Object.keys(RHYTHMS).length);
    expect(seg.querySelector('.on'), 'custom cuts match no rhythm button').toBeNull();
    fireEvent.click(within(seg).getByText(RHYTHMS.beat.name));
    expect(st().look!.cut.rhythm).toBe('beat');
    expect(st().blocks).toBe(null);
    expect(st().ctx!.tl.segs).toHaveLength(16);
    expect(within(field('Cut rhythm')).getByText(RHYTHMS.beat.name).className).toBe('on');
  });

  test('the transition browser edits pools, toggles selections and isolates a transition', () => {
    resetStudio();
    renderStudio(<EditPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse transitions' }));
    const browser = within(screen.getByRole('dialog', { name: 'Transition library' }));
    const preset = browser.getByRole('combobox', { name: 'Transition selection preset' });
    fireEvent.change(preset, { target: { value: 'Glitch' } });
    expect(st().look!.cut.transitions).toEqual(POOLS.Glitch);
    expect((preset as HTMLSelectElement).value).toBe('Glitch');
    expect(browser.getAllByRole('checkbox', { name: /^Include / })).toHaveLength(8);
    const search = browser.getByRole('searchbox', { name: 'Search transitions' });
    fireEvent.change(search, { target: { value: TRANSITIONS.dissolve.name } });
    fireEvent.click(browser.getByRole('checkbox', { name: `Include ${TRANSITIONS.dissolve.name}` }));
    expect(st().look!.cut.transitions).toContain('dissolve');
    expect((preset as HTMLSelectElement).value).toBe('');
    fireEvent.click(browser.getByRole('checkbox', { name: `Include ${TRANSITIONS.dissolve.name}` }));
    expect(st().look!.cut.transitions).not.toContain('dissolve');
    fireEvent.change(search, { target: { value: TRANSITIONS.zoom.name } });
    fireEvent.click(browser.getByRole('button', { name: `Use only ${TRANSITIONS.zoom.name}` }));
    expect(st().look!.cut.transitions).toEqual(['zoom']);
    expect((browser.getByRole('checkbox', { name: `Include ${TRANSITIONS.zoom.name}` }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(browser.getByRole('checkbox', { name: `Include ${TRANSITIONS.zoom.name}` }));
    expect(st().look!.cut.transitions, 'the last transition stays').toEqual(['zoom']);
    expect(st().ctx!.tl.segs.slice(1).every((s) => s.trans === 'zoom')).toBe(true);
    fireEvent.click(browser.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Transition library' })).toBeNull();
    expect(within(field('Transitions')).getByText('1 transition selected')).toBeTruthy();
  });

  test('transition length, order, direction and speed ramp buttons edit the cut', () => {
    resetStudio();
    renderStudio(<EditPane />);
    fireEvent.click(within(field('Transition length (beats)')).getByText('½'));
    expect(st().look!.cut.beats).toBe(0.5);
    fireEvent.click(within(field('Transition order')).getByText('Shuffle'));
    expect(st().look!.cut.order).toBe('random');
    fireEvent.click(within(field('Clip direction')).getByText(DIRECTIONS.pingpong));
    expect(st().direction).toBe('pingpong');
    expect(st().ctx!.tl.segs.every((s) => s.pp)).toBe(true);
    fireEvent.click(within(field('Speed ramp')).getByText(VELOCITY.surge.name));
    expect(st().look!.cut.velocity).toBe('surge');
    expect(st().ctx!.tl.segs[0].vel).toBe('surge');
    for (const [label, on] of [['Transition length (beats)', '½'], ['Transition order', 'Shuffle'], ['Clip direction', DIRECTIONS.pingpong], ['Speed ramp', VELOCITY.surge.name]]) {
      expect(within(field(label)).getByText(on).className, label).toBe('on');
    }
  });

  test('the seed field and the re-roll button change the in-points', () => {
    resetStudio();
    renderStudio(<EditPane />);
    const ins = () => st().ctx!.tl.segs.map((s) => s.in);
    const before = ins();
    const seed = field('Edit seed').querySelector('input') as HTMLInputElement;
    fireEvent.change(seed, { target: { value: '77' } });
    expect(st().seed).toBe(77);
    expect(ins()).not.toEqual(before);
    fireEvent.change(seed, { target: { value: '' } });
    expect(st().seed).toBe(1);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fireEvent.click(screen.getByText('⚄ Re-roll in-points & order'));
    expect(st().seed).toBe(500000);
  });
});

describe('tempo and look switching', () => {
  test('clip speed presets and slider retime footage while keeping the beat grid and segment overrides', () => {
    resetStudio();
    update(() => st().setBlock('g1', { overrides: { camera: { speed: 1.75 } } }));
    renderStudio(<EditPane />);
    const cuts = st().ctx!.tl.segs.map((s) => [s.t0, s.t1]);
    const slider = screen.getByLabelText('Default clip speed');
    fireEvent.click(within(field('Clip speed')).getByText('1.5×'));
    expect(st().look!.camera.p.speed).toBe(1.5);
    expect(st().ctx!.tl.segs[0].speed).toBe(1.5);
    expect(st().ctx!.tl.segs[1].speed).toBe(1.75);
    expect(field('Clip speed').querySelector('output')!.textContent).toBe('1.50×');
    fireEvent.change(slider, { target: { value: '0.6' } });
    expect(st().ctx!.tl.segs[0].speed).toBe(0.6);
    expect(st().ctx!.tl.segs.map((s) => [s.t0, s.t1])).toEqual(cuts);
    expect(st().bpm()).toBe(120);
    fireEvent.doubleClick(slider);
    expect(st().look!.camera.p.speed).toBe(1);
  });

  test('without a song the tempo slider sets the beat clock', () => {
    resetStudio();
    renderStudio(<EditPane />);
    const slider = field('Tempo (no track)').querySelector('input') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '150' } });
    expect(st().bpmManual).toBe(150);
    expect(st().ctx!.beatDur).toBe(0.4);
    expect(within(field('Tempo (no track)')).getByText('150 BPM')).toBeTruthy();
  });

  test('with a song the tempo comes from the song, so the slider is gone', () => {
    withSong();
    renderStudio(<EditPane />);
    expect(field('Tempo (no track)')).toBeUndefined();
  });

  test('Keep my edit makes switching looks keep the cuts', () => {
    resetStudio();
    renderStudio(<EditPane />);
    fireEvent.click(screen.getByLabelText(/Keep my edit/));
    expect(st().lockEdit).toBe(true);
    const cut = st().look!.cut;
    update(() => st().setLook(LOOKS[5]));
    expect(st().look!.cut).toBe(cut);
  });
});
