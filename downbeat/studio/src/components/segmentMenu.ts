import { useStudioStore } from '../state/store.ts';
import { openPop, closePop, h, POOLS, clipAspect, cropRect, room, clipDisplayName } from '../lib/utils.ts';
import { clamp } from '../engine/looks.ts';
import { setMenuSeg } from '../canvas/timelineCanvas.ts';
import { mirrors } from '../canvas/renderLoop.ts';
import { beatName, beatsText, timingSection, segOf, chip, chips } from './segTiming.ts';
import { MOVES, VELOCITY, frameAt, moveAt } from '../engine/timeline.ts';
import { TRANSITIONS } from '../engine/shaders.ts';
import { screenOf } from '../lib/screens.ts';
import type { Block, BlockPatch, FramePoint, Segment, SegmentFrame } from '../engine/types.ts';

/** A clip's name as the Clips list shows it. */
function clipName(id: string): string {
  const c = useStudioStore.getState().clips.find((x) => x.id === id);
  return c ? (c.name ? clipDisplayName({ name: c.name, still: c.still }) : id) : id;
}

/** Tiles for the clips in the edit, `on` marking one. */
export function clipTiles(on: string | null, onPick: (id: string) => void) {
  return h(
    'div',
    { class: 'seg-clips' },
    ...useStudioStore.getState().selected.map((id, k) =>
      h(
        'button',
        { class: `seg-clip${id === on ? ' on' : ''}`, title: `#${k + 1} ${clipName(id)}`, style: `background-image:url(/api/thumb/${id}?w=160)`, onclick: () => onPick(id) },
        h('span', {}, `#${k + 1}`),
      ),
    ),
  );
}

/** The toolbar's clip picker: a clip goes in from the playhead to the next cut. */
export function clipPicker(box: HTMLElement) {
  box.replaceChildren(
    h('div', { class: 'pick-head' }, h('h4', {}, 'Put a clip in'), h('small', {}, 'From the playhead to the next cut')),
    clipTiles(null, (id) => {
      closePop();
      useStudioStore.getState().insertClip(id);
    }),
  );
}

// The Edit tab's pools, then whatever is in none of them (Hard Cut, Shock Ripple).
const TRANS_GROUPS: [string, string[]][] = (() => {
  const groups: [string, string[]][] = ['Smooth', 'Kinetic', 'Glitch'].map((n) => [n, POOLS[n]]);
  const grouped = new Set(groups.flatMap(([, ids]) => ids));
  return [...groups, ['Other', Object.keys(TRANSITIONS).filter((k) => !grouped.has(k))]];
})();

const FRAMES = 8;
const DIRS: [NonNullable<Block['dir']>, string][] = [['forward', 'Forward'], ['reverse', 'Reverse'], ['pingpong', 'Ping-pong']];
const MINE = 'You set this. It goes back to automatic when you change the clips or the rhythm, or roll the edit.';
// per-cut transition lengths, in beats
const LENGTHS: [number, string][] = [[0.25, '¼'], [0.5, '½'], [1, '1'], [2, '2'], [4, '4']];

// Unhooks the open segment menu's arrow keys, lane outline and preview copy.
let detachMenu: (() => void) | null = null;
// The open menu's live copy of the preview, shown when the menu has to cover the stage.
let menuPeek: HTMLCanvasElement | null = null;

const MENU_W = 660;
const MENU_MIN = 340; // one column of controls

/** Moves the open segment menu beside the preview when one side has room, so the frame you pick stays in
 * sight, and keeps it on screen. Returns whether much of the preview is still out of sight: under the menu,
 * or scrolled off the screen as it is on a phone. */
export function placeMenu(p: HTMLElement): boolean {
  const v = document.getElementById('view')?.getBoundingClientRect();
  if (!v?.width) return false;
  const gap = 12;
  const left = v.left - gap - 8;
  const right = window.innerWidth - v.right - gap - 8;
  const room = Math.max(left, right);
  if (room >= MENU_MIN) {
    const w = Math.min(MENU_W, room);
    p.style.width = `${w}px`;
    p.style.left = `${right >= left ? v.right + gap : v.left - gap - w}px`;
  }
  keepOnScreen(p);
  type Box = { left: number; top: number; right: number; bottom: number };
  const cut = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const area = (a: Box) => Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);
  const onScreen = cut(v, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  const seen = area(onScreen) - area(cut(onScreen, p.getBoundingClientRect()));
  return seen / (v.width * v.height) < 0.6;
}

