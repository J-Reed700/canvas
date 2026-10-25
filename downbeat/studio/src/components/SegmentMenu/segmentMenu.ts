import './SegmentMenu.css';
import type { StudioStore } from '../../state/storeTypes.ts';
import { closePop, h, clipAspect, cropRect, room, clipDisplayName, type DomChild } from '../../lib/utils.ts';
import { clamp } from '../../engine/looks.ts';
import { beatName, beatsText, chip, chips, createSegmentTiming } from './segTiming.ts';
import { setMenuSeg } from '../../canvas/timelineCanvas.ts';
import type { createPreviewController } from '../../canvas/renderLoop.ts';
import { MOVES, VELOCITY, footageUsed, frameAt, moveAt } from '../../engine/timeline.ts';
import { CLIP_SPEED_MIN, CLIP_SPEED_MAX, CLIP_SPEED_PRESETS, speedForBpm } from '../../engine/clipSpeed.ts';
import { screenOf } from '../../lib/screens.ts';
import { thumbBackground } from '../../lib/thumbs.ts';
import type { Block, BlockPatch, FramePoint, Segment, SegmentFrame } from '../../engine/types.ts';

/** Where the mounted segment panel wants React's transition picker. */
export interface SegmentPanelTarget {
  id: string;
  transitionHost: HTMLElement;
  onTransitionChange: (id: string) => void;
}

