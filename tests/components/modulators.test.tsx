import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { ModulatorsCard } from '../../downbeat/studio/src/components/ModulatorsCard.tsx';
import { LayersPane } from '../../downbeat/studio/src/components/LayersPane.tsx';
import { SEQ_PRESETS, ENV_PRESETS } from '../../downbeat/studio/src/lib/utils.ts';
import { defaultEnv, defaultSeq } from '../../downbeat/studio/src/engine/audio.ts';
import { LOOKS, cloneLook, renderStudio, resetStudio, screen, serve, st, toastText, update, S } from './studio.tsx';

const PALETTE = {
  colors: [
    { hex: '#e04a2f', rgb: [224, 74, 47], hue: 0.025, role: 'accent' },
    { hex: '#1b2a4a', rgb: [27, 42, 74], hue: 0.61, role: 'shadow' },
    { hex: '#f3e6c8', rgb: [243, 230, 200], hue: 0.115, role: 'highlight' },
  ],
  css_gradient: 'linear-gradient(180deg, #e04a2f, #1b2a4a)',
  primary_hue: 0.025,
};

const steps = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.seqgrid button'));
const lit = () => steps().map((b) => (b.className === 'on' ? 1 : 0));
const rowFor = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.prm')).find((r) => r.querySelector('label')?.textContent === label) as HTMLElement;
const palRows = () => Array.from(document.querySelectorAll<HTMLElement>('.pal-row'));
const lfoBlock = (i: number) => document.querySelectorAll<HTMLElement>('.lfo')[i];

describe('brand palette', () => {
  test("the first clip's palette is fetched and listed with its colors and roles", async () => {
    const fetch = serve({ '/api/palette/a': () => ({ ok: true, ...PALETTE }) });
    resetStudio();
    renderStudio(<ModulatorsCard />);
    await waitFor(() => expect(palRows()).toHaveLength(3));
    expect(fetch).toHaveBeenCalledWith('/api/palette/a', undefined);
    expect(palRows().map((r) => [r.querySelector('.hex')!.textContent, r.querySelector('.role')!.textContent])).toEqual([
      ['#e04a2f', 'accent'], ['#1b2a4a', 'shadow'], ['#f3e6c8', 'highlight'],
    ]);
    expect((document.querySelector('.pal-grad') as HTMLElement).style.background).toContain('linear-gradient');
  });

  test('clicking a color tints the Finish split tone and every hue slider in the stack', () => {
    const look = cloneLook(LOOKS[0]);
    look.layers.push({ m: 'streaks', on: true, p: {}, mods: {} }, { m: 'leak', on: false, p: {}, mods: {} });
    resetStudio({ look, palettes: { a: PALETTE } });
    renderStudio(<ModulatorsCard />);
    const v = st().version;
    fireEvent.click(palRows()[1]);
    expect(st().look!.finish.p.splitHue).toBe(0.61);
    expect(st().look!.finish.p.split).toBe(0.6);
    expect(st().look!.layers[3].p.hue).toBe(0.61);
    expect(st().look!.layers[4].p.hue, 'a bypassed layer is left alone').toBeUndefined();
    expect(st().version).toBeGreaterThan(v);
    expect(toastText()).toBe('Tinted with #1b2a4a: Finish split tone + 1 layer hue · ⌘Z undoes');
    expect(palRows()[1].className).toContain('on');
    expect(palRows()[1].querySelector('.act')!.textContent).toBe('Tinted');
    expect(palRows()[0].querySelector('.act')!.textContent).toBe('Tint');

    // a strong split tone stays strong
    update(() => { st().look!.finish.p.split = 0.9; });
    fireEvent.keyDown(palRows()[0], { key: 'Enter' });
    expect(st().look!.finish.p.split).toBe(0.9);
    expect(st().look!.finish.p.splitHue).toBe(0.025);
    expect(palRows()[0].className).toContain('on');
    fireEvent.keyDown(palRows()[2], { key: ' ' });
    expect(st().look!.finish.p.splitHue).toBe(0.115);
  });

  test('the hex button copies the color without tinting', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    resetStudio({ palettes: { a: PALETTE } });
    renderStudio(<ModulatorsCard />);
    fireEvent.click(within(palRows()[0]).getByText('#e04a2f'));
    expect(writeText).toHaveBeenCalledWith('#e04a2f');
    await waitFor(() => expect(toastText()).toBe('Copied #e04a2f'));
    expect(st().look!.finish.p.splitHue).toBe(LOOKS[0].finish.p.splitHue);
    expect(palRows()[0].className).not.toContain('on');
  });

  test('editing one clip still tints the shared Finish grade on the main look', () => {
    const clipLook = cloneLook(LOOKS[0]);
    clipLook.layers = [{ m: 'glint', on: true, p: {}, mods: {} }];
    resetStudio({ palettes: { a: PALETTE }, clipMode: 'custom', clipLooks: { b: clipLook }, editClip: 'b' });
    renderStudio(<ModulatorsCard />);
    fireEvent.click(palRows()[2]);
    expect(st().look!.finish.p.splitHue).toBe(0.115);
    expect(st().clipLooks.b.layers[0].p.hue).toBe(0.115);
    expect(st().clipLooks.b.finish.p.splitHue, "the clip's own copy of Finish is not used").toBe(LOOKS[0].finish.p.splitHue);
  });
});

