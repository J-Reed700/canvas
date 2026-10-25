// A selected timeline segment is edited in the inspector: Looks and Layers follow the 'This appearance' scope and
// keep their changes on that segment, and the Edit tab shows the segment's own panel.
import React from 'react';
import { expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { TimelinePanel } from '../../downbeat/studio/src/components/TimelinePanel/TimelinePanel.tsx';
import { InspectorPanel } from '../../downbeat/studio/src/components/InspectorPanel/InspectorPanel.tsx';
import { compose } from '../../downbeat/studio/src/engine/composer.ts';
import { LOOKS, cloneLook, pop, renderStudio, resetStudio, segButton, segPanel, st } from './studio.tsx';
import type { Segment } from '../../downbeat/studio/src/engine/types.ts';

function selectAppearance() {
  const look = cloneLook(LOOKS[0]);
  look.cut.rhythm = 'half';
  resetStudio({ look, bars: 5, tab: 'layers' });
  renderStudio(<><TimelinePanel /><InspectorPanel /></>);
  const lane = document.getElementById('lane')!;
  vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 600, bottom: 80, width: 600, height: 80, x: 0, y: 0, toJSON() {} });
  const occurrences = st().ctx!.tl.segs.filter((segment) => segment.clipId === 'a');
  const selected = occurrences[1];
  fireEvent.doubleClick(lane, { clientX: (selected.t0 + selected.dur / 2) / st().ctx!.L * 600, clientY: 30 });
  return { occurrences, selected, original: JSON.stringify(st().look) };
}

const frameFor = (segment: Segment) => compose(st().ctx!, (segment.t0 + segment.t1) / 2);
const scope = () => within(document.querySelector('.inspector-scope') as HTMLElement);
const tab = (name: RegExp) => fireEvent.click(within(document.getElementById('tabs')!).getByRole('tab', { name }));

test('selecting a segment targets only that appearance, and a look applied from Looks leaves its repeated source untouched', () => {
  const { occurrences, selected, original } = selectAppearance();
  expect(st().editBlock).toBe(selected.id);
  expect(scope().getByRole('button', { name: 'This appearance' }).getAttribute('aria-pressed')).toBe('true');
  expect(scope().getByText('Clip 1 · appearance 2 of 4')).toBeTruthy();
  expect(scope().getByText('Your first change affects only this appearance.')).toBeTruthy();
  expect(st().blocks).toBeNull();

  tab(/^Looks/);
  expect(document.querySelector('.look-apply-note')!.textContent).toBe(`Choose a look for segment ${selected.i + 1}`);
  fireEvent.click(document.querySelector('#pane-looks [data-look-id="vhs"]')!);
  expect(st().blocks!.find((block) => block.id === selected.id)!.look!.id).toBe('vhs');
  expect(JSON.stringify(st().look)).toBe(original);
  expect(st().clipLooks).toEqual({});
  expect(frameFor(occurrences[0]).pre).toBeNull();
  expect(frameFor(selected).pre![0].map((layer) => layer.src.m)).toEqual(['lens', 'vhs']);
  expect(scope().getByText('Own look')).toBeTruthy();
  expect(scope().getByText('Only this appearance has these effects.')).toBeTruthy();

  tab(/^Edit/);
  expect((segButton('↺ Reset segment')).disabled, 'the segment has its own settings now').toBe(false);
  fireEvent.click(scope().getByRole('button', { name: 'Use source look' }));
  expect(st().ctx!.tl.segs.find((segment) => segment.id === selected.id)!.look).toBeUndefined();
  expect(JSON.stringify(st().look)).toBe(original);
  expect(scope().getByText('Inherited')).toBeTruthy();
  expect(scope().queryByRole('button', { name: 'Use source look' })).toBeNull();
});

test('effects and modulation added from Layers stay on the selected segment', () => {
  const { occurrences, selected, original } = selectAppearance();
  tab(/^Layers/);
  fireEvent.click(within(document.getElementById('pane-layers')!).getByRole('button', { name: '+ Add effect' }));
  expect(pop().classList.contains('on')).toBe(true);
  fireEvent.click(within(pop()).getByText('VHS Tape', { exact: true }));
  expect(pop().classList.contains('on')).toBe(false);
  const own = () => st().blocks!.find((block) => block.id === selected.id)!.look!;
  expect(own().layers.some((layer) => layer.m === 'vhs')).toBe(true);
  expect(JSON.stringify(st().look)).toBe(original);
  expect(st().clipLooks).toEqual({});
  expect(frameFor(occurrences[0]).pre, 'the other appearances of the clip keep the source look').toBeNull();

  const card = Array.from(document.querySelectorAll('#pane-layers .card')).find((item) => item.querySelector('.ct')?.firstChild?.textContent === 'Liquid Glass')!;
  fireEvent.click(card.querySelector<HTMLButtonElement>('.modbtn')!);
  expect(pop().classList.contains('on')).toBe(true);
  expect(st().editBlock, 'the modulation picker keeps the segment as the target').toBe(selected.id);
  expect(JSON.stringify(st().look)).toBe(original);
});

test('the Edit tab shows the segment panel, stepping moves the target, and All uses is explicitly a source scope', () => {
  const { selected } = selectAppearance();
  expect(st().tab, 'opening a segment shows the Edit tab').toBe('edit');
  const panel = within(segPanel());
  expect(segPanel().closest('#pane-edit')).toBeTruthy();
  expect(panel.getByRole('slider', { name: 'Clip speed' })).toBeTruthy();
  expect(panel.getByRole('group', { name: 'The segment and its neighbours' })).toBeTruthy();
  expect(panel.getByRole('slider', { name: 'Zoom' })).toBeTruthy();
  expect(Array.from(segPanel().querySelectorAll('details.seg-family > summary')).map((s) => s.textContent)).toEqual(['Timing & transition', 'Source & playback', 'Framing']);

  fireEvent.click(panel.getByRole('button', { name: 'Next segment' }));
  expect(st().editBlock).toBe(st().ctx!.tl.segs[selected.i + 1].id);
  expect(st().selectedBlock).toBe(st().editBlock);
  expect(scope().getByText(`Segment ${selected.i + 2}`)).toBeTruthy();

  fireEvent.click(within(segPanel()).getByRole('button', { name: 'Previous segment' }));
  expect(st().editBlock).toBe(selected.id);
  fireEvent.click(scope().getByRole('button', { name: 'All uses' }));
  expect(document.querySelector('.scope-foot')!.textContent).toContain('Editing all 4 appearances of clip 1.');
  expect(segPanel(), 'the Edit tab is back on the whole edit').toBeNull();
});
