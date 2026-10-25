import './ClipsLibrary.css';
import { useStudioStore, useStudioApi, useStudioRuntime } from '../../state/StudioContext.tsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CLIP_KINDS, CLIP_SORTS, clipMetaLine, clipName, filterClips, folderOf, kindCounts, shapeOf } from '../../lib/clipsView.ts';
import { clipAspect, homeShort } from '../../lib/utils.ts';
import { thumbRef } from '../../lib/thumbs.ts';
import { ArmedButton } from '../ArmedButton/ArmedButton.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';
import { Modal } from '../Modal/Modal.tsx';
import { FilterChips } from '../FilterChips/FilterChips.tsx';
import { FilterSearch } from '../FilterSearch/FilterSearch.tsx';
import { LibraryFoot } from '../LibraryFoot/LibraryFoot.tsx';
import { LibraryViewer } from '../LibraryViewer/LibraryViewer.tsx';
import { NoMatch } from '../NoMatch/NoMatch.tsx';
import { useLibraryKeys } from '../../hooks/useLibraryKeys.ts';
import { usePage } from '../../hooks/usePage.ts';
import type { ClipMeta } from '../../engine/types.ts';
import { useClipLibraryActions } from '../../hooks/useClipLibraryActions.ts';
import { MediaGlyph } from '../MediaGlyph/MediaGlyph.tsx';

const LIB_PAGE = 24;

