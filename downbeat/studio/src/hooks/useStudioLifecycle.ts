import { useEffect } from 'react';
import { useStudioApi, useStudioElements, useStudioStore } from '../state/StudioContext.tsx';
import { isMediaLoading } from '../state/mediaLoading.ts';

export function useStudioLifecycle() {
  const store = useStudioApi();
  const elements = useStudioElements();
  const initStudio = useStudioStore((s) => s.initStudio);
  const disposeStudio = useStudioStore((s) => s.disposeStudio);
  const mediaLoading = useStudioStore(isMediaLoading);

  useEffect(() => {
    const canvas = elements.view.current;
    const bank = elements.videoBank.current;
    if (!canvas || !bank) return;
    let active = true;
    void Promise.resolve(initStudio(canvas, bank)).catch((error: unknown) => {
      if (!active) return;
      disposeStudio();
      store.setState({ glError: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; disposeStudio(); };
  }, [elements, initStudio, disposeStudio, store]);

  useEffect(() => {
    if (!mediaLoading) return;
    const state = store.getState();
    state.transport.pause();
    state.bank?.sync([], false);
  }, [mediaLoading, store]);
}
