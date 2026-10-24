import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { useStudioStore } from '../state/store.ts';
import { fmt, openPop, closePop, h, POOLS, clipAspect, cropRect, room } from '../lib/utils.ts';
import { clamp } from '../engine/looks.ts';
import { setMenuSeg } from '../canvas/timelineCanvas.ts';
import { MOVES, RHYTHMS, VELOCITY, frameAt, moveAt } from '../engine/timeline.ts';
import { TRANSITIONS } from '../engine/shaders.ts';
import { screenOf } from '../lib/screens.ts';
import type { FramePoint, Segment, SegmentFrame, SegmentOverride } from '../engine/types.ts';

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

const FRAMES = 8;
const DIRS: [NonNullable<SegmentOverride['dir']>, string][] = [['forward', 'Forward'], ['reverse', 'Reverse'], ['pingpong', 'Ping-pong']];
const MINE = 'You set this. It goes back to automatic when you change the clips, rhythm or transitions.';

// Unhooks the open segment menu's arrow keys and lane outline.
let detachMenu: (() => void) | null = null;

const ZOOM_MAX = 3;
const NO_ROOM = 'The clip only just fills the frame this way. Zoom in to make room.';

/** "Center", or how far toward an edge a crop sits, as a share of the room it has. */
const side = (r: number, neg: string, pos: string) => (Math.abs(r) < 0.005 ? 'Center' : `${Math.round(Math.abs(r) * 100)}% ${r < 0 ? neg : pos}`);

/** The segment framing controls: a crop box over the clip, X, Y and zoom for the start of the segment (or its end,
 * when it moves), how it moves, and quick moves. `edit.key` says which end the controls edit. */
