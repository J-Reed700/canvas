import './ExportsSection.css';
import { useStudioStore } from '../../state/StudioContext.tsx';
import React, { useMemo } from 'react';
import { filterExports, formatLabel, metaLine, timeAgo, titleOf } from '../../lib/exportsView.ts';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';
import { Pager } from '../Pager/Pager.tsx';
import { useExportActions } from '../../hooks/useExportActions.ts';
import { useExportPage } from '../../hooks/useExportPage.ts';
import { ExportSearch } from '../ExportSearch/ExportSearch.tsx';
import { ExportKindChips } from '../ExportKindChips/ExportKindChips.tsx';
import { ClearExportSearch } from '../ClearExportSearch/ClearExportSearch.tsx';
import { ExportThumb } from '../ExportThumb/ExportThumb.tsx';
import { ExportSpecBadge } from '../ExportSpecBadge/ExportSpecBadge.tsx';
import { ExportDeleteButton } from '../ExportDeleteButton/ExportDeleteButton.tsx';

const SIDE_PAGE = 4;

const ExportsList: React.FC = () => {
  const { openLibrary } = useExportActions();

  const renders = useStudioStore((s) => s.renders);
  const reveal = useStudioStore((s) => s.reveal);
  const filter = useStudioStore((s) => s.exportFilter);
  const list = useMemo(() => filterExports(renders, filter), [renders, filter]);
  const [page, pages, setPage] = useExportPage(list.length, SIDE_PAGE);

  return (
    <section className="sec sec-exports">
      <div className="sec-h">
        <h3>Exports</h3>
        <span className="meta" id="exportCount">
          {list.length !== renders.length ? `${list.length} of ${renders.length}` : renders.length || ''}
        </span>
        {renders.length > 0 && (
          <button className="btn sm exp-open" title="Browse every export" onClick={() => openLibrary(null)}>
            <Icon d={ICONS.expand} /> Browse
          </button>
        )}
      </div>

      {renders.length > 0 && (
        <>
          <ExportSearch />
          <ExportKindChips renders={renders} />
        </>
      )}

      <div className="exports" id="exports">
        {!renders.length && <div className="note">Exports appear here, each checked against its format's spec.</div>}
        {renders.length > 0 && !list.length && <ClearExportSearch />}
        {list.slice(page * SIDE_PAGE, page * SIDE_PAGE + SIDE_PAGE).map((r) => (
          <div
            className="exp"
            key={r.filename}
            role="button"
            tabIndex={0}
            title={r.filename}
            onClick={() => openLibrary(r.filename)}
            onKeyDown={(e) => e.key === 'Enter' && openLibrary(r.filename)}
          >
            <ExportThumb r={r} />
            <div className="exp-body">
              <div className="n">{titleOf(r)}</div>
              <div className="m">{metaLine(r)}</div>
              <div className="m">
                {formatLabel(r)}
                {r.created_at ? ` · ${timeAgo(r.created_at)}` : ''} <ExportSpecBadge r={r} />
              </div>
            </div>
            <div className="acts" onClick={(e) => e.stopPropagation()}>
              <a className="btn sm icon" href={r.url} download={r.filename} title="Download">
                <Icon d={ICONS.download} />
              </a>
              {r.promo_url && (
                <a className="btn sm icon promo" href={r.promo_url} download="" title="Download the promo with the song">
                  ♫
                </a>
              )}
              <button className="btn sm icon" title="Reveal in Finder" onClick={() => reveal(r.filename)}>
                <Icon d={ICONS.folder} />
              </button>
              <ExportDeleteButton r={r} />
            </div>
          </div>
        ))}
      </div>

      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} compact />}
    </section>
  );
};

// Memoized so the media panel's frequent re-renders don't reach the list.
export const ExportsSection = React.memo(ExportsList);
