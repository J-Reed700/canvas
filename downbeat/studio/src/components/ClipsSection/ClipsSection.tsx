import './ClipsSection.css';
import { useStudioStore } from '../../state/StudioContext.tsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CLIP_KINDS, clipName, filterClips, folderOf, kindCounts, shapeOf } from '../../lib/clipsView.ts';
import { thumbRef } from '../../lib/thumbs.ts';
import { isLoaded } from '../../state/mediaActions.ts';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';
import { FilterChips } from '../FilterChips/FilterChips.tsx';
import { FilterSearch } from '../FilterSearch/FilterSearch.tsx';
import { NoMatch } from '../NoMatch/NoMatch.tsx';
import { ChooserNote } from '../ChooserNote/ChooserNote.tsx';
import { FolderPathForm } from '../FolderPathForm/FolderPathForm.tsx';
import { useFolderPicker } from '../../hooks/useFolderPicker.ts';
import { useClipLibraryActions } from '../../hooks/useClipLibraryActions.ts';
import { MediaGlyph } from '../MediaGlyph/MediaGlyph.tsx';
import { RemoveClipButton } from '../RemoveClipButton/RemoveClipButton.tsx';

/** The Clips section of the side panel: add, order and pick the clips in the edit. */
export const ClipsSection: React.FC<{ onAddFiles: () => void }> = ({ onAddFiles }) => {
  const { setFilter, clearFilter, openClips } = useClipLibraryActions();

  const folder = useFolderPicker();
  const [dragId, setDragId] = useState<string | null>(null);
  const arrangeRef = useRef<HTMLDetailsElement>(null);

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

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (arrangeRef.current?.open && !arrangeRef.current.contains(e.target as Node)) arrangeRef.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const arrange = (e: React.MouseEvent<HTMLButtonElement>, mode: 'all' | 'stock' | 'solo' | 'reverse' | 'shuffle') => {
    reorderClips(mode);
    const menu = e.currentTarget.closest('details') as HTMLDetailsElement | null;
    if (menu) menu.open = false;
  };

  // Always in the edit's order here, whatever the browser sorts by, so the numbers and dragging make sense.
  const list = filterClips(clips, selected, { ...filter, sort: 'edit' });
  const counts = useMemo(() => kindCounts(clips, selected), [clips, selected]);
  const filtered = list.length !== clips.length;

  return (
    <section className="sec sec-clips">
      <div className="sec-h">
        <h3>Clips</h3>
        <span className="meta" id="clipCount">
          {!clips.length ? 'Empty' : filtered ? `${list.length} of ${clips.length} shown` : `${selected.length} of ${clips.length} in the edit`}
        </span>
        {clips.length > 0 && (
          <button className="btn sm exp-open" id="btnBrowseClips" title="Browse every clip" onClick={openClips}>
            <Icon d={ICONS.expand} /> Browse
          </button>
        )}
      </div>

      <div className="clip-tools" aria-label="Clip library tools">
        <button
          className="btn sm clip-folder-button"
          id="btnAddFolder"
          aria-label="Add a folder"
          disabled={folder.waiting}
          title="List the videos and songs in a folder and its subfolders"
          onClick={folder.choose}
        >
          + Folder
        </button>
        {(folder.waiting || folder.typing || folder.err) && (
          <div className="clip-folder">
            {folder.waiting && <ChooserNote />}
            {folder.typing && <FolderPathForm f={folder} />}
            {folder.err && <div className="tp-err">{folder.err}</div>}
          </div>
        )}
        <details
          className="clip-arrange"
          ref={arrangeRef}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.open = false;
            e.currentTarget.querySelector('summary')?.focus();
          }}
        >
          <summary className="btn sm" title="Choose or reorder the clips in the edit">
            <MediaGlyph kind="more" /> Sequence
          </summary>
          <div className="clip-arrange-menu" role="menu" aria-label="Sequence actions">
            <div className="clip-arrange-label" role="presentation">Selection</div>
            <button id="btnAllClips" role="menuitem" title="Use every loaded clip" onClick={(e) => arrange(e, 'all')}>
              All
            </button>
            {clips.some((c) => c.is_stock) && (
              <button id="btnStockClips" role="menuitem" title="Use the first 5 stock clips instead of the ones picked now" onClick={(e) => arrange(e, 'stock')}>
                Stock
              </button>
            )}
            <button id="btnSoloClip" role="menuitem" title="Use only the first clip in the sequence" onClick={(e) => arrange(e, 'solo')}>
              Solo
            </button>
            <div className="clip-arrange-label" role="presentation">Order</div>
            <button id="btnReverse" role="menuitem" title="Reverse the sequence order" onClick={(e) => arrange(e, 'reverse')}>
              Reverse
            </button>
            <button id="btnShuffle" role="menuitem" title="Shuffle the sequence order" onClick={(e) => arrange(e, 'shuffle')}>
              Shuffle
            </button>
          </div>
        </details>
        <button
          className="btn sm clip-frame"
          id="btnAutoFrame"
          aria-label="Auto frame subjects"
          title="Find faces or the main subject in each selected clip and center the crop on it. Drag the preview to adjust; double-click it to reset."
          onClick={autoFrame}
          disabled={!selected.length}
        >
          <MediaGlyph kind="frame" /><span className="sr-only">Auto frame</span>
        </button>
      </div>

      {clips.length > 0 && (
        <div className="clip-find">
          <FilterSearch value={filter.q} onChange={(q) => setFilter({ q })} placeholder="Search by name or folder" />
          <FilterChips kinds={CLIP_KINDS} counts={counts} value={filter.kind} onChange={(kind) => setFilter({ kind })} />
        </div>
      )}

      <div className="clips" id="clips">
        {!clips.length && (
          <div className="clip-empty">
            <span className="clip-empty-icon" aria-hidden="true">
              <MediaGlyph kind="plus" />
            </span>
            <strong>Bring in your first clip</strong>
            <span>Import video or still images, or drop them anywhere.</span>
            <button className="btn sm" type="button" onClick={onAddFiles}>
              Import media
            </button>
          </div>
        )}
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
              role="group"
              tabIndex={0}
              aria-label={`${c.name}, ${idx >= 0 ? `clip ${idx + 1} in the edit` : 'not in the edit'}`}
              title={`${c.name}\n${c.width || 0}×${c.height || 0} · ${c.duration || 0}s${idle ? '\nNot loaded yet. Click to add it to the edit.' : ''}`}
              onClick={() => toggleClip(c.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                e.stopPropagation();
                toggleClip(c.id);
              }}
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
              <div className="clip-media" ref={thumbRef(`/api/thumb/${c.id}?w=320`)}>
                {idx >= 0 && (
                  <span className="num" title={`Clip ${idx + 1} in the edit`}>
                    <MediaGlyph kind="check" />
                    <span>{idx + 1}</span>
                  </span>
                )}
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
              </div>
              <div className="cap">
                <span className="cap-meta">
                  {c.still ? 'Still' : `${(c.duration || 0).toFixed(1)}s`}
                  <span className="cap-sep"> · </span>
                </span>
                <strong className="cap-name">{c.still ? clipName(c) : c.name}</strong>
              </div>
              <div className="clip-source">{folderOf(c) || shapeOf(c) || (c.still ? 'Still image' : 'Video')}</div>
            </div>
          );
        })}
      </div>

      {!!clips.length && <div className="drop-hint">Drag selected clips to reorder · drop files anywhere to import</div>}
    </section>
  );
};
