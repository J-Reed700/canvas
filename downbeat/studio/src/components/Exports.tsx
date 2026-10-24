import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore } from '../state/store.ts';
import {
  CHECK_ICONS,
  EXPORT_KINDS,
  EXPORT_SORTS,
  aspectOf,
  filterExports,
  formatLabel,
  kindOf,
  metaLine,
  pageList,
  specOf,
  timeAgo,
  titleOf,
} from '../lib/exportsView.ts';
import { postJSON, toast } from '../lib/utils.ts';
import { Icon, ICONS, SearchField, useArmed } from './ui.tsx';
import type { RenderRecord } from '../engine/types.ts';

const SIDE_PAGE = 4;
const LIB_PAGE = 12;

const setFilter = (patch: Partial<{ q: string; kind: string; sort: string }>) =>
  useStudioStore.setState((s) => ({ exportFilter: { ...s.exportFilter, ...patch } }));

const openLibrary = (filename: string | null) => useStudioStore.setState({ libraryOpen: true, libraryItem: filename });

/** Deletes the export and its companion files (audio and promo copies, cover art, teasers, banners) from out/. */
async function deleteExport(r: RenderRecord) {
  const res = await postJSON('/api/export/delete', { filename: r.filename });
  if (!res.ok) {
    toast(res.error || "Couldn't delete the export");
    return;
  }
  useStudioStore.setState((s) => ({
    renders: s.renders.filter((x) => x.filename !== r.filename),
    libraryItem: s.libraryItem === r.filename ? null : s.libraryItem,
  }));
  toast(`Deleted ${titleOf(r)}`);
}

/** Needs a second click within 3 s, so one stray click can't delete an export. */
const DeleteButton: React.FC<{ r: RenderRecord; wide?: boolean }> = ({ r, wide }) => {
  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`btn del ${wide ? '' : 'sm icon'} ${armed ? 'armed' : ''}`}
      title={armed ? 'Click again to delete this export and its extra files' : 'Delete'}
      onClick={() => (armed ? deleteExport(r) : setArmed(true))}
    >
      {armed ? (
        wide ? 'Click again to delete' : 'Delete?'
      ) : (
        <>
          <Icon d={ICONS.trash} />
          {wide ? ' Delete' : null}
        </>
      )}
    </button>
  );
};

const SpecBadge: React.FC<{ r: RenderRecord }> = ({ r }) => {
  const spec = specOf(r);
  if (!spec) return null;
  const n = (r.checks || []).filter((c) => c.level === 'fail').length;
  return spec === 'fail' ? (
    <span className="badge bad" title={`${n} spec check${n > 1 ? 's' : ''} failed`}>✕ {n}</span>
  ) : (
    <span className={`badge ${spec === 'warn' ? 'warn' : ''}`} title={spec === 'warn' ? 'Passed with notes' : 'Passed every spec check'}>
      ✓ spec
    </span>
  );
};

/** First frame of the export; plays on hover. */
const ExportThumb: React.FC<{ r: RenderRecord }> = ({ r }) => {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <span
      className="exp-thumb"
      style={{ ['--ar' as any]: aspectOf(r) }}
      onPointerEnter={() => ref.current?.play().catch(() => {})}
      onPointerLeave={() => ref.current?.pause()}
    >
      <video ref={ref} src={`${r.url}#t=0.3`} muted loop playsInline preload="metadata" />
    </span>
  );
};

const SearchBox: React.FC<{ autoFocus?: boolean; inputRef?: React.Ref<HTMLInputElement> }> = ({ autoFocus, inputRef }) => {
  const q = useStudioStore((s) => s.exportFilter.q);
  return (
    <SearchField
      value={q}
      onChange={(v) => setFilter({ q: v })}
      placeholder="Search by look, format or size"
      autoFocus={autoFocus}
      inputRef={inputRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && q) {
          e.stopPropagation();
          setFilter({ q: '' });
        }
      }}
    />
  );
};

const KindChips: React.FC<{ renders: RenderRecord[] }> = ({ renders }) => {
  const kind = useStudioStore((s) => s.exportFilter.kind);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: renders.length };
    for (const r of renders) c[kindOf(r)] = (c[kindOf(r)] || 0) + 1;
    return c;
  }, [renders]);
  const kinds = EXPORT_KINDS.filter(([k]) => counts[k]);
  if (kinds.length < 3) return null;
  return (
    <div className="exp-kinds">
      {kinds.map(([k, label]) => (
        <button key={k} className={kind === k ? 'on' : ''} onClick={() => setFilter({ kind: k })}>
          {label} <small>{counts[k]}</small>
        </button>
      ))}
    </div>
  );
};

