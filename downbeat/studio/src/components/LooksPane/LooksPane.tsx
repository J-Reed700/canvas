import './LooksPane.css';
import { useStudioStore, useStudioApi } from '../../state/StudioContext.tsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LookJob } from '../../state/storeTypes.ts';
import { LOOKS } from '../../engine/looks.ts';
import { LOOK_STYLES, normalizeRollStyle, ROLL_STYLES } from '../../engine/lookStyles.ts';
import type { LookStyle } from '../../engine/types.ts';
import { screenOf, thumbSize } from '../../lib/screens.ts';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';

type LookGroup = 'mine' | 'curated' | 'art' | 'classic' | Exclude<LookStyle, 'experimental'>;

type LookFilter = 'all' | LookGroup;

const GROUPS: Array<{ id: LookGroup; label: string; shortLabel: string }> = [
  { id: 'mine', label: 'Your looks', shortLabel: 'Saved' },
  { id: 'curated', label: 'Studio looks', shortLabel: 'Studio' },
  { id: 'art', label: 'Album art & stills', shortLabel: 'Album art' },
  { id: 'classic', label: 'Classic stacks', shortLabel: 'Classic' },
  ...LOOK_STYLES.filter((style) => style.id !== 'experimental').map((style) => ({
    id: style.id as Exclude<LookStyle, 'experimental'>, label: style.name, shortLabel: style.name,
  })),
];

const groupOf = (look: { mine?: boolean; group?: string }): LookGroup =>
  look.mine ? 'mine' : GROUPS.some((group) => group.id === look.group) ? look.group as LookGroup : 'curated';

export const LooksPane: React.FC = () => {
  const store = useStudioApi();

  const looksRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LookFilter>('all');

  const look = useStudioStore((s) => s.look);
  const lookId = useStudioStore((s) => s.lookId);
  const saved = useStudioStore((s) => s.saved);
  const selected = useStudioStore((s) => s.selected);
  const editClip = useStudioStore((s) => s.editClip);
  const editBlock = useStudioStore((s) => s.editBlock);
  const segmentNo = useStudioStore((s) => s.ctx?.tl.segs.find((seg) => seg.id === s.editBlock)?.i);
  const engine = useStudioStore((s) => s.engine);
  const screen = useStudioStore((s) => screenOf(s.exportOpts.format));
  const [thumbW, thumbH] = thumbSize(screen, 256);

  const applyLook = useStudioStore((s) => s.applyLook);
  const editLook = useStudioStore((s) => s.editLook());
  const editClipLook = useStudioStore((s) => s.editClipLook);
  const surprise = useStudioStore((s) => s.surprise);
  const rollStyle = useStudioStore((s) => s.rollStyle);

  const allLooks = useMemo(() => [...saved.map((l) => ({ ...l, mine: true })), ...LOOKS], [saved]);
  const target = editLook;
  const isClipEdit = !!editClip && !editBlock && target !== look;
  const clipNo = selected.indexOf(editClip || '') + 1;
  const activeId = editBlock || target !== look ? target?.id : lookId;
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

    store.setState({ lookJobs });

    return () => {
      io.disconnect();
      if (store.getState().lookJobs === lookJobs) store.setState({ lookJobs: [] });
      lookJobs.forEach((j) => engine?.dropThumb?.(j.id));
    };
  }, [filteredLooks, engine, thumbW, thumbH, store]);

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

      <label className="look-random-style">
        <span>Randomize style</span>
        <select
          aria-label="Randomize style"
          aria-describedby="random-style-hint"
          value={rollStyle}
          onChange={(event) => {
            store.setState({ rollStyle: normalizeRollStyle(event.target.value) });
            store.getState().save();
          }}
        >
          {ROLL_STYLES.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
        </select>
        <small id="random-style-hint">Applies to Remix, Surprise and per-clip rolls.</small>
      </label>

      <div className="look-actions">
        {editBlock && <span className="look-apply-note">Choose a look for segment {(segmentNo ?? 0) + 1}</span>}
        <button
          type="button"
          className="btn"
          id="btnVariations"
          onClick={() => store.setState({ varOpen: true })}
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
