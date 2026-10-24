import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStudioStore } from '../state/store.ts';
import { fetchJSON, postJSON, songTitle, sourceLabel, toast } from '../lib/utils.ts';
import { timeAgo } from '../lib/exportsView.ts';
import type { TrackMeta } from '../engine/types.ts';
import { SearchField } from './ui.tsx';

interface LibraryInfo {
  ok?: boolean;
  error?: string;
  tracks: TrackMeta[];
  folders: string[];
  suggestions: string[];
  can_pick: boolean;
  picked?: string | null;
}

type Row = { kind: 'none' } | { kind: 'track'; t: TrackMeta };

// Enough to scroll through comfortably; search narrows the rest.
const MAX_ROWS = 250;

const homeShort = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');



const TrackPickerMenu: React.FC<{ onAddSong: () => void }> = ({ onAddSong }) => {
  const trackId = useStudioStore((s) => s.trackId);
  const tracks = useStudioStore((s) => s.tracks);
  const selectTrack = useStudioStore((s) => s.selectTrack);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [lib, setLib] = useState<LibraryInfo | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [typing, setTyping] = useState(false);
  const [pathText, setPathText] = useState('');
  const [err, setErr] = useState('');
  const [pos, setPos] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = tracks.find((t) => t.id === trackId);

  const apply = (r: LibraryInfo) => {
    useStudioStore.setState({ tracks: r.tracks });
    setLib(r);
  };

  // Rescan every time the picker opens, so songs saved since the last look show up.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setErr('');
    setTyping(false);
    fetchJSON<LibraryInfo>('/api/tracks').then(apply).catch(() => {});
  }, [open]);

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
    const order = ['added', 'downloads', ...(lib?.folders || [])];
    for (const t of tracks) if (t.source && !order.includes(t.source)) order.push(t.source);
    return order
      .map((key) => ({ key, items: tracks.filter((t) => (t.source || 'downloads') === key && match(t)) }))
      .filter((g) => g.items.length || (lib?.folders || []).includes(g.key));
  }, [open, tracks, q, lib]);

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

  const folderAction = async (body: { add?: string; remove?: string }) => {
    setErr('');
    const r = await postJSON<LibraryInfo>('/api/library/folders', body);
    if (r.ok === false) {
      setErr(r.error || 'That folder could not be added');
      return;
    }
    apply(r);
    setTyping(false);
    setPathText('');
    if (body.add) toast(`Added ${homeShort(body.add)}. Its songs are in the list`);
  };

  const chooseFolder = async () => {
    if (!lib?.can_pick) {
      setTyping(true);
      return;
    }
    setWaiting(true);
    setErr('');
    const r = await postJSON<LibraryInfo>('/api/library/pick_folder', {});
    setWaiting(false);
    if (r.ok === false) {
      setTyping(true);
      setErr(r.error || 'The folder chooser did not open. Type the path instead.');
      return;
    }
    apply(r);
    if (r.picked) toast(`Added ${homeShort(r.picked)}. Its songs are in the list`);
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
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.path || 'Pick the song the canvas follows'}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? songTitle(current) : '⏱  No track (BPM clock)'}
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

            <div className="tp-list" ref={listRef} role="listbox">
              {!q && (
                <button className={`tp-row ${hi === 0 ? 'hi' : ''} ${!trackId ? 'on' : ''}`} onClick={() => pick('')} onPointerEnter={() => setHi(0)}>
                  <span className="tp-name">⏱ No track</span>
                  <span className="tp-sub">Visuals follow a steady beat at the tempo set in Edit</span>
                </button>
              )}
              {shown.map((g) => {
                const isFolder = g.key !== 'added' && g.key !== 'downloads';
                const all = groups.find((x) => x.key === g.key)?.items.length || 0;
                return (
                  <div key={g.key} className="tp-group">
                    <div className="tp-gh" title={isFolder ? g.key : undefined}>
                      <span>{sourceLabel(g.key)}</span>
                      <small>{all}</small>
                      {isFolder && (
                        <button className="tp-x" title={`Stop listing songs from ${homeShort(g.key)} (the files stay where they are)`} onClick={() => folderAction({ remove: g.key })}>
                          ✕
                        </button>
                      )}
                    </div>
                    {!g.items.length && all === 0 && <div className="tp-empty">No songs in this folder yet</div>}
                    {g.items.map((t) => {
                      const i = rowIndex++;
                      const ext = t.name.split('.').pop()?.toUpperCase();
                      return (
                        <button
                          key={t.id}
                          className={`tp-row ${hi === i ? 'hi' : ''} ${t.id === trackId ? 'on' : ''}`}
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
              {waiting && <div className="note">A folder chooser opened. If you don't see it, look behind the browser window.</div>}
              {err && <div className="tp-err">{err}</div>}
              {typing && (
                <form
                  className="tp-path"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (pathText.trim()) folderAction({ add: pathText.trim() });
                  }}
                >
                  <input className="numin" autoFocus placeholder="~/Music" value={pathText} onChange={(e) => setPathText(e.target.value)} />
                  <button className="btn sm" type="submit">
                    Add folder
                  </button>
                </form>
              )}
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
                <button className="btn sm" disabled={waiting} title="List every song in a folder and its subfolders" onClick={chooseFolder}>
                  + Add a music folder
                </button>
                {lib?.suggestions.map((p) => (
                  <button key={p} className="btn sm" onClick={() => folderAction({ add: p })}>
                    + {homeShort(p)}
                  </button>
                ))}
                {lib?.can_pick && !typing && (
                  <button className="link tp-typelink" onClick={() => setTyping(true)}>
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