const Pager: React.FC<{ page: number; pages: number; onPage: (p: number) => void; compact?: boolean }> = ({
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

/** Clamps the page when the list shrinks and returns to page 1 when the search changes. */
function usePage(count: number, per: number) {
  const filter = useStudioStore((s) => s.exportFilter);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter.q, filter.kind, filter.sort]);
  const pages = Math.max(1, Math.ceil(count / per));
  return [Math.min(page, pages - 1), pages, setPage] as const;
}

const NoMatch: React.FC = () => (
  <div className="exp-empty">
    No exports match.{' '}
    <button className="link" onClick={() => setFilter({ q: '', kind: 'all' })}>
      Clear search
    </button>
  </div>
);

const ExportsList: React.FC = () => {
  const renders = useStudioStore((s) => s.renders);
  const reveal = useStudioStore((s) => s.reveal);
  const filter = useStudioStore((s) => s.exportFilter);
  const list = useMemo(() => filterExports(renders, filter), [renders, filter]);
  const [page, pages, setPage] = usePage(list.length, SIDE_PAGE);

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
          <SearchBox />
          <KindChips renders={renders} />
        </>
      )}

      <div className="exports" id="exports">
        {!renders.length && <div className="note">Exports appear here, each checked against the Spotify Canvas spec.</div>}
        {renders.length > 0 && !list.length && <NoMatch />}
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
                {r.created_at ? ` · ${timeAgo(r.created_at)}` : ''} <SpecBadge r={r} />
              </div>
            </div>
            <div className="acts" onClick={(e) => e.stopPropagation()}>
              <a className="btn sm icon" href={r.url} download={r.filename} title="Download">
                <Icon d={ICONS.download} />
              </a>
              <button className="btn sm icon" title="Reveal in Finder" onClick={() => reveal(r.filename)}>
                <Icon d={ICONS.folder} />
              </button>
              <DeleteButton r={r} />
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

