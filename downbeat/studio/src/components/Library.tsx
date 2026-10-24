// What the exports and clips browsers share: search, filter chips, pages, the large view and its keys.
import React, { useEffect, useState } from 'react';
import { pageList } from '../lib/exportsView.ts';
import { Icon, ICONS, SearchField } from './ui.tsx';

/** A search field whose Escape clears the search before it closes anything. */
export const FilterSearch: React.FC<{
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}> = ({ value, onChange, placeholder, autoFocus, inputRef }) => (
  <SearchField
    value={value}
    onChange={onChange}
    placeholder={placeholder}
    autoFocus={autoFocus}
    inputRef={inputRef}
    onKeyDown={(e) => {
      if (e.key === 'Escape' && value) {
        e.stopPropagation();
        onChange('');
      }
    }}
  />
);

/** One chip for each kind there is, with how many. A chip that would match everything is left out, and the
 * chips are hidden when that leaves only All. */
export const FilterChips: React.FC<{
  kinds: [string, string][];
  counts: Record<string, number>;
  value: string;
  onChange: (kind: string) => void;
}> = ({ kinds, counts, value, onChange }) => {
  const shown = kinds.filter(([k]) => counts[k] && (k === 'all' || k === value || counts[k] < counts.all));
  if (shown.length < 2) return null;
  return (
    <div className="exp-kinds">
      {shown.map(([k, label]) => (
        <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label} <small>{counts[k]}</small>
        </button>
      ))}
    </div>
  );
};

export const NoMatch: React.FC<{ what: string; onClear: () => void }> = ({ what, onClear }) => (
  <div className="exp-empty">
    No {what} match.{' '}
    <button className="link" onClick={onClear}>
      Clear search
    </button>
  </div>
);

export const Pager: React.FC<{ page: number; pages: number; onPage: (p: number) => void; compact?: boolean }> = ({
  page,
  pages,
  onPage,
  compact,
}) => (
  <nav className="pager" aria-label="Pages">
    <button disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">
      <Icon d={ICONS.prev} />
    </button>
    {compact ? (
      <span className="pager-of">
        <b>{page + 1}</b> / {pages}
      </span>
    ) : (
      pageList(page, pages).map((p, i) =>
        p === null ? (
          <span key={`gap${i}`} className="pager-gap">…</span>
        ) : (
          <button key={p} className={p === page ? 'on' : ''} onClick={() => onPage(p)} aria-current={p === page ? 'page' : undefined}>
            {p + 1}
          </button>
        ),
      )
    )}
    <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">
      <Icon d={ICONS.next} />
    </button>
  </nav>
);

/** The page shown: back to the first when `reset` changes, and never past the last when the list shrinks. */
export function usePage(count: number, per: number, reset: string) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [reset]);
  const pages = Math.max(1, Math.ceil(count / per));
  return [Math.min(page, pages - 1), pages, setPage] as const;
}

/** Which items the page shows, and the pages, under a browser's grid. */
export const LibraryFoot: React.FC<{ page: number; pages: number; per: number; count: number; onPage: (p: number) => void }> = ({
  page,
  pages,
  per,
  count,
  onPage,
}) =>
  count ? (
    <div className="lib-foot">
      <span className="muted">
        {page * per + 1}–{Math.min(count, (page + 1) * per)} of {count}
      </span>
      {pages > 1 && <Pager page={page} pages={pages} onPage={onPage} />}
    </div>
  ) : null;

/** One item large between arrows to the ones before and after it, with its details beside it. */
export const LibraryViewer: React.FC<{
  /** "export" or "clip", for the arrows' tooltips. */
  what: string;
  /** The button back to the grid: "All exports". */
  back: string;
  index: number;
  count: number;
  onStep: (d: number) => void;
  onBack: () => void;
  /** Width / height of the item, for sizing the player. */
  ar: number;
  player: React.ReactNode;
  children: React.ReactNode;
}> = ({ what, back, index, count, onStep, onBack, ar, player, children }) => (
  <div className="lib-view">
    <div className="lib-stage">
      <button className="lib-nav" disabled={index <= 0} onClick={() => onStep(-1)} title={`Previous ${what} (←)`}>
        <Icon d={ICONS.prev} />
      </button>
      <div className="lib-player" style={{ '--ar': ar } as React.CSSProperties}>
        {player}
      </div>
      <button className="lib-nav" disabled={index >= count - 1} onClick={() => onStep(1)} title={`Next ${what} (→)`}>
        <Icon d={ICONS.next} />
      </button>
    </div>

    <div className="lib-info">
      <div className="lib-crumb">
        <button className="btn sm" onClick={onBack}>
          <Icon d={ICONS.prev} /> {back}
        </button>
        {index >= 0 && (
          <span className="muted">
            {index + 1} of {count}
          </span>
        )}
      </div>
      {children}
    </div>
  </div>
);

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
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
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
}