const keepOnScreen = (p: HTMLElement) => {
  const top = parseFloat(p.style.top) || 8;
  p.style.top = `${Math.max(8, Math.min(top, window.innerHeight - p.offsetHeight - 8))}px`;
};

/** Shows the live copy of the preview in the menu, in the preview's shape, at most 300 by 200. */
export function showPeek(peek: HTMLCanvasElement) {
  const v = document.getElementById('view') as HTMLCanvasElement | null;
  const aspect = v && v.height ? v.width / v.height : 9 / 16;
  const w = Math.min(300, 200 * aspect);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  peek.width = Math.round(w * dpr);
  peek.height = Math.round((w / aspect) * dpr);
  peek.style.cssText = `width:${Math.round(w)}px;height:${Math.round(w / aspect)}px`;
  peek.parentElement!.hidden = false;
}

const ZOOM_MAX = 3;
const NO_ROOM = 'The clip only just fills the frame this way. Zoom in to make room.';

/** "Center", or how far toward an edge a crop sits, as a share of the room it has. */
const side = (r: number, neg: string, pos: string) => (Math.abs(r) < 0.005 ? 'Center' : `${Math.round(Math.abs(r) * 100)}% ${r < 0 ? neg : pos}`);

/** The segment framing controls: a crop box over the clip, X, Y and zoom for the start of the segment (or its end,
 * when it moves), how it moves, and quick moves. `edit.key` says which end the controls edit. */
