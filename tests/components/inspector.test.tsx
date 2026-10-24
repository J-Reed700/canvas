import React from 'react';
import { describe, expect, test } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { InspectorPanel } from '../../downbeat/studio/src/components/InspectorPanel.tsx';
import { LooksPane } from '../../downbeat/studio/src/components/LooksPane.tsx';
import { LOOKS, cloneLook, renderStudio, resetStudio, screen, st, toastText, update } from './studio.tsx';

const lookCard = (id: string) => document.querySelector(`[data-look-id="${id}"]`) as HTMLElement;
const tabs = () => document.getElementById('tabs') as HTMLElement;

describe('inspector tabs', () => {
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
});

describe('looks grid', () => {
  test('every look is listed under its group, with yours first', () => {
    const mine = { ...cloneLook(LOOKS[1]), id: 'mine-1', name: 'Night drive', mine: true };
    resetStudio({ tab: 'looks', saved: [mine] });
    renderStudio(<LooksPane />);
    expect(document.querySelectorAll('.look')).toHaveLength(LOOKS.length + 1);
    expect(Array.from(document.querySelectorAll('.look-group')).map((g) => g.textContent)).toEqual([
      'Your looks', 'Studio looks', 'Album art & stills', 'Classic stacks',
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
});
