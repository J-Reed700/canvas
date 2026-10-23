// Transport (sample-accurate Web Audio loop) + modulation sources from the server's audio analysis.

export class Transport {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.gain = null;
    this.node = null;
    this.mode = 'loop'; // 'loop' = hear exactly the slice that drives the canvas; 'listen' = song plays on
    this.playing = false;
    this.offset = 0; // elapsed seconds at pause
    this.start = 0; // song seconds where the loop starts
    this.len = 8;
    this.muted = false;
    this.phase = 0; // listen mode: canvas offset against the song (Spotify does not sync them)
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.gain.gain.value = this.muted ? 0 : 1;
    }
    return this.ctx;
  }

  async decode(url) {
    const ctx = this._ensureCtx();
    const data = await (await fetch(url)).arrayBuffer();
    return ctx.decodeAudioData(data);
  }

  setBuffer(buffer) {
    if (buffer === this.buffer) return;
    const was = this.playing;
    if (was) this.pause();
    this.buffer = buffer;
    if (was) this.play();
  }

  async load(url) { this.setBuffer(await this.decode(url)); }

  unload() {
    this.trackId = null;
    const was = this.playing;
    if (was) this.pause();
    this.buffer = null;
    if (was) this.play();
  }

  setLoop(start, len) {
    if (Math.abs(start - this.start) < 1e-9 && Math.abs(len - this.len) < 1e-9) return;
    const t = ((this.elapsed() % this.len) + this.len) % this.len;
    const was = this.playing;
    if (was) this.pause();
    this.start = start;
    this.len = len;
    this.offset = t % len;
    if (was) this.play();
  }

  setMode(mode) {
    const was = this.playing;
    if (was) this.pause();
    this.mode = mode;
    this.offset %= this.len;
    if (was) this.play();
  }

  setMuted(m) {
    this.muted = m;
    if (this.gain) this.gain.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  latency() {
    return this.ctx ? (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
  }

  play() {
    if (this.playing) return;
    if (this.buffer) {
      const ctx = this._ensureCtx();
      ctx.resume();
      const node = ctx.createBufferSource();
      node.buffer = this.buffer;
      node.connect(this.gain);
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
      this.t0 = performance.now() / 1000 - this.offset;
    }
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.elapsed();
    if (this.node) { try { this.node.stop(); } catch {} this.node.disconnect(); this.node = null; }
    this.playing = false;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  elapsed() {
    if (!this.playing) return this.offset;
    if (this.node) return Math.max(0, this.ctx.currentTime - this.t0 - this.latency());
    return performance.now() / 1000 - this.t0;
  }

  loopTime() {
    const e = this.elapsed() + (this.mode === 'listen' ? this.phase : 0);
    return ((e % this.len) + this.len) % this.len;
  }

  songTime() { return this.start + (this.mode === 'loop' ? this.loopTime() : this.elapsed()); }

  seek(loopT) {
    const was = this.playing;
    if (was) this.pause();
    const ph = this.mode === 'listen' ? this.phase : 0;
    this.offset = ph ? (((loopT - ph) % this.len) + this.len) % this.len : Math.max(0, loopT);
    if (was) this.play();
  }
}

const fract = (x) => x - Math.floor(x);
const hash = (n) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);

// Returns (loopTime) => modulation source values, all 0..1. Audio bands come from the
// server analysis (identical for preview and export); without a track they are synthesised.
export function makeSampler({ features, loopStart, beatDur, seed, L = beatDur * 16 }) {
  // whole cycles per loop for the multi-bar clocks
  const cyc = (beats) => Math.max(1, Math.round(L / (beats * beatDur)));
  const curves = features?.curves;
  const fps = features?.fps || 30;
  return (t) => {
    const beat = t / beatDur;
    const ph = fract(beat);
    let a;
    if (curves) {
      const x = (loopStart + t) * fps;
      const i = Math.floor(x), f = x - i;
      a = {};
      for (const k in curves) {
        const c = curves[k];
        const v0 = c[Math.min(c.length - 1, Math.max(0, i))] || 0;
        const v1 = c[Math.min(c.length - 1, Math.max(0, i + 1))] || 0;
        a[k] = v0 + (v1 - v0) * f;
      }
    } else {
      const kick = Math.exp(-ph * 6);
      a = {
        kick,
        snare: Math.floor(beat) % 2 === 1 ? Math.exp(-ph * 7) : 0,
        hats: Math.exp(-fract(beat * 2) * 10) * 0.8,
        bass: 0.55 + 0.35 * kick,
        energy: 0.75,
        bright: 0.5,
      };
    }
    const u = t / L;
    a.beat = Math.exp(-ph * 5);
    a.off = Math.exp(-fract(beat + 0.5) * 6);
    a.bar = fract(beat / 4);
    a.lfoH = 0.5 + 0.5 * Math.sin((Math.PI * 2 * beat) / 2);
    a.lfo = 0.5 + 0.5 * Math.sin((Math.PI * 2 * beat) / 4);
    a.lfo2 = 0.5 + 0.5 * Math.sin(Math.PI * 2 * u * cyc(8));
    a.tri = 1 - Math.abs(2 * fract(beat / 4) - 1);
    a.arc = Math.sin(Math.PI * u) ** 2;
    a.build = u * u;
    a.rand = hash(Math.floor(beat) + seed * 0.013);
    return a;
  };
}

export const SEQ_STEPS = 16;
export const ENV_POINTS = 16;
export const defaultSeq = () => [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1];
export const defaultEnv = () => Array.from({ length: ENV_POINTS }, (_, i) => +(0.5 - 0.5 * Math.cos((Math.PI * 2 * i) / ENV_POINTS)).toFixed(3));

// Envelope value at loop phase u: wrapping Catmull-Rom through the points, clamped to 0..1.
export function envAt(env, u) {
  const n = env.length, e = fract(u) * n, i = Math.floor(e), f = e - i;
  const P = (k) => env[((i + k) % n + n) % n];
  const v = 0.5 * (2 * P(0) + (-P(-1) + P(1)) * f + (2 * P(-1) - 5 * P(0) + 4 * P(1) - P(2)) * f * f + (-P(-1) + 3 * P(0) - 3 * P(1) + P(2)) * f * f * f);
  return Math.min(1, Math.max(0, v));
}

// Per-look sources: a 16-step sequencer (one bar of 16ths, each hit decaying), a drawn envelope
// across the whole loop (wrapping Catmull-Rom, so the seam is smooth) and two macro knobs.
export function withLook(mv, look, u, beat) {
  const seq = look.seq || defaultSeq();
  const x = fract(beat / 4) * SEQ_STEPS;
  const step = Math.floor(x);
  return {
    ...mv,
    seq: seq[step] ? Math.exp(-(x - step) * 2.5) : 0,
    env: envAt(look.env || defaultEnv(), u),
    macroA: look.macro?.a ?? 0,
    macroB: look.macro?.b ?? 0,
  };
}
