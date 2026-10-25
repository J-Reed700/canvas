import { useStudioStore, useStudioRuntime } from '../state/StudioContext.tsx';
import { useCallback, useState } from 'react';

/**
 * Adding a folder: the system folder chooser on a Mac, or a path typed in a box elsewhere, or when the
 * chooser doesn't open. The welcome screen, the Clips section and the track picker share it.
 */
export function useFolderPicker() {
  const { media } = useStudioRuntime();

  const canPick = useStudioStore((s) => s.canPick);
  const [waiting, setWaiting] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  const [err, setErr] = useState('');

  const choose = async () => {
    setErr('');
    if (!canPick) {
      setTyping(true);
      return;
    }
    setWaiting(true);
    const r = await media.pickFolder();
    setWaiting(false);
    if (r.ok === false) {
      setTyping(true);
      setErr(r.error || 'The folder chooser did not open. Type the path instead.');
    }
  };

  const add = async (p: string) => {
    setErr('');
    const r = await media.addFolder(p);
    if (r.ok === false) {
      setErr(r.error || 'That folder could not be added');
      return;
    }
    setTyping(false);
    setPath('');
  };

  /** Closes the path box and clears any error. */
  const reset = useCallback(() => {
    setTyping(false);
    setErr('');
  }, []);

  return { canPick, waiting, typing, setTyping, path, setPath, err, choose, add, reset };
}

export type FolderPicker = ReturnType<typeof useFolderPicker>;
