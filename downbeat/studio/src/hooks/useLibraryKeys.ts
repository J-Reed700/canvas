import React from 'react';
import { useWindowEvent } from './useWindowEvent.ts';

/** Keys while a browser is open: Escape goes back from the large view to the grid, then closes; the arrows
 * step through the items in the large view or the pages of the grid; / jumps to the search. */
export function useLibraryKeys(
  open: boolean,
  k: {
    viewing: boolean;
    back: () => void;
    close: () => void;
    step: (d: number) => void;
    page: number;
    pages: number;
    setPage: (p: number) => void;
    searchRef: React.RefObject<HTMLInputElement | null>;
  },
) {
  useWindowEvent('keydown', (e) => {
    const typing = (e.target as HTMLElement)?.closest?.('input, select, textarea') as HTMLInputElement | null;
    if (e.key === 'Escape' && typing?.value && typing.type === 'search') {
      return; // the search box clears itself first
    } else if (e.key === 'Escape') {
      if (k.viewing) k.back();
      else k.close();
    } else if (typing) {
      return;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      if (k.viewing) k.step(d);
      else k.setPage(Math.max(0, Math.min(k.pages - 1, k.page + d)));
    } else if (e.key === '/' && !k.viewing) {
      e.preventDefault();
      k.searchRef.current?.focus();
    } else {
      return;
    }
    e.stopPropagation();
  }, open, true);
}