function framingSection(si: number, seg: Segment, own: SegmentFrame | undefined, edit: { key: 'a' | 'b' }, render: () => void) {
  const s = useStudioStore.getState();
  const L = s.ctx!.L;
  const clip = s.clips.find((c) => c.id === seg.clipId) || {};
  const ca = screenOf(s.exportOpts.format).aspect;
  const cz = s.look?.camera.p.zoom ?? 1; // the look's camera zoom, which the shader multiplies in
  const base: FramePoint = [...(seg.focus || [0.5, 0.5, 1])] as FramePoint;
  const moving = !!own?.b;
  const now = (): SegmentFrame => useStudioStore.getState().segOverrides[si]?.frame || { a: base };
  const pt = (f: SegmentFrame): FramePoint => (edit.key === 'b' && f.b ? f.b : f.a);
  const roomAt = (z: number) => room(clip, Math.max(1, cz * z), ca).room;

  // the preview shows the end being edited, just clear of the transitions either side
  const show = (k: 'a' | 'b') => {
    const segs = s.ctx!.tl.segs;
    const pad = Math.min((k === 'b' ? segs[(seg.i + 1) % segs.length].transDur : seg.transDur) / 2 + 0.02, seg.dur * 0.3);
    s.transport.seek((((k === 'b' ? seg.t1 - pad : seg.t0 + pad) % L) + L) % L);
  };
  const apply = (f: SegmentFrame, again = false) => {
    patchSegment(si, { frame: f });
    show(f.b ? edit.key : 'a');
    s.rebuild();
    if (again) render();
    else draw();
  };
  const put = (p: FramePoint) => {
    const f = now();
    apply(edit.key === 'b' && f.b ? { ...f, b: p } : { ...f, a: p });
  };

  // The crop box: the clip at its in-point, the crop at the start (solid) and the end (dashed).
  const va = clipAspect(clip);
  const win = (k: 'a' | 'b') => h('i', { class: `seg-win${k === edit.key ? ' on' : ''}${k === 'b' ? ' end' : ''}` }, h('small', {}, k === 'a' ? 'Start' : 'End'));
  const wins = { a: win('a'), b: win('b') };
  const crop = h(
    'div',
    {
      class: 'seg-crop',
      title: 'Drag the box to move the crop. Scroll on it to zoom.',
      style: `width:${Math.round(Math.min(300, 136 * va))}px;aspect-ratio:${va.toFixed(4)};background-image:url(/api/thumb/${seg.clipId}?w=320&t=${seg.in.toFixed(2)})`,
      onpointerdown: (e: PointerEvent) => {
        const r = crop.getBoundingClientRect();
        const p0 = pt(now());
        const [l, t, w, hh] = cropRect(clip, Math.max(1, cz * p0[2]), p0[0], p0[1], ca);
        const ux = (e.clientX - r.left) / r.width, uy = (e.clientY - r.top) / r.height;
        // grab the crop where it sits, or bring its centre to where you pressed
        const inside = ux >= l && ux <= l + w && uy >= t && uy <= t + hh;
        const c0 = inside ? [l + w / 2, 1 - t - hh / 2] : [ux, 1 - uy];
        const to = (ev: PointerEvent) => {
          const rm = roomAt(p0[2]);
          const x = 0.5 + clamp(c0[0] + (ev.clientX - e.clientX) / r.width - 0.5, -rm[0], rm[0]);
          const y = 0.5 + clamp(c0[1] - (ev.clientY - e.clientY) / r.height - 0.5, -rm[1], rm[1]);
          put([x, y, p0[2]]);
        };
        crop.setPointerCapture?.(e.pointerId);
        to(e);
        crop.onpointermove = to;
        crop.onpointerup = crop.onpointercancel = () => {
          crop.onpointermove = crop.onpointerup = crop.onpointercancel = null;
          render();
        };
      },
      onwheel: (e: WheelEvent) => {
        e.preventDefault();
        const p = pt(now());
        put([p[0], p[1], clamp(p[2] * Math.exp(-e.deltaY * 0.0015), 1, ZOOM_MAX)]);
      },
    },
    wins.a,
    moving && wins.b,
  );

  // The menu covers the stage, so while the playhead is in this segment a thin box follows the crop as it moves.
  const live = h('i', { class: 'seg-win live' });
  live.hidden = true;
  if (moving) crop.append(live);
  const follow = () => {
    if (!live.closest('.pop.on')) return; // closed, or redrawn with a new box
    const st = useStudioStore.getState();
    const sg = st.ctx?.tl.segs[si];
    const local = sg ? ((((st.transport.loopTime() - sg.t0) % L) + L) % L) : Infinity;
    live.hidden = !sg?.frame?.b || local > sg.dur;
    if (!live.hidden) {
      const [x, y, z] = frameAt(sg!.frame!, moveAt(sg!, local));
      const [l, t, w, hh] = cropRect(clip, Math.max(1, cz * z), x, y, ca);
      live.style.cssText = `left:${l * 100}%;top:${t * 100}%;width:${w * 100}%;height:${hh * 100}%`;
    }
    requestAnimationFrame(follow);
  };
  if (moving && typeof requestAnimationFrame === 'function') requestAnimationFrame(follow);

  // X and Y run from one edge of the room the crop has to the other; zoom from filling the frame to 3x.
  const row = (label: string, input: HTMLInputElement, val: HTMLElement) => h('label', { class: 'seg-xyz' }, h('span', {}, label), input, val);
  const range = (aria: string, min: number, max: number, onv: (v: number) => void) =>
    h('input', {
      type: 'range', min, max, step: 0.01, 'aria-label': aria,
      oninput: (ev: Event) => onv(+(ev.target as HTMLInputElement).value),
      onchange: () => render(),
    }) as HTMLInputElement;
  const xIn = range('X', -1, 1, (r) => { const p = pt(now()); put([0.5 + r * roomAt(p[2])[0], p[1], p[2]]); });
  const yIn = range('Y', -1, 1, (r) => { const p = pt(now()); put([p[0], 0.5 + r * roomAt(p[2])[1], p[2]]); });
  const zIn = range('Zoom', 1, ZOOM_MAX, (z) => { const p = pt(now()); put([p[0], p[1], z]); });
  const xVal = h('b', { class: 'seg-val' }), yVal = h('b', { class: 'seg-val' }), zVal = h('b', { class: 'seg-val' });

  function draw() {
    const f = now();
    for (const k of ['a', 'b'] as const) {
      const p = k === 'b' ? f.b : f.a;
      if (!p) continue;
      const [l, t, w, hh] = cropRect(clip, Math.max(1, cz * p[2]), p[0], p[1], ca);
      wins[k].style.cssText = `left:${l * 100}%;top:${t * 100}%;width:${w * 100}%;height:${hh * 100}%`;
    }
    const p = pt(f);
    const rm = roomAt(p[2]);
    const rel = (v: number, m: number) => (m > 1e-3 ? clamp((v - 0.5) / m, -1, 1) : 0);
    xIn.value = String(rel(p[0], rm[0]));
    yIn.value = String(rel(p[1], rm[1]));
    zIn.value = String(p[2]);
    xIn.disabled = rm[0] <= 1e-3;
    yIn.disabled = rm[1] <= 1e-3;
    xIn.title = xIn.disabled ? NO_ROOM : '';
    yIn.title = yIn.disabled ? NO_ROOM : '';
    xVal.textContent = xIn.disabled ? 'No room' : side(rel(p[0], rm[0]), 'left', 'right');
    yVal.textContent = yIn.disabled ? 'No room' : side(rel(p[1], rm[1]), 'down', 'up');
    zVal.textContent = `${p[2].toFixed(2)}×`;
  }

  const chip = (on: boolean, text: string, onclick: () => void, title?: string) =>
    h('button', { class: on ? 'on' : '', title, onclick: () => !on && onclick() }, text);
  const chips = (...kids: HTMLElement[]) => h('div', { class: 'seg-chips' }, ...kids);
  const sub = (label: string, ...kids: any[]) => h('div', { class: 'seg-f' }, h('div', { class: 'seg-l' }, h('span', {}, label)), ...kids);

  // the handlers read the framing afresh: dragging and scrolling on the box don't redraw the menu
  const ease = own?.ease || 'smooth';
  const motion = (k: keyof typeof MOVES) => () => {
    const f = now();
    if (f.b) return apply({ ...f, ease: k }, true);
    // starting a move from still: a gentle push in, with the end ready to adjust
    edit.key = 'b';
    apply({ a: f.a, b: [f.a[0], f.a[1], Math.min(ZOOM_MAX, +(f.a[2] * 1.25).toFixed(2))], ease: k }, true);
  };
  const preset = (make: (p: FramePoint) => SegmentFrame) => () => {
    const f = now();
    edit.key = 'a';
    apply({ ease: f.ease || 'smooth', ...make(f.a) }, true);
  };
  // pushes and pulls zoom by half again, or between 2x and 3x from the top of the range
  const zooms = (z: number): [number, number] => (z * 1.5 <= ZOOM_MAX ? [z, +(z * 1.5).toFixed(2)] : [2, ZOOM_MAX]);
  const push = (out: boolean) =>
    preset(([x, y, z]) => {
      const [lo, hi] = zooms(z);
      return out ? { a: [x, y, hi], b: [x, y, lo] } : { a: [x, y, lo], b: [x, y, hi] };
    });
  // Pans run most of the way across the room the crop has, zooming in first if it has too little.
  const pan = (axis: 0 | 1, dir: 1 | -1) =>
    preset((p) => {
      const frac = room(clip, 1, ca).frac[axis];
      const z = clamp(Math.max(p[2], frac / 0.76 / cz), 1, ZOOM_MAX);
      const m = roomAt(z)[axis] * 0.9;
      const a: FramePoint = [p[0], p[1], z], b: FramePoint = [p[0], p[1], z];
      a[axis] = 0.5 - dir * m;
      b[axis] = 0.5 + dir * m;
      return { a, b };
    });

  draw();
  return h(
    'div',
    { class: 'seg-body seg-framing' },
    h(
      'div',
      { class: 'seg-col' },
      h(
        'div',
        { class: 'seg-f' },
        h('div', { class: 'seg-l' }, h('span', {}, 'Framing', own && h('i', { class: 'seg-mine', title: MINE })), h('small', {}, `on top of the look's ${cz.toFixed(2)}× zoom`)),
        crop,
        h('div', { class: 'seg-note' }, own ? 'Drag the box to move the crop, scroll on it to zoom.' : "Automatic: the look's drift wanders around the clip's framing. Drag the box to set your own."),
      ),
    ),
    h(
      'div',
      { class: 'seg-col' },
      sub(
        'Motion',
        chips(
          chip(!own, 'Auto', () => {
            const all = { ...useStudioStore.getState().segOverrides };
            const { frame: _, ...rest } = all[si] || {};
            if (Object.keys(rest).length) all[si] = rest;
            else delete all[si];
            useStudioStore.setState({ segOverrides: all });
            s.rebuild();
            render();
          }, "The look's drift"),
          chip(!!own && !moving, 'Still', () => apply({ a: now().a }, true), 'Hold one framing for the whole segment'),
          ...Object.entries(MOVES).map(([k, v]) => chip(moving && ease === k, v.name, motion(k as keyof typeof MOVES), v.desc)),
        ),
      ),
      moving &&
        chips(
          chip(edit.key === 'a', 'Start', () => { edit.key = 'a'; show('a'); render(); }, 'Adjust the framing at the start of the segment'),
          chip(edit.key === 'b', 'End', () => { edit.key = 'b'; show('b'); render(); }, 'Adjust the framing at the end of the segment'),
          h('button', { title: 'Swap the start and the end', onclick: () => { const f = now(); apply({ ...f, a: f.b!, b: f.a }, true); } }, '⇄ Swap'),
        ),
      h('div', { class: 'seg-sliders' }, row('X', xIn, xVal), row('Y', yIn, yVal), row('Zoom', zIn, zVal)),
      sub(
        'Quick moves',
        chips(
          h('button', { title: 'Zoom in by half again over the segment', onclick: push(false) }, 'Push in'),
          h('button', { title: 'Start zoomed in by half again and pull back out', onclick: push(true) }, 'Pull out'),
          h('button', { title: 'Pan from right to left', onclick: pan(0, -1) }, 'Pan ←'),
          h('button', { title: 'Pan from left to right', onclick: pan(0, 1) }, 'Pan →'),
          h('button', { title: 'Tilt from the bottom up', onclick: pan(1, 1) }, 'Pan ↑'),
          h('button', { title: 'Tilt from the top down', onclick: pan(1, -1) }, 'Pan ↓'),
        ),
      ),
    ),
  );
}

