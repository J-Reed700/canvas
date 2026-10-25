import React, { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TransitionPicker } from '../../downbeat/studio/src/components/TransitionPicker/TransitionPicker.tsx';
import { EditPane } from '../../downbeat/studio/src/components/EditPane/EditPane.tsx';
import { TimelinePanel } from '../../downbeat/studio/src/components/TimelinePanel/TimelinePanel.tsx';
import { renderStudio, resetStudio, segPanel, st, update } from './studio.tsx';

function Pool({ initial = ['dissolve', 'zoom'] }: { initial?: string[] }) {
  const [value, onChange] = useState(initial);
  return <TransitionPicker multiple value={value} onChange={onChange} />;
}
const browser = () => within(screen.getByRole('dialog', { name: 'Transition library' }));
const search = (query: string) => fireEvent.change(browser().getByRole('searchbox', { name: 'Search transitions' }), { target: { value: query } });
const openPool = () => { render(<Pool />); fireEvent.click(screen.getByRole('button', { name: 'Browse transitions' })); };

describe('shared transition browser', () => {
  test('paginates the full catalog and resets the page when changing types or searches', () => {
    openPool();
    expect(browser().getByText('64 transitions · 8 types')).toBeTruthy();
    expect(browser().getByRole('table', { name: 'Available transitions' })).toBeTruthy();
    expect(browser().getAllByRole('checkbox', { name: /^Include / })).toHaveLength(8);
    expect(browser().getByText('1–8 of 64')).toBeTruthy();
    fireEvent.click(browser().getByRole('button', { name: 'Next page' }));
    expect(browser().getByText('9–16 of 64')).toBeTruthy();
    expect(browser().getByRole('rowheader', { name: /Wipes/ })).toBeTruthy();
    fireEvent.click(browser().getByRole('button', { name: 'Distortion' }));
    expect(browser().getByText('1–8 of 8')).toBeTruthy();
    expect((browser().getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    search('  HORIZONTAL   WAVE  ');
    expect(browser().getByText('1–1 of 1')).toBeTruthy();
    expect(browser().getByText('Horizontal Wave')).toBeTruthy();
    search('no such transition');
    expect(browser().getByText('No transitions found')).toBeTruthy();
    fireEvent.click(browser().getByRole('button', { name: 'Clear filters' }));
    expect(browser().getByText('1–8 of 64')).toBeTruthy();
    search('amber');
    expect(browser().getByText('Light Leak')).toBeTruthy();
  });

  test('keeps selections across pages, groups filtered results, and reviews selected transitions', () => {
    openPool();
    fireEvent.click(browser().getByRole('button', { name: 'Next page' }));
    fireEvent.click(browser().getByRole('checkbox', { name: 'Include Clock Wipe' }));
    expect(browser().getByText('3 selected · Used across the edit')).toBeTruthy();
    fireEvent.click(browser().getByRole('checkbox', { name: /Selected only/ }));
    expect(browser().getByText('1–3 of 3')).toBeTruthy();
    expect(browser().getByText('Light Dissolve')).toBeTruthy();
    expect(browser().getByText('Clock Wipe')).toBeTruthy();
    expect(browser().getByText('Zoom Punch')).toBeTruthy();
    expect(browser().getAllByRole('rowheader')).toHaveLength(3);
    fireEvent.click(browser().getByRole('checkbox', { name: 'Include Clock Wipe' }));
    expect(browser().queryByText('Clock Wipe')).toBeNull();
    expect(browser().getByText('1–2 of 2')).toBeTruthy();
    fireEvent.click(browser().getByRole('button', { name: 'Done' }));
    expect(screen.getByText('2 transitions selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse transitions' }));
    expect(browser().getByText('1–8 of 64')).toBeTruthy();
    expect((browser().getByRole('checkbox', { name: 'Include Light Dissolve' }) as HTMLInputElement).checked).toBe(true);
  });

  test('traps keyboard focus, closes on Escape or the backdrop, and restores the trigger', () => {
    openPool();
    expect(document.activeElement).toBe(browser().getByRole('searchbox', { name: 'Search transitions' }));
    const done = browser().getByRole('button', { name: 'Done' });
    done.focus();
    fireEvent.keyDown(done, { key: 'Tab' });
    const close = browser().getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Transition library' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Browse transitions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse transitions' }));
    fireEvent.click(screen.getByRole('dialog', { name: 'Transition library' }).parentElement!);
    expect(screen.queryByRole('dialog', { name: 'Transition library' })).toBeNull();
  });

  test('single selection applies one transition and closes, while disabled controls do not open', () => {
    const change = vi.fn();
    const view = render(<TransitionPicker value={['dissolve']} onChange={change} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose transition' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<TransitionPicker value={['dissolve']} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose transition' }));
    search('Diamond');
    fireEvent.click(browser().getByRole('button', { name: 'Use Diamond Reveal' }));
    expect(change).toHaveBeenCalledWith(['diamond']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

test("the inspector's segment panel keeps its place under the shared picker and changes only that cut", () => {
  resetStudio();
  renderStudio(<><TimelinePanel /><EditPane /></>);
  const lane = document.getElementById('lane')!;
  vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 400, bottom: 60, width: 400, height: 60, x: 0, y: 0, toJSON() {} });
  fireEvent.doubleClick(lane, { clientX: 125, clientY: 30 });
  const selected = st().selectedBlock!;
  const before = st().ctx!.tl.segs.map((segment) => segment.trans);
  const timing = () => segPanel().querySelector('details[data-family="timing"]') as HTMLDetailsElement;
  fireEvent.click(within(segPanel()).getByRole('button', { name: 'Choose transition' }));
  const input = browser().getByRole('searchbox', { name: 'Search transitions' });
  fireEvent.pointerDown(input);
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  expect(segPanel()).toBeTruthy();
  expect(st().selectedBlock).toBe(selected);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Transition library' })).toBeNull();
  expect(st().editBlock, 'Escape in the library leaves the segment selected').toBe(selected);
  expect(timing().open).toBe(true);
  fireEvent.click(within(segPanel()).getByRole('button', { name: 'Choose transition' }));
  search('Diamond');
  fireEvent.pointerDown(browser().getByRole('button', { name: 'Use Diamond Reveal' }));
  fireEvent.click(browser().getByRole('button', { name: 'Use Diamond Reveal' }));
  expect(st().editBlock).toBe(selected);
  expect(st().blocks!.find((block) => block.id === selected)!.trans).toBe('diamond');
  expect(st().ctx!.tl.segs.map((segment, index) => segment.id === selected ? 'unchanged' : segment.trans)).toEqual(before.map((transition, index) => st().ctx!.tl.segs[index].id === selected ? 'unchanged' : transition));
  expect(within(segPanel()).getByText('Diamond Reveal')).toBeTruthy();
  update(() => st().undo());
  expect(st().ctx!.tl.segs.find((segment) => segment.id === selected)!.trans).toBe(before[st().ctx!.tl.segs.findIndex((segment) => segment.id === selected)]);
});