describe('step sequencer', () => {
  test('clicking a step turns it on and off', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    expect(lit()).toEqual(defaultSeq());
    const v = st().version;
    fireEvent.click(steps()[2]);
    expect(st().look!.seq![2]).toBe(1);
    expect(steps()[2].className).toBe('on');
    expect(st().version).toBeGreaterThan(v);
    fireEvent.click(steps()[2]);
    expect(st().look!.seq![2]).toBe(0);
    expect(steps()[2].className).toBe('');
  });

  test('every preset fills the grid', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    for (const name of Object.keys(SEQ_PRESETS)) {
      fireEvent.click(within(screen.getByText('Step sequencer · 1 bar').parentElement!).getByText(name));
      const want = name === 'Random' ? SEQ_PRESETS.Four() : SEQ_PRESETS[name]();
      expect(st().look!.seq, name).toEqual(want);
      expect(lit(), name).toEqual(want);
    }
  });

  test('the render loop gets the grid to light the current step', () => {
    resetStudio();
    const { unmount } = renderStudio(<ModulatorsCard />);
    expect(st().modUI!.grid).toBe(document.querySelector('.seqgrid'));
    expect(typeof st().modUI!.drawEnv).toBe('function');
    unmount();
    expect(st().modUI).toBe(null);
  });
});

describe('drawn envelope', () => {
  const canvas = () => document.querySelector('canvas.envcv:not(.lfocv)') as HTMLCanvasElement;
  const box = (cv: HTMLCanvasElement) =>
    vi.spyOn(cv, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 160, height: 108, right: 160, bottom: 108, x: 0, y: 0, toJSON() {} });

  test('presets replace the envelope', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    for (const name of ['Ramp', 'Dip', 'Pulses', 'Arc']) {
      fireEvent.click(within(screen.getByText('Envelope · whole loop').parentElement!).getByText(name));
      expect(st().look!.env, name).toEqual(ENV_PRESETS[name]());
    }
  });

  test('dragging on the envelope draws points, and double-click puts the arc back', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    const cv = canvas();
    box(cv);
    cv.setPointerCapture = () => {};
    fireEvent.pointerDown(cv, { clientX: 0, clientY: 4, pointerId: 1 });
    expect(st().look!.env![0]).toBe(1);
    fireEvent.pointerMove(cv, { clientX: 80, clientY: 104, pointerId: 1 });
    expect(st().look!.env![8]).toBe(0);
    fireEvent.pointerUp(cv, { pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 40, clientY: 4, pointerId: 1 });
    expect(st().look!.env![4], 'moving without the button down draws nothing').not.toBe(1);
    fireEvent.doubleClick(cv);
    expect(st().look!.env).toEqual(defaultEnv());
  });
});