/** The menu a double-click on a segment opens. Picks apply straight away and the menu stays open, and ‹ › or
 * the arrow keys move it to the next segment, so a whole edit can be gone through in one sitting. */
function segmentMenu(box: HTMLElement, start: number) {
  detachMenu?.();
  let si = start;
  const edit: { key: 'a' | 'b' } = { key: 'a' }; // which end of a framing move the controls edit

  const outline = () => {
    setMenuSeg(si);
    useStudioStore.getState().drawLane();
  };
  const go = (d: number) => {
    const s = useStudioStore.getState();
    const n = s.ctx?.tl.segs.length || 1;
    si = (si + d + n) % n;
    const seg = s.ctx?.tl.segs[si];
    if (seg) s.transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
    outline();
    render();
  };

  const open = () => box.classList.contains('on') && box.classList.contains('seg-menu');
  const onKey = (e: KeyboardEvent) => {
    if (!open()) return detachMenu?.();
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    e.stopPropagation(); // everywhere else ← → step through the looks
    go(e.key === 'ArrowRight' ? 1 : -1);
  };
  const watch = new MutationObserver(() => {
    if (!open()) detachMenu?.();
  });
  window.addEventListener('keydown', onKey, true);
  watch.observe(box, { attributes: true, attributeFilter: ['class'] });
  detachMenu = () => {
    window.removeEventListener('keydown', onKey, true);
    watch.disconnect();
    detachMenu = null;
    setMenuSeg(null);
    useStudioStore.getState().drawLane();
  };

  const render = () => {
    const s = useStudioStore.getState();
    const seg = s.ctx?.tl.segs[si];
    if (!s.ctx || !seg) return closePop();
    const { L, beatDur } = s.ctx;
    const n = s.ctx.tl.segs.length;
    const mine = s.segOverrides[si] || {};
    const pick = (patch: SegmentOverride) => {
      patchSegment(si, patch);
      s.rebuild();
      render();
    };
    const field = (label: string, key: keyof SegmentOverride, aside: any, ...kids: any[]) =>
      h(
        'div',
        { class: 'seg-f' },
        h('div', { class: 'seg-l' }, h('span', {}, label, mine[key] != null && h('i', { class: 'seg-mine', title: MINE })), aside),
        ...kids,
      );
    const chip = (on: boolean, text: string, onclick: () => void, title?: string) =>
      h('button', { class: on ? 'on' : '', title, onclick: () => !on && onclick() }, text);
    const chips = (...kids: HTMLElement[]) => h('div', { class: 'seg-chips' }, ...kids);

    const b = seg.t0 / beatDur + 1e-6;
    const beat = Math.floor(b % 4) + 1;
    const where = `Bar ${Math.floor(b / 4) + 1}${beat > 1 ? `, beat ${beat}` : ''} · ${seg.dur.toFixed(2)} s long`;
    // a beat of the segment before, then the transition
    const lead = seg.transDur / 2 + beatDur;
    const playCut = () => {
      s.transport.seek((((seg.t0 - lead) % L) + L) % L);
      if (!s.transport.playing) s.transport.play();
    };

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

    // In-point: a filmstrip of the moments the segment can start on, with the slider under it.
    const clip = s.clips.find((c) => c.id === seg.clipId);
    const dur = s.clipDur.get(seg.clipId) || 10;
    const maxIn = Math.max(0, dur - seg.dur * seg.speed - 0.1);
    const inVal = h('b', { class: 'seg-val' });
    const mark = h('i', { class: 'seg-mark' });
    const place = (v: number) => {
      inVal.textContent = `${v.toFixed(2)} s`;
      mark.style.left = `${maxIn > 0 ? Math.min(1, v / maxIn) * 100 : 0}%`;
    };
    const setIn = (v: number) => {
      patchSegment(si, { in: v });
      place(v);
      s.transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
      s.rebuild();
    };
    const strip =
      maxIn > 0 &&
      !clip?.still &&
      h(
        'div',
        { class: 'seg-strip' },
        ...Array.from({ length: FRAMES }, (_, k) => {
          const t = (maxIn * (k + 0.5)) / FRAMES;
          return h('button', {
            title: `Start at ${t.toFixed(1)} s`,
            style: `background-image:url(/api/thumb/${seg.clipId}?w=120&t=${t.toFixed(2)})`,
            onclick: () => {
              setIn(+t.toFixed(2));
              render();
            },
          });
        }),
        mark,
      );
    const slider = h('input', {
      type: 'range',
      min: 0,
      max: maxIn.toFixed(2),
      step: 0.01,
      value: Math.min(seg.in, maxIn),
      disabled: maxIn <= 0,
      'aria-label': 'In-point',
      oninput: (ev: Event) => setIn(+(ev.target as HTMLInputElement).value),
      onchange: () => render(), // shows the you-set-this mark once the slider is let go
    });
    place(seg.in);

    const dirNow = seg.pp ? 'pingpong' : seg.rev ? 'reverse' : 'forward';
    if (!mine.frame?.b) edit.key = 'a';
    const any = Object.keys(mine).length > 0;

    box.replaceChildren(
      h(
        'div',
        { class: 'seg-head' },
        h('button', { class: 'seg-step', title: 'Previous segment (←)', 'aria-label': 'Previous segment', disabled: n < 2, onclick: () => go(-1) }, '‹'),
        h('h4', {}, `Segment ${si + 1}`, h('small', {}, ` of ${n}`)),
        h('button', { class: 'seg-step', title: 'Next segment (→)', 'aria-label': 'Next segment', disabled: n < 2, onclick: () => go(1) }, '›'),
        h('span', { class: 'meta' }, where),
        h('button', { class: 'seg-play', title: 'Play from a beat before the cut into this segment', onclick: playCut }, '▶ Play the cut'),
        h('button', { class: 'seg-x', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closePop }, '✕'),
      ),
      h(
        'div',
        { class: 'seg-body' },
        h(
          'div',
          { class: 'seg-col' },
          field('Clip', 'clipId', null, clips, h('div', { class: 'seg-name' }, name(seg.clipId))),
          field(
            'In-point',
            'in',
            h('span', {}, inVal, h('small', {}, ` of ${dur.toFixed(1)} s`)),
            strip,
            slider,
            maxIn <= 0 && h('div', { class: 'seg-note' }, 'This clip is only just long enough to fill the segment.'),
          ),
          field('Direction', 'dir', null, chips(...DIRS.map(([k, label]) => chip(dirNow === k, label, () => pick({ dir: k }))))),
          field(
            'Speed ramp',
            'vel',
            null,
            chips(...Object.entries(VELOCITY).map(([k, v]) => chip(seg.vel === k, v.name, () => pick({ vel: k }), v.desc || 'Constant clip speed'))),
          ),
        ),
        h(
          'div',
          { class: 'seg-col' },
          field(
            'Transition in',
            'trans',
            null,
            si === 0 && h('div', { class: 'seg-note' }, 'This cut is the loop seam, where the end of the loop joins the start.'),
            ...TRANS_GROUPS.map(([group, ids]) =>
              h('div', { class: 'seg-group' }, h('small', {}, group), chips(...ids.map((k) => chip(seg.trans === k, TRANSITIONS[k].name, () => pick({ trans: k }))))),
            ),
          ),
        ),
      ),
      framingSection(si, seg, mine.frame, edit, render),
      h(
        'div',
        { class: 'seg-foot' },
        h('span', {}, any ? 'Dots mark what you set. Changing the clips, rhythm or transitions sets them back to automatic.' : 'Everything here is automatic, picked from the edit seed.'),
        h(
          'button',
          {
            class: 'seg-auto',
            disabled: !any,
            title: 'Forget what you set for this segment',
            onclick: () => {
              const all = { ...s.segOverrides };
              delete all[si];
              useStudioStore.setState({ segOverrides: all });
              s.rebuild();
              render();
            },
          },
          '↺ Back to auto',
        ),
      ),
    );
  };

  outline();
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
