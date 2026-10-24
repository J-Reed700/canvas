// Web Audio transport and audio analysis modulation sources.
import type { LfoSpec, Look, Modulation, ModValues, SamplerOptions } from './types.ts';

export class Transport {
  ctx: AudioContext | null = null;
  buffer: AudioBuffer | null = null;
  gain: GainNode | null = null;
  node: AudioBufferSourceNode | null = null;
  mode: string = 'loop';
  playing: boolean = false;
  offset: number = 0;
  start: number = 0;
  len: number = 8;
  muted: boolean = false;
  phase: number = 0;
  trackId: string | null = null;
  t0: number = 0;
  private listeners = new Set<() => void>();

  // Lets the UI follow play/pause no matter who triggered it (Space, a button, an export).
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  _ensureCtx(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.gain.gain.value = this.muted ? 0 : 1;
    }
    return this.ctx;
  }

  async decode(url: string): Promise<AudioBuffer> {
    const ctx = this._ensureCtx();
    const data = await (await fetch(url)).arrayBuffer();
    return ctx.decodeAudioData(data);
  }

  setBuffer(buffer: AudioBuffer | null): void {
    if (buffer === this.buffer) return;
    const was = this.playing;
    if (was) this.pause();
    this.buffer = buffer;
    if (was) this.play();
  }

  async load(url: string): Promise<void> { this.setBuffer(await this.decode(url)); }

  unload(): void {
    this.trackId = null;
    const was = this.playing;
    if (was) this.pause();
    this.buffer = null;
    if (was) this.play();
  }

  setLoop(start: number, len: number): void {
    if (Math.abs(start - this.start) < 1e-9 && Math.abs(len - this.len) < 1e-9) return;
    const t = ((this.elapsed() % this.len) + this.len) % this.len;
    const was = this.playing;
    if (was) this.pause();
    this.start = start;
    this.len = len;
    this.offset = t % len;
    if (was) this.play();
  }

  setMode(mode: string): void {
    const was = this.playing;
    if (was) this.pause();
    this.mode = mode;
    this.offset %= this.len;
    if (was) this.play();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  latency(): number {
    return this.ctx ? ((this.ctx as any).outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
  }

  play(): void {
    if (this.playing) return;
    if (this.buffer) {
      const ctx = this._ensureCtx();
      ctx.resume();
      const node = ctx.createBufferSource();
      node.buffer = this.buffer;
      if (this.gain) node.connect(this.gain);
      const dur = this.buffer.duration;
      if (this.mode === 'loop') {
        node.loop = true;
        node.loopStart = Math.min(this.start, dur - 0.01);
        node.loopEnd = Math.min(this.start + this.len, dur);
        node.start(0, this.start + (this.offset % this.len));
      } else {
        node.start(0, Math.min(this.start + this.offset, dur - 0.01));
      }
      this.node = node;
      this.t0 = ctx.currentTime - this.offset;
    } else {
      // No song yet. Wake the audio from this press anyway: Safari only starts audio from a click or a key,
      // so a song that finishes loading while the clock runs would otherwise play silently.
      if (typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) this._ensureCtx().resume();
      this.t0 = performance.now() / 1000 - this.offset;
    }
    this.playing = true;
    this.listeners.forEach((fn) => fn());
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.elapsed();
    if (this.node) { try { this.node.stop(); } catch {} this.node.disconnect(); this.node = null; }
    this.playing = false;
    this.listeners.forEach((fn) => fn());
  }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  elapsed(): number {
    if (!this.playing) return this.offset;
    if (this.node && this.ctx) return Math.max(0, this.ctx.currentTime - this.t0 - this.latency());
    return performance.now() / 1000 - this.t0;
  }

  loopTime(): number {
    const e = this.elapsed() + (this.mode === 'listen' ? this.phase : 0);
    return ((e % this.len) + this.len) % this.len;
  }

  songTime(): number { return this.start + (this.mode === 'loop' ? this.loopTime() : this.elapsed()); }

  seek(loopT: number): void {
    const was = this.playing;
    if (was) this.pause();
    const ph = this.mode === 'listen' ? this.phase : 0;
    this.offset = ph ? (((loopT - ph) % this.len) + this.len) % this.len : Math.max(0, loopT);
    if (was) this.play();
  }
}

const fract = (x: number): number => x - Math.floor(x);
const hash = (n: number): number => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const smoothstep = (min: number, max: number, x: number): number => {
  const s = Math.max(0, Math.min(1, (x - min) / (max - min)));
  return s * s * (3 - 2 * s);
};

// Returns (loopTime) => modulation source values, all 0..1. Audio bands come from the
// server analysis (identical for preview and export); without a track they are synthesised.
export function makeSampler({ features, loopStart, beatDur, seed, L = beatDur * 16 }: SamplerOptions): (rawT: number) => ModValues {
  // whole cycles per loop for the multi-bar clocks
  const cyc = (beats: number): number => Math.max(1, Math.round(L / (beats * beatDur)));
  const curves = features?.curves;
  const fps = features?.fps || 30;
  // Song value at `s` seconds, read between analysis frames.
  const read = (c: number[], s: number): number => {
    const x = s * fps, i = Math.floor(x), f = x - i;
    const v0 = c[Math.min(c.length - 1, Math.max(0, i))] || 0;
    const v1 = c[Math.min(c.length - 1, Math.max(0, i + 1))] || 0;
    return v0 + (v1 - v0) * f;
  };
  // A loop often ends louder or quieter than it starts. Over its last bar the curves ease into the audio
  // just before the loop start, which arrives exactly at the start's values, and since the loop is whole
  // bars its kicks land on the same beats. A shorter fade snaps the zoom and glow back at the wrap.
  const wrapDur = Math.min(beatDur * 4, L * 0.25);
  const sample = (rawT: number): ModValues => {
    const t = L > 0 ? ((rawT % L) + L) % L : rawT;
    const beat = t / beatDur;
    const ph = fract(beat);
    const att = smoothstep(0, 0.05, ph);
    const u = t / L;
    let a: ModValues;
    if (curves) {
      const w = wrapDur > 0 && t > L - wrapDur ? smoothstep(L - wrapDur, L, t) : 0;
      a = {};
      for (const k in curves) {
        const v = read(curves[k], loopStart + t);
        a[k] = w ? v + (read(curves[k], loopStart + t - L) - v) * w : v;
      }
      if (a.vocals === undefined) a.vocals = 0.5 + 0.35 * Math.sin(Math.PI * 2 * u * cyc(8));
      if (a.presence === undefined) a.presence = 0.5 + 0.4 * Math.sin((Math.PI * 2 * t) / L);
    } else {
      const kick = att * Math.exp(-ph * 6);
      const phHats = fract(beat * 2);
      a = {
        kick,
        snare: Math.floor(beat) % 2 === 1 ? att * Math.exp(-ph * 7) : 0,
        hats: smoothstep(0, 0.05, phHats) * Math.exp(-phHats * 10) * 0.8,
        bass: 0.55 + 0.35 * kick,
        energy: 0.75,
        bright: 0.5,
        vocals: 0.5 + 0.35 * Math.sin(Math.PI * 2 * u * cyc(8)),
        presence: 0.5 + 0.4 * Math.sin((Math.PI * 2 * t) / L),
      };
    }
    a.beat = att * Math.exp(-ph * 5);
    const phOff = fract(beat + 0.5);
    a.off = smoothstep(0, 0.05, phOff) * Math.exp(-phOff * 6);
    const bPhase = fract(beat / 4);
    a.bar = bPhase > 0.92 ? bPhase * (1 - smoothstep(0.92, 1.0, bPhase)) : bPhase;
    a.lfoH = 0.5 + 0.5 * Math.sin((Math.PI * 2 * beat) / 2);
    a.lfo = 0.5 + 0.5 * Math.sin((Math.PI * 2 * beat) / 4);
    a.lfo2 = 0.5 + 0.5 * Math.sin(Math.PI * 2 * u * cyc(8));
    a.tri = 1 - Math.abs(2 * fract(beat / 4) - 1);
    a.arc = Math.sin(Math.PI * u) ** 2;
    const bld = u * u;
    a.build = u > 0.9 ? bld * (1 - smoothstep(0.9, 1.0, u)) : bld;
    a.rand = hash(Math.floor(beat) + seed * 0.013);
    return a;
  };
  // Integrate positive speed, never instantaneous energy * time: a quieter bar slows the motion
  // instead of sending it backward. Normalizing each integral to L keeps cyclic shaders seamless.
  // This fixed grid is shared by preview, seeking and export; it has no playback history.
  let clocks: [Float64Array, Float64Array] | undefined;
  const n = Math.max(2, Math.min(72000, Math.ceil(L * 120)));
  const clockAt = (t: number): [number, number] => {
    if (!clocks) {
      clocks = [new Float64Array(n + 1), new Float64Array(n + 1)];
      let prev = sample(0);
      for (let i = 1; i <= n; i++) {
        const next = sample(i * L / n);
        for (const [k, band] of ['energy', 'bass'].entries()) {
          const speed = (a: ModValues) => 0.1 + unit(a[band]);
          clocks[k][i] = clocks[k][i - 1] + (speed(prev) + speed(next)) / 2;
        }
        prev = next;
      }
    }
    const ratio = t / L;
    let cycle = Math.floor(ratio), phase = ratio - cycle;
    // Frame-time arithmetic can put an exact loop end a few ulps past the seam. Snap it so both the
    // accumulated clock and normalized phase land on their exact endpoint.
    if (phase < 1e-12) phase = 0;
    else if (1 - phase < 1e-12) { cycle += 1; phase = 0; }
    const x = phase * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
    return clocks.map((c) => cycle * L + ((c[i] + (c[i + 1] - c[i]) * f) / c[n]) * L) as [number, number];
  };
  return (t: number): ModValues => {
    const a = sample(t);
    const [audioTime, bassTime] = L > 0 ? clockAt(t) : [t, t];
    return { ...a, audioTime, bassTime, audioPhase: L > 0 ? fract(audioTime / L) : 0, bassPhase: L > 0 ? fract(bassTime / L) : 0 };
  };
}

const unit = (v: number | undefined): number => Number.isFinite(v) ? Math.min(1, Math.max(0, v!)) : 0;

type RouteTable = { values: Float32Array; bytes: number };
type RouteCache = { tables: Map<string, RouteTable>; bytes: number };
// A bounded cache belongs to a particular analysis/loop sampler. A new song or loop releases its
// tables. A value signature also notices mutable edits to envelope, macros and LFOs immediately.
const routeTables = new WeakMap<(t: number) => ModValues, RouteCache>();
const MAX_ROUTE_TABLES = 128;
const MAX_ROUTE_BYTES = 32 * 1024 * 1024;

/** A stateless route reader. Attack/decay are causal envelope followers, warmed on the preceding
 * loop before making a periodic lookup table. Calling frame 90 before frame 3 produces the same
 * values as linear playback, including a loop's first frame and the export warm-up. */
export function modulationAt(
  route: Modulation, sampler: (t: number) => ModValues, look: Look,
  t: number, L: number, beatDur: number, current: ModValues,
): number {
  const attack = Math.min(2000, Math.max(0, Number.isFinite(route.attack) ? route.attack! : 0)) / 1000;
  const decay = Math.min(5000, Math.max(0, Number.isFinite(route.decay) ? route.decay! : 0)) / 1000;
  const gate = unit(route.gate), duck = unit(route.duck?.amount);
  const gated = (v: number) => gate >= 1 || v <= gate ? 0 : (v - gate) / (1 - gate);
  if (!(attack || decay) || !(L > 0)) {
    // Preserve the exact original route value when shaping is disabled.
    const v = gate ? gated(unit(current[route.src])) : (current[route.src] ?? 0);
    return v * (1 - duck * unit(current[route.duck?.src || '']));
  }
  let cache = routeTables.get(sampler);
  if (!cache) { cache = { tables: new Map(), bytes: 0 }; routeTables.set(sampler, cache); }
  const key = JSON.stringify([L, beatDur, route.src, attack, decay, gate, route.duck?.src, duck, look.env, look.seq, look.macro, look.lfos]);
  let table = cache.tables.get(key);
  if (table) {
    // Map insertion order is the LRU queue. Refresh a hit so a rarely used preview route leaves before
    // the active look's working set does.
    cache.tables.delete(key);
    cache.tables.set(key, table);
  }
  if (!table) {
    // 120 Hz follows quick transients; the cap bounds memory even for a very long song.
    const n = Math.max(2, Math.min(72000, Math.ceil(L * 120))), dt = L / n;
    const source = new Float32Array(n), side = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i * dt;
      const v = withLook(sampler(s), look, s / L, s / beatDur, L / beatDur);
      source[i] = gated(unit(v[route.src]));
      side[i] = duck ? unit(v[route.duck?.src || '']) : 0;
    }
    const rising = attack ? Math.exp(-dt / attack) : 0, falling = decay ? Math.exp(-dt / decay) : 0;
    const follow = (prev: number, v: number) => v + (prev - v) * (v > prev ? rising : falling);
    let value = 0, sideValue = 0;
    // Fourteen time constants leaves < 0.000001 residual, even on a constant source.
    const warm = Math.ceil(14 * Math.max(attack, decay) / dt);
    for (let j = -warm; j < 0; j++) {
      const i = ((j % n) + n) % n;
      value = follow(value, source[i]); sideValue = follow(sideValue, side[i]);
    }
    const values = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      value = follow(value, source[i]); sideValue = follow(sideValue, side[i]);
      values[i] = value * (1 - duck * sideValue);
    }
    values[n] = values[0];
    table = { values, bytes: values.byteLength };
    while (cache.tables.size && (cache.tables.size >= MAX_ROUTE_TABLES || cache.bytes + table.bytes > MAX_ROUTE_BYTES)) {
      const oldest = cache.tables.keys().next().value!;
      cache.bytes -= cache.tables.get(oldest)!.bytes;
      cache.tables.delete(oldest);
    }
    cache.tables.set(key, table);
    cache.bytes += table.bytes;
  }
  const values = table.values, x = fract(t / L) * (values.length - 1), i = Math.floor(x);
  return values[i] + (values[i + 1] - values[i]) * (x - i);
}

