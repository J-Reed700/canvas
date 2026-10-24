import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore } from '../state/store.ts';
import {
  CLIP_KINDS,
  CLIP_SORTS,
  clipMetaLine,
  clipName,
  filterClips,
  folderOf,
  kindCounts,
  shapeOf,
  type ClipFilter,
} from '../lib/clipsView.ts';
import { clipAspect, homeShort } from '../lib/utils.ts';
import { isLoaded, removeClip, revealClip } from '../state/mediaActions.ts';
import { ArmedButton, Icon, ICONS, Modal, useArmed } from './ui.tsx';
import { FilterChips, FilterSearch, LibraryFoot, LibraryViewer, NoMatch, useLibraryKeys, usePage } from './Library.tsx';
import { ChooserNote, FolderPathForm, useFolderPicker } from './Folders.tsx';
import type { ClipMeta } from '../engine/types.ts';

const LIB_PAGE = 24;

const setFilter = (patch: Partial<ClipFilter>) => useStudioStore.setState((s) => ({ clipFilter: { ...s.clipFilter, ...patch } }));
const clearFilter = () => setFilter({ q: '', kind: 'all' });
const openClips = () => useStudioStore.setState({ clipsOpen: true, clipsItem: null });
const showClip = (id: string | null) => useStudioStore.setState({ clipsItem: id });

/** Needs a second click within 3 s, like deleting an export. */
const RemoveClipButton: React.FC<{ id: string }> = ({ id }) => {
  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`rm ${armed ? 'armed' : ''}`}
      title={armed ? 'Click again to remove this clip' : 'Remove from the library'}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) removeClip(id);
        else setArmed(true);
      }}
    >
      {armed ? 'Remove?' : '✕'}
    </button>
  );
};

