// Frame-exact export: render every frame on the GPU, encode H.264 with WebCodecs (hardware),
// and let the server remux + verify. ProRes and the H.264 fallback stream raw native-size RGBA to
// ffmpeg, so a ProRes master never passes through a lossy browser encode or an upscale.
// Clip frames come from the server (clipFrames.ts), and checkFootage() fails an export whose clips froze.
import { MODULES } from './modules.ts';
import { compose } from './composer.ts';
import { checkFootage } from './footage.ts';
import type { FootageSample } from './footage.ts';
import type { ExportLoopOptions, RenderRecord } from './types.ts';

const CODECS: string[] = ['avc1.640034', 'avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0034', 'avc1.42E034'];

async function makeEncoder(
  w: number,
  h: number,
  fps: number,
  chunks: Uint8Array<ArrayBuffer>[],
  fail: (err: DOMException) => void,
  wantBitrate?: number,
): Promise<{ enc: VideoEncoder; codec: string } | null> {
  if (typeof window === 'undefined' || !('VideoEncoder' in window)) return null;
  const bitrate = wantBitrate || (w * h >= 1000 * 1800 ? 16_000_000 : 9_000_000);
  for (const codec of CODECS) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
      const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'annexb' }, latencyMode: 'quality', bitrateMode: 'variable', hardwareAcceleration };
      let enc: VideoEncoder | null = null;
      try {
        const { supported, config } = await window.VideoEncoder.isConfigSupported(cfg);
        if (!supported) continue;
        enc = new window.VideoEncoder({
          output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); chunks.push(b); },
          error: fail,
        });
        enc.configure(config ?? cfg);
        return { enc, codec };
      } catch {
        try { if (enc?.state !== 'closed') enc?.close(); } catch { /* failed candidates are discarded */ }
        /* try the next config */
      }
    }
  }
  return null;
}

const srgb2lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const LIN: Float32Array = Float32Array.from({ length: 256 }, (_, i) => srgb2lin(i / 255));

export interface Frame0Reference {
  id: string;
  name?: string;
  width: number;
  height: number;
  /** 36×64 RGBA, stored bottom-up to match WebGL readPixels. */
  pixels: Uint8Array;
}

export interface Frame0Check {
  level: 'ok' | 'warn';
  detail: string;
}

/** Honest, deliberately low-resolution visual QA: useful for catching the wrong cover or first cut. */
export function compareFrame0(rendered: Uint8Array | null, reference?: Frame0Reference, width = 9, height = 16): Frame0Check {
  if (!reference) return { level: 'warn', detail: 'No reference still selected; Frame 0 was rendered but could not be compared.' };
  if (!rendered || rendered.length !== reference.pixels.length) {
    return { level: 'warn', detail: `${reference.name || reference.id}: Frame 0 pixels were unavailable for comparison.` };
  }
  let delta = 0;
  let channels = 0;
  for (let i = 0; i < rendered.length; i += 4) {
    delta += Math.abs(rendered[i] - reference.pixels[i]);
    delta += Math.abs(rendered[i + 1] - reference.pixels[i + 1]);
    delta += Math.abs(rendered[i + 2] - reference.pixels[i + 2]);
    channels += 3;
  }
  const difference = delta / Math.max(1, channels) / 255;
  const expectedAspect = width / Math.max(1, height);
  const referenceAspect = reference.width / Math.max(1, reference.height);
  const aspectMismatch = Math.abs(referenceAspect / expectedAspect - 1) > 0.02;
  const similarity = Math.max(0, 100 * (1 - difference));
  const aspectNote = aspectMismatch ? `; reference is ${reference.width}×${reference.height}, export is ${width}×${height}` : '';
  return {
    level: difference <= 0.08 && !aspectMismatch ? 'ok' : 'warn',
    detail: `${reference.name || reference.id}: ${similarity.toFixed(1)}% mean RGB similarity${aspectNote}`,
  };
}

// Seam smoothness + WCAG-style flash counting from 36×64 thumbnails of every frame.
class Stats {
  first: Float32Array | null = null;
  firstPixels: Uint8Array | null = null;
  prev: Float32Array | null = null;
  steps: number[] = [];
  series: number[][] = [[], [], [], [], []];

