import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { EditPane } from '../../downbeat/studio/src/components/EditPane.tsx';
import { RHYTHMS, DIRECTIONS, VELOCITY } from '../../downbeat/studio/src/engine/timeline.ts';
import { TRANSITIONS } from '../../downbeat/studio/src/engine/shaders.ts';
import { POOLS } from '../../downbeat/studio/src/lib/utils.ts';
import { LOOKS, SONG, renderStudio, resetStudio, screen, st, update, withSong } from './studio.tsx';

const field = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.field')).find((f) => f.querySelector(':scope > label')?.textContent === label) as HTMLElement;
const barsIn = () => screen.getByLabelText('Loop length in bars') as HTMLInputElement;
const lenIn = () => screen.getByLabelText('Loop length in minutes and seconds') as HTMLInputElement;
const typeInto = (el: HTMLInputElement, text: string) => {
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
};
const note = () => field('Loop length').querySelector(':scope > .note')!.textContent;

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
    resetStudio({ customCuts: [1, 2.5], segOverrides: { 0: { trans: 'zoom' } } });
    renderStudio(<EditPane />);
    const seg = field('Cut rhythm');
    expect(within(seg).getAllByRole('button')).toHaveLength(Object.keys(RHYTHMS).length);
    expect(seg.querySelector('.on'), 'custom cuts match no rhythm button').toBeNull();
    fireEvent.click(within(seg).getByText(RHYTHMS.beat.name));
    expect(st().look!.cut.rhythm).toBe('beat');
    expect(st().customCuts).toBe(null);
    expect(st().segOverrides).toEqual({});
    expect(st().ctx!.tl.segs).toHaveLength(16);
    expect(within(field('Cut rhythm')).getByText(RHYTHMS.beat.name).className).toBe('on');
  });

  test('a transition pool replaces the transitions; the grid toggles them one at a time', () => {
    resetStudio();
    renderStudio(<EditPane />);
    const f = field('Transitions');
    fireEvent.click(within(f).getByText('Glitch'));
    expect(st().look!.cut.transitions).toEqual(POOLS.Glitch);
    expect(within(field('Transitions')).getByText('Glitch').className).toContain('on');
    const grid = f.querySelector('.tgrid') as HTMLElement;
    expect(within(grid).getAllByRole('button')).toHaveLength(Object.keys(TRANSITIONS).length);
    fireEvent.click(within(grid).getByText(TRANSITIONS.dissolve.name));
    expect(st().look!.cut.transitions).toContain('dissolve');
    expect(within(field('Transitions')).getByText('Glitch').className, 'no longer exactly the pool').not.toContain('on');
    fireEvent.click(within(grid).getByText(TRANSITIONS.dissolve.name));
    expect(st().look!.cut.transitions).not.toContain('dissolve');
    fireEvent.doubleClick(within(grid).getByText(TRANSITIONS.zoom.name));
    expect(st().look!.cut.transitions).toEqual(['zoom']);
    fireEvent.click(within(grid).getByText(TRANSITIONS.zoom.name));
    expect(st().look!.cut.transitions, 'the last transition stays').toEqual(['zoom']);
    expect(st().ctx!.tl.segs.slice(1).every((s) => s.trans === 'zoom')).toBe(true);
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