export const SEQ_STEPS: number = 16;
export const ENV_POINTS: number = 16;
export const defaultSeq = (): number[] => [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1];
export const defaultEnv = (): number[] => Array.from({ length: ENV_POINTS }, (_, i) => +(0.5 - 0.5 * Math.cos((Math.PI * 2 * i) / ENV_POINTS)).toFixed(3));

// Envelope value at loop phase u: wrapping Catmull-Rom through the points, clamped to 0..1.
export function envAt(env: number[], u: number): number {
  const n = env.length, e = fract(u) * n, i = Math.floor(e), f = e - i;
  const P = (k: number): number => env[((i + k) % n + n) % n];
  const v = 0.5 * (2 * P(0) + (-P(-1) + P(1)) * f + (2 * P(-1) - 5 * P(0) + 4 * P(1) - P(2)) * f * f + (-P(-1) + 3 * P(0) - 3 * P(1) + P(2)) * f * f * f);
  return Math.min(1, Math.max(0, v));
}

export const LFO_SHAPES: [string, string][] = [
  ['sine', 'Sine'],
  ['tri', 'Triangle'],
  ['saw', 'Saw'],
  ['square', 'Square'],
  ['random', 'Random steps'],
  ['smooth', 'Smooth random'],
];
// Rate in bars; 0 is one cycle per loop.
export const LFO_RATES: [number, string][] = [
  [0.25, '¼'],
  [0.5, '½'],
  [1, '1'],
  [2, '2'],
  [4, '4'],
  [0, 'Loop'],
];
export const defaultLfos = (): LfoSpec[] => [
  { shape: 'sine', rate: 1, phase: 0, seed: 1 },
  { shape: 'tri', rate: 2, phase: 0, seed: 2 },
];
// Read-only defaults for looks that never set their own, so withLook allocates nothing per frame.
const DEFAULT_LFOS = defaultLfos();
const DEFAULT_SEQ = defaultSeq();
const DEFAULT_ENV = defaultEnv();