  add(px: Uint8Array): void {
    if (!this.firstPixels) this.firstPixels = px.slice();
    const n = 36 * 64;
    const lumaD = new Float32Array(n);
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      lumaD[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const rel = 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
      const x = i % 36, y = Math.floor(i / 36);
      sums[0] += rel;
      sums[1 + (x < 18 ? 0 : 1) + (y < 32 ? 0 : 2)] += rel;
    }
    this.series[0].push(sums[0] / n);
    for (let q = 1; q < 5; q++) this.series[q].push(sums[q] / (n / 4));
    if (this.prev) this.steps.push(meanAbs(lumaD, this.prev));
    if (!this.first) this.first = lumaD;
    this.prev = lumaD;
  }
  result(fps: number): { seam_ratio: number; max_flashes_per_sec: number; mean_luminance: number } {
    // Compare the wrap-around step (last -> first frame) with the loop's own motion: a loop that
    // starts on a kick legitimately jumps there, just as it does on every other beat.
    const sorted = [...this.steps].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.floor(0.95 * (sorted.length - 1))] : 0;
    const seam = this.first && this.prev ? meanAbs(this.first, this.prev) : 0;
    return {
      seam_ratio: +(seam / Math.max(p95, 1e-4)).toFixed(3),
      max_flashes_per_sec: Math.max(...this.series.map((s) => flashesPerSecond([...s, ...s], fps))),
      mean_luminance: +(this.series[0].reduce((a, b) => a + b, 0) / Math.max(1, this.series[0].length)).toFixed(3),
    };
  }
}

function meanAbs(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// A flash = a pair of opposing relative-luminance changes of ≥ 0.1 where the darker state is < 0.8.
export function flashesPerSecond(series: number[], fps: number): number {
  const events: number[] = [];
  let peak = series[0], trough = series[0], dir = 0;
  for (let i = 1; i < series.length; i++) {
    const v = series[i];
    peak = Math.max(peak, v);
    trough = Math.min(trough, v);
    if (dir !== 1 && v - trough >= 0.1 && trough < 0.8) { events.push(i); dir = 1; peak = trough = v; }
    else if (dir !== -1 && peak - v >= 0.1 && v < 0.8) { events.push(i); dir = -1; peak = trough = v; }
  }
  let best = 0;
  for (let i = 0, j = 0; i < events.length; i++) {
    while (events[i] - events[j] >= fps) j++;
    best = Math.max(best, i - j + 1);
  }
  return Math.floor(best / 2);
}

interface ExportReply {
  ok?: boolean;
  error?: string;
  sid?: string;
  render?: RenderRecord;
}

async function boundedJSON(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ response: Response; body: ExportReply }> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason || new DOMException('Export cancelled', 'AbortError'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('The export server timed out', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const value: unknown = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw controller.signal.reason || error;
      return null;
    });
    const body = value && typeof value === 'object' && !Array.isArray(value) ? value as ExportReply : {};
    return { response, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** The timeout is a fallback for encoders that stop dispatching dequeue; either outcome releases both. */
function waitForEncoder(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      encoder.removeEventListener?.('dequeue', done);
      resolve();
    };
    const timer = setTimeout(done, 50);
    encoder.addEventListener?.('dequeue', done, { once: true });
  });
}

