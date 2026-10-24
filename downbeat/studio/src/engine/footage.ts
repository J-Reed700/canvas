// Did the footage in an export actually play? The exporter records, for every frame it renders, which
// clip frame each cut asked for, a hash of the picture the server decoded, and a hash of what landed on
// the GPU. A cut that shows one picture for a long stretch fails the export, with the reason.

import { CLIP_FPS } from './clipFrames.ts';

export interface FootageSample {
  /** Output frame number. */
  frame: number;
  /** The cut (one per clip and timeline slot), from compose(): `${clipId}#${key}`. */
  vkey: string;
  clipId: string;
  /** Clip frame asked for. */
  idx: number;
  /** Hash of the decoded frame. */
  sig: number;
  /** Hash of the clip's texture after the upload. */
  gpu: number;
}

export interface FootageIssue {
  level: 'fail' | 'warn';
  /** The clip's name. */
  clip: string;
  /** Output seconds where it starts, and how long it lasts. */
  at: number;
  secs: number;
  why: string;
}

export interface FootageReport {
  level: 'ok' | 'warn' | 'fail';
  detail: string;
  issues: FootageIssue[];
  cuts: number;
}

export interface FootageClip {
  name: string;
  still?: boolean;
  /** The clip's last frame, when known. */
  last?: number;
}

// A cut may hold a frame on purpose (Hold & jump holds half a beat; the slowest speed with Surge
// moves a frame about every 0.9 s), so only a longer hold counts.
export const HOLD_LIMIT = 1.5;

const clock = (s: number): string => {
  const t = Math.round(s * 10) / 10;
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
};

/** Group samples into stretches of consecutive output frames that show the same cut. */
function runs(samples: FootageSample[]): FootageSample[][] {
  const byKey = new Map<string, FootageSample[]>();
  for (const s of samples) {
    let list = byKey.get(s.vkey);
    if (!list) byKey.set(s.vkey, (list = []));
    list.push(s);
  }
  const out: FootageSample[][] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.frame - b.frame);
    let cur: FootageSample[] = [];
    for (const s of list) {
      if (cur.length && s.frame !== cur[cur.length - 1].frame + 1) { out.push(cur); cur = []; }
      cur.push(s);
    }
    if (cur.length) out.push(cur);
  }
  return out.sort((a, b) => a[0].frame - b[0].frame);
}

/** The longest stretch of the run where `same(prev, cur)` holds for every step. */
function longest(run: FootageSample[], same: (a: FootageSample, b: FootageSample) => boolean): [number, number] {
  let best: [number, number] = [0, 0];
  let from = 0;
  for (let i = 1; i <= run.length; i++) {
    if (i === run.length || !same(run[i - 1], run[i])) {
      if (i - from > best[1] - best[0]) best = [from, i];
      from = i;
    }
  }
  return best;
}

export function checkFootage(samples: FootageSample[], clips: (id: string) => FootageClip, fps: number = 30): FootageReport {
  const issues: FootageIssue[] = [];
  const limit = Math.round(HOLD_LIMIT * fps);
  const all = runs(samples);
  for (const run of all) {
    const c = clips(run[0].clipId);
    if (c.still) continue; // a photo is meant to stand still
    const span = (a: number, b: number) => ({ at: run[a].frame / fps, secs: (b - a) / fps });

    // 1. The edit itself asks for one frame the whole time.
    const [a, b] = longest(run, (p, q) => p.idx === q.idx);
    if (b - a >= limit) {
      const idx = run[a].idx;
      const where = clock(idx / CLIP_FPS);
      const why = c.last !== undefined && idx >= c.last
        ? `starts or runs past the end of ${c.name}'s footage (${where}) and holds its last frame. Exports use the first 60 s of a clip; pick an earlier start point`
        : idx === 0
          ? `holds the first frame of ${c.name}: the cut runs backwards past the clip's start, or its speed stops the footage`
          : `holds frame ${where} of ${c.name}: the speed settings for this cut stop the footage`;
      issues.push({ level: 'fail', clip: c.name, ...span(a, b), why });
      continue;
    }

    // 2. New frames were decoded but the picture on the GPU didn't change: the upload is stale.
    const [d, e] = longest(run, (p, q) => p.gpu === q.gpu);
    const changed = new Set(run.slice(d, e).map((s) => s.sig)).size;
    if (e - d >= limit && changed >= 3) {
      issues.push({ level: 'fail', clip: c.name, ...span(d, e), why: `${changed} different frames of ${c.name} were decoded, but the browser kept drawing the same picture` });
      continue;
    }

    // 3. The clip moves on, but its pictures are identical: the footage itself is still there.
    const [f, g] = longest(run, (p, q) => p.sig === q.sig);
    if (g - f >= limit) {
      issues.push({ level: 'warn', clip: c.name, ...span(f, g), why: `${c.name} itself doesn't change from ${clock(run[f].idx / CLIP_FPS)} to ${clock(run[g - 1].idx / CLIP_FPS)}` });
    }
  }
  const fails = issues.filter((i) => i.level === 'fail');
  const level = fails.length ? 'fail' : issues.length ? 'warn' : 'ok';
  const shown = (fails.length ? fails : issues).slice(0, 3)
    .map((i) => `${clock(i.at)} for ${i.secs.toFixed(1)} s: ${i.why}`);
  const more = (fails.length || issues.length) - shown.length;
  const detail = level === 'ok'
    ? `checked ${all.length} cut${all.length === 1 ? '' : 's'}: every clip plays`
    : `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
  return { level, detail, issues, cuts: all.length };
}