/** The Clips section of the side panel: add, order and pick the clips in the edit. */
export const ClipsSection: React.FC<{ onAddFiles: () => void }> = ({ onAddFiles }) => {
  const folder = useFolderPicker();
  const [dragId, setDragId] = useState<string | null>(null);

  const clips = useStudioStore((s) => s.clips);
  const selected = useStudioStore((s) => s.selected);
  const filter = useStudioStore((s) => s.clipFilter);
  const clipMode = useStudioStore((s) => s.clipMode);
  const editClip = useStudioStore((s) => s.editClip);
  const look = useStudioStore((s) => s.look);
  const clipLookOf = useStudioStore((s) => s.clipLookOf);
  const editClipLook = useStudioStore((s) => s.editClipLook);
  const toggleClip = useStudioStore((s) => s.toggleClip);
  const reorderClips = useStudioStore((s) => s.reorderClips);
  const autoFrame = useStudioStore((s) => s.autoFrame);

  // Always in the edit's order here, whatever the browser sorts by, so the numbers and dragging make sense.
  const list = filterClips(clips, selected, { ...filter, sort: 'edit' });
  const counts = useMemo(() => kindCounts(clips, selected), [clips, selected]);
  const filtered = list.length !== clips.length;

  return (
    <section className="sec sec-clips">
      <div className="sec-h">
        <h3>Clips</h3>
        <span className="meta" id="clipCount">
          {filtered ? `${list.length} of ${clips.length} shown` : `${selected.length} of ${clips.length} in the edit`}
        </span>
        {clips.length > 0 && (
          <button className="btn sm exp-open" id="btnBrowseClips" title="Browse every clip" onClick={openClips}>
            <Icon d={ICONS.expand} /> Browse
          </button>
        )}
      </div>

      <div className="clip-tools">
        <button
          className="btn sm add"
          id="btnAddMedia"
          title="Copy video clips, album art / photos or songs into Downbeat (or drop them anywhere)"
          onClick={onAddFiles}
        >
          + Add files
        </button>
        <button
          className="btn sm add"
          id="btnAddFolder"
          disabled={folder.waiting}
          title="List the videos and songs in a folder and its subfolders"
          onClick={folder.choose}
        >
          + Add a folder
        </button>
        {(folder.waiting || folder.typing || folder.err) && (
          <div className="clip-folder">
            {folder.waiting && <ChooserNote />}
            {folder.typing && <FolderPathForm f={folder} />}
            {folder.err && <div className="tp-err">{folder.err}</div>}
          </div>
        )}
        <button className="btn sm" id="btnAllClips" title="Use every loaded clip" onClick={() => reorderClips('all')}>
          All
        </button>
        {clips.some((c) => c.is_stock) && (
          <button className="btn sm" id="btnStockClips" title="Use the first 5 stock clips instead of the ones picked now" onClick={() => reorderClips('stock')}>
            Stock
          </button>
        )}
        <button className="btn sm" id="btnSoloClip" title="Use only the first clip in the sequence" onClick={() => reorderClips('solo')}>
          Solo
        </button>
        <button className="btn sm" id="btnReverse" title="Reverse the sequence order" onClick={() => reorderClips('reverse')}>
          Reverse
        </button>
        <button className="btn sm" id="btnShuffle" title="Shuffle the sequence order" onClick={() => reorderClips('shuffle')}>
          Shuffle
        </button>
        <button
          className="btn sm wide"
          id="btnAutoFrame"
          title="Find faces or the main subject in each selected clip and center the crop on it. Drag the preview to adjust; double-click it to reset."
          onClick={autoFrame}
        >
          ⌖ Auto-frame subjects
        </button>
      </div>

      {clips.length > 0 && (
        <div className="clip-find">
          <FilterSearch value={filter.q} onChange={(q) => setFilter({ q })} placeholder="Search by name or folder" />
          <FilterChips kinds={CLIP_KINDS} counts={counts} value={filter.kind} onChange={(kind) => setFilter({ kind })} />
        </div>
      )}

      <div className="clips" id="clips">
        {clips.length > 0 && !list.length && <NoMatch what="clips" onClear={clearFilter} />}
        {list.map((c) => {
          const idx = selected.indexOf(c.id);
          const busy = c.proxy === 'queued' || c.proxy === 'building';
          const idle = !isLoaded(c, selected);
          const clk = clipLookOf(c.id);
          const own = clk !== look;

          return (
            <div
              key={c.id}
              className={`clip ${idx >= 0 ? 'on' : 'off'}${idle ? ' idle' : ''}`}
              draggable={idx >= 0}
              title={`${c.name}\n${c.width || 0}×${c.height || 0} · ${c.duration || 0}s${idle ? '\nNot loaded yet. Click to add it to the edit.' : ''}`}
              style={{ backgroundImage: `url(/api/thumb/${c.id}?w=240)` }}
              onClick={() => toggleClip(c.id)}
              onDragStart={(e) => {
                setDragId(c.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => {
                if (dragId && idx >= 0) {
                  e.preventDefault();
                  e.currentTarget.classList.add('drag-over');
                }
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.classList.remove('drag-over');
                if (!dragId || dragId === c.id || idx < 0) return;
                // the dragged clip takes the target's place, whichever way it moved
                reorderClips({ from: selected.indexOf(dragId), to: idx });
                setDragId(null);
              }}
            >
              {idx >= 0 && <span className="num">{idx + 1}</span>}
              {idle && <span className="add-hint">+ Add</span>}
              {busy && <span className="busy" title="Preparing playback proxy" />}
              {idx >= 0 && clipMode !== 'one' && (
                <button
                  className={`lk ${own ? 'own' : ''} ${editClip === c.id ? 'on' : ''}`}
                  title={`${own ? clk?.name : 'Main look'}: click to edit clip effects`}
                  onClick={(e) => {
                    e.stopPropagation();
                    editClipLook(c.id);
                  }}
                >
                  {own ? clk?.name : 'Main'}
                </button>
              )}
              <RemoveClipButton id={c.id} />
              <div className="cap">
                {c.still ? `Still · ${clipName(c)}` : `${(c.duration || 0).toFixed(1)}s · ${c.name}`}
              </div>
            </div>
          );
        })}
      </div>

      <div className="drop-hint">Drop MP4 / MOV / JPG / PNG / WAV / MP3 anywhere · drag clips to reorder</div>
    </section>
  );
};

/** Its first frame, or the clip itself while the pointer is on it once it has a playback copy. */
const ClipThumb: React.FC<{ c: ClipMeta; n: number }> = ({ c, n }) => {
  const [hover, setHover] = useState(false);
  return (
    <span
      className="clip-thumb"
      style={{ backgroundImage: `url(/api/thumb/${c.id}?w=360)` }}
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
        className={`clip-pick ${n ? 'on' : ''}`}
        title={n ? 'Take it out of the edit' : 'Add to the edit'}
        aria-label={n ? `Take ${clipName(c)} out of the edit` : `Add ${clipName(c)} to the edit`}
        onClick={() => toggleClip(c.id)}
      >
        {n ? '✓' : '+'}
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
        <button className="btn" onClick={() => revealClip(c.id)}>
          <Icon d={ICONS.folder} /> Reveal in Finder
        </button>
        <ArmedButton
          className="del"
          onConfirm={() => removeClip(c.id)}
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
  const close = () => useStudioStore.setState({ clipsOpen: false, clipsItem: null });
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
            <div className="exp-empty">No clips yet. Add files or a folder in the Clips panel.</div>
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
