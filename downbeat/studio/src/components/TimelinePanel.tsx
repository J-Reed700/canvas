import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { useStudioStore } from '../store.ts';
import { fmt, openPop, closePop, h } from '../utils.ts';
import { clamp } from '../../looks.ts';
import { RHYTHMS, VELOCITY } from '../../timeline.ts';
import { TRANSITIONS } from '../../shaders.ts';
import type { SegmentOverride } from '../../types.ts';

/** Merge a change into one segment's overrides: its clip, in-point, speed ramp or transition. */
function patchSegment(i: number, patch: SegmentOverride) {
  const ov = { ...useStudioStore.getState().segOverrides };
  ov[i] = { ...(ov[i] || {}), ...patch };
  useStudioStore.setState({ segOverrides: ov });
}

export const TimelinePanel: React.FC = () => {
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const laneRef = useRef<HTMLCanvasElement>(null);
  const laneWrapRef = useRef<HTMLDivElement>(null);

  const features = useStudioStore((s) => s.features);
  const loopStart = useStudioStore((s) => s.loopStart);
  const customCuts = useStudioStore((s) => s.customCuts);
  const look = useStudioStore((s) => s.look);
  const selected = useStudioStore((s) => s.selected);
  const ctx = useStudioStore((s) => s.ctx);
  const rebuild = useStudioStore((s) => s.rebuild);
  const save = useStudioStore((s) => s.save);
  const drawTimeline = useStudioStore((s) => s.drawTimeline);
  const transport = useStudioStore((s) => s.transport);
  const clipDur = useStudioStore((s) => s.clipDur);

  const dragRef = useRef<any>(null);
  const slipRef = useRef<any>(null);
  const overviewDragRef = useRef<any>(null);

  const laneTime = (e: MouseEvent | PointerEvent): number => {
    const lane = laneRef.current;
    if (!lane) return 0;
    const r = lane.getBoundingClientRect();
    const currentCtx = useStudioStore.getState().ctx;
    return clamp((e.clientX - r.left) / r.width, 0, 0.9999) * (currentCtx?.L || 1);
  };

  const nearestCut = (e: MouseEvent | PointerEvent): number => {
    const currentCtx = useStudioStore.getState().ctx;
    if (!currentCtx || !laneRef.current) return -1;
    const r = laneRef.current.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = -1;
    let bd = 7;
    currentCtx.tl.segs.forEach((s, i) => {
      if (i === 0) return;
      const d = Math.abs((s.t0 / currentCtx.L) * r.width - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const segAt = (t: number): number => {
    const currentCtx = useStudioStore.getState().ctx;
    if (!currentCtx) return -1;
    return currentCtx.tl.segs.findIndex((s) => t >= s.t0 && t < s.t1);
  };

  const editClip = useStudioStore((s) => s.editClip);
  const clipLooks = useStudioStore((s) => s.clipLooks);

  // Layout effect, so a drag that rebuilds the edit shows the new timeline in the same frame.
  useLayoutEffect(() => {
    drawTimeline();
  }, [drawTimeline, ctx, features, loopStart, editClip, clipLooks, selected]);

  useEffect(() => {
    const lw = laneWrapRef.current;
    if (!lw || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      drawTimeline();
    });
    ro.observe(lw);
    return () => ro.disconnect();
  }, [drawTimeline]);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;

    const onPointerMove = (e: PointerEvent) => {
      const currentCtx = useStudioStore.getState().ctx;
      if (!currentCtx) return;

      if (slipRef.current) {
        const slip = slipRef.current;
        const seg = currentCtx.tl.segs[slip.i];
        const dur = clipDur.get(seg.clipId) || 10;
        const v = clamp(slip.in0 - (laneTime(e) - slip.t0) * seg.speed, 0, Math.max(0, dur - seg.dur * seg.speed - 0.1));
        patchSegment(slip.i, { in: v });
        rebuild();
        return;
      }

      if (dragRef.current) {
        const drag = dragRef.current;
        const bd = currentCtx.beatDur;
        const cuts = useStudioStore.getState().customCuts;
        if (!cuts) return;
        const lo = (drag.i > 1 ? cuts[drag.i - 2] : 0) + bd;
        const hi = (drag.i < cuts.length ? cuts[drag.i] : currentCtx.L) - bd;
        const snapped = clamp(Math.round(laneTime(e) / bd) * bd, lo, hi);
        if (snapped !== cuts[drag.i - 1]) {
          cuts[drag.i - 1] = snapped;
          drag.moved = true;
          useStudioStore.setState({ customCuts: [...cuts] });
          rebuild();
        }
        return;
      }

      lane.style.cursor = e.altKey ? 'grab' : nearestCut(e) > 0 ? 'ew-resize' : 'pointer';
    };

    const onPointerDown = (e: PointerEvent) => {
      const currentCtx = useStudioStore.getState().ctx;
      if (!currentCtx) return;

      if (e.altKey) {
        const si = segAt(laneTime(e));
        if (si < 0) return;
        slipRef.current = { i: si, t0: laneTime(e), in0: currentCtx.tl.segs[si].in };
        lane.setPointerCapture(e.pointerId);
        lane.style.cursor = 'grabbing';
        return;
      }

      const cutIdx = nearestCut(e);
      if (cutIdx > 0) {
        const cuts = currentCtx.tl.segs.slice(1).map((s) => s.t0);
        useStudioStore.setState({ customCuts: cuts });
        dragRef.current = { i: cutIdx, moved: false };
        lane.setPointerCapture(e.pointerId);
        return;
      }

      transport.seek(laneTime(e));
    };

    const onPointerUp = () => {
      if (slipRef.current) {
        slipRef.current = null;
        lane.style.cursor = '';
        save();
      }
      if (dragRef.current) {
        dragRef.current = null;
        save();
      }
    };

    const onDblClick = (e: MouseEvent) => {
      const currentCtx = useStudioStore.getState().ctx;
      if (!currentCtx) return;
      const si = segAt(laneTime(e));
      if (si < 0) return;

      const anchor = document.createElement('div');
      anchor.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:1px;height:1px`;
      document.body.append(anchor);

      openPop(anchor, (box) => {
        const seg = currentCtx.tl.segs[si];
        box.append(h('div', { class: 'ph' }, `Segment ${si + 1} · clip`));

        const stateSelected = useStudioStore.getState().selected;
        const stateClips = useStudioStore.getState().clips;

        stateSelected.forEach((cid, k) => {
          const c = stateClips.find((x) => x.id === cid);
          box.append(
            h(
              'button',
              {
                class: `pi ${seg.clipId === cid ? 'on' : ''}`,
                onclick: () => {
                  patchSegment(si, { clipId: cid });
                  rebuild();
                  closePop();
                },
              },
              h('span', { class: 'sd', style: '--c:#C8FF4D' }),
              `#${k + 1} ${c?.name || cid}`,
            ),
          );
        });

        const dur = clipDur.get(seg.clipId) || 10;
        const maxIn = Math.max(0, dur - seg.dur * seg.speed - 0.1);
        const inLabel = h('span', { class: 'muted' }, `${seg.in.toFixed(2)} s`);

        box.append(
          h('div', { class: 'ph' }, 'In-point · which moment of the clip plays'),
          h(
            'div',
            { class: 'row', style: 'padding:2px 10px 6px;gap:8px' },
            h('input', {
              type: 'range',
              min: 0,
              max: maxIn.toFixed(2),
              step: 0.01,
              value: Math.min(seg.in, maxIn),
              style: 'flex:1;accent-color:var(--accent)',
              oninput: (ev: Event) => {
                const val = +(ev.target as HTMLInputElement).value;
                patchSegment(si, { in: val });
                inLabel.textContent = `${val.toFixed(2)} s`;
                transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
                rebuild();
              },
            }),
            inLabel,
          ),
          h('div', { class: 'ph' }, 'Speed ramp for this segment'),
          h(
            'div',
            { class: 'tgrid', style: 'padding:4px 6px 6px' },
            ...Object.entries(VELOCITY).map(([k, v]) =>
              h(
                'button',
                {
                  class: seg.vel === k ? 'on' : '',
                  title: v.desc || 'Constant clip speed',
                  onclick: () => {
                    patchSegment(si, { vel: k });
                    rebuild();
                    closePop();
                  },
                },
                v.name,
              ),
            ),
          ),
          h('div', { class: 'ph' }, si === 0 ? 'Transition into this segment (loop seam)' : 'Transition into this segment'),
          h(
            'div',
            { class: 'tgrid', style: 'padding:4px 6px 6px' },
            ...Object.entries(TRANSITIONS).map(([k, t]) =>
              h(
                'button',
                {
                  class: seg.trans === k ? 'on' : '',
                  onclick: () => {
                    patchSegment(si, { trans: k });
                    rebuild();
                    closePop();
                  },
                },
                t.name,
              ),
            ),
          ),
        );
      });

      anchor.remove();
    };

    lane.addEventListener('pointermove', onPointerMove);
    lane.addEventListener('pointerdown', onPointerDown);
    lane.addEventListener('pointerup', onPointerUp);
    lane.addEventListener('pointercancel', onPointerUp);
    lane.addEventListener('dblclick', onDblClick);

    return () => {
      lane.removeEventListener('pointermove', onPointerMove);
      lane.removeEventListener('pointerdown', onPointerDown);
      lane.removeEventListener('pointerup', onPointerUp);
      lane.removeEventListener('pointercancel', onPointerUp);
      lane.removeEventListener('dblclick', onDblClick);
    };
  }, [clipDur, rebuild, save, transport]);

  useEffect(() => {
    const ov = overviewRef.current;
    if (!ov) return;

    const snapDown = (t: number) => {
      const s = useStudioStore.getState();
      const f = s.features;
      const L = s.ctx?.L ?? s.loopLen();
      let best = f?.downbeats?.[0] ?? 0;
      for (const d of f?.downbeats || []) {
        if (d + L > (f?.duration || 60)) break;
        if (Math.abs(d - t) < Math.abs(best - t)) best = d;
      }
      return best;
    };

    const onPointerDown = (e: PointerEvent) => {
      const s = useStudioStore.getState();
      if (!s.features) return;
      const r = ov.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * s.features.duration!;
      const L = s.ctx?.L ?? s.loopLen();
      const start = t >= s.loopStart && t <= s.loopStart + L ? s.loopStart : snapDown(t - L / 2);
      overviewDragRef.current = { x: e.clientX, start, w: r.width };
      ov.setPointerCapture(e.pointerId);
      ov.style.cursor = 'grabbing';
      if (start !== s.loopStart) {
        useStudioStore.setState({ loopStart: start, customCuts: null });
        rebuild();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const od = overviewDragRef.current;
      const s = useStudioStore.getState();
      if (!od || !s.features) return;
      const t = od.start + ((e.clientX - od.x) / od.w) * s.features.duration!;
      const nextStart = snapDown(t);
      if (nextStart !== s.loopStart) {
        useStudioStore.setState({ loopStart: nextStart, customCuts: null });
        rebuild();
      }
    };

    const onPointerUp = () => {
      overviewDragRef.current = null;
      ov.style.cursor = '';
    };

    ov.addEventListener('pointerdown', onPointerDown);
    ov.addEventListener('pointermove', onPointerMove);
    ov.addEventListener('pointerup', onPointerUp);
    ov.addEventListener('pointercancel', onPointerUp);

    return () => {
      ov.removeEventListener('pointerdown', onPointerDown);
      ov.removeEventListener('pointermove', onPointerMove);
      ov.removeEventListener('pointerup', onPointerUp);
      ov.removeEventListener('pointercancel', onPointerUp);
    };
  }, [rebuild]);

  const curRhythm = customCuts ? 'custom' : look?.cut?.rhythm || 'bar';

  return (
    <section className="panel timeline">
      <div className="tl-head">
        <div className="loopchips" id="loopChips">
          {features?.loops?.map((l) => (
            <button
              key={l.start}
              className={Math.abs(l.start - loopStart) < 0.05 ? 'on' : ''}
              title={`Starts at ${fmt(l.start)}`}
              onClick={() => {
                useStudioStore.setState({ loopStart: l.start, customCuts: null });
                rebuild();
              }}
            >
              {l.label}
            </button>
          ))}
        </div>

        <div className="info" id="tlInfo">
          {ctx ? (
            <>
              <b>{ctx.tl.segs.length}</b> cuts
              {features ? (
                <>
                  {' '}
                  · from <b>{fmt(loopStart)}</b>
                </>
              ) : (
                ''
              )}
              {editClip && clipLooks[editClip] && selected.includes(editClip) && (
                <span className="muted"> · highlighted: #{selected.indexOf(editClip) + 1}, whose own FX you're editing</span>
              )}
            </>
          ) : (
            <span className="muted">Select clips to build the edit</span>
          )}
        </div>

        <div className="spacer" />

        <div className="seg" id="rhythmSeg">
          {Object.entries(RHYTHMS).map(([k, r]) => (
            <button
              key={k}
              className={k === curRhythm ? 'on' : ''}
              title={r.name}
              onClick={() => {
                if (!look) return;
                look.cut.rhythm = k;
                useStudioStore.setState({ customCuts: null, segOverrides: {} });
                rebuild();
              }}
            >
              {r.short}
            </button>
          ))}
          {customCuts && (
            <button className="on" title="You dragged the cuts">
              Custom
            </button>
          )}
        </div>
      </div>

      <div className="tl-canvas" id="overviewWrap">
        <canvas id="overview" ref={overviewRef} />
      </div>

      <div className="tl-canvas" id="laneWrap" ref={laneWrapRef}>
        <canvas
          id="lane"
          ref={laneRef}
          title={'The loop, left to right. Each block is one cut: #n is clip n from the Clips list (thumbnail = the moment it starts on).\nDiamonds are transitions (pink = animated, white = hard cut). Curves: kick (red), hats (blue), energy (green).\nClick: seek · drag a cut line: move it · double-click a block: clip, in-point, speed ramp, transition · ⌥-drag: slip the clip'}
        />
        <div className="playhead" id="playhead" />
      </div>
    </section>
  );
};
