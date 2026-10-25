import { useEffect } from 'react';
import { useStudioApi } from '../state/StudioContext.tsx';
import { useWindowEvent } from './useWindowEvent.ts';

export function useMediaDrop() {
  const store = useStudioApi();
  useWindowEvent('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    document.body.classList.add('dropping');
  });
  useWindowEvent('dragleave', (event) => {
    if (!event.relatedTarget) document.body.classList.remove('dropping');
  });
  useWindowEvent('drop', (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    document.body.classList.remove('dropping');
    void store.getState().uploadFiles(Array.from(event.dataTransfer.files));
  });
  useEffect(() => () => document.body.classList.remove('dropping'), []);
}
