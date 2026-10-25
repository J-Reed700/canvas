import './TimelinePanel.css';
import { useStudioStore, useStudioApi, useStudioRuntime, useSegmentMenu } from '../../state/StudioContext.tsx';
import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { fmt, openPop } from '../../lib/utils.ts';
import { clamp } from '../../engine/looks.ts';
import { RHYTHMS } from '../../engine/timeline.ts';
import { SNAPS, snapBeat } from '../../engine/blocks.ts';
import type { Segment } from '../../engine/types.ts';

// How close, in CSS pixels, a press has to land to a cut line or a transition's edge to grab it.
const grabPx = (e: PointerEvent | MouseEvent, mouse: number, touch: number) => ((e as PointerEvent).pointerType === 'touch' ? touch : mouse);

const LONG_PRESS = 450;

type ToolIconName = 'edit' | 'split' | 'repeat' | 'insert' | 'delete';

const ToolIcon: React.FC<{ name: ToolIconName }> = ({ name }) => {
  const paths: Record<ToolIconName, React.ReactNode> = {
    edit: <><path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    split: <><path d="M12 3v3m0 3v3m0 3v3m0 3v0" /><path d="M9 7H5v4M15 17h4v-4" /></>,
    repeat: <><path d="M7 7h9a4 4 0 0 1 4 4v1" /><path d="m17 9 3 3 3-3" /><path d="M17 17H8a4 4 0 0 1-4-4v-1" /><path d="m7 15-3-3-3 3" /></>,
    insert: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M12 8v8M8 12h8" /></>,
    delete: <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" /><path d="M10 10v7M14 10v7" /></>,
  };
  return <svg className="tl-tool-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
};

