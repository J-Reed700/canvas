import './TrackPicker.css';
import { useStudioStore, useStudioRuntime } from '../../state/StudioContext.tsx';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchJSON, homeShort, songTitle, sourceLabel } from '../../lib/utils.ts';
import { timeAgo } from '../../lib/exportsView.ts';
import type { LibraryInfo } from '../../state/mediaActions.ts';
import type { TrackMeta } from '../../engine/types.ts';
import { SearchField } from '../SearchField/SearchField.tsx';
import { ChooserNote } from '../ChooserNote/ChooserNote.tsx';
import { FolderPathForm } from '../FolderPathForm/FolderPathForm.tsx';
import { useFolderPicker } from '../../hooks/useFolderPicker.ts';
import { StrokeIcon } from '../StrokeIcon/StrokeIcon.tsx';

type Row = { kind: 'none' } | { kind: 'track'; t: TrackMeta };

// Enough to scroll through comfortably; search narrows the rest.
const MAX_ROWS = 250;

const PickerGlyph: React.FC<{ kind: 'audio' | 'clock' | 'check' | 'chevron' | 'close' }> = ({ kind }) => {
  const paths = {
    audio: 'M3 9.5V6.5M6.25 12V4M9.75 10.75v-7.5M13 9V7',
    clock: 'M8 13.25A5.25 5.25 0 1 0 8 2.75a5.25 5.25 0 0 0 0 10.5ZM8 5.25V8l1.9 1.15',
    check: 'm3.25 8.25 3 3 6.5-7',
    chevron: 'm4.25 6.25 3.75 3.5 3.75-3.5',
    close: 'm4.25 4.25 7.5 7.5m0-7.5-7.5 7.5',
  } as const;
  return <StrokeIcon d={paths[kind]} />;
};