export function framingSection(id: string, seg: Segment, own: SegmentFrame | undefined, edit: { key: 'a' | 'b' }, render: () => void) {
  const s = useStudioStore.getState();
  const L = s.ctx!.L;
  const clip = s.clips.find((c) => c.id === seg.clipId) || {};
  const ca = screenOf(s.exportOpts.format).aspect;
  const cz = s.look?.camera.p.zoom ?? 1; // the look's camera zoom, which the shader multiplies in
  const base: FramePoint = [...(seg.focus || [0.5, 0.5, 1])] as FramePoint;
  const moving = !!own?.b;
  const now = (): SegmentFrame => segOf(id)?.frame || { a: base };
  const pt = (f: SegmentFrame): FramePoint => (edit.key === 'b' && f.b ? f.b : f.a);
  const roomAt = (z: number) => room(clip, Math.max(1, cz * z), ca).room;

  // the preview shows the end being edited, just clear of the transitions either side
  const show = (k: 'a' | 'b') => {
    const segs = s.ctx!.tl.segs;
    const pad = Math.min((k === 'b' ? segs[(seg.i + 1) % segs.length].transDur : seg.transDur) / 2 + 0.02, seg.dur * 0.3);
    s.transport.seek((((k === 'b' ? seg.t1 - pad : seg.t0 + pad) % L) + L) % L);
  };
  const apply = (f: SegmentFrame, again = false) => {
    s.setBlock(id, { frame: f });
    show(f.b ? edit.key : 'a');
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
      title: 'Drag the box to move the crop. Pinch on it, or use the Zoom slider, to zoom.',
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
      // A plain scroll scrolls the menu: the box sits where the pointer is while scrolling down to the
      // controls under it. A trackpad pinch arrives as a wheel with Ctrl held, and that zooms.
      onwheel: (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const p = pt(now());
        put([p[0], p[1], clamp(p[2] * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 1, ZOOM_MAX)]);
      },
    },
    wins.a,
    moving && wins.b,
  );
  // Safari reports a pinch as gesture events instead
  let pinchFrom = 1;
  crop.addEventListener('gesturestart', (e) => { e.preventDefault(); pinchFrom = pt(now())[2]; });
  crop.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const p = pt(now());
    put([p[0], p[1], clamp(pinchFrom * ((e as any).scale || 1), 1, ZOOM_MAX)]);
  });

  // The menu covers the stage, so while the playhead is in this segment a thin box follows the crop as it moves.
  const live = h('i', { class: 'seg-win live' });
  live.hidden = true;
  if (moving) crop.append(live);
  const follow = () => {
    if (!live.closest('.pop.on')) return; // closed, or redrawn with a new box
    const st = useStudioStore.getState();
    const sg = segOf(id);
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
        h('div', { class: 'seg-note' }, own ? 'Drag the box to move the crop. Pinch on it, or use the Zoom slider, to zoom.' : "Automatic: the look's drift wanders around the clip's framing. Drag the box to set your own."),
      ),
    ),
    h(
      'div',
      { class: 'seg-col' },
      sub(
        'Motion',
        chips(
          chip(!own, 'Auto', () => {
            s.setBlock(id, { frame: undefined });
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
export function segmentMenu(box: HTMLElement, start: string) {
  detachMenu?.();
  let id = start;
  let choosing = false; // the clip tiles for Put a clip in are showing
  // Kept across redraws: a copy of the preview for when the menu sits over it.
  const peek = h('canvas', { class: 'seg-peek', 'aria-label': 'Preview' }) as HTMLCanvasElement;
  const peekWrap = h('div', { class: 'seg-peek-wrap' }, peek);
  peekWrap.hidden = true;
  menuPeek = peek;
  mirrors.add(peek);
  const edit: { key: 'a' | 'b' } = { key: 'a' }; // which end of a framing move the controls edit

  const outline = () => {
    setMenuSeg(id);
    useStudioStore.getState().drawLane();
  };
  const go = (d: number) => {
    const s = useStudioStore.getState();
    const segs = s.ctx?.tl.segs || [];
    const k = segs.findIndex((x) => x.id === id);
    const seg = segs[(k + d + segs.length) % segs.length];
    if (!seg) return;
    id = seg.id;
    s.transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
    outline();
    render();
  };

  const open = () => box.classList.contains('on') && box.classList.contains('seg-menu');
  const onKey = (e: KeyboardEvent) => {
    if (!open()) return detachMenu?.();
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable], .seg-zoom')) return;
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
    mirrors.delete(peek);
    if (menuPeek === peek) menuPeek = null;
    detachMenu = null;
    setMenuSeg(null);
    useStudioStore.getState().drawLane();
  };

  const render = () => {
    const s = useStudioStore.getState();
    const seg = segOf(id);
    if (!s.ctx || !seg) return closePop();
    const { L, beatDur, tl } = s.ctx;
    const si = seg.i;
    const n = tl.segs.length;
    // What was set by hand: the block's own settings, and a clip or in-point changed from the rolled one.
    const block = s.blocks?.find((b) => b.id === id);
    const twin = tl.rolled.find((b) => b.id === id);
    const mine: Record<keyof BlockPatch, boolean> = {
      clipId: !!block && !!twin && block.clipId !== twin.clipId,
      in: !!block && !!twin && Math.abs(block.in - twin.in) > 1e-6,
      trans: block?.trans != null,
      transBeats: block?.transBeats != null,
      vel: block?.vel != null,
      dir: block?.dir != null,
      frame: block?.frame != null,
    };
    const pick = (patch: BlockPatch) => {
      s.setBlock(id, patch);
      render();
    };
    const field = (label: string, key: keyof BlockPatch, aside: any, ...kids: any[]) =>
      h(
        'div',
        { class: 'seg-f' },
        h('div', { class: 'seg-l' }, h('span', {}, label, mine[key] && h('i', { class: 'seg-mine', title: MINE })), aside),
        ...kids,
      );

    const where = `${beatName(seg.t0 / beatDur)} · ${seg.dur.toFixed(2)} s long`;
    // a beat of the segment before, then the transition
    const lead = seg.transDur / 2 + beatDur;
    const playCut = () => {
      s.transport.seek((((seg.t0 - lead) % L) + L) % L);
      if (!s.transport.playing) s.transport.play();
    };

    const clips = clipTiles(seg.clipId, (cid) => cid !== seg.clipId && pick({ clipId: cid }));

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
      s.setBlock(id, { in: v });
      place(v);
      s.transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
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
    if (!block?.frame?.b) edit.key = 'a';
    const any = Object.values(mine).some(Boolean);
    // the transition's length: what this cut asks for, and what it gets once held to its neighbours
    const want = block?.transBeats ?? s.look?.cut.beats ?? 1;
    const got = seg.transDur / beatDur;

    const length = field(
      'Transition length',
      'transBeats',
      seg.trans !== 'cut' && h('b', { class: 'seg-val' }, beatsText(got)),
      seg.trans === 'cut'
        ? h('div', { class: 'seg-note' }, 'A hard cut has no length.')
        : chips(
            chip(block?.transBeats == null, 'Auto', () => pick({ transBeats: undefined }), `The edit's length, ${beatsText(s.look?.cut.beats ?? 1)}`),
            ...LENGTHS.map(([b, label]) => chip(block?.transBeats === b, label, () => pick({ transBeats: b }), beatsText(b))),
          ),
      seg.trans !== 'cut' &&
        got < want - 1e-6 &&
        h('div', { class: 'seg-note' }, `Shortened from ${beatsText(want)} to fit the segments either side.`),
    );

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
        { class: 'seg-acts' },
        h('button', { title: 'Split at the playhead, or in half when the playhead is in another segment (B)', onclick: () => { s.splitBlockAt(id); outline(); render(); } }, '✂ Split'),
        h('button', { title: 'Split in half and play the first half twice (⌘D)', onclick: () => { s.repeatSegment(id); outline(); render(); } }, 'Repeat'),
        h('button', { class: choosing ? 'on' : '', title: 'Put another clip in the second half of this segment', onclick: () => { choosing = !choosing; render(); } }, 'Put a clip in'),
        h(
          'button',
          {
            class: 'seg-del',
            disabled: n < 2,
            title: n < 2 ? 'The loop needs at least one segment' : 'Delete this segment. The one before it plays on to the next cut (Delete)',
            onclick: () => {
              s.deleteBlock(id);
              id = useStudioStore.getState().selectedBlock || id;
              outline();
              render();
            },
          },
          'Delete',
        ),
        choosing &&
          h(
            'div',
            { class: 'seg-put' },
            h('small', {}, 'Pick the clip for the second half'),
            clipTiles(null, (cid) => {
              choosing = false;
              s.insertClip(cid, { id });
              outline();
              render();
            }),
          ),
      ),
      timingSection(id, render, length),
      h(
        'div',
        { class: 'seg-body' },
        h(
          'div',
          { class: 'seg-col' },
          peekWrap,
          field('Clip', 'clipId', null, clips, h('div', { class: 'seg-name' }, clipName(seg.clipId))),
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
      framingSection(id, seg, block?.frame, edit, render),
      h(
        'div',
        { class: 'seg-foot' },
        h(
          'span',
          {},
          tl.handCut
            ? 'This edit is cut by hand. The rhythm buttons and the dice start the cuts over.'
            : any
              ? 'Dots mark what you set. Changing the clips or the rhythm, or rolling the edit, sets them back to automatic.'
              : 'Everything here is automatic, picked from the edit seed.',
        ),
        h(
          'button',
          {
            class: 'seg-auto',
            disabled: !any,
            title: 'Forget what you set for this segment',
            onclick: () => {
              s.clearBlock(id);
              render();
            },
          },
          '↺ Back to auto',
        ),
      ),
      more,
    );
    showMore();
  };

  // The menu is often taller than the window; say so at its bottom edge until it's scrolled to the end.
  const more = h('div', { class: 'seg-more', 'aria-hidden': 'true' }, 'More below ↓');
  const showMore = () => { more.hidden = box.scrollTop + box.clientHeight >= box.scrollHeight - 4; };
  box.onscroll = showMore;

  outline();
  render();
}

/** Opens the segment menu on block `id`, from the element or point it was asked for at, or else from the block
 * on the lane. Double-click, right-click, a long press, Enter, the toolbar's Edit button and the Edit chip on
 * the selected block all come here. */
export function openSegmentMenu(id: string, from?: HTMLElement | { x: number; y: number }) {
  const s = useStudioStore.getState();
  const seg = segOf(id);
  if (!s.ctx || !seg) return;
  if (!from) {
    const r = document.getElementById('lane')?.getBoundingClientRect();
    from = r ? { x: r.left + ((seg.t0 + seg.dur / 2) / s.ctx.L) * r.width, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
  }
  let anchor = from as HTMLElement;
  if (!(from instanceof HTMLElement)) {
    anchor = document.createElement('div');
    anchor.style.cssText = `position:fixed;left:${from.x}px;top:${from.y}px;width:1px;height:1px`;
    document.body.append(anchor);
  }
  s.selectBlock(id);
  openPop(anchor, (box) => segmentMenu(box, id), 'seg-menu');
  if (anchor !== from) anchor.remove();
  const p = document.getElementById('pop')!;
  if (placeMenu(p) && menuPeek) {
    showPeek(menuPeek);
    keepOnScreen(p);
  }
  p.onscroll?.(new Event('scroll'));
}