export async function exportLoop({ engine, frames, clips, ctx, width, height, fps = 30, bitrate, meta, onProgress, signal }: ExportLoopOptions): Promise<RenderRecord & { footage: ReturnType<typeof checkFootage> }> {
  const N = Math.round(ctx.L * fps);
  const stacks = [ctx.look, ...(ctx.clipLook ? ctx.tl.segs.map((s) => ctx.clipLook?.(s.clipId, s)).filter(Boolean) : [])];
  const hasFeedback = stacks.some((look) => look?.layers.some((l) => l.on !== false && MODULES[l.m]?.feedback));
  // Pre-roll the end of the loop so frame 0 inherits its feedback history. Feedback fades within a
  // few seconds, so long videos don't need a whole extra pass.
  const warm = hasFeedback ? Math.min(N, 10 * fps) : 12;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let encErr: DOMException | null = null;
  let made: { enc: VideoEncoder; codec: string } | null = null;
  let sid: string | undefined;
  let leave: (() => void) | undefined;
  const { frame0Reference, ...serverMeta } = meta;
  const outputCodec = serverMeta.codec || 'h264';
  if (!['h264', 'prores_422_hq', 'prores_4444'].includes(outputCodec)) throw new Error(`Unsupported export codec: ${outputCodec}`);
  const stats = new Stats();
  const footage: FootageSample[] = [];
  const t0 = performance.now();
  try {
    if (signal?.aborted) throw signal.reason || new DOMException('Export cancelled', 'AbortError');
    // WebCodecs only emits H.264 here. ProRes always takes native RGBA pixels from the GPU.
    made = outputCodec === 'h264' ? await makeEncoder(width, height, fps, chunks, (e) => { encErr = e; }, bitrate) : null;
    const encoderCodec = made?.codec || 'raw-rgba';
    // Either way the video streams to the server as it renders: encoded H.264 chunks, or raw RGBA
    // frames for ffmpeg. Nothing the length of the whole video is held in memory.
    const { response: begunResponse, body: begun } = await boundedJSON('/api/export/raw/begin', {
      method: 'POST',
      body: JSON.stringify({ ...serverMeta, width, height, fps, codec: outputCodec, stream_codec: encoderCodec, stream: made ? 'h264' : 'raw' }),
    }, 30_000, signal);
    if (!begunResponse.ok || !begun.ok || typeof begun.sid !== 'string' || !begun.sid) {
      throw new Error(begun.error || 'the server could not start the export');
    }
    const sessionId: string = begun.sid;
    sid = sessionId;
    // Closing or reloading the tab mid-export would otherwise leave the server waiting for frames.
    leave = () => navigator.sendBeacon(`/api/export/raw/abort?sid=${encodeURIComponent(sessionId)}`);
    globalThis.addEventListener?.('pagehide', leave);
    if (signal?.aborted) throw signal.reason || new DOMException('Export cancelled', 'AbortError');
    const send = async (body: BodyInit): Promise<void> => {
      const { response, body: reply } = await boundedJSON(`/api/export/raw/frames?sid=${encodeURIComponent(sessionId)}`, { method: 'POST', body }, 120_000, signal);
      if (!response.ok) throw new Error(reply.error || 'the server stopped taking frames');
    };
    const upload = async (): Promise<void> => {
      if (chunks.length) await send(new Blob(chunks.splice(0)));
    };

    // GPU allocation can fail at native 4K. It belongs after begin so the same cleanup path aborts
    // the server session, and inside the try so it cannot leave ffmpeg waiting for frames.
    engine.resize(width, height);
    engine.main.reset();
    // Every clip must decode before the first frame is committed: one check per clip, not per cut.
    const firstUse = new Map(ctx.tl.segs.map((s) => [s.clipId, s] as const));
    await Promise.all([...firstUse.values()].map((s) => frames.check(s.clipId, s.in)));
    const at = (j: number) => (((j / fps) % ctx.L) + ctx.L) % ctx.L;
    let fr = compose(ctx, at(-warm));
    for (let j = -warm; j < N; j++) {
      if (signal?.aborted) throw signal.reason || new DOMException('Export cancelled', 'AbortError');
      if (encErr) throw encErr;
      const got = await Promise.all(fr.needs.map((n) => frames.get(n.clipId, n.time, n.vkey)));
      engine.pruneFrames?.(fr.needs.map((n) => n.vkey));
      const sources = fr.needs.map((n, i) => ({ ...engine.frame(n.vkey, got[i]), cam: n.cam }));
      const out = engine.renderMain({ ...fr, sources });
      const needs = fr.needs;
      // ask for the next frame's pictures now, so the server decodes them while this one encodes
      fr = compose(ctx, at(j + 1));
      for (const n of fr.needs) frames.get(n.clipId, n.time, n.vkey).catch(() => {});
      if (j < 0) continue;
      if (made) {
        const vf = new window.VideoFrame(engine.canvas, { timestamp: Math.round((j * 1e6) / fps), duration: Math.round(1e6 / fps) });
        try {
          made.enc.encode(vf, { keyFrame: j % fps === 0 });
        } finally {
          vf.close();
        }
      } else {
        await send(engine.readFull());
      }
      const prints = engine.sourcePrints(needs.map((n) => n.vkey));
      needs.forEach((n, i) => footage.push({ frame: j, vkey: n.vkey, clipId: n.clipId, idx: got[i].idx, sig: got[i].sig, gpu: prints[i] }));
      stats.add(engine.readStats(out));
      if (made && made.enc.encodeQueueSize > 4) {
        await waitForEncoder(made.enc);
      }
      if (made && j % fps === fps - 1) await upload(); // about a second of video per request
      onProgress?.({ frame: j + 1, total: N, speed: ((j + 1) / fps) / ((performance.now() - t0) / 1000) });
    }
    if (made) {
      await made.enc.flush();
      made.enc.close();
      if (encErr) throw encErr;
      await upload();
    }
    if (signal?.aborted) throw signal.reason || new DOMException('Export cancelled', 'AbortError');
    const report = checkFootage(footage, (id) => ({ name: id, ...clips?.(id), last: frames.last(id) }), fps);
    const st = {
      ...stats.result(fps),
      frame0_reference: compareFrame0(stats.firstPixels, frame0Reference, width, height),
      footage: { level: report.level, detail: report.detail },
    };
    const { response: res, body: json } = await boundedJSON(`/api/export/raw/end?sid=${encodeURIComponent(sessionId)}`, {
      method: 'POST', body: JSON.stringify({ stats: st }),
    }, 600_000, signal);
    if (!res.ok || !json.ok || !json.render || typeof json.render.filename !== 'string') throw new Error(json.error || 'export failed');
    return { ...json.render, stats: st, footage: report, codec: encoderCodec, output_codec: outputCodec, seconds: (performance.now() - t0) / 1000 };
  } catch (err) {
    if (sid) await boundedJSON(`/api/export/raw/abort?sid=${encodeURIComponent(sid)}`, { method: 'POST' }, 10_000).catch(() => {});
    throw err;
  } finally {
    if (leave) globalThis.removeEventListener?.('pagehide', leave);
    try { if (made && made.enc.state !== 'closed') made.enc.close(); } catch { /* best-effort release after a failed export */ }
    engine.dropFrames?.();
  }
}