// Whole cycles an LFO makes per loop. A rate longer than the loop plays once per loop.
export const lfoCycles = (rate: number, loopBeats: number): number =>
  rate > 0 ? Math.max(1, Math.round(loopBeats / (rate * 4))) : 1;

// LFO value (0..1) at loop phase u. Every shape makes a whole number of cycles per loop and the random
// shapes reuse the same values each loop, so the seam never shows. Saw, square and random steps ease
// their jumps over 3% of a cycle so nothing hard-cuts from one frame to the next.
export function lfoAt(lfo: LfoSpec, u: number, loopBeats: number): number {
  const n = lfoCycles(lfo.rate, loopBeats);
  const x = fract(u) * n + (lfo.phase || 0);
  const i = Math.floor(x), p = x - i;
  const E = 0.03;
  const rnd = (k: number): number => hash((((k % n) + n) % n) * 7.13 + (lfo.seed || 0) * 1.37);
  switch (lfo.shape) {
    case 'tri': return 1 - Math.abs(2 * p - 1);
    case 'saw': return p < 1 - E ? p / (1 - E) : (1 - p) / E;
    case 'square': return smoothstep(0, E, p) * (1 - smoothstep(0.5, 0.5 + E, p));
    case 'random': return rnd(i - 1) + (rnd(i) - rnd(i - 1)) * smoothstep(0, E, p);
    case 'smooth': return rnd(i) + (rnd(i + 1) - rnd(i)) * (0.5 - 0.5 * Math.cos(Math.PI * p));
    default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
  }
}

