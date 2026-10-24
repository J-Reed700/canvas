// The segment menu's timing section: where a segment's two cuts sit and how long its transitions last,
// on a strip zoomed in on the segment and its neighbours, with steppers that move a cut along the snap grid.
import { useStudioStore } from '../state/store.ts';
import { h } from '../lib/utils.ts';
import { clamp } from '../engine/looks.ts';
import { MIN_BEATS, SNAPS, moveCut, segAt, snapBeat } from '../engine/blocks.ts';
import { editTime } from '../engine/timeline.ts';
import type { SnapDiv } from '../engine/blocks.ts';
import type { Segment } from '../engine/types.ts';

const st = () => useStudioStore.getState();
const EIGHTHS = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];

/** The segment playing block `id` in the edit as it is now. */
export const segOf = (id: string): Segment | undefined => useStudioStore.getState().ctx?.tl.segs.find((x) => x.id === id);

export const chip = (on: boolean, text: string, onclick: () => void, title = '') =>
  h('button', { class: on ? 'on' : '', title, onclick: () => !on && onclick() }, text);

export const chips = (...kids: (HTMLElement | boolean | null | undefined)[]) => h('div', { class: 'seg-chips' }, ...kids);

/** Where a beat of the loop falls, as "Bar 2, beat 3½". Between eighths it gives the beat to two places. */
export function beatName(beats: number): string {
  const q = Math.round(beats * 8);
  if (Math.abs(beats * 8 - q) < 0.05) {
    const bar = Math.floor(q / 32);
    const e = q - bar * 32;
    return `Bar ${bar + 1}, beat ${Math.floor(e / 8) + 1}${EIGHTHS[e % 8]}`;
  }
  const bar = Math.floor(beats / 4);
  return `Bar ${bar + 1}, beat ${(beats - bar * 4 + 1).toFixed(2)}`;
}

export const beatsText = (b: number) => `${+b.toFixed(2)} beat${Math.abs(b - 1) < 1e-9 ? '' : 's'}`;

const STEP_NAME: Record<SnapDiv, string> = { 1: 'a beat', 2: 'half a beat', 4: 'a quarter beat', 0: 'an eighth of a beat' };
const SNAP_TIP: Record<SnapDiv, string> = { 1: 'Cuts snap to the beat', 2: 'Cuts snap to half beats', 4: 'Cuts snap to quarter beats', 0: 'Cuts go anywhere' };

/** The next line of the snap grid from a beat, or an eighth of a beat on with the snap off. */
export function stepBeat(beat: number, dir: 1 | -1, div: SnapDiv): number {
  if (!div) return beat + dir * MIN_BEATS;
  const g = beat * div;
  return (dir > 0 ? Math.floor(g + 1e-6) + 1 : Math.ceil(g - 1e-6) - 1) / div;
}

// a segment on the strip, and where it sits in the strip's time: a copy round the seam is a loop early or late
type Shown = { seg: Segment; off: number };

/** The timing section of the menu for block `id`. `length` is the menu's transition length field, which goes
 * under the strip. `render` redraws the whole menu, once a drag ends. */
