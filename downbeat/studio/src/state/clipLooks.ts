import { LOOKS, evolveLook } from '../engine/looks.ts';
import { rng } from '../engine/timeline.ts';
import type { Look, RollStyle, Segment } from '../engine/types.ts';

/** The look policy depends only on edit data, not React, the GPU or HTTP services. */
export interface ClipLookState {
  version: number;
  look: Look | null;
  lookId: string | null;
  saved: Look[];
  selected: string[];
  clipMode: string;
  evolveCuts: boolean;
  evolveAmt: number;
  seed: number;
  clipLooks: Record<string, Look>;
  editClip: string | null;
  rollStyle?: RollStyle;
}

export class ClipLookResolver {
  private version = -1;
  private looks = new Map<string, Look>();
  private filled = false;
  private readonly catalog: readonly Look[];

  constructor(catalog: readonly Look[] = LOOKS) { this.catalog = catalog; }

  resolve(state: ClipLookState, id: string, seg?: Segment): Look {
    const main = state.look || LOOKS[0];
    if (!state.look || state.clipMode === 'one') return main;
    if (this.version !== state.version) {
      this.version = state.version;
      this.looks.clear();
      this.filled = false;
    }
    if (state.clipMode === 'evolve' && state.evolveCuts) {
      if (!seg?.i) return main;
      const key = `#${seg.i}`;
      let look = this.looks.get(key);
      if (!look) {
        look = evolveLook(main, state.evolveAmt, state.seed * 31 + seg.i * 7919 + 17);
        this.looks.set(key, look);
      }
      return look;
    }
    if (!this.filled) {
      this.filled = true;
      if (state.clipMode === 'evolve') {
        state.selected.forEach((clip, i) => {
          if (i) this.looks.set(clip, evolveLook(main, state.evolveAmt, state.seed * 31 + i * 7919));
        });
      } else if (state.clipMode === 'cycle') {
        const random = rng(state.seed + 99);
        const base = state.lookId?.replace(/^edit:/, '');
        const style = state.rollStyle && state.rollStyle !== 'balanced' ? state.rollStyle : main.style;
        const pool = [...state.saved, ...this.catalog].filter((look) => look.id !== base && look.id !== 'clean' &&
          (!style || style === 'experimental' || look.style === style));
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        state.selected.forEach((clip, i) => {
          if (i && pool.length) this.looks.set(clip, pool[(i - 1) % pool.length]);
        });
      } else if (state.clipMode === 'custom') {
        state.selected.forEach((clip) => {
          if (state.clipLooks[clip]) this.looks.set(clip, state.clipLooks[clip]);
        });
      }
    }
    return this.looks.get(id) || main;
  }
}

export function editingLook(state: ClipLookState): Look {
  if (!state.look) return LOOKS[0];
  if (state.clipMode === 'custom' && state.editClip && state.selected.includes(state.editClip)) {
    return state.clipLooks[state.editClip] || state.look || LOOKS[0];
  }
  return state.look || LOOKS[0];
}
