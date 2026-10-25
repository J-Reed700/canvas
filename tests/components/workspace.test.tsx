import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { App } from '../../downbeat/studio/src/components/App/App.tsx';
import { workspaceStore as W, DEFAULT_LAYOUT } from '../../downbeat/studio/src/state/workspaceStore.ts';
import { timecode } from '../../downbeat/studio/src/lib/playback.ts';
import { render, resetStudio, S, screen, st, update } from './studio.tsx';

beforeEach(() => {
  resetStudio({ tab: 'looks' });
  W.setState({ commands: false, focus: false, layout: { ...DEFAULT_LAYOUT } });
  update(() => S.setState({ initStudio: vi.fn() }));
});
afterEach(() => { W.setState({ commands: false, focus: false }); });
const key = (key: string, opts = {}) => fireEvent.keyDown(window, { key, ...opts });

test('the command menu searches, runs with Enter, and isolates editing shortcuts', () => {
  render(<App />);
  key('k', { metaKey: true });
  const input = screen.getByRole('combobox', { name: 'Search commands' });
  expect(document.activeElement).toBe(input);
  expect(document.querySelector<HTMLElement>('.app')!.inert).toBe(true);
  fireEvent.change(input, { target: { value: 'color' } });
  expect(within(screen.getByRole('listbox', { name: 'Commands' })).getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(input, { key: ' ' });
  expect(st().transport.playing).toBe(false);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(st().tab).toBe('layers');
  expect(screen.queryByRole('dialog', { name: 'Command menu' })).toBeNull();
  expect(document.querySelector<HTMLElement>('.app')!.inert).toBe(false);
});

test('command search has an empty result state and restores focus on dismiss', () => {
  render(<App />);
  const trigger = screen.getByRole('button', { name: 'Search commands' });
  trigger.focus(); fireEvent.click(trigger);
  const input = screen.getByRole('combobox', { name: 'Search commands' });
  fireEvent.change(input, { target: { value: 'nothing-matches-this' } });
  expect(screen.getByText(/No commands match/)).toBeTruthy();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(W.getState().commands).toBe(true);
  fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
  expect(W.getState().commands).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

test('focus view preserves the preview canvas and Escape restores the workspace', () => {
  render(<App />);
  const canvas = document.getElementById('view');
  const look = st().look;
  key('F', { shiftKey: true });
  expect(document.querySelector('.app')!.className).toContain('workspace-focus');
  expect(document.getElementById('view')).toBe(canvas);
  expect(st().look).toBe(look);
  key('Escape');
  expect(W.getState().focus).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Focus viewer' }));
  expect(W.getState().focus).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }));
  expect(W.getState().focus).toBe(false);
});

test('panel resizing is bounded, saved separately and keyboard resizing does not change the look', () => {
  render(<App />);
  const look = st().lookId;
  const handle = screen.getByRole('separator', { name: 'Resize library' });
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(W.getState().layout.library).toBe(DEFAULT_LAYOUT.library + 10);
  expect(st().lookId).toBe(look);
  expect(JSON.parse(localStorage.getItem('downbeat.workspace.v1')!).library).toBe(DEFAULT_LAYOUT.library + 10);
  update(() => W.getState().resize('library', 9999));
  expect(W.getState().layout.library).toBe(400);
  fireEvent.doubleClick(handle);
  expect(W.getState().layout.library).toBe(DEFAULT_LAYOUT.library);
  const measure = vi.spyOn(document.querySelector('.media')!, 'getBoundingClientRect').mockReturnValue({ width: 235 } as DOMRect);
  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(W.getState().layout.library, 'resize from the visible width when a narrow window caps the saved size').toBe(225);
  measure.mockRestore();
  const timeline = screen.getByRole('separator', { name: 'Resize timeline' });
  fireEvent.keyDown(timeline, { key: 'ArrowUp', shiftKey: true });
  expect(W.getState().layout.timeline).toBe(DEFAULT_LAYOUT.timeline + 40);
});

test('frame stepping pauses, advances exactly one frame and clamps at both ends', () => {
  render(<App />);
  update(() => { st().transport.pause(); st().transport.seek(0); });
  key(',');
  expect(st().transport.loopTime()).toBe(0);
  key('.');
  expect(st().transport.loopTime()).toBeCloseTo(1 / 30, 9);
  fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
  expect(st().transport.loopTime()).toBeCloseTo(2 / 30, 9);
  update(() => { st().transport.seek(st().transport.len - .001); });
  key('.');
  expect(st().transport.loopTime()).toBeCloseTo(239 / 30, 9);
  update(() => st().transport.play());
  fireEvent.click(screen.getByRole('button', { name: 'Previous frame' }));
  expect(st().transport.playing).toBe(false);
  expect(timecode(59.999)).toBe('00:00:59:29');
  expect(timecode(60)).toBe('00:01:00:00');
});

test('inspector tab keys never trigger the global look shortcut', () => {
  render(<App />);
  const look = st().lookId;
  fireEvent.keyDown(screen.getByRole('tab', { name: /^Looks/ }), { key: 'ArrowRight' });
  expect(st().tab).toBe('layers');
  expect(st().lookId).toBe(look);
});

test('clip keyboard selection and native button activation do not toggle playback or open segment editing', () => {
  render(<App />);
  const clip = document.querySelector<HTMLElement>('#clips .clip')!;
  const selected = st().selected.length;
  fireEvent.keyDown(clip, { key: ' ' });
  expect(st().selected.length).toBe(selected - 1);
  expect(st().transport.playing).toBe(false);
  fireEvent.keyDown(clip, { key: 'Enter' });
  expect(st().selected.length).toBe(selected);
  expect(document.getElementById('pop')?.classList.contains('on')).not.toBe(true);
  fireEvent.keyDown(screen.getByRole('tab', { name: /^Layers/ }), { key: ' ' });
  expect(st().transport.playing).toBe(false);
});

test('command search does not open over an active export or project dialog', () => {
  render(<App />);
  update(() => S.setState({ exporting: true }));
  key('k', { metaKey: true });
  expect(W.getState().commands).toBe(false);
  update(() => S.setState({ exporting: false, projectsOpen: true }));
  key('k', { ctrlKey: true });
  expect(W.getState().commands).toBe(false);
});
