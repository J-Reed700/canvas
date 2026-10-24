import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { LayersPane } from '../../downbeat/studio/src/components/LayersPane.tsx';
import { ParamRow } from '../../downbeat/studio/src/components/ParamRow.tsx';
import { MODULES, CAMERA, CATEGORIES } from '../../downbeat/studio/src/engine/modules.ts';
import { STAGE } from '../../downbeat/studio/src/engine/looks.ts';
import { LOOKS, cloneLook, pop, popButton, popButtons, renderStudio, resetStudio, screen, st, toastText, update, withSong, S } from './studio.tsx';

const cards = () => Array.from(document.querySelectorAll<HTMLElement>('.card'));
const titleOf = (card: HTMLElement) => card.querySelector('.ct')?.firstChild?.textContent || '';
const cardFor = (title: string) => cards().find((c) => titleOf(c) === title) as HTMLElement;
const layerTitles = () => st().look!.layers.map((l) => MODULES[l.m].name);
const shownLayers = () => cards().map(titleOf).filter((t) => !['Master', 'Modulators', 'Camera', 'Finish', 'Color palette', 'Color studio'].includes(t));
const sliderIn = (row: HTMLElement) => row.querySelector('input[type=range]') as HTMLInputElement;
const rowFor = (label: string, root: HTMLElement = document.body) =>
  Array.from(root.querySelectorAll<HTMLElement>('.prm')).find((r) => r.querySelector('label')?.textContent === label) as HTMLElement;