const TrackPickerMenu: React.FC<{ onAddSong: () => void }> = ({ onAddSong }) => {
  const { media } = useStudioRuntime();

  const trackId = useStudioStore((s) => s.trackId);
  const tracks = useStudioStore((s) => s.tracks);
  const selectTrack = useStudioStore((s) => s.selectTrack);
  const folders = useStudioStore((s) => s.folders);
  const suggestions = useStudioStore((s) => s.folderSuggestions);
  const f = useFolderPicker();
  const { reset: resetFolderPicker } = f;

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = tracks.find((t) => t.id === trackId);

  // Rescan every time the picker opens, so songs saved since the last look show up.
  useEffect(() => {
    if (!open) return;
    setQ('');
    resetFolderPicker();
    let active = true;
    fetchJSON<LibraryInfo>('/api/tracks').then((library) => { if (active) media.applyLibrary(library); }).catch(() => {});
    return () => { active = false; };
  }, [open, resetFolderPicker, media]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    if (window.innerWidth < 700) {
      setPos({ left: 8, right: 8, top: 8, bottom: 8 });
      return;
    }
    const width = Math.min(Math.max(r.width, 380), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const top = r.bottom + 6;
    setPos({ left, top, width, maxHeight: Math.max(300, window.innerHeight - top - 12) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const groups = useMemo(() => {
    if (!open) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (t: TrackMeta) => words.every((w) => `${t.name} ${t.dir || ''}`.toLowerCase().includes(w));
    const order = ['added', ...folders];
    for (const t of tracks) if (t.source && !order.includes(t.source)) order.push(t.source);
    return order
      .map((key) => ({ key, items: tracks.filter((t) => t.source === key && match(t)) }))
      .filter((g) => g.items.length || folders.includes(g.key));
  }, [open, tracks, q, folders]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  let budget = MAX_ROWS;
  const shown = groups.map((g) => {
    const items = g.items.slice(0, Math.max(0, budget));
    budget -= items.length;
    return { ...g, items };
  });
  const rows: Row[] = [...(q ? [] : [{ kind: 'none' } as Row]), ...shown.flatMap((g) => g.items.map((t) => ({ kind: 'track', t }) as Row))];

  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.tp-row.hi')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const pick = (id: string) => {
    setOpen(false);
    if (id !== trackId) selectTrack(id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, Math.min(rows.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      const r = rows[hi];
      if (r) pick(r.kind === 'none' ? '' : r.t.id);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (q) setQ('');
      else setOpen(false);
    }
  };

  let rowIndex = q ? 0 : 1;

  return (
    <>
      <button
        ref={btnRef}
        className="select tp-btn"
        id="trackSelect"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'trackPickerList' : undefined}
        aria-label={current ? `Audio source: ${songTitle(current)}` : 'Audio source: No track, BPM clock'}
        title={current?.path || 'Pick the song the canvas follows'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tp-btn-icon">
          <PickerGlyph kind={current ? 'audio' : 'clock'} />
        </span>
        {current ? <span className="tp-current">{songTitle(current)}</span> : <span className="tp-current tp-no-track-main">⏱  No track (BPM clock)</span>}
        <span className="tp-btn-chevron">
          <PickerGlyph kind="chevron" />
        </span>
      </button>

      {open &&
        createPortal(
          <div className="tp-panel" ref={panelRef} style={pos} role="dialog" aria-label="Pick a track">
            <SearchField
              className="tp-search"
              value={q}
              onChange={setQ}
              placeholder={`Search ${tracks.length} song${tracks.length === 1 ? '' : 's'}`}
              autoFocus
              onKeyDown={onKey}
            />

            <div className="tp-list" id="trackPickerList" ref={listRef} role="listbox" aria-label="Audio sources">
              {!q && (
                <button
                  className={`tp-row tp-row-none ${hi === 0 ? 'hi' : ''} ${!trackId ? 'on' : ''}`}
                  type="button"
                  role="option"
                  aria-label="No track. Use the BPM clock"
                  aria-selected={!trackId}
                  onClick={() => pick('')}
                  onPointerEnter={() => setHi(0)}
                >
                  <span className="tp-row-icon" aria-hidden="true"><PickerGlyph kind="clock" /></span>
                  <span className="tp-name tp-no-track">⏱ No track</span>
                  <span className="tp-sub">Visuals follow a steady beat at the tempo set in Edit</span>
                  {!trackId && <span className="tp-row-check"><PickerGlyph kind="check" /></span>}
                </button>
              )}
              {shown.map((g) => {
                const isFolder = g.key !== 'added';
                const all = groups.find((x) => x.key === g.key)?.items.length || 0;
                return (
                  <div key={g.key} className="tp-group" role="group" aria-label={sourceLabel(g.key)}>
                    <div className="tp-gh" title={isFolder ? g.key : undefined}>
                      <span>{sourceLabel(g.key)}</span>
                      <small>{all}</small>
                      {isFolder && (
                        <button
                          className="tp-x"
                          type="button"
                          aria-label={`Stop listing videos and songs from ${homeShort(g.key)}`}
                          title={`Stop listing videos and songs from ${homeShort(g.key)} (the files stay where they are)`}
                          onClick={() => media.removeFolder(g.key)}
                        >
                          <PickerGlyph kind="close" />
                        </button>
                      )}
                    </div>
                    {!g.items.length && all === 0 && <div className="tp-empty">No songs in this folder</div>}
                    {g.items.map((t) => {
                      const i = rowIndex++;
                      const ext = t.name.split('.').pop()?.toUpperCase();
                      return (
                        <button
                          key={t.id}
                          className={`tp-row ${hi === i ? 'hi' : ''} ${t.id === trackId ? 'on' : ''}`}
                          type="button"
                          title={t.path}
                          role="option"
                          aria-selected={t.id === trackId}
                          onClick={() => pick(t.id)}
                          onPointerEnter={() => setHi(i)}
                        >
                          <span className="tp-name">{songTitle(t)}</span>
                          <span className="tp-meta">
                            {ext} · {timeAgo(t.mtime)}
                          </span>
                          {t.dir && <span className="tp-sub">{t.dir}</span>}
                          {t.id === trackId && <span className="tp-row-check"><PickerGlyph kind="check" /></span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {q && !total && <div className="tp-empty">No songs match "{q}"</div>}
              {total > MAX_ROWS && (
                <div className="tp-empty">
                  Showing {MAX_ROWS} of {total}. Type to narrow it down.
                </div>
              )}
            </div>

            <div className="tp-foot">
              {f.waiting && <ChooserNote />}
              {f.err && <div className="tp-err">{f.err}</div>}
              {f.typing && <FolderPathForm f={f} />}
              <div className="tp-actions">
                <button
                  className="btn sm"
                  title="Copy a song file into Downbeat (or drop it anywhere on the window)"
                  onClick={() => {
                    setOpen(false);
                    onAddSong();
                  }}
                >
                  + Add a song
                </button>
                <button className="btn sm" disabled={f.waiting} title="List the videos and songs in a folder and its subfolders" onClick={f.choose}>
                  + Add a folder
                </button>
                {suggestions.map((p) => (
                  <button key={p} className="btn sm" onClick={() => f.add(p)}>
                    + {homeShort(p)}
                  </button>
                ))}
                {f.canPick && !f.typing && (
                  <button className="link tp-typelink" onClick={() => f.setTyping(true)}>
                    Type a path
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

// The media panel re-renders on every look edit; the picker only needs to when its props or the songs change.
export const TrackPicker = React.memo(TrackPickerMenu);
