import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore, type LookJob } from '../state/store.ts';
import { LOOKS } from '../engine/looks.ts';
import { screenOf, thumbSize } from '../lib/screens.ts';
import { Icon, ICONS } from './ui.tsx';

type LookGroup = 'mine' | 'curated' | 'art' | 'classic';
type LookFilter = 'all' | LookGroup;

const GROUPS: Array<{ id: LookGroup; label: string; shortLabel: string }> = [
  { id: 'mine', label: 'Your looks', shortLabel: 'Saved' },
  { id: 'curated', label: 'Studio looks', shortLabel: 'Studio' },
  { id: 'art', label: 'Album art & stills', shortLabel: 'Album art' },
  { id: 'classic', label: 'Classic stacks', shortLabel: 'Classic' },
];

const groupOf = (look: { mine?: boolean; group?: string }): LookGroup =>
  look.mine ? 'mine' : look.group === 'art' || look.group === 'classic' ? look.group : 'curated';

export const LooksPane: React.FC = () => {
  const looksRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LookFilter>('all');

  const look = useStudioStore((s) => s.look);
  const lookId = useStudioStore((s) => s.lookId);
  const saved = useStudioStore((s) => s.saved);
  const selected = useStudioStore((s) => s.selected);
  const editClip = useStudioStore((s) => s.editClip);
  const engine = useStudioStore((s) => s.engine);
  const screen = useStudioStore((s) => screenOf(s.exportOpts.format));
  const [thumbW, thumbH] = thumbSize(screen, 256);

  const applyLook = useStudioStore((s) => s.applyLook);
  const editLook = useStudioStore((s) => s.editLook());
  const editClipLook = useStudioStore((s) => s.editClipLook);
  const surprise = useStudioStore((s) => s.surprise);

  const allLooks = useMemo(() => [...saved.map((l) => ({ ...l, mine: true })), ...LOOKS], [saved]);
  const target = editLook;
  const isClipEdit = target !== look;
  const clipNo = selected.indexOf(editClip || '') + 1;
  const activeId = target === look ? lookId : target?.id;
  const groupCounts = useMemo(
    () => Object.fromEntries(GROUPS.map(({ id }) => [id, allLooks.filter((l) => groupOf(l) === id).length])) as Record<LookGroup, number>,
    [allLooks],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredLooks = useMemo(
    () => allLooks.filter((l) => {
      if (filter !== 'all' && groupOf(l) !== filter) return false;
      if (!normalizedQuery) return true;
      const group = GROUPS.find(({ id }) => id === groupOf(l));
      return `${l.name} ${l.vibe} ${group?.label || ''}`.toLocaleLowerCase().includes(normalizedQuery);
    }),
    [allLooks, filter, normalizedQuery],
  );
  const filteredIds = filteredLooks.map((l) => l.id).join('|');

  useEffect(() => {
    const pane = looksRef.current;
    if (!pane || typeof IntersectionObserver === 'undefined') return;

    const lookJobs: LookJob[] = [];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const j = lookJobs.find((x) => x.card === e.target);
          if (j) j.visible = e.isIntersecting;
        }
      },
      { root: pane },
    );

    filteredLooks.forEach((l) => {
      const card = pane.querySelector(`[data-look-id="${l.id}"]`) as HTMLElement | null;
      const cv = card?.querySelector('canvas') as HTMLCanvasElement | null;
      if (card && cv) {
        const job: LookJob = {
          id: `look:${l.id}`,
          look: l,
          card,
          ctx2d: cv.getContext('2d'),
          visible: false,
        };
        lookJobs.push(job);
        io.observe(card);
      }
    });

    useStudioStore.setState({ lookJobs });

    return () => {
      io.disconnect();
      lookJobs.forEach((j) => engine?.dropThumb?.(j.id));
    };
  }, [filteredIds, engine, thumbW, thumbH]);

  // ← and → step through the looks: keep the current one in view
  useEffect(() => {
    const cards = looksRef.current?.querySelectorAll<HTMLElement>('[data-look-id]') || [];
    const card = [...cards].find((c) => c.dataset.lookId === activeId);
    card?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [activeId, filteredIds]);

  const resetFilters = () => {
    setQuery('');
    setFilter('all');
  };

  return (
    <div
      className="pane on looks-pane"
      id="pane-looks"
      ref={looksRef}
      role="tabpanel"
      aria-labelledby="inspector-tab-looks"
    >
      <div className="look-target" id="lookTarget" hidden={!isClipEdit}>
        <span className="look-target-copy">
          <small>Applying to</small>
          <b>Clip {clipNo} · {target?.name}</b>
          <span className="look-target-legacy">Clicking a look applies it to clip {clipNo}</span>
        </span>
        <button type="button" className="btn sm" onClick={() => editClipLook(null)}>
          Back to main
        </button>
      </div>

      <div className="looks-toolbar">
        <label className="look-search">
          <Icon d={ICONS.search} />
          <span className="sr-only">Search looks</span>
          <input
            type="search"
            value={query}
            placeholder="Search looks"
            aria-label="Search looks"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear look search" onClick={() => setQuery('')}>
              Clear
            </button>
          )}
        </label>

        <div className="look-filters" role="group" aria-label="Filter looks by collection">
          <button
            type="button"
            className={filter === 'all' ? 'on' : ''}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All <span>{allLooks.length}</span>
          </button>
          {GROUPS.filter(({ id }) => groupCounts[id] > 0).map(({ id, shortLabel }) => (
            <button
              type="button"
              key={id}
              className={filter === id ? 'on' : ''}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {shortLabel} <span>{groupCounts[id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="look-actions">
        <button
          type="button"
          className="btn"
          id="btnVariations"
          onClick={() => useStudioStore.setState({ varOpen: true })}
        >
          Variations <span className="kbd">M</span>
        </button>
        <button type="button" className="btn" id="btnSurprise" onClick={surprise}>
          Surprise me <span className="kbd">R</span>
        </button>
      </div>

      <div
        className="looks"
        id="looks"
        data-screen={screen.id}
        aria-live="polite"
        aria-label={`${filteredLooks.length} ${filteredLooks.length === 1 ? 'look' : 'looks'}`}
      >
        {filteredLooks.map((l, i) => {
          const group = groupOf(l);
          const prev = i ? groupOf(filteredLooks[i - 1]) : null;
          const showHead = group !== prev;
          const headLabel = GROUPS.find(({ id }) => id === group)?.label || group;
          const groupCount = filteredLooks.filter((candidate) => groupOf(candidate) === group).length;
          const isActive = l.id === activeId;

          return (
            <React.Fragment key={l.id}>
              {showHead && (
                <div className="look-group" role="heading" aria-level={3} data-count={groupCount}>
                  {headLabel}
                </div>
              )}
              <button
                type="button"
                className={`look ${isActive ? 'on' : ''}`}
                data-look-id={l.id}
                aria-pressed={isActive}
                title={l.vibe}
                onClick={() => applyLook(l)}
              >
                <span className="look-visual">
                  <canvas width={thumbW} height={thumbH} />
                  {isActive && <span className="look-active">Active</span>}
                </span>
                <div className="lbl">
                  <b>{l.mine ? `★ ${l.name}` : l.name}</b>
                  <span className="look-vibe">{l.vibe}</span>
                  <span className="look-meta">
                    <span>{l.layers.length} {l.layers.length === 1 ? 'effect' : 'effects'}</span>
                    <span>{l.mine ? 'Saved' : headLabel.replace(' looks', '')}</span>
                  </span>
                </div>
              </button>
            </React.Fragment>
          );
        })}

        {!filteredLooks.length && (
          <div className="looks-empty">
            <b>No matching looks</b>
            <span>Try another name, vibe, or collection.</span>
            <button type="button" className="btn sm" onClick={resetFilters}>Show all looks</button>
          </div>
        )}
      </div>
    </div>
  );
};