describe('macros and LFOs', () => {
  test('Macro A and B sliders move and set the look', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    fireEvent.change(rowFor('Macro A').querySelector('input')!, { target: { value: '0.6' } });
    expect(st().look!.macro).toEqual({ a: 0.6, b: 0 });
    expect(rowFor('Macro A').querySelector('output')!.textContent).toBe('60%');
    expect((rowFor('Macro A').querySelector('.knob') as HTMLElement).style.left).toBe('60%');
    fireEvent.change(rowFor('Macro B').querySelector('input')!, { target: { value: '0.25' } });
    expect(st().look!.macro).toEqual({ a: 0.6, b: 0.25 });
    fireEvent.doubleClick(rowFor('Macro A').querySelector('input')!);
    expect(st().look!.macro!.a).toBe(0);
  });

  test('LFO shape, rate and phase controls edit that LFO', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    fireEvent.click(within(lfoBlock(0)).getByLabelText('Square'));
    expect(st().look!.lfos![0].shape).toBe('square');
    expect(within(lfoBlock(0)).getByLabelText('Square').className).toBe('on');
    fireEvent.click(within(lfoBlock(1)).getByText('½'));
    expect(st().look!.lfos![1].rate).toBe(0.5);
    fireEvent.change(lfoBlock(0).querySelector('.prm input')!, { target: { value: '0.25' } });
    expect(st().look!.lfos![0].phase).toBe(0.25);
    expect(lfoBlock(0).querySelector('.prm output')!.textContent).toBe('90°');
  });

  test('the LFO header counts cycles per loop and says when a cycle is longer than the loop', () => {
    resetStudio(); // 4 bars
    renderStudio(<ModulatorsCard />);
    expect(lfoBlock(0).querySelector('.mod-h span')!.textContent).toBe('LFO A · 4 cycles per loop');
    expect(lfoBlock(1).querySelector('.mod-h span')!.textContent).toBe('LFO B · 2 cycles per loop');
    fireEvent.click(within(lfoBlock(1)).getByText('Loop'));
    expect(lfoBlock(1).querySelector('.mod-h span')!.textContent).toBe('LFO B · 1 cycle per loop');
    update(() => st().setBars(1));
    expect(lfoBlock(0).querySelector('.mod-h span')!.textContent).toBe('LFO A · 1 cycle per loop');
    fireEvent.click(within(lfoBlock(0)).getByText('4'));
    expect(lfoBlock(0).querySelector('.mod-h span')!.textContent).toBe('LFO A · once per loop (the loop is 1 bar)');
  });

  test('random shapes get a New pattern button that changes their seed', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    expect(within(lfoBlock(0)).queryByText('🎲 New pattern')).toBeNull();
    fireEvent.click(within(lfoBlock(0)).getByLabelText('Random steps'));
    const seed = st().look!.lfos![0].seed;
    fireEvent.click(within(lfoBlock(0)).getByText('🎲 New pattern'));
    expect(st().look!.lfos![0].seed).toBe(seed + 1);
  });
});

describe('routing summary', () => {
  test('lists what each of your sources drives once something is connected', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    expect(document.querySelector('.mod-routes')!.textContent).toMatch(/^None of these are connected yet/);
    update(() => {
      st().look!.layers[0].mods.strength = { src: 'macroA', amt: 0.5 };
      st().look!.camera.mods.shake = { src: 'seq', amt: 0.5 };
      st().look!.layers[2].on = false;
      st().look!.layers[2].mods.intensity = { src: 'env', amt: 0.5 };
      st().touch();
    });
    const lines = Array.from(document.querySelectorAll('.mod-routes > div')).map((d) => d.textContent);
    expect(lines).toEqual([
      'LFO A → nothing yet',
      'LFO B → nothing yet',
      'Macro A → Liquid Glass · Refraction',
      'Macro B → nothing yet',
      'Drawn envelope → nothing yet',
      'Step sequencer → Camera · Shake',
    ]);
  });

  test("while editing a clip's stack, Camera and Finish routes are not counted", () => {
    const own = cloneLook(LOOKS[0]);
    own.camera.mods.shake = { src: 'seq', amt: 0.5 };
    resetStudio({ clipMode: 'custom', clipLooks: { b: own }, editClip: 'b' });
    renderStudio(<ModulatorsCard />);
    expect(document.querySelector('.mod-routes')!.textContent).toMatch(/^None of these are connected yet/);
  });

  test('controls follow the look being edited after an undo replaces it', () => {
    resetStudio();
    renderStudio(<ModulatorsCard />);
    fireEvent.click(steps()[1]);
    update(() => S.setState({ look: cloneLook(LOOKS[0]), version: st().version + 1 }));
    expect(lit()).toEqual(defaultSeq());
    fireEvent.click(steps()[3]);
    expect(st().look!.seq![3]).toBe(1);
  });
});
