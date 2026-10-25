import './ExportsLibrary.css';
import { useStudioStore, useStudioApi, useStudioRuntime } from '../../state/StudioContext.tsx';
import React, { useEffect, useMemo, useRef } from 'react';
import { CHECK_ICONS, EXPORT_SORTS, aspectOf, filterExports, formatLabel, metaLine, timeAgo, titleOf } from '../../lib/exportsView.ts';
import { postJSON, toast } from '../../lib/utils.ts';
import { ArmedButton } from '../ArmedButton/ArmedButton.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';
import { Modal } from '../Modal/Modal.tsx';
import { useArmed } from '../../hooks/useArmed.ts';
import { LibraryFoot } from '../LibraryFoot/LibraryFoot.tsx';
import { LibraryViewer } from '../LibraryViewer/LibraryViewer.tsx';
import { useLibraryKeys } from '../../hooks/useLibraryKeys.ts';
import type { RenderRecord } from '../../engine/types.ts';
import { ExportDeleteButton } from '../ExportDeleteButton/ExportDeleteButton.tsx';
import { useExportActions } from '../../hooks/useExportActions.ts';
import { useExportPage } from '../../hooks/useExportPage.ts';
import { ExportSearch } from '../ExportSearch/ExportSearch.tsx';
import { ExportKindChips } from '../ExportKindChips/ExportKindChips.tsx';
import { ClearExportSearch } from '../ClearExportSearch/ClearExportSearch.tsx';
import { ExportThumb } from '../ExportThumb/ExportThumb.tsx';
import { ExportSpecBadge } from '../ExportSpecBadge/ExportSpecBadge.tsx';

const LIB_PAGE = 12;

/** Opens the edit the export was made from. An edit that isn't in a project would be lost, so that takes a second click. */
const OpenEditButton: React.FC<{ r: RenderRecord }> = ({ r }) => {
  const { projects: projectController } = useStudioRuntime();

  const project = useStudioStore((s) => s.project);
  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`btn ${armed ? 'armed' : ''}`}
      title={armed ? "The edit open now isn't saved to a project. Click again to replace it" : 'Open the edit this export was made from'}
      onClick={() => (project || armed ? projectController.openExportEdit(r.filename, titleOf(r)) : setArmed(true))}
    >
      {armed ? 'Replace the unsaved edit?' : 'Open the edit'}
    </button>
  );
};

const ExportViewer: React.FC<{ r: RenderRecord; index: number; count: number; onStep: (d: number) => void }> = ({
  r,
  index,
  count,
  onStep,
}) => {
  const store = useStudioApi();

  const reveal = useStudioStore((s) => s.reveal);
  const exportCompanion = useStudioStore((s) => s.exportCompanion);

  return (
    <LibraryViewer
      what="export"
      back="All exports"
      index={index}
      count={count}
      onStep={onStep}
      onBack={() => store.setState({ libraryItem: null })}
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
        <ExportDeleteButton r={r} wide />
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
  const store = useStudioApi();
  const { setFilter } = useExportActions();

  const open = useStudioStore((s) => s.libraryOpen);
  const item = useStudioStore((s) => s.libraryItem);
  const renders = useStudioStore((s) => s.renders);
  const filter = useStudioStore((s) => s.exportFilter);
  const list = useMemo(() => filterExports(renders, filter), [renders, filter]);
  const [page, pages, setPage] = useExportPage(list.length, LIB_PAGE);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = item ? renders.find((r) => r.filename === item) || null : null;
  const index = current ? list.indexOf(current) : -1;
  const close = () => store.setState({ libraryOpen: false, libraryItem: null });
  const step = (d: number) => {
    const next = list[index + d];
    if (next) store.setState({ libraryItem: next.filename });
  };
  const totalMb = renders.reduce((a, r) => a + (r.size_mb || 0), 0);

  // Opening an export from the side panel shows its page when going back to the grid.
  useEffect(() => {
    if (open && index >= 0) setPage(Math.floor(index / LIB_PAGE));
  }, [open, index, setPage]);

  useLibraryKeys(open, {
    viewing: !!current,
    back: () => store.setState({ libraryItem: null }),
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
              store.setState({ renders: [], libraryItem: null });
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
            <ExportSearch autoFocus inputRef={searchRef} />
            <ExportKindChips renders={renders} />
            <select className="select sm" value={filter.sort} onChange={(e) => setFilter({ sort: e.target.value })} title="Sort">
              {EXPORT_SORTS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {!list.length && <ClearExportSearch />}
          <div className="lib-grid">
            {list.slice(page * LIB_PAGE, page * LIB_PAGE + LIB_PAGE).map((r) => (
              <button className="lib-card" key={r.filename} title={r.filename} onClick={() => store.setState({ libraryItem: r.filename })}>
                <ExportThumb r={r} />
                <span className="lib-cap">
                  <b>{titleOf(r)}</b>
                  <span>{metaLine(r)}</span>
                  <span>
                    {formatLabel(r)}
                    {r.created_at ? ` · ${timeAgo(r.created_at)}` : ''} <ExportSpecBadge r={r} />
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
