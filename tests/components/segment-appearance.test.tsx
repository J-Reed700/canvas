import React from 'react';
import { expect, test, vi } from 'vitest';
import { fireEvent, within, waitFor } from '@testing-library/react';
import { TimelinePanel } from '../../downbeat/studio/src/components/TimelinePanel/TimelinePanel.tsx';
import { SegmentAppearanceEditor } from '../../downbeat/studio/src/components/SegmentAppearanceEditor/SegmentAppearanceEditor.tsx';
import { InspectorPanel } from '../../downbeat/studio/src/components/InspectorPanel/InspectorPanel.tsx';
import { compose } from '../../downbeat/studio/src/engine/composer.ts';
import { LOOKS, cloneLook, pop, renderStudio, resetStudio, st, update } from './studio.tsx';
import type { Segment } from '../../downbeat/studio/src/engine/types.ts';

function openAppearance() {
  const look = cloneLook(LOOKS[0]);
  look.cut.rhythm = 'half';
  resetStudio({ look, bars: 5, tab: 'layers' });
  renderStudio(<><TimelinePanel /><SegmentAppearanceEditor /><InspectorPanel /></>);
  const lane = document.getElementById('lane')!;
  vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 600, bottom: 80, width: 600, height: 80, x: 0, y: 0, toJSON() {} });
  const occurrences = st().ctx!.tl.segs.filter((segment) => segment.clipId === 'a');
  const selected = occurrences[1];
  fireEvent.doubleClick(lane, { clientX: (selected.t0 + selected.dur / 2) / st().ctx!.L * 600, clientY: 30 });
  return { occurrences, selected, original: JSON.stringify(st().look) };
}

const frameFor = (segment: Segment) => compose(st().ctx!, (segment.t0 + segment.t1) / 2);

test('closing the appearance editor restores the inspector animation reader', async () => {
  openAppearance();
  const inspectorGrid = document.querySelector('#pane-layers .seqgrid');
  expect(st().modUI!.grid).not.toBe(inspectorGrid);
  fireEvent.click(within(pop()).getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(st().modUI!.grid).toBe(inspectorGrid));
  expect(st().modUI!.grid!.isConnected).toBe(true);
});

test('double-click opens filters for only that appearance, and applying a preset leaves its repeated source untouched', () => {
  const { occurrences, selected, original } = openAppearance();
  const editor = within(pop());
  expect(pop().getAttribute('role')).toBe('dialog');
  expect(editor.getByRole('tab', { name: 'Look & effects' }).getAttribute('aria-selected')).toBe('true');
  expect(editor.getByText('Clip 1 · appearance 2 of 4')).toBeTruthy();
  expect(editor.getByText('Only this appearance')).toBeTruthy();
  expect(st().blocks).toBeNull();
  fireEvent.click(editor.getByRole('button', { name: 'Browse looks' }));
  fireEvent.change(editor.getByRole('searchbox', { name: 'Search appearance looks' }), { target: { value: 'VHS Afterhours' } });
  fireEvent.click(pop().querySelector('[data-segment-look-id="vhs"]')!);
  expect(st().blocks!.find((block) => block.id === selected.id)!.look!.id).toBe('vhs');
  expect(JSON.stringify(st().look)).toBe(original);
  expect(st().clipLooks).toEqual({});
  expect(frameFor(occurrences[0]).pre).toBeNull();
  expect(frameFor(selected).pre![0].map((layer) => layer.src.m)).toEqual(['lens', 'vhs']);
  expect((editor.getByRole('button', { name: '↺ Reset segment' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(editor.getByRole('button', { name: 'Use source look' }));
  expect(st().ctx!.tl.segs.find((segment) => segment.id === selected.id)!.look).toBeUndefined();
  expect(JSON.stringify(st().look)).toBe(original);
});

test('effect and modulation pickers stay above the appearance editor and edits remain on its selected block', () => {
  const { selected, original } = openAppearance();
  fireEvent.click(within(pop()).getByRole('button', { name: '+ Add effect' }));
  const child = document.getElementById('subpop')!;
  expect(child.classList.contains('on')).toBe(true);
  expect(pop().classList.contains('seg-menu')).toBe(true);
  fireEvent.click(within(child).getByText('VHS Tape', { exact: true }));
  expect(child.classList.contains('on')).toBe(false);
  expect(pop().classList.contains('on')).toBe(true);
  const card = Array.from(pop().querySelectorAll('.card')).find((item) => item.querySelector('.ct')?.firstChild?.textContent === 'Liquid Glass')!;
  const button = card.querySelector<HTMLButtonElement>('.modbtn')!;
  fireEvent.click(button);
  expect(child.classList.contains('on')).toBe(true);
  expect(pop().querySelector('.appearance-editor')).toBeTruthy();
  const own = st().blocks!.find((block) => block.id === selected.id)!.look!;
  expect(own.layers.some((layer) => layer.m === 'vhs')).toBe(true);
  expect(JSON.stringify(st().look)).toBe(original);
  fireEvent.keyDown(child, { key: 'Escape' });
  expect(child.classList.contains('on')).toBe(false);
  expect(pop().classList.contains('on')).toBe(true);
  fireEvent.click(within(pop()).getByRole('button', { name: 'Browse looks' }));
  fireEvent.keyDown(within(pop()).getByRole('searchbox', { name: 'Search appearance looks' }), { key: 'Escape' });
  expect(pop().classList.contains('on')).toBe(false);
});

test('dialog sections are separate, navigation moves the filter target, and all uses is explicitly a source scope', () => {
  const { selected } = openAppearance();
  const editor = within(pop());
  fireEvent.click(editor.getByRole('tab', { name: 'Playback' }));
  expect(editor.getByRole('slider', { name: 'Clip speed' })).toBeTruthy();
  expect(pop().querySelector('#segment-panel-appearance')!.hasAttribute('hidden')).toBe(true);
  fireEvent.click(editor.getByRole('tab', { name: 'Timing' }));
  expect(editor.getByRole('group', { name: 'The segment and its neighbours' })).toBeTruthy();
  fireEvent.click(editor.getByRole('tab', { name: 'Framing' }));
  expect(editor.getByRole('slider', { name: 'Zoom' })).toBeTruthy();
  fireEvent.click(editor.getByRole('tab', { name: 'Look & effects' }));
  fireEvent.click(editor.getByRole('button', { name: 'Next segment' }));
  expect(st().editBlock).toBe(st().ctx!.tl.segs[selected.i + 1].id);
  expect(st().selectedBlock).toBe(st().editBlock);
  fireEvent.click(editor.getByRole('button', { name: 'Done' }));
  update(() => st().selectBlock(selected.id));
  const scopes = within(document.querySelector('.scope-choices')!);
  expect(scopes.getByRole('button', { name: 'This appearance' })).toBeTruthy();
  fireEvent.click(scopes.getByRole('button', { name: 'All uses' }));
  expect(document.querySelector('.scope-foot')!.textContent).toContain('Editing all 4 appearances of clip 1.');
});
