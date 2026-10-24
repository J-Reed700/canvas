// Exports take every clip frame from /api/frames, where ffmpeg decodes the clip's playback copy. A
// <video> element seeked to a time doesn't promise to show that frame (Safari often keeps the old one),
// and that turned whole clips into stills. Decoding on the server gives the same frames in every browser.

/** Playback copies are constant 30 fps (media/proxy.py), so frame n starts at n / 30 s. */
export const CLIP_FPS = 30;
const BATCH = 30;
const KEEP = 4 * BATCH; // encoded frames kept per clip, around the one in use
const DECODED = 8; // decoded pictures kept, across clips

/** The playback-copy frame on screen `time` seconds into a clip. */
export const frameIndex = (time: number): number => Math.max(0, Math.floor(time * CLIP_FPS + 1e-4));

export interface ClipFrame {
  clipId: string;
  /** The frame decoded, after clamping to the clip's last frame. */
  idx: number;
  img: TexImageSource;
  w: number;
  h: number;
  /** Hash of the encoded frame: equal for identical pictures. */
  sig: number;
}

export interface FrameSource {
  /** `lane` names the cut asking (compose()'s vkey), so each one is read in its own direction. */
  get(clipId: string, time: number, lane?: string): Promise<ClipFrame>;
  /** The clip's last frame index, once known. */
  last(clipId: string): number | undefined;
}

type Encoded = { idx: number; bytes: Uint8Array; sig: number };

export function fnv(bytes: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

/** Split the server's reply: each JPEG with its length in front (4 bytes, big-endian). */
export function unpack(buf: ArrayBuffer): Uint8Array[] {
  const view = new DataView(buf);
  const out: Uint8Array[] = [];
  for (let at = 0; at + 4 <= buf.byteLength;) {
    const n = view.getUint32(at);
    at += 4;
    if (at + n > buf.byteLength) throw new Error('the frame data was cut short');
    out.push(new Uint8Array(buf, at, n));
    at += n;
  }
  return out;
}

async function decodeJpeg(bytes: Uint8Array): Promise<{ img: HTMLImageElement; w: number; h: number }> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  return { img, w: img.naturalWidth, h: img.naturalHeight };
}

export class ClipFrames implements FrameSource {
  name: (clipId: string) => string;
  decode: (bytes: Uint8Array) => Promise<{ img: TexImageSource; w: number; h: number }>;
  totals = new Map<string, number>();
  encoded = new Map<string, Map<number, Promise<Encoded>>>();
  decoded = new Map<string, Promise<ClipFrame>>();
  prev = new Map<string, number>();
  requests = 0;

  constructor(name: (clipId: string) => string = (id) => id, decode = decodeJpeg) {
    this.name = name;
    this.decode = decode;
  }

  last(clipId: string): number | undefined {
    const n = this.totals.get(clipId);
    return n === undefined ? undefined : n - 1;
  }

  async get(clipId: string, time: number, lane: string = clipId): Promise<ClipFrame> {
    let idx = frameIndex(time);
    const last = this.last(clipId);
    if (last !== undefined) idx = Math.min(idx, last);
    // reversed and ping-pong cuts walk backwards: fetch the frames before this one, not after
    const dir = idx < (this.prev.get(lane) ?? -1) ? -1 : 1;
    this.prev.set(lane, idx);
    const enc = this._encoded(clipId, idx, dir);
    this._prefetch(clipId, idx, dir);
    const key = `${clipId}:${idx}`;
    let p = this.decoded.get(key);
    if (!p) {
      p = enc.then(async (e) => ({ clipId, idx: e.idx, sig: e.sig, ...(await this.decode(e.bytes)) }));
      this.decoded.set(key, p);
      p.catch(() => this.decoded.delete(key));
      while (this.decoded.size > DECODED) this.decoded.delete(this.decoded.keys().next().value as string);
    }
    return p;
  }

  _encoded(clipId: string, idx: number, dir: number): Promise<Encoded> {
    const have = this.encoded.get(clipId);
    const hit = have?.get(idx);
    if (hit) return hit;
    this._fetch(clipId, dir > 0 ? idx : Math.max(0, idx - BATCH + 1));
    return this.encoded.get(clipId)!.get(idx)!;
  }

  _prefetch(clipId: string, idx: number, dir: number): void {
    const ahead = idx + dir * (BATCH >> 1);
    const last = this.last(clipId);
    if (ahead < 0 || (last !== undefined && ahead > last)) return;
    if (this.encoded.get(clipId)?.has(ahead)) return;
    // start where the frames we have run out
    let from = idx;
    while (this.encoded.get(clipId)?.has(from + dir)) from += dir;
    from += dir;
    this._fetch(clipId, dir > 0 ? from : Math.max(0, from - BATCH + 1)).catch(() => {});
  }

  _fetch(clipId: string, start: number): Promise<unknown> {
    let have = this.encoded.get(clipId);
    if (!have) this.encoded.set(clipId, (have = new Map()));
    this.requests++;
    const batch = fetch(`/api/frames/${encodeURIComponent(clipId)}?start=${start}&count=${BATCH}`).then(async (res) => {
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({})))?.error;
        throw new Error(`${this.name(clipId)}: ${msg || `the server could not decode its frames (HTTP ${res.status})`}`);
      }
      const total = Number(res.headers.get('X-Frame-Total'));
      const first = Number(res.headers.get('X-Frame-Start'));
      if (total > 0) this.totals.set(clipId, total);
      const frames = unpack(await res.arrayBuffer());
      if (!frames.length) throw new Error(`${this.name(clipId)}: the server sent no frames`);
      return { first, frames };
    });
    for (let i = start; i < start + BATCH; i++) {
      if (have.has(i)) continue;
      const p = batch.then(({ first, frames }) => {
        // past the end of the clip the last frame holds, just as the clip time is clamped
        const k = Math.min(Math.max(i - first, 0), frames.length - 1);
        return { idx: first + k, bytes: frames[k], sig: fnv(frames[k]) };
      });
      p.catch(() => have!.delete(i));
      have.set(i, p);
    }
    // keep a window around the frames in use; drop the ones furthest from this batch
    if (have.size > KEEP) {
      const mid = start + BATCH / 2;
      const far = [...have.keys()].sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid));
      for (const k of far.slice(0, have.size - KEEP)) have.delete(k);
    }
    return batch;
  }
}
