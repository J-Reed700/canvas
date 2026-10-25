import React from 'react';
import { expect, test, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { ColorGradeCard } from '../../downbeat/studio/src/components/ColorGradeCard/ColorGradeCard.tsx';
import { IDENTITY_LUT } from '../../downbeat/studio/src/engine/lut.ts';
import { studioRuntime } from '../../downbeat/studio/src/state/store.ts';
import { renderStudio, resetStudio, screen, st, update } from './studio.tsx';

const { snapshot, applySnapshot } = studioRuntime.history;

const cube = 'TITLE "Night grade"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1';

test('the color inspector waits safely for an edit to load', () => {
  resetStudio({ look: null });
  const { container } = renderStudio(<ColorGradeCard />);
  expect(container.querySelector('.grade-file')).toBeNull();
});

test('imports a LUT, adjusts mix, preserves it in the edit, and removes it', async () => {
  resetStudio();
  renderStudio(<ColorGradeCard />);
  const file = new File([cube], 'night.cube', { type: 'text/plain' });
  fireEvent.change(screen.getByLabelText('Import 3D LUT'), { target: { files: [file] } });
  await waitFor(() => expect(st().look.finish.lut?.name).toBe('Night grade'));
  expect(screen.getByText('Night grade')).toBeTruthy();
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0.4' } });
  expect(st().look.finish.p.lutMix).toBe(0.4);
  const snap = snapshot();
  fireEvent.click(screen.getByText('Remove LUT'));
  expect(st().look.finish.lut).toBeUndefined();
  update(() => applySnapshot(snap));
  expect(st().look.finish.lut?.name).toBe('Night grade');
  expect(st().look.finish.p.lutMix).toBe(0.4);
});

test('an invalid import leaves the previous grade intact and explains the failure', async () => {
  resetStudio();
  st().look.finish.lut = IDENTITY_LUT;
  renderStudio(<ColorGradeCard />);
  fireEvent.change(screen.getByLabelText('Import 3D LUT'), { target: { files: [new File(['LUT_1D_SIZE 4'], 'bad.cube')] } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/3D-only/));
  expect(st().look.finish.lut).toBe(IDENTITY_LUT);
});

test('scopes are off by default and LUT edits are disabled during export', () => {
  resetStudio({ exporting: true });
  renderStudio(<ColorGradeCard />);
  expect((screen.getByText('Import .cube') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('.video-scope')).toBeNull();
  fireEvent.click(screen.getByText('RGB parade'));
  expect(screen.getByLabelText('RGB parade of the finished preview')).toBeTruthy();
  expect(screen.getByText(/Paused during export/)).toBeTruthy();
});

test('changing the look while a LUT loads never applies it to the new edit', async () => {
  resetStudio();
  renderStudio(<ColorGradeCard />);
  let finish: (s: string) => void = () => {};
  const file = new File([''], 'slow.cube');
  vi.spyOn(file, 'text').mockImplementation(() => new Promise((r) => { finish = r; }));
  fireEvent.change(screen.getByLabelText('Import 3D LUT'), { target: { files: [file] } });
  update(() => st().stepLook(1));
  finish(cube);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/edit changed/));
  expect(st().look.finish.lut).toBeUndefined();
});
