import React, { useEffect, useMemo, useRef } from 'react';
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
  specOf,
  timeAgo,
  titleOf,
} from '../lib/exportsView.ts';
import { postJSON, toast } from '../lib/utils.ts';
import { ArmedButton, Icon, ICONS, Modal, useArmed } from './ui.tsx';
import { FilterChips, FilterSearch, LibraryFoot, LibraryViewer, NoMatch, Pager, useLibraryKeys, usePage } from './Library.tsx';
import { openExportEdit } from '../state/projectController.ts';
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

/** Opens the edit the export was made from. An edit that isn't in a project would be lost, so that takes a second click. */
const OpenEditButton: React.FC<{ r: RenderRecord }> = ({ r }) => {
  const project = useStudioStore((s) => s.project);
  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`btn ${armed ? 'armed' : ''}`}
      title={armed ? "The edit open now isn't saved to a project. Click again to replace it" : 'Open the edit this export was made from'}
      onClick={() => (project || armed ? openExportEdit(r.filename, titleOf(r)) : setArmed(true))}
    >
      {armed ? 'Replace the unsaved edit?' : 'Open the edit'}
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
    <FilterSearch value={q} onChange={(v) => setFilter({ q: v })} placeholder="Search by look, format or size" autoFocus={autoFocus} inputRef={inputRef} />
  );
};

const KindChips: React.FC<{ renders: RenderRecord[] }> = ({ renders }) => {
  const kind = useStudioStore((s) => s.exportFilter.kind);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: renders.length };
    for (const r of renders) c[kindOf(r)] = (c[kindOf(r)] || 0) + 1;
    return c;
  }, [renders]);
  return <FilterChips kinds={EXPORT_KINDS} counts={counts} value={kind} onChange={(k) => setFilter({ kind: k })} />;
};

/** Back to page 1 when the search changes. */
function useExportPage(count: number, per: number) {
  const { q, kind, sort } = useStudioStore((s) => s.exportFilter);
  return usePage(count, per, `${q}\n${kind}\n${sort}`);
}

const ClearSearch: React.FC = () => <NoMatch what="exports" onClear={() => setFilter({ q: '', kind: 'all' })} />;

const ExportsList: React.FC = () => {
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
          <SearchBox />
          <KindChips renders={renders} />
        </>
      )}

      <div className="exports" id="exports">
        {!renders.length && <div className="note">Exports appear here, each checked against its format's spec.</div>}
        {renders.length > 0 && !list.length && <ClearSearch />}
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
              {r.promo_url && (
                <a className="btn sm icon promo" href={r.promo_url} download="" title="Download the promo with the song">
                  ♫
                </a>
              )}
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

  return (
    <LibraryViewer
      what="export"
      back="All exports"
      index={index}
      count={count}
      onStep={onStep}
      onBack={() => useStudioStore.setState({ libraryItem: null })}
      ar={aspectOf(r)}
      player={<video key={r.filename} src={r.url} controls autoPlay muted loop playsInline />}
    >
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
          <Icon d={ICONS.download} /> {r.filename.toLowerCase().endsWith('.mov') ? 'MOV' : 'MP4'}
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
        {r.has_edit && <OpenEditButton r={r} />}
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
    </LibraryViewer>
  );
};

export const ExportsLibrary: React.FC = () => {
  const open = useStudioStore((s) => s.libraryOpen);
  const item = useStudioStore((s) => s.libraryItem);
  const renders = useStudioStore((s) => s.renders);
  const filter = useStudioStore((s) => s.exportFilter);
  const list = useMemo(() => filterExports(renders, filter), [renders, filter]);
  const [page, pages, setPage] = useExportPage(list.length, LIB_PAGE);
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

  useLibraryKeys(open, {
    viewing: !!current,
    back: () => useStudioStore.setState({ libraryItem: null }),
    close,
    step,
    page,
    pages,
    setPage,
    searchRef,
  });

  return (
    <Modal
      id="libraryModal"
      open={open}
      onClose={close}
      title="Exports"
      subtitle={`${renders.length} render${renders.length === 1 ? '' : 's'} · ${totalMb.toFixed(1)} MB in out/`}
      className="modal-wide lib"
      ariaLabel="Exports"
      closeButtonDataAction="close-exports"
      headerActions={
        renders.length > 0 ? (
          <ArmedButton
            className="sm del"
            onConfirm={async () => {
              for (const r of renders) {
                await postJSON('/api/export/delete', { filename: r.filename });
              }
              useStudioStore.setState({ renders: [], libraryItem: null });
              toast('Deleted all exports');
            }}
            label="Delete all"
            armedLabel="Delete all?"
            title="Delete all exports"
          />
        ) : undefined
      }
    >
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

          {!list.length && <ClearSearch />}
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

          <LibraryFoot page={page} pages={pages} per={LIB_PAGE} count={list.length} onPage={setPage} />
        </>
      )}
    </Modal>
  );
};
