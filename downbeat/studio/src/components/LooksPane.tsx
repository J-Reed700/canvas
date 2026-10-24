import React, { useRef, useEffect } from 'react';
import { useStudioStore, type LookJob } from '../state/store.ts';
import { LOOKS } from '../engine/looks.ts';
import { screenOf, thumbSize } from '../lib/screens.ts';

export const LooksPane: React.FC = () => {
  const looksRef = useRef<HTMLDivElement>(null);

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

  const allLooks = [...saved.map((l) => ({ ...l, mine: true })), ...LOOKS];
  const target = editLook;
  const isClipEdit = target !== look;
  const clipNo = selected.indexOf(editClip || '') + 1;
  const activeId = target === look ? lookId : target?.id;

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

    allLooks.forEach((l) => {
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
  }, [allLooks.length, engine]);

  // ← and → step through the looks: keep the current one in view
  useEffect(() => {
    const cards = looksRef.current?.querySelectorAll<HTMLElement>('[data-look-id]') || [];
    const card = [...cards].find((c) => c.dataset.lookId === activeId);
    card?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  return (
    <div className="pane on" id="pane-looks" ref={looksRef}>
      <div className="look-target" id="lookTarget" hidden={!isClipEdit}>
        <span>
          Clicking a look applies it to <b>clip {clipNo}</b>
        </span>
        <button className="btn sm" onClick={() => editClipLook(null)}>
          Back to main
        </button>
      </div>

      <div className="look-actions">
        <button
          className="btn"
          id="btnVariations"
          onClick={() => useStudioStore.setState({ varOpen: true })}
        >
          Variations <span className="kbd">M</span>
        </button>
        <button className="btn" id="btnSurprise" onClick={surprise}>
          ⚄ Surprise me <span className="kbd">R</span>
        </button>
      </div>

      <div className="looks" id="looks" data-screen={screen.id}>
        {allLooks.map((l, i) => {
          const group = l.mine ? 'mine' : l.group || 'curated';
          const prev = i ? (allLooks[i - 1].mine ? 'mine' : allLooks[i - 1].group || 'curated') : null;
          const showHead = group !== prev;
          const headLabel =
            { mine: 'Your looks', curated: 'Studio looks', art: 'Album art & stills', classic: 'Classic stacks' }[group] ||
            group;

          return (
            <React.Fragment key={l.id}>
              {showHead && <div className="look-group">{headLabel}</div>}
              <div
                className={`look ${l.id === activeId ? 'on' : ''}`}
                data-look-id={l.id}
                onClick={() => applyLook(l)}
              >
                <canvas width={thumbW} height={thumbH} />
                <div className="lbl">
                  <b>{l.mine ? `★ ${l.name}` : l.name}</b>
                  <span>{l.vibe}</span>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