export const TimelinePanel: React.FC = () => {
  const store = useStudioApi();
  const { blocks } = useStudioRuntime();
  const menus = useSegmentMenu();

  const overviewRef = useRef<HTMLCanvasElement>(null);
  const laneRef = useRef<HTMLCanvasElement>(null);
  const laneWrapRef = useRef<HTMLDivElement>(null);

  const features = useStudioStore((s) => s.features);
  const loopStart = useStudioStore((s) => s.loopStart);
  const look = useStudioStore((s) => s.look);
  const selected = useStudioStore((s) => s.selected);
  const ctx = useStudioStore((s) => s.ctx);
  const snap = useStudioStore((s) => s.snap);
  const selectedBlock = useStudioStore((s) => s.selectedBlock);
  const rebuild = useStudioStore((s) => s.rebuild);
  const save = useStudioStore((s) => s.save);
  const drawTimeline = useStudioStore((s) => s.drawTimeline);
  const transport = useStudioStore((s) => s.transport);
  const clipDur = useStudioStore((s) => s.clipDur);

  const dragRef = useRef<{ id: string } | null>(null);
  const lenRef = useRef<{ id: string } | null>(null);
  const slipRef = useRef<{ id: string; t0: number; in0: number } | null>(null);
  const pressRef = useRef<{ x: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const overviewDragRef = useRef<{ x: number; start: number; w: number } | null>(null);

  const editClip = useStudioStore((s) => s.editClip);
  const clipLooks = useStudioStore((s) => s.clipLooks);

  // Layout effect, so a drag that rebuilds the edit shows the new timeline in the same frame.
  useLayoutEffect(() => {
    drawTimeline();
  }, [drawTimeline, ctx, features, loopStart, editClip, clipLooks, selected, selectedBlock]);

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
    const laneTime = (e: MouseEvent | PointerEvent): number => {
      const lane = laneRef.current;
      if (!lane) return 0;
      const r = lane.getBoundingClientRect();
      const currentCtx = store.getState().ctx;
      return clamp((e.clientX - r.left) / r.width, 0, 0.9999) * (currentCtx?.L || 1);
    };
    const lanePx = (e: MouseEvent | PointerEvent) => {
      const r = laneRef.current!.getBoundingClientRect();
      return { px: e.clientX - r.left, w: r.width };
    };

    // the cut line under the pointer; the loop seam has none to grab
    const nearestCut = (e: MouseEvent | PointerEvent): Segment | null => {
      const currentCtx = store.getState().ctx;
      if (!currentCtx || !laneRef.current) return null;
      const { px, w } = lanePx(e);
      let best: Segment | null = null;
      let bd = grabPx(e, 7, 14);
      for (const s of currentCtx.tl.segs) {
        const d = Math.abs((s.t0 / currentCtx.L) * w - px);
        if (s.i > 0 && d < bd) {
          bd = d;
          best = s;
        }
      }
      return best;
    };

    // the edge of a transition's window under the pointer, for dragging its length
    const bandEdge = (e: MouseEvent | PointerEvent): Segment | null => {
      const currentCtx = store.getState().ctx;
      if (!currentCtx || !laneRef.current) return null;
      const { px, w } = lanePx(e);
      const L = currentCtx.L;
      const reach = grabPx(e, 4, 10);
      for (const s of currentCtx.tl.segs) {
        if (s.transDur <= 0) continue;
        for (const edge of [s.t0 - s.transDur / 2, s.t0 + s.transDur / 2]) {
          const x = ((((edge % L) + L) % L) / L) * w;
          if (Math.abs(x - px) < reach) return s;
        }
      }
      return null;
    };

    const segAtTime = (t: number): Segment | undefined => store.getState().ctx?.tl.segs.find((s) => t >= s.t0 && t < s.t1);

    const openMenu = (e: MouseEvent | PointerEvent) => {
      const seg = segAtTime(laneTime(e));
      if (seg) menus.openSegmentMenu(seg.id, { x: e.clientX, y: e.clientY });
    };


    const cancelPress = () => {
      if (pressRef.current) clearTimeout(pressRef.current.timer);
      pressRef.current = null;
    };

    const onPointerMove = (e: PointerEvent) => {
      const s = store.getState();
      const currentCtx = s.ctx;
      if (!currentCtx) return;
      if (pressRef.current && Math.abs(e.clientX - pressRef.current.x) > 6) cancelPress();

      if (slipRef.current) {
        const slip = slipRef.current;
        const seg = currentCtx.tl.segs.find((x) => x.id === slip.id);
        if (!seg) return;
        const dur = clipDur.get(seg.clipId) || 10;
        s.setBlock(slip.id, { in: clamp(slip.in0 - (laneTime(e) - slip.t0) * seg.speed, 0, Math.max(0, dur - seg.dur * seg.speed - 0.1)) });
        return;
      }
      if (dragRef.current) {
        s.trimCut(dragRef.current.id, laneTime(e) / currentCtx.beatDur, e.shiftKey ? 0 : s.snap);
        return;
      }
      if (lenRef.current) {
        const seg = currentCtx.tl.segs.find((x) => x.id === lenRef.current!.id);
        if (!seg) return;
        let d = Math.abs(laneTime(e) - seg.t0);
        if (d > currentCtx.L / 2) d = currentCtx.L - d; // the seam's window wraps round the loop
        const beats = clamp(snapBeat((2 * d) / currentCtx.beatDur, e.shiftKey ? 0 : 4), 0.125, 8);
        if (Math.abs(beats - (s.blocks?.find((b) => b.id === seg.id)?.transBeats ?? -1)) > 1e-9) s.setBlock(seg.id, { transBeats: beats });
        return;
      }
      lane.style.cursor = e.altKey ? 'grab' : nearestCut(e) ? 'ew-resize' : bandEdge(e) ? 'col-resize' : 'pointer';
    };

    const onPointerDown = (e: PointerEvent) => {
      const s = store.getState();
      const currentCtx = s.ctx;
      if (!currentCtx || e.button === 2) return; // a right-click opens the menu, on contextmenu

      if (e.altKey) {
        const seg = segAtTime(laneTime(e));
        if (!seg) return;
        slipRef.current = { id: seg.id, t0: laneTime(e), in0: seg.in };
        lane.setPointerCapture(e.pointerId);
        lane.style.cursor = 'grabbing';
        return;
      }
      const cut = nearestCut(e);
      if (cut) {
        dragRef.current = { id: cut.id };
        lane.setPointerCapture(e.pointerId);
        return;
      }
      const edge = bandEdge(e);
      if (edge) {
        lenRef.current = { id: edge.id };
        lane.setPointerCapture(e.pointerId);
        return;
      }

      const seg = segAtTime(laneTime(e));
      if (seg) s.selectBlock(seg.id);
      transport.seek(laneTime(e));
      // a long press opens the segment menu where there's no double-click
      if (e.pointerType !== 'mouse') {
        cancelPress();
        pressRef.current = { x: e.clientX, timer: setTimeout(() => { pressRef.current = null; openMenu(e); }, LONG_PRESS) };
      }
    };

    const onPointerUp = () => {
      cancelPress();
      if (slipRef.current) {
        slipRef.current = null;
        lane.style.cursor = '';
        save();
      }
      if (dragRef.current || lenRef.current) {
        dragRef.current = lenRef.current = null;
        save();
      }
    };

    const onDblClick = (e: MouseEvent) => {
      if (store.getState().ctx) openMenu(e);
    };
    const onContextMenu = (e: MouseEvent) => {
      if (!store.getState().ctx) return;
      e.preventDefault();
      transport.seek(laneTime(e));
      openMenu(e);
    };

    lane.addEventListener('pointermove', onPointerMove);
    lane.addEventListener('pointerdown', onPointerDown);
    lane.addEventListener('pointerup', onPointerUp);
    lane.addEventListener('pointercancel', onPointerUp);
    lane.addEventListener('dblclick', onDblClick);
    lane.addEventListener('contextmenu', onContextMenu);

    return () => {
      cancelPress();
      lane.removeEventListener('pointermove', onPointerMove);
      lane.removeEventListener('pointerdown', onPointerDown);
      lane.removeEventListener('pointerup', onPointerUp);
      lane.removeEventListener('pointercancel', onPointerUp);
      lane.removeEventListener('dblclick', onDblClick);
      lane.removeEventListener('contextmenu', onContextMenu);
    };
  }, [clipDur, save, transport, store, menus]);

  useEffect(() => {
    const ov = overviewRef.current;
    if (!ov) return;

    const snapDown = (t: number) => {
      const s = store.getState();
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
      const s = store.getState();
      if (!s.features) return;
      const r = ov.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * s.features.duration!;
      const L = s.ctx?.L ?? s.loopLen();
      const start = t >= s.loopStart && t <= s.loopStart + L ? s.loopStart : snapDown(t - L / 2);
      overviewDragRef.current = { x: e.clientX, start, w: r.width };
      ov.setPointerCapture(e.pointerId);
      ov.style.cursor = 'grabbing';
      if (start !== s.loopStart) {
        store.setState({ loopStart: start, blocks: null });
        rebuild();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const od = overviewDragRef.current;
      const s = store.getState();
      if (!od || !s.features) return;
      const t = od.start + ((e.clientX - od.x) / od.w) * s.features.duration!;
      const nextStart = snapDown(t);
      if (nextStart !== s.loopStart) {
        store.setState({ loopStart: nextStart, blocks: null });
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
  }, [rebuild, store]);

  const handCut = !!ctx?.tl.handCut;
  const curRhythm = handCut ? 'custom' : look?.cut?.rhythm || 'bar';
  const selSeg = ctx && selectedBlock ? ctx.tl.segs.find((x) => x.id === selectedBlock) : undefined;
  const selNo = selSeg ? selSeg.i + 1 : 0;
  const st = store.getState;

  return (
    <section className="panel timeline tl-panel" aria-label="Timeline editor">
      <div className="tl-head">
        <div className="tl-summary">
          <span className="tl-title">Timeline</span>
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
                {selNo > 0 && <> · segment <b>{selNo}</b> selected</>}
                {editClip && clipLooks[editClip] && selected.includes(editClip) && (
                  <span className="muted"> · highlighted: #{selected.indexOf(editClip) + 1}, whose own FX you're editing</span>
                )}
              </>
            ) : (
              <span className="muted">Select clips to build the edit</span>
            )}
          </div>
        </div>

        <div className="tl-loop-control">
          <span className="tl-control-label">Loop</span>
          <div className="loopchips" id="loopChips" role="group" aria-label="Suggested loops">
            {features?.loops?.map((l) => (
              <button
                key={l.start}
                className={Math.abs(l.start - loopStart) < 0.05 ? 'on' : ''}
                aria-pressed={Math.abs(l.start - loopStart) < 0.05}
                title={`Starts at ${fmt(l.start)}`}
                onClick={() => {
                  store.setState({ loopStart: l.start, blocks: null });
                  rebuild();
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <div className="tl-rhythm-control">
          <span className="tl-control-label">Cut rhythm</span>
          <div className="seg" id="rhythmSeg" role="group" aria-label="Cut rhythm">
            {Object.entries(RHYTHMS).map(([k, r]) => (
              <button
                key={k}
                className={k === curRhythm ? 'on' : ''}
                aria-pressed={k === curRhythm}
                title={r.name}
                onClick={() => {
                  if (!look) return;
                  look.cut.rhythm = k;
                  store.setState({ blocks: null });
                  rebuild();
                }}
              >
                {r.short}
              </button>
            ))}
            {handCut && (
              <button className="on" aria-pressed="true" title="Cut by hand. Pick a rhythm to start the cuts over.">
                Custom
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="tl-tools" id="blockTools">
        <div className="tl-primary-tools" role="group" aria-label="Segment editing tools">
          <button
            className="tl-tool tl-edit"
            data-label={selNo ? `Edit segment ${selNo}` : 'Edit segment'}
            data-pop
            disabled={!ctx}
            title="Open the menu for the selected segment, or the one under the playhead: its timing, clip, transition and framing (Enter)"
            onClick={(e) => {
              const id = blocks.targetBlock();
              if (id) menus.openSegmentMenu(id, e.currentTarget);
            }}
          >
            ✎ {selNo ? `Edit segment ${selNo}` : 'Edit segment'}
            <ToolIcon name="edit" />
          </button>
          <div className="tl-tool-divider" aria-hidden="true" />
          <button className="tl-tool tl-tool-key" data-label="Split" data-key="B" disabled={!ctx} title="Split the segment at the playhead, on the snap grid (B)" onClick={() => st().splitAtPlayhead()}>
            ✂ Split
            <ToolIcon name="split" />
            <span className="tl-shortcut" data-key="B" aria-hidden="true" />
          </button>
          <button className="tl-tool tl-tool-key" data-label="Repeat" data-key="⌘D" disabled={!ctx} title="Split the selected segment in half and play its first half twice (⌘D)" onClick={() => st().repeatSegment()}>
            Repeat
            <ToolIcon name="repeat" />
            <span className="tl-shortcut" data-key="⌘D" aria-hidden="true" />
          </button>
          <button
            className="tl-tool"
            data-label="Put a clip in"
            data-pop
            disabled={!ctx}
            title="Put a clip in from the playhead to the next cut"
            onClick={(e) => openPop(e.currentTarget, menus.clipPicker, 'clip-pick')}
          >
            Put a clip in
            <ToolIcon name="insert" />
          </button>
          <button
            className="tl-tool tl-tool-key tl-delete"
            data-label="Delete"
            data-key="⌫"
            disabled={!ctx || ctx.tl.segs.length < 2}
            title={ctx && ctx.tl.segs.length < 2 ? 'The loop needs at least one segment' : 'Delete the selected segment. The one before it plays on (Delete)'}
            onClick={() => st().deleteBlock()}
          >
            Delete
            <ToolIcon name="delete" />
            <span className="tl-shortcut" data-key="⌫" aria-hidden="true" />
          </button>
        </div>
        <div className="seg snap" role="group" aria-label="Cut snap interval" title="What a dragged cut snaps to (N). Hold Shift while dragging to place it anywhere.">
          <span className="lbl">Snap</span>
          {SNAPS.map(([d, label]) => (
            <button key={d} className={snap === d ? 'on' : ''} aria-pressed={snap === d} onClick={() => st().setSnap(d)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="tl-track-row tl-overview-row">
        <div className="tl-track-label">
          <span>Song</span>
          <small>Source</small>
        </div>
        <div className="tl-canvas" id="overviewWrap">
          <canvas id="overview" ref={overviewRef} aria-label="Song overview and selected loop" />
        </div>
      </div>

      <div className="tl-track-row tl-lane-row">
        <div className="tl-lane-labels" aria-hidden="true">
          <span className="tl-ruler-label">Time</span>
          <span className="tl-video-label">Video</span>
          <span className="tl-audio-label">Audio</span>
        </div>
        <div className="tl-canvas" id="laneWrap" ref={laneWrapRef}>
          <canvas
            id="lane"
            ref={laneRef}
            aria-label="Editable video timeline with audio waveform"
            title={'The loop, left to right. Each block is one cut: #n is clip n from the Clips list (thumbnail = the moment it starts on).\nViolet diamonds are animated transitions, white diamonds are hard cuts, and the violet band is the transition duration. Audio: source waveform plus kick (red), hats (blue), and energy (green).\nClick: select and seek · drag a cut line: move it (Shift: off the grid) · drag a band edge: transition length · double-click, right-click or long-press a block, or press Enter: its menu · ⌥-drag: slip the clip · B: split at the playhead'}
          />
          <div className="playhead" id="playhead" />
          {selSeg && ctx && (
            <button
              className="lane-edit"
              data-label="Edit"
              data-pop
              title="Open this segment's menu (Enter)"
              style={{ left: `${((selSeg.t0 + selSeg.dur / 2) / ctx.L) * 100}%` }}
              onClick={(e) => menus.openSegmentMenu(selSeg.id, e.currentTarget)}
            >
              ✎ Edit
              <ToolIcon name="edit" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
