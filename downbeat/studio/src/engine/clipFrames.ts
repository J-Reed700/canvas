// Exports take every clip frame from /api/frames, where ffmpeg decodes the clip's playback copy. A
// <video> element seeked to a time doesn't promise to show that frame (Safari often keeps the old one),
// and that turned whole clips into stills. Decoding on the server gives the same frames in every browser.

/** Playback copies are constant 30 fps (media/proxy.py), so frame n starts at n / 30 s. */
export const CLIP_FPS = 30;
const BATCH = 30;
const KEEP = 3 * BATCH; // frames kept per clip, around the one in use
const BUDGET = 640 << 20; // bytes of frames kept across clips

/** The playback-copy frame on screen `time` seconds into a clip. */
export const frameIndex = (time: number): number => Math.max(0, Math.floor(time * CLIP_FPS + 1e-4));

export interface ClipFrame {
  clipId: string;
  /** The frame sent, after clamping to the clip's last frame. */
  idx: number;
  w: number;
  h: number;
  /** 8-bit 4:2:0 planes, Y then U then V, BT.709 full range, top row first. */
  data: Uint8Array;
  /** Hash of the frame: equal for identical pictures. */
  sig: number;
}

export interface FrameSource {
  /** Make sure the clip decodes, before any frame of the export is committed. */
  check(clipId: string, time: number): Promise<void>;
  /** `lane` names the cut asking (compose()'s vkey), so each one is read in its own direction. */
  get(clipId: string, time: number, lane?: string): Promise<ClipFrame>;
  /** The clip's last frame index, once known. */
  last(clipId: string): number | undefined;
}

type Batch = { first: number; total: number; w: number; h: number; frames: Uint8Array[] };

export function fnv(bytes: ArrayLike<number>, step: number = 1): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

export class ClipFrames implements FrameSource {
  name: (clipId: string) => string;
  totals = new Map<string, number>();
  /** Frames per request for each clip: the server sends fewer of a big clip's frames at a time. */
  batch = new Map<string, number>();
  cache = new Map<string, Map<number, Promise<ClipFrame>>>();
  bytes = new Map<string, number>();
  used = new Map<string, number>();
  prev = new Map<string, number>();
  requests = 0;
  clock = 0;

  constructor(name: (clipId: string) => string = (id) => id) {
    this.name = name;
  }

  last(clipId: string): number | undefined {
    const n = this.totals.get(clipId);
    return n === undefined ? undefined : n - 1;
  }

  async check(clipId: string, time: number): Promise<void> {
    await this._fetch(clipId, frameIndex(time), 1);
  }

  get(clipId: string, time: number, lane: string = clipId): Promise<ClipFrame> {
    let idx = frameIndex(time);
    const last = this.last(clipId);
    if (last !== undefined) idx = Math.min(idx, last);
    // reversed and ping-pong cuts walk backwards: fetch the frames before this one, not after
    const dir = idx < (this.prev.get(lane) ?? -1) ? -1 : 1;
    this.prev.set(lane, idx);
    this.used.set(clipId, ++this.clock);
    const p = this._frame(clipId, idx, dir);
    this._prefetch(clipId, idx, dir);
    return p;
  }

  _frame(clipId: string, idx: number, dir: number): Promise<ClipFrame> {
    const hit = this.cache.get(clipId)?.get(idx);
    if (hit) return hit;
    const n = this.batch.get(clipId) ?? BATCH;
    this._fetch(clipId, dir > 0 ? idx : Math.max(0, idx - n + 1), n);
    return this.cache.get(clipId)!.get(idx)!;
  }

  // Keep the next two requests' worth of frames on the way, so the export rarely waits for the server.
  _prefetch(clipId: string, idx: number, dir: number): void {
    const n = this.batch.get(clipId) ?? BATCH;
    const last = this.last(clipId);
    const have = this.cache.get(clipId);
    let at = idx;
    while (have?.has(at + dir)) at += dir;
    at += dir;
    if (Math.abs(at - idx) > 1.5 * n || at < 0 || (last !== undefined && at > last)) return;
    this._fetch(clipId, dir > 0 ? at : Math.max(0, at - n + 1), n).catch(() => {});
  }

  _fetch(clipId: string, start: number, n: number): Promise<Batch> {
    let have = this.cache.get(clipId);
    if (!have) this.cache.set(clipId, (have = new Map()));
    this.requests++;
    const batch: Promise<Batch> = fetch(`/api/frames/${encodeURIComponent(clipId)}?start=${start}&count=${n}`).then(async (res) => {
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({})))?.error;
        throw new Error(`${this.name(clipId)}: ${msg || `the server could not decode its frames (HTTP ${res.status})`}`);
      }
      const head = (k: string) => Number(res.headers.get(`X-Frame-${k}`));
      const [first, count, total, w, h] = ['Start', 'Count', 'Total', 'Width', 'Height'].map(head);
      const buf = await res.arrayBuffer();
      const size = (w * h * 3) / 2;
      if (![first, count, total, w, h].every(Number.isSafeInteger) || first < 0 || count < 1 || count > n ||
          total < 1 || first + count > total || first !== Math.min(start, total - 1) ||
          w < 2 || h < 2 || w % 2 !== 0 || h % 2 !== 0 || buf.byteLength !== count * size) {
        throw new Error(`${this.name(clipId)}: the server sent a broken frame batch`);
      }
      this.totals.set(clipId, total);
      if (count < n && first + count < total) this.batch.set(clipId, count);
      this.bytes.set(clipId, size);
      const frames = Array.from({ length: count }, (_, k) => new Uint8Array(buf, k * size, size));
      return { first, total, w, h, frames };
    });
    for (let i = start; i < start + n; i++) {
      if (have.has(i)) continue;
      const p: Promise<ClipFrame> = batch.then((b) => {
        const k = i - b.first;
        if (k >= b.frames.length && b.first + b.frames.length < b.total) {
          // the server sent fewer frames than asked for: ask again from here
          have!.delete(i);
          return this._frame(clipId, i, 1);
        }
        // past the end of the clip the last frame holds, just as the clip time is clamped
        const j = Math.min(Math.max(k, 0), b.frames.length - 1);
        const data = b.frames[j];
        return { clipId, idx: b.first + j, w: b.w, h: b.h, data, sig: fnv(data, 97) };
      });
      p.catch(() => have!.delete(i));
      have.set(i, p);
    }
    this._trim(clipId, start + n / 2);
    return batch;
  }

  // Keep a window of frames around the one in use, and drop whole clips that haven't been used lately
  // when the frames kept pass the budget.
  _trim(clipId: string, mid: number): void {
    const have = this.cache.get(clipId)!;
    if (have.size > KEEP) {
      const far = [...have.keys()].sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid));
      for (const k of far.slice(0, have.size - KEEP)) have.delete(k);
    }
    const kept = () => [...this.cache].reduce((s, [id, m]) => s + m.size * (this.bytes.get(id) ?? 0), 0);
    const idle = [...this.cache.keys()].filter((id) => id !== clipId).sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0));
    while (idle.length && kept() > BUDGET) this.cache.delete(idle.shift()!);
  }
}