describe('layer cards', () => {
  test('every layer of the look gets a card, in stack order', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    expect(shownLayers()).toEqual(['Liquid Glass', 'Liquid Chrome', 'Bloom']);
    expect(cardFor('Liquid Glass').querySelector('small')?.textContent).toBe(CATEGORIES.warp.name);
    for (const p of MODULES.glass.params) expect(rowFor(p.name, cardFor('Liquid Glass'))).toBeTruthy();
    expect(cardFor('Camera')).toBeTruthy();
    expect(cardFor('Finish')).toBeTruthy();
  });

  test('the switch bypasses a layer and turns it back on, and the card shows it', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const v = st().version;
    fireEvent.click(within(cardFor('Bloom')).getByTitle('Enable / bypass'));
    expect(st().look!.layers[2].on).toBe(false);
    expect(cardFor('Bloom').className).toContain('off');
    expect(cardFor('Bloom').querySelector('.sw')!.className).not.toContain('on');
    expect(st().version).toBeGreaterThan(v);
    fireEvent.click(within(cardFor('Bloom')).getByTitle('Enable / bypass'));
    expect(st().look!.layers[2].on).toBe(true);
    expect(cardFor('Bloom').className).not.toContain('off');
  });

  test('move up, move down and remove change the stack', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    expect((within(cardFor('Liquid Glass')).getByTitle('Move up') as HTMLButtonElement).disabled, 'the top layer cannot go up').toBe(true);
    fireEvent.click(within(cardFor('Liquid Glass')).getByTitle('Move up'));
    expect(layerTitles()).toEqual(['Liquid Glass', 'Liquid Chrome', 'Bloom']);
    fireEvent.click(within(cardFor('Liquid Glass')).getByTitle('Move down'));
    expect(layerTitles()).toEqual(['Liquid Chrome', 'Liquid Glass', 'Bloom']);
    expect(shownLayers()).toEqual(['Liquid Chrome', 'Liquid Glass', 'Bloom']);
    expect((within(cardFor('Bloom')).getByTitle('Move down') as HTMLButtonElement).disabled, 'nor the bottom one down').toBe(true);
    fireEvent.click(within(cardFor('Bloom')).getByTitle('Move down'));
    expect(layerTitles().at(-1)).toBe('Bloom');
    fireEvent.click(within(cardFor('Bloom')).getByTitle('Move up'));
    expect(layerTitles()).toEqual(['Liquid Chrome', 'Bloom', 'Liquid Glass']);
    fireEvent.click(within(cardFor('Liquid Chrome')).getByTitle('Remove'));
    expect(shownLayers()).toEqual(['Bloom', 'Liquid Glass']);
    expect(st().look!.layers.map((l) => l.m)).toEqual(['bloom', 'glass']);
  });

  test('+ Add effect lists every effect by category and adds the one picked', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    fireEvent.click(screen.getByText('+ Add effect'));
    expect(pop().className).toContain('on');
    const headings = Array.from(pop().querySelectorAll('.ph')).map((e) => e.textContent);
    expect(headings).toEqual(Object.values(CATEGORIES).map((c) => c.name));
    expect(popButtons()).toHaveLength(Object.keys(MODULES).length);
    fireEvent.click(popButton(new RegExp(`^${MODULES.trails.name}`)));
    expect(st().look!.layers.at(-1)!.m).toBe('trails');
    expect(shownLayers().at(-1)).toBe('Feedback Trails');
    expect(toastText()).toBe('Added Feedback Trails');
    expect(pop().className).toBe('pop');
  });

  test('Random layer adds an effect the stack does not have yet, at its pipeline stage', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fireEvent.click(screen.getByText('Random layer'));
    const added = Object.keys(MODULES).find((id) => !['glass', 'chrome', 'bloom'].includes(id))!;
    const ms = st().look!.layers.map((l) => l.m);
    expect(ms).toContain(added);
    const stages = ms.map((m) => STAGE.indexOf(MODULES[m].cat!));
    expect([...stages].sort((a, b) => a - b)).toEqual(stages);
    expect(toastText()).toBe(`Added ${MODULES[added].name} at random`);
    expect(shownLayers()).toContain(MODULES[added].name);
  });

  test('Shuffle reorders the stack, and is off with fewer than two layers', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fireEvent.click(screen.getByText('Shuffle'));
    expect(layerTitles()).toEqual(['Liquid Chrome', 'Bloom', 'Liquid Glass']);
    expect(shownLayers()).toEqual(layerTitles());
    expect(toastText()).toBe('Shuffled the stack');
    fireEvent.click(within(cardFor('Bloom')).getByTitle('Remove'));
    fireEvent.click(within(cardFor('Liquid Glass')).getByTitle('Remove'));
    expect(screen.getByText('Shuffle').closest('button')!.disabled).toBe(true);
  });

  test('Clear empties the stack and Revert brings the look back', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    fireEvent.click(screen.getByText('Clear'));
    expect(st().look!.layers).toEqual([]);
    expect(shownLayers()).toEqual([]);
    expect(screen.getByText(/No effect layers: just the camera and the grade/)).toBeTruthy();
    expect(screen.getByText('Clear').closest('button')!.disabled).toBe(true);
    expect(toastText()).toBe('Cleared: Revert restores the look');
    fireEvent.click(screen.getByText('Revert'));
    expect(st().look!.layers).toEqual(LOOKS[0].layers);
    expect(shownLayers()).toEqual(['Liquid Glass', 'Liquid Chrome', 'Bloom']);
    expect(toastText()).toBe(`Reverted to ${LOOKS[0].name}`);
  });

  test('Revert explains when there is no original to go back to', () => {
    resetStudio({ look: { ...cloneLook(LOOKS[0]), id: 'restored-from-last-session' }, lookId: 'restored-from-last-session' });
    renderStudio(<LayersPane />);
    fireEvent.click(screen.getByText('Revert'));
    expect(toastText()).toMatch(/nothing to revert to/);
  });

  test('Save as look asks for a name and adds the look to Your looks', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    fireEvent.click(screen.getByText('Save as look'));
    const input = pop().querySelector('input') as HTMLInputElement;
    expect(input.value).toBe(LOOKS[0].name);
    input.value = '   ';
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(st().saved).toHaveLength(0);
    input.value = 'Night drive';
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(st().saved[0].name).toBe('Night drive');
    expect(pop().className).toBe('pop');
  });
});