export function createSegmentMenu(store: StudioStore, preview?: ReturnType<typeof createPreviewController>) {
  const { timingSection, segOf } = createSegmentTiming(store);
  let panelTarget: SegmentPanelTarget | null = null;
  const panelListeners = new Set<() => void>();
  const getPanelTarget = () => panelTarget;
  const subscribePanel = (listener: () => void) => { panelListeners.add(listener); return () => { panelListeners.delete(listener); }; };
  const setPanelTarget = (target: SegmentPanelTarget | null) => {
    if (panelTarget?.id === target?.id && panelTarget?.transitionHost === target?.transitionHost) return;
    panelTarget = target;
    panelListeners.forEach((listener) => listener());
  };

  /** A clip's name as the Clips list shows it. */
  function clipName(id: string): string {
    const c = store.getState().clips.find((x) => x.id === id);
    return c ? (c.name ? clipDisplayName({ name: c.name, still: c.still }) : id) : id;
  }

  /** Tiles for the clips in the edit, `on` marking one. */
  function clipTiles(on: string | null, onPick: (id: string) => void) {
    return h(
      'div',
      { class: 'seg-clips' },
      ...store.getState().selected.map((id, k) =>
        h(
          'button',
          { class: `seg-clip${id === on ? ' on' : ''}`, title: `#${k + 1} ${clipName(id)}`, style: `background-image:url(/api/thumb/${id}?w=160)`, onclick: () => onPick(id) },
          h('span', {}, `#${k + 1}`),
        ),
      ),
    );
  }

  /** The toolbar's clip picker: a clip goes in from the playhead to the next cut. */
  function clipPicker(box: HTMLElement) {
    box.replaceChildren(
      h('div', { class: 'pick-head' }, h('h4', {}, 'Put a clip in'), h('small', {}, 'From the playhead to the next cut')),
      clipTiles(null, (id) => {
        closePop();
        store.getState().insertClip(id);
      }),
    );
  }

  const FRAMES = 8;
  const DIRS: [NonNullable<Block['dir']>, string][] = [['forward', 'Forward'], ['reverse', 'Reverse'], ['pingpong', 'Ping-pong']];
  const MINE = 'You set this. It goes back to automatic when you change the clips or the rhythm, or roll the edit.';
  // per-cut transition lengths, in beats
  const LENGTHS: [number, string][] = [[0.25, '¼'], [0.5, '½'], [1, '1'], [2, '2'], [4, '4']];

  // Unhooks the mounted segment panel's store subscription and transition picker target.
  let detachPanel: (() => void) | null = null;

  const ZOOM_MAX = 3;
  const NO_ROOM = 'The clip only just fills the frame this way. Zoom in to make room.';

  /** "Center", or how far toward an edge a crop sits, as a share of the room it has. */
  const side = (r: number, neg: string, pos: string) => (Math.abs(r) < 0.005 ? 'Center' : `${Math.round(Math.abs(r) * 100)}% ${r < 0 ? neg : pos}`);

  /** The segment framing controls: a crop box over the clip, X, Y and zoom for the start of the segment (or its end,
   * when it moves), how it moves, and quick moves. `edit.key` says which end the controls edit. */
  function framingSection(id: string, seg: Segment, own: SegmentFrame | undefined, edit: { key: 'a' | 'b' }, render: () => void) {
    const s = store.getState();
    const L = s.ctx!.L;
    const clip = s.clips.find((c) => c.id === seg.clipId) || {};
    const ca = screenOf(s.exportOpts.format).aspect;
    const cz = s.editLook().camera.p.zoom ?? 1; // the appearance's camera zoom, which the shader multiplies in
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
        style: `width:${Math.round(Math.min(300, 136 * va))}px;aspect-ratio:${va.toFixed(4)}`,
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
    thumbBackground(crop, `/api/thumb/${seg.clipId}?w=320&t=${seg.in.toFixed(2)}`);
    // Safari reports a pinch as gesture events instead
    let pinchFrom = 1;
    crop.addEventListener('gesturestart', (e) => { e.preventDefault(); pinchFrom = pt(now())[2]; });
    crop.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const p = pt(now());
      const scale = 'scale' in e && typeof e.scale === 'number' ? e.scale : 1;
      put([p[0], p[1], clamp(pinchFrom * (scale || 1), 1, ZOOM_MAX)]);
    });

    // While the playhead is in this segment a thin box follows the crop as it moves.
    const live = h('i', { class: 'seg-win live' });
    live.hidden = true;
    if (moving) crop.append(live);
    const follow = () => {
      if (!live.isConnected) return; // unmounted, or redrawn with a new box
      const st = store.getState();
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

    const sub = (label: string, ...kids: DomChild[]) => h('div', { class: 'seg-f' }, h('div', { class: 'seg-l' }, h('span', {}, label)), ...kids);

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

  // Which families of the segment panel are open, kept while stepping from one segment to the next.
  const openFamilies = new Set(['timing', 'playback', 'framing']);

  /** Renders the controls for timeline segment `id` into `host`, the inspector's Edit tab while a segment is
   * selected. Picks apply straight away. The panel redraws when the edit changes elsewhere, such as a cut dragged
   * on the lane or an undo, but not while one of its own controls is in use. Returns a function that unmounts it. */
  function mountSegmentPanel(host: HTMLElement, id: string): () => void {
    detachPanel?.();
    let choosing = false; // the clip tiles for Put a clip in are showing
    const transitionHost = h('div', { class: 'seg-transition-picker' });
    // The BPM helper applies a speed once; keep its draft while the panel redraws.
    const clipBpms = new Map<string, string>();
    const edit: { key: 'a' | 'b' } = { key: 'a' }; // which end of a framing move the controls edit

    const go = (d: number) => step(id, d); // the inspector remounts the panel on the new selection

    // The block being edited keeps a white outline on the lane, inside the selection's violet one.
    setMenuSeg(id);
    store.getState().drawLane();

    // A live copy of the preview sits in the bar whenever the preview itself is mostly out of sight, as it is
    // on a phone once the inspector is scrolled to.
    const peek = h('canvas', { class: 'seg-peek', 'aria-label': 'Preview' }) as HTMLCanvasElement;
    const peekWrap = h('div', { class: 'seg-peek-wrap' }, peek);
    peekWrap.hidden = true;
    preview?.mirrors.add(peek);
    const view = typeof document === 'undefined' ? null : document.getElementById('view') as HTMLCanvasElement | null;
    const sight = view && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
          const hidden = entry.intersectionRatio < 0.4;
          if (hidden && peekWrap.hidden) sizePeek(peek, view);
          peekWrap.hidden = !hidden;
        }, { threshold: [0, 0.4, 1] })
      : null;
    if (view) sight?.observe(view);

    // The panel's own controls redraw it as they need, so a store change made from inside it, or during a drag
    // that began in it, is left alone; the drag redraws once it ends if anything else changed meanwhile.
    let inside = false;
    let holding = false;
    let stale = false;
    const enter = () => {
      inside = true;
      queueMicrotask(leave); // a handler that stops the event's propagation never reaches leave() below
    };
    const leave = () => { inside = false; };
    const press = () => { holding = true; };
    const release = () => {
      if (!holding) return;
      holding = false;
      if (stale) { stale = false; render(); }
    };
    const EVENTS = ['pointerdown', 'pointerup', 'click', 'dblclick', 'input', 'change', 'keydown', 'wheel', 'submit', 'gesturechange'];
    for (const type of EVENTS) {
      host.addEventListener(type, enter, true);
      host.addEventListener(type, leave);
    }
    host.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.ctx === previous.ctx && state.blocks === previous.blocks && state.snap === previous.snap
        && state.selected === previous.selected && state.clips === previous.clips) return;
      if (inside || holding) { stale = holding; return; }
      render();
    });
    const detach = () => {
      for (const type of EVENTS) {
        host.removeEventListener(type, enter, true);
        host.removeEventListener(type, leave);
      }
      host.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      unsubscribe();
      sight?.disconnect();
      preview?.mirrors.delete(peek);
      setPanelTarget(null);
      host.replaceChildren();
      if (detachPanel === detach) detachPanel = null;
      setMenuSeg(null);
      store.getState().drawLane();
    };
    detachPanel = detach;

    const render = () => {
      const s = store.getState();
      const seg = segOf(id);
      if (!s.ctx || !seg) {
        setPanelTarget(null);
        host.replaceChildren();
        return;
      }
      const { L, beatDur, tl } = s.ctx;
      const si = seg.i;
      const n = tl.segs.length;
      // What was set by hand: the block's own settings, and a clip or in-point changed from the rolled one.
      const block = s.blocks?.find((b) => b.id === id);
      const twin = tl.rolled.find((b) => b.id === id);
      const mine: Record<keyof BlockPatch | 'speed', boolean> = {
        clipId: !!block && !!twin && block.clipId !== twin.clipId,
        in: !!block && !!twin && Math.abs(block.in - twin.in) > 1e-6,
        trans: block?.trans != null,
        transBeats: block?.transBeats != null,
        vel: block?.vel != null,
        dir: block?.dir != null,
        frame: block?.frame != null,
        overrides: block?.overrides != null,
        look: block?.look != null,
        speed: block?.overrides?.camera?.speed != null,
      };
      const pick = (patch: BlockPatch) => {
        s.setBlock(id, patch);
        render();
      };
      const field = (label: string, key: keyof BlockPatch | 'speed', aside: DomChild, ...kids: DomChild[]) =>
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
            const b = h('button', {
              title: `Start at ${t.toFixed(1)} s`,
              onclick: () => {
                setIn(+t.toFixed(2));
                render();
              },
            });
            thumbBackground(b, `/api/thumb/${seg.clipId}?w=120&t=${t.toFixed(2)}`);
            return b;
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

      const speedVal = h('b', { class: 'seg-val' }, `${seg.speed.toFixed(2)}×`);
      const setSpeed = (value: number | undefined, redraw = true, constant = false) => {
        const current = store.getState();
        const overrides = { ...current.blocks?.find((b) => b.id === id)?.overrides };
        const camera = { ...overrides.camera };
        if (value === undefined) delete camera.speed; else camera.speed = value;
        if (Object.keys(camera).length) overrides.camera = camera; else delete overrides.camera;
        current.setBlock(id, { overrides: Object.keys(overrides).length ? overrides : undefined, ...(constant ? { vel: 'none' } : {}) });
        if (redraw) render();
        else speedVal.textContent = `${segOf(id)!.speed.toFixed(2)}×`;
      };
      const bpm = s.bpm();
      const bpmIn = h('input', {
        class: 'numin', type: 'number', min: 1, step: 'any', placeholder: 'e.g. 80',
        'aria-label': 'Original clip BPM', value: clipBpms.get(seg.clipId) || '',
        oninput: (e: Event) => {
          clipBpms.set(seg.clipId, (e.target as HTMLInputElement).value);
          showMatch();
        },
      }) as HTMLInputElement;
      const matchNote = h('div', { class: 'seg-note', 'aria-live': 'polite' });
      const match = h('button', {
        class: 'btn sm', type: 'submit',
      }, `Match ${+bpm.toFixed(2)} BPM`) as HTMLButtonElement;
      const showMatch = () => {
        const source = +bpmIn.value;
        const rate = speedForBpm(source, bpm);
        match.disabled = rate === null;
        matchNote.textContent = rate !== null
          ? `${source} → ${+bpm.toFixed(2)} BPM at ${rate.toFixed(2)}×, with a constant speed. Adjust In-point to align the first move with a beat.`
          : source > 0
            ? `This tempo match needs ${(bpm / source).toFixed(2)}×, outside the supported ${CLIP_SPEED_MIN}–${CLIP_SPEED_MAX}× range.`
            : 'Enter the clip’s original BPM to match its tempo to the song or BPM clock.';
      };
      showMatch();
      const speedField = field(
        'Clip speed', 'speed', !clip?.still && speedVal,
        clip?.still
          ? h('div', { class: 'seg-note' }, 'Still images have no playback speed.')
          : h('div', { class: 'seg-speed' },
              h('input', {
                type: 'range', min: CLIP_SPEED_MIN, max: CLIP_SPEED_MAX, step: 0.01, value: seg.speed,
                'aria-label': 'Clip speed', title: 'Playback speed for this segment; double-click for normal speed',
                oninput: (e: Event) => setSpeed(+(e.target as HTMLInputElement).value, false),
                onchange: () => render(), ondblclick: () => setSpeed(1),
              }),
              chips(
                chip(!mine.speed, 'Auto', () => setSpeed(undefined), `Follow the edit’s clip speed, ${(s.look?.camera.p.speed ?? 1).toFixed(2)}×`),
                ...CLIP_SPEED_PRESETS.map((rate) => chip(mine.speed && Math.abs(seg.speed - rate) < 1e-6, `${rate}×`, () => setSpeed(rate))),
              ),
              h('div', { class: 'seg-note' }, 'Only this segment. Cut timing and the song’s tempo stay the same.'),
              footageUsed(seg, seg.dur) * seg.speed * (seg.pp ? 0.5 : 1) > dur &&
                h('div', { class: 'seg-note' }, 'This clip is too short to fill the segment at this speed. Lower the speed or shorten the segment.'),
              h('form', {
                class: 'seg-bpm', onsubmit: (e: Event) => {
                  e.preventDefault();
                  const rate = speedForBpm(+bpmIn.value, store.getState().bpm());
                  if (rate !== null) setSpeed(rate, true, true);
                },
              }, h('label', {}, 'Original clip BPM', bpmIn), match),
              matchNote,
            ),
      );

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

      const appearances = tl.segs.filter((item) => item.clipId === seg.clipId);
      const appearanceNo = appearances.findIndex((item) => item.id === id) + 1;
      // Split, Repeat and Put a clip in reshape the timeline around this segment; the panel stays on it.
      const stay = () => {
        if (store.getState().selectedBlock !== id && segOf(id)) store.getState().selectBlock(id);
        render();
      };
      const family = (key: string, title: string, ...children: DomChild[]) => {
        const details = h('details', { class: 'edit-family seg-family', 'data-family': key, open: openFamilies.has(key) },
          h('summary', {}, title), h('div', { class: 'edit-family-body' }, ...children));
        details.addEventListener('toggle', () => { if ((details as HTMLDetailsElement).open) openFamilies.add(key); else openFamilies.delete(key); });
        return details;
      };
      host.replaceChildren(
        h('div', { class: 'seg-panel-bar' },
          peekWrap,
          h('div', { class: 'seg-identity' },
            h('span', { class: 'seg-index' }, String(si + 1).padStart(2, '0')),
            h('div', {}, h('h4', {}, `Segment ${si + 1}`, h('small', {}, ` of ${n}`)),
              h('span', { class: 'meta' }, `Clip ${s.selected.indexOf(seg.clipId) + 1} · appearance ${appearanceNo} of ${appearances.length}`))),
          h('button', { class: 'seg-x', type: 'button', title: 'Done: back to the whole edit (Esc)', 'aria-label': 'Done', onclick: () => s.selectBlock(null) }, '✕'),
          h('div', { class: 'seg-navigation', role: 'group', 'aria-label': 'Navigate segments' },
            h('button', { class: 'seg-step', type: 'button', title: 'Previous segment (←)', 'aria-label': 'Previous segment', disabled: n < 2, onclick: () => go(-1) }, '‹'),
            h('button', { class: 'seg-step', type: 'button', title: 'Next segment (→)', 'aria-label': 'Next segment', disabled: n < 2, onclick: () => go(1) }, '›')),
          h('span', { class: 'seg-where' }, where),
          h('div', { class: 'seg-panel-acts' },
            h('button', { class: 'seg-play', type: 'button', title: 'Play from a beat before the cut into this segment', onclick: playCut }, '▶ Play the cut'),
            h('button', { class: 'seg-auto', type: 'button', disabled: !any, title: 'Forget all custom settings for this segment', onclick: () => { s.clearBlock(id); render(); } }, '↺ Reset segment'))),
        family('timing', 'Timing & transition',
          timingSection(id, render, length),
          field('Transition in', 'trans', null,
            si === 0 && h('div', { class: 'seg-note' }, 'This cut joins the end of the loop back to its start.'),
            transitionHost),
          h('div', { class: 'seg-acts' },
            h('button', { type: 'button', title: 'Split at the playhead, or in half when the playhead is in another segment (B)', onclick: () => { s.splitBlockAt(id); stay(); } }, '✂ Split'),
            h('button', { type: 'button', title: 'Split in half and play the first half twice (⌘D)', onclick: () => { s.repeatSegment(id); stay(); } }, 'Repeat'),
            h('button', { type: 'button', class: choosing ? 'on' : '', title: 'Put another clip in the second half of this segment', onclick: () => { choosing = !choosing; render(); } }, 'Put a clip in'),
            h('button', { type: 'button', class: 'seg-del', disabled: n < 2, title: n < 2 ? 'The loop needs at least one segment' : 'Delete this segment. The one before it plays on to the next cut (Delete)', onclick: () => s.deleteBlock(id) }, 'Delete'),
            choosing && h('div', { class: 'seg-put' }, h('small', {}, 'Pick the clip for the second half'), clipTiles(null, (cid) => { choosing = false; s.insertClip(cid, { id }); stay(); })))),
        family('playback', 'Source & playback',
          field('Clip', 'clipId', null, clips, h('div', { class: 'seg-name' }, clipName(seg.clipId))),
          field('In-point', 'in', h('span', {}, inVal, h('small', {}, ` of ${dur.toFixed(1)} s`)), strip, slider,
            maxIn <= 0 && h('div', { class: 'seg-note' }, 'This clip is only just long enough to fill the segment.')),
          field('Direction', 'dir', null, chips(...DIRS.map(([key, label]) => chip(dirNow === key, label, () => pick({ dir: key }))))),
          speedField,
          field('Speed ramp', 'vel', null, chips(...Object.entries(VELOCITY).map(([key, value]) => chip(seg.vel === key, value.name, () => pick({ vel: key }), value.desc || 'Constant clip speed'))))),
        family('framing', 'Framing', framingSection(id, seg, block?.frame, edit, render)),
      );
      setPanelTarget({ id, transitionHost, onTransitionChange: (trans) => pick({ trans }) });
    };

    render();
    return detach;
  }

  /** Selects the segment `d` along from `id`, wrapping round the loop, and moves the playhead into it. */
  function step(id: string, d: number) {
    const s = store.getState();
    const segs = s.ctx?.tl.segs || [];
    const k = segs.findIndex((x) => x.id === id);
    const seg = segs[(k + d + segs.length) % segs.length];
    if (!seg) return;
    s.selectBlock(seg.id);
    s.transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
  }

  /** ← → while a segment's settings are showing: steps to the next or previous segment. Returns whether it did. */
  function stepSegment(d: number): boolean {
    if (!panelTarget || !segOf(panelTarget.id)) return false;
    step(panelTarget.id, d);
    return true;
  }

  /** Sizes the bar's copy of the preview to the preview's shape. */
  function sizePeek(peek: HTMLCanvasElement, view: HTMLCanvasElement) {
    const aspect = view.height ? view.width / view.height : 9 / 16;
    const w = Math.min(96, 68 * aspect);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    peek.width = Math.round(w * dpr);
    peek.height = Math.round((w / aspect) * dpr);
    peek.style.cssText = `width:${Math.round(w)}px;height:${Math.round(w / aspect)}px`;
  }

  /** Brings segment `id` into the inspector: selects it, moves the playhead into it and opens the Edit tab. A
   * double-click, right-click or long press on a block, Enter and the toolbar's Edit button all come here. */
  function revealSegment(id: string) {
    const s = store.getState();
    const seg = segOf(id);
    if (!s.ctx || !seg) return;
    s.selectBlock(id);
    s.transport.seek(seg.t0 + Math.min(seg.dur / 2, 0.25));
    if (s.tab !== 'edit') s.setTab('edit');
    const tab = typeof document === 'undefined' ? null : document.getElementById('inspector-tab-edit');
    tab?.scrollIntoView?.({ block: 'nearest' });
  }

  function dispose() { detachPanel?.(); }

  return { clipTiles, clipPicker, framingSection, mountSegmentPanel, revealSegment, stepSegment, dispose, getPanelTarget, subscribePanel };
}