// Per-look sources: two LFOs, a 16-step sequencer (one bar of 16ths), a drawn envelope across the whole
// loop (wrapping Catmull-Rom, so the seam is smooth) and two macro knobs. A step hit decays from the last
// lit step, wrapping round the bar, so it lasts a few frames and never cuts off at the next step.
export function withLook(mv: ModValues, look: Look, u: number, beat: number, loopBeats: number): ModValues {
  const lfos = look.lfos || DEFAULT_LFOS;
  const seq = look.seq || DEFAULT_SEQ;
  const x = fract(beat / 4) * SEQ_STEPS;
  const step = Math.floor(x);
  let since = -1;
  for (let k = 0; k < SEQ_STEPS && since < 0; k++) if (seq[(step - k + SEQ_STEPS) % SEQ_STEPS]) since = x - step + k;
  return {
    ...mv,
    seq: since < 0 ? 0 : Math.exp(-since * 1.2),
    env: envAt(look.env || DEFAULT_ENV, u),
    macroA: look.macro?.a ?? 0,
    macroB: look.macro?.b ?? 0,
    lfoA: lfoAt(lfos[0] || DEFAULT_LFOS[0], u, loopBeats),
    lfoB: lfoAt(lfos[1] || DEFAULT_LFOS[1], u, loopBeats),
  };
}