const ExportViewer: React.FC<{ r: RenderRecord; index: number; count: number; onStep: (d: number) => void }> = ({
  r,
  index,
  count,
  onStep,
}) => {
  const reveal = useStudioStore((s) => s.reveal);
  const exportCompanion = useStudioStore((s) => s.exportCompanion);
  const ar = aspectOf(r);

  return (
    <div className="lib-view">
      <div className="lib-stage">
        <button className="lib-nav" disabled={index <= 0} onClick={() => onStep(-1)} title="Previous export (←)">
          <Icon d={ICONS.prev} />
        </button>
        <div className="lib-player" style={{ ['--ar' as any]: ar }}>
          <video key={r.filename} src={r.url} controls autoPlay muted loop playsInline />
        </div>
        <button className="lib-nav" disabled={index >= count - 1} onClick={() => onStep(1)} title="Next export (→)">
          <Icon d={ICONS.next} />
        </button>
      </div>

      <div className="lib-info">
        <div className="lib-crumb">
          <button className="btn sm" onClick={() => useStudioStore.setState({ libraryItem: null })}>
            <Icon d={ICONS.prev} /> All exports
          </button>
          {index >= 0 && (
            <span className="muted">
              {index + 1} of {count}
            </span>
          )}
        </div>
        <h3>{titleOf(r)}</h3>
        <div className="summary">
          <span>Format</span>
          <b>{formatLabel(r)}</b>
          {r.resolution && (
            <>
              <span>Size</span>
              <b>{r.resolution.replace('x', ' × ')}</b>
            </>
          )}
          {r.duration ? (
            <>
              <span>Length</span>
              <b>{(+r.duration).toFixed(3)} s</b>
            </>
          ) : null}
          {r.bpm ? (
            <>
              <span>Tempo</span>
              <b>{(+r.bpm).toFixed(2)} BPM</b>
            </>
          ) : null}
          <span>File</span>
          <b>{r.size_mb} MB</b>
          {r.created_at ? (
            <>
              <span>Made</span>
              <b>{new Date(r.created_at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b>
            </>
          ) : null}
        </div>

        <div className="actions">
          <a className="btn primary" href={r.url} download={r.filename}>
            <Icon d={ICONS.download} /> MP4
          </a>
          {r.audio_url && (
            <a className="btn" href={r.audio_url} download="">
              With audio
            </a>
          )}
          {r.promo_url && (
            <a className="btn" href={r.promo_url} download="">
              Promo with song
            </a>
          )}
          {r.cover_url && (
            <a className="btn" href={r.cover_url} download="">
              Cover JPG
            </a>
          )}
          <button className="btn" onClick={() => reveal(r.filename)}>
            <Icon d={ICONS.folder} /> Reveal in Finder
          </button>
          <DeleteButton r={r} wide />
        </div>
        <div className="actions">
          <button className="btn sm" onClick={() => exportCompanion({ filename: r.filename, kind: 'gif' })}>
            GIF teaser
          </button>
          <button className="btn sm" onClick={() => exportCompanion({ filename: r.filename, kind: 'webp' })}>
            WebP teaser
          </button>
        </div>

        {(r.checks || []).length > 0 && (
          <>
            <div className="lib-ph">Spec checks</div>
            <div className="checks">
              {(r.checks || []).map((c) => (
                <div className={`ck ${c.level}`} key={c.id}>
                  <span className="ic">{CHECK_ICONS[c.level]}</span>
                  <b>{c.label}</b>
                  <span>{c.detail || ''}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="note lib-file">{r.filename}</div>
      </div>
    </div>
  );
};

export const ExportsLibrary: React.FC = () => {
  const open = useStudioStore((s) => s.libraryOpen);
  const item = useStudioStore((s) => s.libraryItem);
  const renders = useStudioStore((s) => s.renders);
  const filter = useStudioStore((s) => s.exportFilter);
  const list = useMemo(() => filterExports(renders, filter), [renders, filter]);
  const [page, pages, setPage] = usePage(list.length, LIB_PAGE);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = item ? renders.find((r) => r.filename === item) || null : null;
  const index = current ? list.indexOf(current) : -1;
  const close = () => useStudioStore.setState({ libraryOpen: false, libraryItem: null });
  const step = (d: number) => {
    const next = list[index + d];
    if (next) useStudioStore.setState({ libraryItem: next.filename });
  };
  const totalMb = renders.reduce((a, r) => a + (r.size_mb || 0), 0);

  // Opening an export from the side panel shows its page when going back to the grid.
  useEffect(() => {
    if (open && index >= 0) setPage(Math.floor(index / LIB_PAGE));
  }, [open, index, setPage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, select, textarea') as HTMLInputElement | null;
      if (e.key === 'Escape' && typing?.value && typing.type === 'search') {
        return; // the search box clears itself first
      } else if (e.key === 'Escape') {
        if (current) useStudioStore.setState({ libraryItem: null });
        else close();
      } else if (typing) {
        return;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const d = e.key === 'ArrowLeft' ? -1 : 1;
        if (current) step(d);
        else setPage(Math.max(0, Math.min(pages - 1, page + d)));
      } else if (e.key === '/' && !current) {
        e.preventDefault();
        searchRef.current?.focus();
      } else {
        return;
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div
      className={`modal-bg ${open ? 'on' : ''}`}
      id="libraryModal"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {open && (
        <div className="modal lib" role="dialog" aria-label="Exports">
          <div className="modal-h">
            <div>
              <h2>Exports</h2>
              <div className="sub">
                {renders.length} render{renders.length === 1 ? '' : 's'} · {totalMb.toFixed(1)} MB in out/
              </div>
            </div>
            <button className="btn icon modal-x" title="Close (Esc)" onClick={close}>
              ✕
            </button>
          </div>

          {current ? (
            <ExportViewer r={current} index={index} count={list.length} onStep={step} />
          ) : (
            <>
              <div className="lib-bar">
                <SearchBox autoFocus inputRef={searchRef} />
                <KindChips renders={renders} />
                <select className="select sm" value={filter.sort} onChange={(e) => setFilter({ sort: e.target.value })} title="Sort">
                  {EXPORT_SORTS.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              {!list.length && <NoMatch />}
              <div className="lib-grid">
                {list.slice(page * LIB_PAGE, page * LIB_PAGE + LIB_PAGE).map((r) => (
                  <button className="lib-card" key={r.filename} title={r.filename} onClick={() => useStudioStore.setState({ libraryItem: r.filename })}>
                    <ExportThumb r={r} />
                    <span className="lib-cap">
                      <b>{titleOf(r)}</b>
                      <span>{metaLine(r)}</span>
                      <span>
                        {formatLabel(r)}
                        {r.created_at ? ` · ${timeAgo(r.created_at)}` : ''} <SpecBadge r={r} />
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              {list.length > 0 && (
                <div className="lib-foot">
                  <span className="muted">
                    {page * LIB_PAGE + 1}–{Math.min(list.length, (page + 1) * LIB_PAGE)} of {list.length}
                  </span>
                  {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
