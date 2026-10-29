import React from 'react';
import { describe, expect, test } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { InspectorPanel } from '../../downbeat/studio/src/components/InspectorPanel/InspectorPanel.tsx';
import { LooksPane } from '../../downbeat/studio/src/components/LooksPane/LooksPane.tsx';
import { TopBar } from '../../downbeat/studio/src/components/TopBar/TopBar.tsx';
import { LOOKS, cloneLook, renderStudio, resetStudio, screen, st, toastText, update } from './studio.tsx';

const lookCard = (id: string) => document.querySelector(`[data-look-id="${id}"]`) as HTMLElement;
const tabs = () => document.getElementById('tabs') as HTMLElement;

describe('inspector tabs', () => {
  test('the persistent scope targets one repeated appearance and preserves it when the main look changes', () => {
    const main = cloneLook(LOOKS[0]);
    main.cut.rhythm = 'half';
    resetStudio({ look: main, bars: 5, tab: 'looks' });
    const occurrences = st().ctx!.tl.segs.filter((seg) => seg.clipId === 'a');
    update(() => st().selectBlock(occurrences[1].id));
    renderStudio(<InspectorPanel />);
    const scopes = screen.getByRole('group', { name: 'Apply effects to' });
    expect(within(scopes).getByText('This appearance').getAttribute('aria-pressed')).toBe('true');
    expect(st().blocks).toBeNull();
    fireEvent.click(lookCard('vhs'));
    expect(st().blocks!.find((b) => b.id === occurrences[1].id)!.look!.id).toBe('vhs');
    expect(st().look).toBe(main);
    expect(st().ctx!.tl.segs.find((seg) => seg.id === occurrences[0].id)!.look).toBeUndefined();
    expect(screen.getByText('Use source look')).toBeTruthy();
    fireEvent.click(within(scopes).getByText('Whole edit'));
    fireEvent.click(lookCard('thermal'));
    expect(st().look!.id).toBe('thermal');
    expect(st().blocks!.find((b) => b.id === occurrences[1].id)!.look!.id).toBe('vhs');
    fireEvent.click(within(scopes).getByText('This appearance'));
    fireEvent.click(screen.getByText('Use source look'));
    expect(st().ctx!.tl.segs.find((seg) => seg.id === occurrences[1].id)!.look).toBeUndefined();
  });

  test('a layer slider forks the selected appearance without changing the inherited layer', () => {
    resetStudio({ tab: 'layers' });
    const block = st().ctx!.tl.segs[1];
    const before = JSON.stringify(st().look);
    update(() => st().selectBlock(block.id));
    renderStudio(<InspectorPanel />);
    const card = Array.from(document.querySelectorAll('.card')).find((card) => card.querySelector('.ct')?.firstChild?.textContent === 'Liquid Glass')!;
    const slider = card.querySelector('input[type=range]')!;
    fireEvent.change(slider, { target: { value: '0.8' } });
    expect(st().blocks!.find((b) => b.id === block.id)!.look).toBeTruthy();
    expect(JSON.stringify(st().look)).toBe(before);
    expect(screen.getByText('Own look')).toBeTruthy();
  });

  test('color, camera and animation families edit the same appearance without touching the main look', () => {
    resetStudio({ tab: 'layers' });
    const id = st().ctx!.tl.segs[1].id;
    const before = JSON.stringify(st().look);
    update(() => st().selectBlock(id));
    renderStudio(<InspectorPanel />);
    const nav = screen.getByRole('navigation', { name: 'Layer inspector sections' });
    const change = (label: string, value: string) => {
      const row = Array.from(document.querySelectorAll('.prm')).find((row) => row.querySelector('label')?.textContent === label)!;
      fireEvent.change(row.querySelector('input[type=range]')!, { target: { value } });
    };
    fireEvent.click(within(nav).getByText('Color'));
    change('Exposure', '1');
    fireEvent.click(within(nav).getByText('Motion'));
    change('Zoom', '1.6');
    fireEvent.click(within(nav).getByText('Animate'));
    fireEvent.click(screen.getByTitle('Step 6 (16th note 6 of the bar)'));
    const own = st().blocks!.find((block) => block.id === id)!.look!;
    expect(own.finish.p.exposure).toBe(1);
    expect(own.camera.p.zoom).toBe(1.6);
    expect(own.seq).toBeTruthy();
    expect(JSON.stringify(st().look)).toBe(before);
  });

  test('the tabs switch panes and show how many looks and layers there are', () => {
    resetStudio({ tab: 'looks' });
    renderStudio(<InspectorPanel />);
    expect(document.getElementById('pane-looks')).toBeTruthy();
    expect(document.getElementById('lookCount')!.textContent).toBe(String(LOOKS.length));
    expect(document.getElementById('layerCount')!.textContent).toBe('3');
    fireEvent.click(within(tabs()).getByText('Layers'));
    expect(st().tab).toBe('layers');
    expect(document.getElementById('pane-layers')).toBeTruthy();
    expect(document.getElementById('pane-looks')).toBeNull();
    fireEvent.click(within(tabs()).getByText('Edit'));
    expect(document.getElementById('pane-edit')).toBeTruthy();
    expect(within(tabs()).getByText('Edit').className).toBe('on');
  });

  test('the layer count follows edits made in place', () => {
    resetStudio({ tab: 'layers' });
    renderStudio(<InspectorPanel />);
    fireEvent.click(screen.getByText('Clear'));
    expect(document.getElementById('layerCount')!.textContent).toBe('0');
  });

  test('a saved look counts toward the looks tab', () => {
    resetStudio({ tab: 'looks', saved: [{ ...cloneLook(LOOKS[1]), id: 'mine-1', name: 'Mine', mine: true }] });
    renderStudio(<InspectorPanel />);
    expect(document.getElementById('lookCount')!.textContent).toBe(String(LOOKS.length + 1));
  });

  test('the tablist supports arrow-key navigation and reports the active tab', () => {
    resetStudio({ tab: 'looks' });
    renderStudio(<InspectorPanel />);
    const looks = screen.getByRole('tab', { name: /^Looks/ });
    expect(looks.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(looks, { key: 'ArrowRight' });
    expect(st().tab).toBe('layers');
    expect(screen.getByRole('tab', { name: /^Layers/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: /^Layers/ }), { key: 'End' });
    expect(st().tab).toBe('edit');
  });
});

describe('looks grid', () => {
  test('every look is listed under its group, with yours first', () => {
    const mine = { ...cloneLook(LOOKS[1]), id: 'mine-1', name: 'Night drive', mine: true };
    resetStudio({ tab: 'looks', saved: [mine] });
    renderStudio(<LooksPane />);
    expect(document.querySelectorAll('.look')).toHaveLength(LOOKS.length + 1);
    expect(Array.from(document.querySelectorAll('.look-group')).map((g) => g.textContent)).toEqual([
      'Your looks', 'Studio looks', 'Album art & stills', 'Classic stacks',
      'Natural', 'Monochrome', 'Film', 'Soft', 'Light & shadow', 'Illustrated',
    ]);
    expect(lookCard('mine-1').querySelector('b')!.textContent).toBe('★ Night drive');
    expect(lookCard(LOOKS[0].id).className).toContain('on');
  });

  test('clicking a look applies it and marks it', () => {
    resetStudio({ tab: 'looks' });
    renderStudio(<LooksPane />);
    fireEvent.click(lookCard('vhs'));
    expect(st().lookId).toBe('vhs');
    expect(st().look!.name).toBe(LOOKS.find((l) => l.id === 'vhs')!.name);
    expect(lookCard('vhs').className).toContain('on');
    expect(lookCard(LOOKS[0].id).className).not.toContain('on');
    expect(toastText()).toBe(st().look!.name);
  });

  test('while a clip is picked, a look goes on that clip only', () => {
    resetStudio({ tab: 'looks' });
    update(() => st().editClipLook('b'));
    update(() => st().setTab('looks'));
    renderStudio(<LooksPane />);
    const banner = document.getElementById('lookTarget') as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('Clicking a look applies it to clip 2');
    fireEvent.click(lookCard('thermal'));
    expect(st().clipLooks.b.id).toBe('thermal');
    expect(st().lookId).toBe(LOOKS[0].id);
    expect(lookCard('thermal').className).toContain('on');
    fireEvent.click(within(banner).getByText('Back to main'));
    expect(st().editClip).toBe(null);
    expect((document.getElementById('lookTarget') as HTMLElement).hidden).toBe(true);
    expect(lookCard(LOOKS[0].id).className).toContain('on');
  });

  test('All uses in the inspector scope opens a generated clip look without changing the composition', () => {
    resetStudio({ tab: 'looks', clipMode: 'cycle' });
    const main = cloneLook(st().look!);
    const before = st().selected.map((id) => cloneLook(st().clipLookOf(id)));
    const segB = st().ctx!.tl.segs.find((seg) => seg.clipId === 'b')!;
    update(() => st().selectBlock(segB.id));
    renderStudio(<InspectorPanel />);
    const scopes = screen.getByRole('group', { name: 'Apply effects to' });
    fireEvent.click(within(scopes).getByText('All uses'));
    expect(st().tab).toBe('looks');
    expect(st().editClip).toBe('b');
    expect(st().selected.map((id) => st().clipLookOf(id))).toEqual(before);
    expect(lookCard(before[1].id).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(lookCard('thermal'));
    expect(st().clipLooks.b.id).toBe('thermal');
    expect(st().look).toEqual(main);
    expect(st().clipLookOf('c')).toEqual(before[2]);
    fireEvent.click(within(scopes).getByText('Whole edit'));
    expect(st().editClip).toBeNull();
    expect(st().tab).toBe('looks');
  });

  test('Surprise me follows the visible clip target', () => {
    resetStudio({ tab: 'looks' });
    update(() => st().editClipLook('b', { tab: 'looks' }));
    renderStudio(<LooksPane />);
    const main = cloneLook(st().look!);
    fireEvent.click(screen.getByText(/Surprise me/));
    expect(st().look).toEqual(main);
    expect(st().clipLooks.b.id).not.toBe(main.id);
    expect(st().editClip).toBe('b');
    expect(toastText()).toContain('Clip 2');
  });

  test('Surprise me rolls a new look and Variations opens the variations sheet', () => {
    resetStudio({ tab: 'looks' });
    renderStudio(<LooksPane />);
    fireEvent.click(screen.getByText(/Surprise me/));
    expect(toastText()).toMatch(/^Surprise: /);
    expect(st().lookId).not.toBe(LOOKS[0].id);
    fireEvent.click(screen.getByText(/Variations/));
    expect(st().varOpen).toBe(true);
  });

  test('look thumbnails are handed to the render loop', () => {
    resetStudio({ tab: 'looks' });
    renderStudio(<LooksPane />);
    const jobs = st().lookJobs;
    expect(jobs).toHaveLength(LOOKS.length);
    expect(jobs[0].id).toBe(`look:${LOOKS[0].id}`);
    expect(jobs[0].card).toBe(lookCard(LOOKS[0].id));
  });

  test('search and collection filters update both the tiles and thumbnail jobs', () => {
    resetStudio({ tab: 'looks' });
    renderStudio(<LooksPane />);
    const search = screen.getByLabelText('Search looks');

    fireEvent.change(search, { target: { value: 'VHS Afterhours' } });
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-look-id]')).map((el) => el.dataset.lookId)).toEqual(['vhs']);
    expect(st().lookJobs.map((job) => job.id)).toEqual(['look:vhs']);

    // The result count stays at one; the job still has to follow the new filtered ID.
    fireEvent.change(search, { target: { value: 'Glyph Terminal' } });
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-look-id]')).map((el) => el.dataset.lookId)).toEqual(['matrix']);
    expect(st().lookJobs.map((job) => job.id)).toEqual(['look:matrix']);

    fireEvent.click(screen.getByLabelText('Clear look search'));
    fireEvent.click(screen.getByRole('button', { name: /^Album art/ }));
    const artIds = Array.from(document.querySelectorAll<HTMLElement>('[data-look-id]')).map((el) => el.dataset.lookId);
    expect(artIds).toHaveLength(LOOKS.filter((look) => look.group === 'art').length);
    expect(artIds.every((id) => id?.startsWith('art-'))).toBe(true);
    expect(st().lookJobs.map((job) => job.id)).toEqual(artIds.map((id) => `look:${id}`));
  });

  test('new collections expose their presets and Surprise respects the random style setting', () => {
    resetStudio({ tab: 'looks' });
    renderStudio(<LooksPane />);
    for (const [name, style] of [['Natural', 'natural'], ['Monochrome', 'monochrome'], ['Film', 'film'], ['Soft', 'soft'], ['Light & shadow', 'light'], ['Illustrated', 'illustrated']]) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
      const ids = Array.from(document.querySelectorAll<HTMLElement>('[data-look-id]')).map((card) => card.dataset.lookId);
      expect(ids).toHaveLength(5);
      expect(ids.every((id) => id?.startsWith(`${style}-`))).toBe(true);
    }
    fireEvent.change(screen.getByRole('combobox', { name: 'Randomize style' }), { target: { value: 'film' } });
    expect(st().rollStyle).toBe('film');
    fireEvent.click(screen.getByText(/Surprise me/));
    expect(st().look!.style).toBe('film');
    expect(st().look!.layers.length).toBeLessThanOrEqual(3);
  });

  test('the Remix menu and Looks gallery share their style choice', () => {
    resetStudio({ tab: 'looks', rollStyle: 'film' });
    renderStudio(<><TopBar /><LooksPane /></>);
    fireEvent.click(document.getElementById('btnRollOpts')!);
    const menu = screen.getByRole('combobox', { name: 'Remix style' }) as HTMLSelectElement;
    expect(menu.value).toBe('film');
    fireEvent.change(menu, { target: { value: 'soft' } });
    expect((screen.getByRole('combobox', { name: 'Randomize style' }) as HTMLSelectElement).value).toBe('soft');
    fireEvent.click(document.getElementById('btnRoll')!);
    expect(st().look!.style).toBe('soft');
    expect(st().look!.layers.length).toBeLessThanOrEqual(3);
  });
});