/** Its first frame, or the clip itself while the pointer is on it once it has a playback copy. */
const ClipThumb: React.FC<{ c: ClipMeta; n: number }> = ({ c, n }) => {
  const [hover, setHover] = useState(false);
  return (
    <span
      className="clip-thumb"
      ref={thumbRef(`/api/thumb/${c.id}?w=360`)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {hover && c.proxy === 'ready' && <video src={`/api/proxy/${c.id}`} autoPlay muted loop playsInline />}
      {n > 0 && <span className="num">{n}</span>}
    </span>
  );
};

/** `n` is the clip's place in the edit, or 0. */
const ClipCard: React.FC<{ c: ClipMeta; n: number }> = ({ c, n }) => {
  const { showClip } = useClipLibraryActions();

  const toggleClip = useStudioStore((s) => s.toggleClip);
  return (
    <div className={`lib-card clip-card ${n ? 'on' : ''}`}>
      <button className="lib-open" title={c.name} onClick={() => showClip(c.id)}>
        <ClipThumb c={c} n={n} />
        <span className="lib-cap">
          <b>{clipName(c)}</b>
          <span>{clipMetaLine(c)}</span>
          <span>{folderOf(c) || shapeOf(c) || ' '}</span>
        </span>
      </button>
      <button
        className={`clip-select ${n ? 'on' : ''}`}
        title={n ? 'Take it out of the edit' : 'Add to the edit'}
        aria-label={n ? `Take ${clipName(c)} out of the edit` : `Add ${clipName(c)} to the edit`}
        onClick={() => toggleClip(c.id)}
      >
        <MediaGlyph kind={n ? 'check' : 'plus'} />
      </button>
    </div>
  );
};

const ClipViewer: React.FC<{ c: ClipMeta; index: number; count: number; onStep: (d: number) => void; onClose: () => void }> = ({
  c,
  index,
  count,
  onStep,
  onClose,
}) => {
  const { media } = useStudioRuntime();
  const { showClip } = useClipLibraryActions();

  const selected = useStudioStore((s) => s.selected);
  const clipMode = useStudioStore((s) => s.clipMode);
  const look = useStudioStore((s) => s.look);
  const clipLookOf = useStudioStore((s) => s.clipLookOf);
  const toggleClip = useStudioStore((s) => s.toggleClip);
  const editClipLook = useStudioStore((s) => s.editClipLook);
  const n = selected.indexOf(c.id) + 1;
  const busy = c.proxy === 'queued' || c.proxy === 'building';
  const clipLook = n && clipMode !== 'one' ? clipLookOf(c.id) : null;
  const folder = folderOf(c);

  return (
    <LibraryViewer
      what="clip"
      back="All clips"
      index={index}
      count={count}
      onStep={onStep}
      onBack={() => showClip(null)}
      ar={clipAspect(c)}
      player={
        c.proxy === 'ready' ? (
          <video key={c.id} src={`/api/proxy/${c.id}`} controls autoPlay muted loop playsInline />
        ) : (
          <span className="lib-still">
            <img key={c.id} src={`/api/thumb/${c.id}?w=720`} alt="" />
            <small>{busy ? 'Making a playback copy' : 'Add it to the edit to play it here'}</small>
          </span>
        )
      }
    >
      <h3>{clipName(c)}</h3>
      <div className="summary">
        <span>Kind</span>
        <b>{c.still ? 'Still image' : c.is_stock ? 'Stock video' : 'Video'}</b>
        {c.width && c.height ? (
          <>
            <span>Size</span>
            <b>
              {c.width} × {c.height} · {shapeOf(c)}
            </b>
          </>
        ) : null}
        {!c.still && (
          <>
            <span>Length</span>
            <b>
              {(c.duration || 0).toFixed(1)} s{c.fps ? ` · ${c.fps} fps` : ''}
            </b>
          </>
        )}
        {folder && (
          <>
            <span>Folder</span>
            <b>{folder}</b>
          </>
        )}
        <span>In the edit</span>
        <b>{n ? `Clip ${n} of ${selected.length}` : 'No'}</b>
        {clipLook && (
          <>
            <span>Look</span>
            <b>{clipLook === look ? 'The main look' : clipLook.name}</b>
          </>
        )}
      </div>

      <div className="actions">
        <button className={`btn ${n ? '' : 'primary'}`} onClick={() => toggleClip(c.id)}>
          {n ? 'Take out of the edit' : '+ Add to the edit'}
        </button>
        {clipLook && (
          <button
            className="btn"
            onClick={() => {
              editClipLook(c.id);
              onClose();
            }}
          >
            Edit its effects
          </button>
        )}
        <button className="btn" onClick={() => media.revealClip(c.id)}>
          <Icon d={ICONS.folder} /> Reveal in Finder
        </button>
        <ArmedButton
          className="del"
          onConfirm={() => media.removeClip(c.id)}
          title="Remove from the library. A file from a picked folder stays where it is"
          armedTitle="Click again to remove this clip"
          armedLabel="Click again to remove"
        >
          <Icon d={ICONS.trash} /> Remove
        </ArmedButton>
      </div>
      {c.path && <div className="note lib-file">{homeShort(c.path)}</div>}
    </LibraryViewer>
  );
};

export const ClipsLibrary: React.FC = () => {
  const store = useStudioApi();
  const { setFilter, clearFilter, showClip } = useClipLibraryActions();

  const open = useStudioStore((s) => s.clipsOpen);
  const item = useStudioStore((s) => s.clipsItem);
  const clips = useStudioStore((s) => s.clips);
  const selected = useStudioStore((s) => s.selected);
  const filter = useStudioStore((s) => s.clipFilter);
  const list = useMemo(() => (open ? filterClips(clips, selected, filter) : []), [open, clips, selected, filter]);
  const counts = useMemo(() => kindCounts(clips, selected), [clips, selected]);
  const [page, pages, setPage] = usePage(list.length, LIB_PAGE, `${filter.q}\n${filter.kind}\n${filter.sort}`);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = item ? clips.find((c) => c.id === item) || null : null;
  const index = current ? list.indexOf(current) : -1;
  const close = () => store.setState({ clipsOpen: false, clipsItem: null });
  const step = (d: number) => {
    const next = list[index + d];
    if (next) showClip(next.id);
  };

  // Going back to the grid shows the page the clip is on.
  useEffect(() => {
    if (open && index >= 0) setPage(Math.floor(index / LIB_PAGE));
  }, [open, index, setPage]);

  useLibraryKeys(open, { viewing: !!current, back: () => showClip(null), close, step, page, pages, setPage, searchRef });

  return (
    <Modal
      id="clipsModal"
      open={open}
      onClose={close}
      title="Clips"
      subtitle={`${clips.length} clip${clips.length === 1 ? '' : 's'} · ${selected.length} in the edit`}
      className="modal-wide lib clips-lib"
      closeButtonDataAction="close-clips"
    >
      {current ? (
        <ClipViewer c={current} index={index} count={list.length} onStep={step} onClose={close} />
      ) : (
        <>
          <div className="lib-bar">
            <FilterSearch value={filter.q} onChange={(q) => setFilter({ q })} placeholder="Search by name, folder or size" autoFocus inputRef={searchRef} />
            <FilterChips kinds={CLIP_KINDS} counts={counts} value={filter.kind} onChange={(kind) => setFilter({ kind })} />
            <select className="select sm" value={filter.sort} onChange={(e) => setFilter({ sort: e.target.value })} title="Sort">
              {CLIP_SORTS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {!clips.length ? (
            <div className="exp-empty">No clips yet. Import media from the Library panel.</div>
          ) : (
            !list.length && <NoMatch what="clips" onClear={clearFilter} />
          )}
          <div className="lib-grid">
            {list.slice(page * LIB_PAGE, page * LIB_PAGE + LIB_PAGE).map((c) => (
              <ClipCard key={c.id} c={c} n={selected.indexOf(c.id) + 1} />
            ))}
          </div>
          <LibraryFoot page={page} pages={pages} per={LIB_PAGE} count={list.length} onPage={setPage} />
        </>
      )}
    </Modal>
  );
};