export function timingSection(id: string, render: () => void, length: HTMLElement): HTMLElement {
  const zoom = h('div', { class: 'seg-zoom', role: 'group', 'aria-label': 'The segment and its neighbours' });
  const tiles = h('div', { class: 'zl' });
  const marks = h('div', { class: 'zl' });
  const head = h('i', { class: 'zhead' });
  zoom.append(tiles, marks, head);
  const tileEls = new Map<string, HTMLElement>();

  const ctx = () => st().ctx!;
  // the strip works in edit time, so its length is the plan's: half the loop in a Rebound loop
  const span = () => ctx().tl.L;
  const now = () => ctx().tl.segs.find((x) => x.id === id)!;
  const blocks = () => st().blocks ?? ctx().tl.blocks;

  // The strip shows up to a bar either side, and at least two beats. It holds still while a drag is on, so
  // the cut under the pointer stays under it.
  let view = { lo: 0, hi: 1 };
  const frame = () => {
    const { beatDur: bd, tl } = ctx();
    const L = span();
    const seg = now();
    const n = tl.segs.length;
    if (n < 2) return { lo: 0, hi: L };
    const prev = tl.segs[(seg.i - 1 + n) % n];
    const next = tl.segs[(seg.i + 1) % n];
    const side = (d: number) => Math.max(2 * bd, Math.min(d, 4 * bd));
    return { lo: seg.t0 - side(prev.dur), hi: seg.t1 + side(next.dur) };
  };
  const at = (t: number) => ((t - view.lo) / (view.hi - view.lo)) * 100;
  const timeAt = (x: number) => {
    const r = zoom.getBoundingClientRect();
    return view.lo + clamp((x - r.left) / (r.width || 1), 0, 1) * (view.hi - view.lo);
  };

  // the segments in sight, with the copies a loop either side
  const shown = (): Shown[] => {
    const { tl } = ctx();
    const L = span();
    const out: Shown[] = [];
    // a Rebound loop turns round at its ends instead of starting over, so there's nothing to show past them
    for (const off of tl.rebound ? [0] : [-L, 0, L]) for (const seg of tl.segs) if (seg.t1 + off > view.lo && seg.t0 + off < view.hi) out.push({ seg, off });
    return out;
  };
  // the cut at the end of the segment, unless that's the loop seam
  const nextOf = (seg: Segment) => ctx().tl.segs[seg.i + 1] as Segment | undefined;

  // ---- dragging: a cut line, a band's edge, or the playhead ----
  type Drag = { kind: 'cut'; block: string } | { kind: 'len'; block: string; cut: number } | { kind: 'seek' };
  let drag: Drag | null = null;
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const s = st();
    const { beatDur: bd } = ctx();
    const L = span();
    const t = timeAt(e.clientX);
    if (drag.kind === 'cut') s.trimCut(drag.block, t / bd, e.shiftKey ? 0 : s.snap);
    else if (drag.kind === 'len') {
      const { block, cut } = drag;
      const beats = clamp(snapBeat((2 * Math.abs(t - cut)) / bd, e.shiftKey ? 0 : 4), 0.125, 8);
      const own = blocks().find((b) => b.id === block)?.transBeats;
      if (Math.abs(beats - (own ?? -1)) > 1e-9) s.setBlock(block, { transBeats: beats });
    } else s.transport.seek(((t % L) + L) % L);
    layout();
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    zoom.classList.remove('dragging');
    const was = drag;
    drag = null;
    if (was && was.kind !== 'seek') {
      st().save();
      render();
    }
  };
  const start = (d: Drag) => (e: PointerEvent) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = d;
    zoom.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    if (d.kind === 'seek') move(e);
  };
  zoom.onpointerdown = start({ kind: 'seek' });
  // a double-click splits the segment under it, on the snap grid
  zoom.ondblclick = (e: MouseEvent) => {
    const s = st();
    const { beatDur: bd, tl } = ctx();
    const L = span();
    const t = timeAt(e.clientX);
    const seg = segAt(tl, t);
    if (!seg) return;
    const local = (((t - seg.t0) % L) + L) % L;
    s.splitBlockAt(seg.id, snapBeat((seg.t0 + local) / bd, s.snap));
    render();
  };

  // ---- the steppers under the strip ----
  const nudge = (block: string, cut: () => number, dir: 1 | -1) => {
    const s = st();
    const { beatDur: bd } = ctx();
    const L = span();
    const to = stepBeat(cut() / bd, dir, s.snap);
    const cur = blocks();
    const next = moveCut(cur, block, to, s.snap, L / bd);
    return { ok: !!next && next !== cur, go: () => s.trimCut(block, to, s.snap) };
  };
  const stepper = (label: string, aria: string) => {
    const val = h('b', { class: 'seg-val' });
    const back = h('button', { class: 'seg-nudge', 'aria-label': `${aria} earlier` }, '‹') as HTMLButtonElement;
    const fwd = h('button', { class: 'seg-nudge', 'aria-label': `${aria} later` }, '›') as HTMLButtonElement;
    return { el: h('div', { class: 'seg-cut' }, h('span', { class: 'lbl' }, label), back, val, fwd), val, back, fwd };
  };
  const startStep = stepper('Starts', 'Move the start');
  const endStep = stepper('Ends', 'Move the end');
  const len = h('span', { class: 'seg-len' });
  const wire = (step: ReturnType<typeof stepper>, block: string | null, cut: () => number, seam: string) => {
    const s = st();
    step.val.textContent = block ? beatName(cut() / ctx().beatDur) : seam;
    for (const [btn, dir] of [[step.back, -1], [step.fwd, 1]] as const) {
      const n = block ? nudge(block, cut, dir) : null;
      btn.disabled = !n?.ok;
      btn.title = !block ? `The loop seam stays put. Pick another loop to move it.` : `${dir < 0 ? 'Earlier' : 'Later'} by ${STEP_NAME[s.snap]}`;
      btn.onclick = () => {
        if (!n?.ok) return;
        n.go();
        render();
      };
    }
  };

  // ---- drawing ----
  function layout() {
    const s = st();
    const { beatDur: bd } = ctx();
    const L = span();
    const seg = now();
    if (!seg) return;
    if (!drag) view = frame();
    const nx = nextOf(seg);

    // the blocks, each showing the frame it starts on
    const seen = new Set<string>();
    for (const { seg: sg, off } of shown()) {
      const key = `${sg.id}@${off}`;
      let el = tileEls.get(key);
      if (!el) {
        el = h('i', { class: 'zb' }, h('span'));
        tileEls.set(key, el);
        tiles.append(el);
      }
      const x0 = Math.max(0, at(sg.t0 + off)), x1 = Math.min(100, at(sg.t1 + off));
      el.className = `zb${sg.id === id && off === 0 ? ' on' : ''}`;
      el.style.cssText = `left:${x0}%;width:${x1 - x0}%;background-image:url(/api/thumb/${sg.clipId}?w=160&t=${sg.in.toFixed(2)})`;
      el.firstElementChild!.textContent = `#${s.selected.indexOf(sg.clipId) + 1}`;
      seen.add(key);
    }
    for (const [k, el] of tileEls) if (!seen.has(k)) (el.remove(), tileEls.delete(k));

    // the beat grid, the transitions' windows and the cut lines; this segment's two cuts and their windows can be dragged
    const kids: HTMLElement[] = [];
    const beats = Math.round(L / bd);
    const div = s.snap > 1 ? s.snap : 1;
    for (let k = Math.ceil((view.lo / bd) * div); k <= Math.floor((view.hi / bd) * div); k++) {
      const b = k / div;
      const onBeat = k % div === 0;
      const bar = onBeat && ((b % 4) + 4) % 4 === 0;
      kids.push(h('i', { class: `zt${bar ? ' bar' : onBeat ? '' : ' sub'}`, style: `left:${at(b * bd)}%` }, bar && h('small', {}, `${(((b % beats) + beats) % beats) / 4 + 1}`)));
    }
    for (const { seg: sg, off } of shown()) {
      const t = sg.t0 + off;
      const mine = off === 0 && (sg.id === id || sg.id === nx?.id);
      if (sg.transDur > 0) {
        kids.push(h('i', { class: 'zband', style: `left:${at(t - sg.transDur / 2)}%;width:${at(t + sg.transDur / 2) - at(t)}%` }));
        if (mine)
          for (const edge of [t - sg.transDur / 2, t + sg.transDur / 2])
            kids.push(h('i', { class: 'zedge', title: 'Drag to change how long the transition lasts', style: `left:${at(edge)}%`, onpointerdown: start({ kind: 'len', block: sg.id, cut: t }) }));
      }
      if (t > view.lo && t < view.hi) {
        const grab = mine && sg.i > 0;
        kids.push(
          grab
            ? h('button', {
                class: `zcut${sg.trans === 'cut' ? ' hard' : ''}`,
                'aria-label': sg.id === id ? 'The start cut' : 'The end cut',
                title: 'Drag to move this cut. Hold Shift to place it off the grid',
                style: `left:${at(t)}%`,
                onpointerdown: start({ kind: 'cut', block: sg.id }),
                onkeydown: (e: KeyboardEvent) => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  const n = nudge(sg.id, () => segOf(sg.id)!.t0, e.key === 'ArrowLeft' ? -1 : 1);
                  if (n.ok) n.go();
                  layout();
                },
              })
            : h('i', { class: `zline${sg.trans === 'cut' ? ' hard' : ''}${sg.i === 0 ? ' seam' : ''}`, style: `left:${at(t)}%` }),
        );
      }
    }
    // a focused grip keeps its focus through the redraw
    const focused = document.activeElement?.closest?.('.zcut')?.getAttribute('aria-label');
    marks.replaceChildren(...kids);
    if (focused) (marks.querySelector(`[aria-label="${focused}"]`) as HTMLElement | null)?.focus();

    wire(startStep, seg.i > 0 ? id : null, () => now().t0, 'Start of the loop');
    wire(endStep, nx ? nx.id : null, () => now().t1, 'End of the loop');
    len.textContent = `${seg.dur.toFixed(2)} s, ${beatsText(seg.dur / bd)}`;
    playhead();
  }

  function playhead() {
    const L = span();
    const t = editTime(ctx().tl, st().transport.loopTime()).t;
    const x = [t, t - L, t + L].find((v) => v >= view.lo && v <= view.hi);
    head.hidden = x == null;
    if (x != null) head.style.left = `${at(x)}%`;
  }
  const follow = () => {
    if (!zoom.closest('.pop.on')) return; // closed, or redrawn with a new strip
    if (st().ctx) playhead();
    requestAnimationFrame(follow);
  };

  const snapChips = h(
    'div',
    { class: 'seg-snap' },
    h('small', {}, 'Snap'),
    ...SNAPS.map(([d, label]) =>
      h('button', { class: st().snap === d ? 'on' : '', title: SNAP_TIP[d], onclick: () => { st().setSnap(d); render(); } }, label),
    ),
  );

  layout();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(follow);
  return h(
    'div',
    { class: 'seg-time' },
    h('div', { class: 'seg-l' }, h('span', {}, 'Timing'), snapChips),
    zoom,
    h('div', { class: 'seg-cuts' }, startStep.el, endStep.el, len),
    h('div', { class: 'seg-note' }, 'Drag a cut line to move it, or the edge of a pink band to change how long the transition lasts. Shift lets go of the grid. Click to move the playhead, double-click to split there.'),
    length,
  );
}
