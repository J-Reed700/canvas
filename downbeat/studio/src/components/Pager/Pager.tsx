import './Pager.css';
import React from 'react';
import { pageList } from '../../lib/exportsView.ts';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';

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
