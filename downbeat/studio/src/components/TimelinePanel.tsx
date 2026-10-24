import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { useStudioStore } from '../state/store.ts';
import { fmt, openPop, closePop, h, POOLS } from '../lib/utils.ts';
import { clamp } from '../engine/looks.ts';
import { RHYTHMS, VELOCITY } from '../engine/timeline.ts';
import { TRANSITIONS } from '../engine/shaders.ts';
import type { SegmentOverride } from '../engine/types.ts';

/** Merge a change into one segment's overrides: its clip, in-point, speed ramp or transition. */
function patchSegment(i: number, patch: SegmentOverride) {
  const ov = { ...useStudioStore.getState().segOverrides };
  ov[i] = { ...(ov[i] || {}), ...patch };
  useStudioStore.setState({ segOverrides: ov });
}

// The Edit tab's pools, then whatever is in none of them (Hard Cut, Shock Ripple).
const TRANS_GROUPS: [string, string[]][] = (() => {
  const groups: [string, string[]][] = ['Smooth', 'Kinetic', 'Glitch'].map((n) => [n, POOLS[n]]);
  const grouped = new Set(groups.flatMap(([, ids]) => ids));
  return [...groups, ['Other', Object.keys(TRANSITIONS).filter((k) => !grouped.has(k))]];
})();

/** The menu a double-click on a segment opens. Picks apply straight away and the menu stays open, so a
 * segment's clip, in-point, speed ramp and transition can all be set in one go. */
function segmentMenu(box: HTMLElement, si: number) {
  const render = () => {
    const s = useStudioStore.getState();
    const seg = s.ctx?.tl.segs[si];
    if (!s.ctx || !seg) return closePop();
    const pick = (patch: SegmentOverride) => {
      patchSegment(si, patch);
      s.rebuild();
      render();
    };
    const field = (label: string, aside: any, ...kids: any[]) =>
      h('div', { class: 'seg-f' }, h('div', { class: 'seg-l' }, h('span', {}, label), aside), ...kids);
    const chip = (on: boolean, text: string, onclick: () => void, title?: string) =>
      h('button', { class: on ? 'on' : '', title, onclick: () => !on && onclick() }, text);

    const b = seg.t0 / s.ctx.beatDur + 1e-6;
    const beat = Math.floor(b % 4) + 1;
    const where = `Bar ${Math.floor(b / 4) + 1}${beat > 1 ? `, beat ${beat}` : ''} · ${seg.dur.toFixed(2)} s long`;

    const name = (id: string) => {
      const c = s.clips.find((x) => x.id === id);
      return c ? (c.still ? c.name.replace(/\.still\.mp4$/, '') : c.name) : id;
    };
    const clips = h(
      'div',
      { class: 'seg-clips' },
      ...s.selected.map((id, k) =>
        h(
          'button',
          {
            class: `seg-clip${id === seg.clipId ? ' on' : ''}`,
            title: `#${k + 1} ${name(id)}`,
            style: `background-image:url(/api/thumb/${id}?w=160)`,
            onclick: () => id !== seg.clipId && pick({ clipId: id }),
          },
          h('span', {}, `#${k + 1}`),
        ),
      ),
    );

    const dur = s.clipDur.get(seg.clipId) || 10;
    const maxIn = Math.max(0, dur - seg.dur * seg.speed - 0.1);
    const inVal = h('b', { class: 'seg-val' }, `${seg.in.toFixed(2)} s`);
    const slider = h('input', {
      type: 'range',
      min: 0,
      max: maxIn.toFixed(2),
      step: 0.01,
      value: Math.min(seg.in, maxIn),
      disabled: maxIn <= 0,
      oninput: (ev: Event) => {
        const v = +(ev.target as HTMLInputElement).value;
        patchSegment(si, { in: v });
        inVal.textContent = `${v.toFixed(2)} s`;
        s.transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
        s.rebuild();
      },
    });

    box.replaceChildren(
      h(
        'div',
        { class: 'seg-head' },
        h('h4', {}, `Segment ${si + 1}`),
        h('span', { class: 'meta' }, where),
        h('button', { class: 'seg-x', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closePop }, '✕'),
      ),
      h(
        'div',
        { class: 'seg-body' },
        h(
          'div',
          { class: 'seg-col' },
          field('Clip', null, clips, h('div', { class: 'seg-name' }, name(seg.clipId))),
          field(
            'In-point',
            h('span', {}, inVal, h('small', {}, ` of ${dur.toFixed(1)} s`)),
            slider,
            maxIn <= 0 && h('div', { class: 'seg-note' }, 'This clip is only just long enough to fill the segment.'),
          ),
          field(
            'Speed ramp',
            null,
            h('div', { class: 'seg-chips' }, ...Object.entries(VELOCITY).map(([k, v]) => chip(seg.vel === k, v.name, () => pick({ vel: k }), v.desc || 'Constant clip speed'))),
          ),
        ),
        h(
          'div',
          { class: 'seg-col' },
          field(
            'Transition in',
            null,
            si === 0 && h('div', { class: 'seg-note' }, 'This cut is the loop seam, where the end of the loop joins the start.'),
            ...TRANS_GROUPS.map(([group, ids]) =>
              h(
                'div',
                { class: 'seg-group' },
                h('small', {}, group),
                h('div', { class: 'seg-chips' }, ...ids.map((k) => chip(seg.trans === k, TRANSITIONS[k].name, () => pick({ trans: k })))),
              ),
            ),
          ),
        ),
      ),
    );
  };
  render();
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

      openPop(anchor, (box) => segmentMenu(box, si), 'seg-menu');

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
