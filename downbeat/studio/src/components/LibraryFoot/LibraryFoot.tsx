import './LibraryFoot.css';
import React from 'react';
import { Pager } from '../Pager/Pager.tsx';

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
