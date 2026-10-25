import { useStudioApi } from '../state/StudioContext.tsx';
import { titleOf } from '../lib/exportsView.ts';
import { postJSON, toast } from '../lib/utils.ts';
import type { RenderRecord } from '../engine/types.ts';

export function useExportActions() {
  const store = useStudioApi();
  const setFilter = (patch: Partial<{ q: string; kind: string; sort: string }>) =>
    store.setState((s) => ({ exportFilter: { ...s.exportFilter, ...patch } }));

  const openLibrary = (filename: string | null) => store.setState({ libraryOpen: true, libraryItem: filename });

  /** Deletes the export and its companion files (audio and promo copies, cover art, teasers, banners) from out/. */
  async function deleteExport(r: RenderRecord) {
    const res = await postJSON('/api/export/delete', { filename: r.filename });
    if (!res.ok) {
      toast(res.error || "Couldn't delete the export");
      return;
    }
    store.setState((s) => ({
      renders: s.renders.filter((x) => x.filename !== r.filename),
      libraryItem: s.libraryItem === r.filename ? null : s.libraryItem,
    }));
    toast(`Deleted ${titleOf(r)}`);
  }

  return { setFilter, openLibrary, deleteExport };
}