describe('folding cards', () => {
  test('section navigation isolates effects and color without unmounting either toolset', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const nav = screen.getByRole('navigation', { name: 'Layer inspector sections' });
    const effects = document.getElementById('layer-effects-section') as HTMLElement;
    const color = document.getElementById('layer-color-section') as HTMLElement;
    expect(effects.hidden).toBe(false);
    expect(color.hidden).toBe(false);

    fireEvent.click(within(nav).getByRole('button', { name: 'Color' }));
    expect(effects.hidden).toBe(true);
    expect(color.hidden).toBe(false);
    expect(cardFor('Master'), 'the effect controls stay mounted').toBeTruthy();

    fireEvent.click(within(nav).getByRole('button', { name: /^Effects/ }));
    expect(effects.hidden).toBe(false);
    expect(color.hidden).toBe(true);
    expect(cardFor('Color studio'), 'the color tools stay mounted').toBeTruthy();
  });

  test('clicking a card header folds it, but not when the click is on a control in it', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const bloom = cardFor('Bloom');
    const fold = bloom.querySelector('button.fold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(bloom.querySelector('.ct')!);
    expect(bloom.classList.contains('collapsed')).toBe(true);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.title).toBe('Unfold');
    expect(bloom.querySelector('.prms input[type=range]'), 'the controls stay in the page, hidden').toBeTruthy();

    const on = st().look!.layers.find((l) => l.m === 'bloom')!.on;
    fireEvent.click(within(bloom).getByTitle('Enable / bypass'));
    expect(st().look!.layers.find((l) => l.m === 'bloom')!.on).toBe(!on);
    expect(bloom.classList.contains('collapsed'), 'the switch does not fold the card').toBe(true);

    fireEvent.click(fold);
    expect(bloom.classList.contains('collapsed')).toBe(false);
    expect(cardFor('Master').classList.contains('collapsed')).toBe(false);
  });
});

describe('master card', () => {
  test('FX intensity sets the store and the playing edit, and double-click resets it', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const row = rowFor('FX intensity');
    fireEvent.change(sliderIn(row), { target: { value: '0.5' } });
    expect(st().intensity).toBe(0.5);
    expect(st().ctx!.intensity).toBe(0.5);
    expect(row.querySelector('output')!.textContent).toBe('50%');
    fireEvent.doubleClick(sliderIn(rowFor('FX intensity')));
    expect(st().intensity).toBe(1);
  });

  test('FX intensity goes past 100% up to 180%', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const slider = sliderIn(rowFor('FX intensity'));
    expect(slider.max).toBe('1.8');
    fireEvent.change(slider, { target: { value: '1.5' } });
    expect(st().ctx!.intensity).toBe(1.5);
    expect(rowFor('FX intensity').querySelector('output')!.textContent).toBe('150%');
  });

  test('Evolve can mutate every cut instead of every clip', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    expect(screen.queryByLabelText('A new mutation on every cut, not just every clip')).toBeNull();
    fireEvent.click(screen.getByText('Evolve'));
    const box = screen.getByLabelText('A new mutation on every cut, not just every clip') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(st().evolveCuts).toBe(true);
    expect(screen.getByText(/every later cut gets its own mutation of it, even when its clip has been on before/)).toBeTruthy();
    expect(document.querySelector('.stack-scope')!.textContent).toBe('Main stack: runs on the first cut. Every later cut gets a mutation of it.');
    const [, second] = st().ctx!.tl.segs;
    expect(st().ctx!.clipLook!(second.clipId, second)).not.toBe(st().look);
  });

  test('Evolve shows its amount slider and explains what happens to later clips', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    expect(rowFor('Evolve amount')).toBeUndefined();
    fireEvent.click(screen.getByText('Evolve'));
    expect(st().clipMode).toBe('evolve');
    expect(screen.getByText('Evolve').className).toBe('on');
    expect(screen.getByText(/each later clip gets its own mutation/)).toBeTruthy();
    fireEvent.change(sliderIn(rowFor('Evolve amount')), { target: { value: '0.8' } });
    expect(st().evolveAmt).toBe(0.8);
    expect(document.querySelector('.stack-scope')!.textContent).toBe('Main stack: runs on #1. Later clips get a mutation of it.');
  });

  test('in Custom, picking a clip edits its own stack; Camera and Finish stay on Main', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    fireEvent.click(screen.getByText('Custom'));
    const strip = document.querySelector('.clipstrip') as HTMLElement;
    expect(Array.from(strip.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Main', '1', '2', '3']);
    fireEvent.click(within(strip).getByText('2'));
    expect(st().editClip).toBe('b');
    expect(titleOf(cards()[0])).toBe(`Clip 2 · ${LOOKS[0].name}`);
    expect(cardFor('Camera')).toBeUndefined();
    expect(cardFor('Finish')).toBeUndefined();
    expect(screen.getByText(/shared by every clip. Edit them on Main/)).toBeTruthy();
    expect(document.querySelector('.stack-scope')!.textContent).toMatch(/^Clip 2's own stack/);

    // a layer edit here changes clip 2 only
    fireEvent.click(within(cardFor('Bloom')).getByTitle('Remove'));
    expect(st().clipLooks.b.layers.map((l) => l.m)).toEqual(['glass', 'chrome']);
    expect(st().look!.layers).toHaveLength(3);
    expect(document.querySelector('.stack-scope')!.textContent).toMatch(/^Clip 2's own stack/);

    fireEvent.click(screen.getByText('Reset clip 2'));
    expect(st().clipLooks.b).toBeUndefined();
    expect(st().editClip).toBe(null);
    expect(cardFor('Camera')).toBeTruthy();
    expect(document.querySelector('.stack-scope')!.textContent).toBe('Main stack: runs on #1, #2, #3 (clips without their own stack).');
  });

  test('Same look on all drops the per-clip looks; Roll FX per clip makes them', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    expect(screen.queryByText('Same look on all')).toBeNull();
    fireEvent.click(screen.getByText('Roll FX per clip'));
    expect(st().clipMode).toBe('custom');
    expect(Object.keys(st().clipLooks).sort()).toEqual(['a', 'b', 'c']);
    expect(document.querySelector('.stack-scope')!.textContent).toMatch(/every clip has its own stack right now/);
    fireEvent.click(screen.getByText('Same look on all'));
    expect(st().clipMode).toBe('one');
    expect(st().clipLooks).toEqual({});
    expect(toastText()).toBe('Main look on every clip');
  });
});

