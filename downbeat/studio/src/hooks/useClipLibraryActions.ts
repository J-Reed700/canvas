import { useStudioApi } from '../state/StudioContext.tsx';
import { type ClipFilter } from '../lib/clipsView.ts';

export function useClipLibraryActions() {
  const store = useStudioApi();
  const setFilter = (patch: Partial<ClipFilter>) => store.setState((s) => ({ clipFilter: { ...s.clipFilter, ...patch } }));
  const clearFilter = () => setFilter({ q: '', kind: 'all' });
  const openClips = () => store.setState({ clipsOpen: true, clipsItem: null });
  const showClip = (id: string | null) => store.setState({ clipsItem: id });

  return { setFilter, clearFilter, openClips, showClip };
}
