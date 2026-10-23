// Frame-exact export: render every frame on the GPU, encode H.264 with WebCodecs (hardware),
// and let the server remux + verify. Falls back to streaming raw RGBA frames to ffmpeg.
import { MODULES } from './modules.js';
import { compose } from './composer.js';

const CODECS = ['avc1.640034', 'avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0034', 'avc1.42E034'];

async function makeEncoder(w, h, fps, chunks, fail, wantBitrate) {
  if (!('VideoEncoder' in window)) return null;
  const bitrate = wantBitrate || (w * h >= 1000 * 1800 ? 16_000_000 : 9_000_000);
  for (const codec of CODECS) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'annexb' }, latencyMode: 'quality', bitrateMode: 'variable', hardwareAcceleration };
      try {
        const { supported, config } = await VideoEncoder.isConfigSupported(cfg);
        if (!supported) continue;
        const enc = new VideoEncoder({
          output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); chunks.push(b); },
          error: fail,
        });
        enc.configure(config);
        return { enc, codec };
      } catch { /* try the next config */ }
    }
  }
  return null;
}

const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const LIN = Float32Array.from({ length: 256 }, (_, i) => srgb2lin(i / 255));

// Seam smoothness + WCAG-style flash counting from 36×64 thumbnails of every frame.
class Stats {
  constructor() { this.first = null; this.prev = null; this.steps = []; this.series = [[], [], [], [], []]; }
  add(px) {
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
  result(fps) {
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

function meanAbs(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// A flash = a pair of opposing relative-luminance changes of ≥ 0.1 where the darker state is < 0.8.
export function flashesPerSecond(series, fps) {
  const events = [];
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

export async function exportLoop({ engine, bank, ctx, width, height, fps = 30, bitrate, meta, onProgress, signal }) {
  const N = Math.round(ctx.L * fps);
  const stacks = [ctx.look, ...(ctx.clipLook ? ctx.tl.segs.map((s) => ctx.clipLook(s.clipId)) : [])];
  const hasFeedback = stacks.some((look) => look.layers.some((l) => l.on !== false && MODULES[l.m]?.feedback));
  const warm = hasFeedback ? N : 12; // pre-roll a full loop so frame 0 inherits the end's feedback history
  const chunks = [];
  let encErr = null;
  const made = await makeEncoder(width, height, fps, chunks, (e) => { encErr = e; }, bitrate);
  let raw = null;
  if (!made) {
    const r = await fetch('/api/export/raw/begin', { method: 'POST', body: JSON.stringify({ ...meta, width, height, fps }) });
    raw = (await r.json()).sid;
  }
  engine.resize(width, height);
  engine.main.reset();
  const stats = new Stats();
  const t0 = performance.now();
  try {
  // Every clip must be decodable before the first frame is committed.
  for (const s of ctx.tl.segs) await bank.exact([{ vkey: `${s.clipId}#${s.i}`, clipId: s.clipId, time: s.in }]);
  for (let j = -warm; j < N; j++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    if (encErr) throw encErr;
    const t = (((j / fps) % ctx.L) + ctx.L) % ctx.L;
    const fr = compose(ctx, t);
    await bank.exact(fr.needs);
    const sources = fr.needs.map((n) => ({ ...engine.video(n.vkey, bank.get(n.vkey, n.clipId), true), cam: n.cam }));
    const out = engine.renderMain({ ...fr, sources });
    if (j < 0) continue;
    if (made) {
      const vf = new VideoFrame(engine.canvas, { timestamp: Math.round((j * 1e6) / fps), duration: Math.round(1e6 / fps) });
      made.enc.encode(vf, { keyFrame: j % fps === 0 });
      vf.close();
    } else {
      const px = engine.readFull();
      await fetch(`/api/export/raw/frames?sid=${encodeURIComponent(raw)}`, { method: 'POST', body: px });
    }
    stats.add(engine.readStats(out));
    if (made && made.enc.encodeQueueSize > 4) {
      await new Promise((r) => { made.enc.addEventListener?.('dequeue', r, { once: true }); setTimeout(r, 50); });
    }
    onProgress?.({ frame: j + 1, total: N, speed: ((j + 1) / fps) / ((performance.now() - t0) / 1000) });
  }
  } catch (err) {
    if (made && made.enc.state !== 'closed') made.enc.close();
    if (raw) fetch(`/api/export/raw/abort?sid=${encodeURIComponent(raw)}`, { method: 'POST' }).catch(() => {});
    throw err;
  }
  const st = stats.result(fps);
  const fullMeta = { ...meta, width, height, fps, stats: st, codec: made?.codec || 'raw-rgba' };
  let res;
  if (made) {
    await made.enc.flush();
    made.enc.close();
    if (encErr) throw encErr;
    res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'X-Export-Meta': encodeURIComponent(JSON.stringify(fullMeta)), 'Content-Type': 'application/octet-stream' },
      body: new Blob(chunks),
    });
  } else {
    res = await fetch(`/api/export/raw/end?sid=${encodeURIComponent(raw)}`, { method: 'POST', body: JSON.stringify({ stats: st }) });
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'export failed');
  return { ...json.render, stats: st, codec: fullMeta.codec, seconds: (performance.now() - t0) / 1000 };
}