describe('parameter rows', () => {
  test('a slider sets its value and shows it; double-click resets it', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const card = cardFor('Liquid Glass');
    const v = st().version;
    fireEvent.change(sliderIn(rowFor('Refraction', card)), { target: { value: '0.9' } });
    expect(st().look!.layers[0].p.strength).toBe(0.9);
    expect(rowFor('Refraction', cardFor('Liquid Glass')).querySelector('output')!.textContent).toBe('0.90');
    expect(st().version).toBeGreaterThan(v);
    fireEvent.doubleClick(sliderIn(rowFor('Refraction', cardFor('Liquid Glass'))));
    expect(st().look!.layers[0].p.strength).toBe(MODULES.glass.params[0].def);
  });

  test('whole-number sliders show whole numbers and step by one', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const row = rowFor('Flow / loop', cardFor('Liquid Glass'));
    expect(sliderIn(row).step).toBe('1');
    fireEvent.change(sliderIn(row), { target: { value: '3' } });
    expect(rowFor('Flow / loop', cardFor('Liquid Glass')).querySelector('output')!.textContent).toBe('3');
    expect(row.querySelector('.modbtn')!.className).toContain('na');
  });

  test('a choice parameter is a row of buttons', () => {
    resetStudio({ look: { ...cloneLook(LOOKS[0]), layers: [{ m: 'mirror', on: true, p: {}, mods: {} }] } });
    renderStudio(<LayersPane />);
    const row = rowFor('Mode', cardFor(MODULES.mirror.name));
    fireEvent.click(within(row).getByText('Horizon'));
    expect(st().look!.layers[0].p.mode).toBe(2);
    expect(within(rowFor('Mode', cardFor(MODULES.mirror.name))).getByText('Horizon').className).toBe('on');
  });

  test('clip speed retimes the edit', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    const before = st().ctx;
    fireEvent.change(sliderIn(rowFor('Clip speed', cardFor('Camera'))), { target: { value: '1.5' } });
    expect(st().look!.camera.p.speed).toBe(1.5);
    expect(st().ctx).not.toBe(before);
    expect(st().ctx!.tl.segs[0].speed).toBe(1.5);
  });

  test('the ● button routes a source to the slider, sets its amount and removes it', () => {
    withSong();
    renderStudio(<LayersPane />);
    fireEvent.click(rowFor('Shake', cardFor('Camera')).querySelector('.modbtn')!);
    expect(Array.from(pop().querySelectorAll('.ph')).map((e) => e.textContent)).toEqual([
      'Modulate Shake', 'From the song', 'Tempo clocks · loop-locked', 'Yours · Modulators card',
    ]);
    fireEvent.click(popButton('Kick'));
    expect(st().look!.camera.mods.shake).toEqual({ src: 'kick', amt: 0.25 });
    expect(popButton('Kick').className).toContain('on');
    const amt = pop().querySelector('.amt input') as HTMLInputElement;
    fireEvent.input(amt, { target: { value: '-0.4' } });
    expect(st().look!.camera.mods.shake.amt).toBe(-0.4);
    expect(pop().querySelector('.amt output')!.textContent).toBe('-0.40');
    expect(rowFor('Shake', cardFor('Camera')).className).toContain('modded');
    expect(rowFor('Shake', cardFor('Camera')).querySelector('.modbtn')!.getAttribute('title')).toBe('Kick × -0.40');

    fireEvent.click(popButton('Step sequencer'));
    expect(st().look!.camera.mods.shake, 'switching source keeps the amount').toEqual({ src: 'seq', amt: -0.4 });
    fireEvent.click(popButton('Remove modulation'));
    expect(st().look!.camera.mods.shake).toBeUndefined();
    expect(rowFor('Shake', cardFor('Camera')).className).not.toContain('modded');
  });

  test('your own sources start at half strength, and the list says when there is no song', () => {
    resetStudio();
    renderStudio(<LayersPane />);
    fireEvent.click(rowFor('Drift', cardFor('Camera')).querySelector('.modbtn')!);
    expect(pop().textContent).toContain('Audio (synthetic beat, no track)');
    fireEvent.click(popButton('Macro A'));
    expect(st().look!.camera.mods.drift).toEqual({ src: 'macroA', amt: 0.5 });
  });

  test('a modulation route exposes attack, decay, gate and sidechain ducking controls', () => {
    withSong();
    renderStudio(<LayersPane />);
    fireEvent.click(rowFor('Shake', cardFor('Camera')).querySelector('.modbtn')!);
    fireEvent.click(popButton('Kick'));
    fireEvent.input(within(pop()).getByLabelText('Attack'), { target: { value: '120' } });
    fireEvent.input(within(pop()).getByLabelText('Decay'), { target: { value: '450' } });
    fireEvent.input(within(pop()).getByLabelText('Gate'), { target: { value: '0.3' } });
    fireEvent.change(within(pop()).getByLabelText('Sidechain source'), { target: { value: 'bass' } });
    fireEvent.input(within(pop()).getByLabelText('Duck amount'), { target: { value: '0.65' } });
    expect(st().look!.camera.mods.shake).toEqual({
      src: 'kick', amt: 0.25, attack: 120, decay: 450, gate: 0.3, duck: { src: 'bass', amount: 0.65 },
    });
    fireEvent.click(popButton('Step sequencer'));
    expect(st().look!.camera.mods.shake.attack, 'shape follows the route when its source changes').toBe(120);
  });

  test('each slider registers a marker that reads the live value from the frame on screen', () => {
    resetStudio({ ghosts: [] });
    const holder = { p: { zoom: 1.2 }, mods: {} };
    const read = vi.fn((fr: any) => fr.camera.p_zoom);
    renderStudio(<ParamRow p={CAMERA.params[0]} holder={holder} readLive={read} />);
    const [g] = st().ghosts;
    expect(g.el).toBe(document.querySelector('.ghost'));
    expect(g.def).toBe(CAMERA.params[0]);
    expect(g.read({ camera: { p_zoom: 1.4 } })).toBe(1.4);
    update(() => S.setState({ version: st().version + 1 }));
    expect(st().ghosts).toHaveLength(1);
  });
});
