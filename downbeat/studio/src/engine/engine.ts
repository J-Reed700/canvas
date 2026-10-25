// Downbeat GPU engine: WebGL2 render graph shared by the live preview, the look
// thumbnails and the frame-exact exporter (so preview == export).
import * as S from './shaders.ts';
import { MODULES, moduleSource } from './modules.ts';
import { fnv } from './clipFrames.ts';
import { IDENTITY_LUT, lutValues, type CubeLut } from './lut.ts';
import type { ComposedFrame, ComposedLayer, ComposedSource, ProgramInfo, RenderTarget, Samplers, TextureSource, Uniforms } from './types.ts';

const GUARD_LIMIT = 18 / 255; // max mean-luma change per frame (display space), same limit as the CPU engine
const HISTORY_BYTES = 512 * 1024 * 1024;

interface VideoTexture extends TextureSource {
  vw: number;
  vh: number;
  stamp: number;
  el: HTMLVideoElement | null;
  print?: number;
}

interface FrameTexture extends TextureSource {
  rt: RenderTarget;
  y: WebGLTexture;
  u: WebGLTexture;
  v: WebGLTexture;
  vw: number;
  vh: number;
  stamp: string;
  print?: number;
}

// WebGL allocation errors are flags, not JavaScript exceptions. Scope checks to a fresh allocation
// so an unrelated earlier error cannot cause us to cache an incomplete texture or misreport its cause.
function clearGlErrors(gl: WebGL2RenderingContext): void {
  for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) { /* bounded even after context loss */ }
}

function checkGlAllocation(gl: WebGL2RenderingContext, label: string): void {
  if (gl.getError() !== gl.NO_ERROR) throw new Error(`The GPU could not allocate ${label}. Close other graphics apps or choose a smaller export.`);
}

export class GPU {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  hdr: boolean;
  programs: Map<string, ProgramInfo>;
  vert: WebGLShader;
  black: RenderTarget;
  private luts = new Map<CubeLut, { tex: WebGLTexture; target: number }>();
  private vertexArray: WebGLVertexArrayObject | null;
  private vertexBuffer: WebGLBuffer | null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    }) as WebGL2RenderingContext;
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.programs = new Map();
    const vao = gl.createVertexArray();
    this.vertexArray = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    this.vertexBuffer = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vert = this._shader(gl.VERTEX_SHADER, S.VERT);
    this.black = this.target(1, 1, { float: false });
  }

  _shader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error('Failed to create shader');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log || 'Shader compilation failed');
    }
    return sh;
  }

  program(key: string, fragSrc: string): ProgramInfo {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    let frag: WebGLShader;
    try {
      frag = this._shader(gl.FRAGMENT_SHADER, fragSrc);
    } catch (err) {
      throw new Error(`shader "${key}" failed to compile:\n${err instanceof Error ? err.message : String(err)}`);
    }
    const prog = gl.createProgram();
    if (!prog) { gl.deleteShader(frag); throw new Error('Failed to create program'); }
    gl.attachShader(prog, this.vert);
    gl.attachShader(prog, frag);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.detachShader(prog, frag);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`program "${key}" failed to link: ${log}`);
    }
    const locs = new Map<string, WebGLUniformLocation | null>();
    p = { prog, loc: (n: string) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(prog, n)); return locs.get(n) ?? null; } };
    this.programs.set(key, p);
    return p;
  }

  assertSize(w: number, h: number): void {
    if (this.gl.isContextLost()) throw new Error('The graphics context was lost. Reload the studio to restart the preview.');
    const limit = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > limit || h > limit) {
      throw new Error(`This GPU cannot render ${w}×${h}. Its maximum texture side is ${limit} pixels.`);
    }
  }

  target(w: number, h: number, { float = true, mips = false }: { float?: boolean; mips?: boolean } = {}): RenderTarget {
    const gl = this.gl;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    this.assertSize(w, h);
    clearGlErrors(gl);
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    let fb: WebGLFramebuffer | null = null;
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const hdr = float && this.hdr;
      gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
      checkGlAllocation(gl, `a ${w}×${h} render target`);
      fb = gl.createFramebuffer();
      if (!fb) throw new Error('Failed to create framebuffer');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`The GPU could not allocate a ${w}×${h} render target. Close other graphics apps or choose a smaller export.`);
      }
      return { tex, fb, w, h, mips };
    } catch (error) {
      if (fb) gl.deleteFramebuffer(fb);
      gl.deleteTexture(tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw error;
    }
  }

  free(t: RenderTarget | null | undefined): void {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  dispose(): void {
    this.free(this.black);
    for (const { tex } of this.luts.values()) this.gl.deleteTexture(tex);
    for (const { prog } of this.programs.values()) this.gl.deleteProgram(prog);
    this.luts.clear();
    this.programs.clear();
    this.gl.deleteShader(this.vert);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteVertexArray(this.vertexArray);
  }

  /** LUTs are shared by preview/export/thumbnail pipelines and bounded to eight GPU textures. */
  lut(lut: CubeLut = IDENTITY_LUT): { tex: WebGLTexture; target: number } {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('The graphics context was lost. Reload the studio before importing a grade.');
    const cached = this.luts.get(lut);
    if (cached) {
      this.luts.delete(lut);
      this.luts.set(lut, cached);
      return cached;
    }
    const values = lutValues(lut);
    if (lut.size > gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)) throw new Error('This GPU cannot load the selected LUT size.');
    clearGlErrors(gl);
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create LUT texture');
    // RGB16F is filterable in WebGL2 without requiring float32-linear extensions.
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const binding = gl.getParameter(gl.TEXTURE_BINDING_3D);
    try {
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, values);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      checkGlAllocation(gl, 'the LUT texture');
    } catch (error) {
      gl.deleteTexture(tex);
      throw error;
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      gl.bindTexture(gl.TEXTURE_3D, binding);
    }
    const result = { tex, target: gl.TEXTURE_3D };
    this.luts.set(lut, result);
    if (this.luts.size > 8) {
      const oldest = this.luts.keys().next().value!;
      gl.deleteTexture(this.luts.get(oldest)!.tex);
      this.luts.delete(oldest);
    }
    return result;
  }

  // Run one full-screen pass. `target` null = default framebuffer (viewport may be given).
  draw(
    key: string,
    src: string,
    target: RenderTarget | null,
    uniforms: Uniforms,
    samplers: Samplers,
    viewport?: [number, number, number, number],
  ): void {
    const gl = this.gl;
    const p = this.program(key, src);
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const [vx, vy, vw, vh] = viewport || [0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height];
    gl.viewport(vx, vy, vw, vh);
    let unit = 0;
    for (const name in samplers) {
      const loc = p.loc(name);
      if (loc === null) continue;
      const s = samplers[name];
      gl.activeTexture(gl.TEXTURE0 + unit);
      const targetType = s && 'target' in s ? s.target ?? gl.TEXTURE_2D : gl.TEXTURE_2D;
      gl.bindTexture(targetType, s && 'tex' in s ? s.tex : s || this.black.tex);
      gl.uniform1i(loc, unit++);
    }
    for (const name in uniforms) {
      const loc = p.loc(name);
      if (loc === null) continue;
      const v = uniforms[name];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

// Every effect layer runs through a dry/wet stage driven by the studio-wide FX intensity (uWet).
const fxCache = new Map<string, string>();
function fxSource(id: string): string | null {
  if (!fxCache.has(id)) {
    const src = moduleSource(id);
    if (!src) return null;
    fxCache.set(id, `${src.replace(/void\s+main\s*\(\s*\)/, 'void fxMain()')}
uniform float uWet;
void main() {
  fxMain();
  if (uWet < 0.999) outColor = vec4(mix(texture(uSrc, vUv).rgb, outColor.rgb, uWet), 1.0);
}`);
  }
  return fxCache.get(id) || null;
}

// One render path at one resolution (main stage, a thumbnail, a variation tile...).
export class Pipeline {
  g: GPU;
  guard: boolean;
  histories: Map<string, [RenderTarget, RenderTarget]>;
  chains: Map<string, RenderTarget[]>;
  w: number = 0;
  h: number = 0;
  guardReset: boolean = true;
  histFresh: Set<string> = new Set();
  frame: ComposedFrame | null = null;
  _used: Set<string> = new Set();
  srcA: RenderTarget | null = null;
  srcB: RenderTarget | null = null;
  brollT: RenderTarget | null = null;
  mixT: RenderTarget | null = null;
  hold: RenderTarget | null = null;
  ping: RenderTarget | null = null;
  pong: RenderTarget | null = null;
  final: RenderTarget | null = null;
  outA: RenderTarget | null = null;
  outB: RenderTarget | null = null;
  stA: RenderTarget | null = null;
  stB: RenderTarget | null = null;

  constructor(gpu: GPU, w: number, h: number, { guard = false }: { guard?: boolean } = {}) {
    this.g = gpu;
    this.guard = guard;
    this.histories = new Map();
    this.chains = new Map();
    this.resize(w, h);
  }

  dispose(): void {
    const g = this.g;
    for (const t of [this.srcA, this.srcB, this.brollT, this.mixT, this.hold, this.ping, this.pong, this.final, this.outA, this.outB, this.stA, this.stB]) g.free(t);
    for (const pair of this.histories.values()) pair.forEach((t) => g.free(t));
    for (const chain of this.chains.values()) chain.forEach((t) => g.free(t));
    this.histories.clear();
    this.chains.clear();
    this.srcA = this.srcB = this.brollT = this.mixT = this.hold = this.ping = this.pong = this.final = this.outA = this.outB = this.stA = this.stB = null;
    this.w = this.h = 0;
  }

  resize(w: number, h: number): void {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (this.w === w && this.h === h) return;
    const g = this.g;
    g.assertSize(w, h);
    this.dispose();
    this.w = w; this.h = h;
    try {
      this.srcA = g.target(w, h);
      // Transition, B-roll and effect scratch targets are allocated only when used.
      // At native Apple square resolution each unused half-float target costs 112 MiB.
      this.final = g.target(w, h, { float: false, mips: this.guard });
      if (this.guard) {
        this.outA = g.target(w, h, { float: false }); this.outB = g.target(w, h, { float: false });
        this.stA = g.target(1, 1); this.stB = g.target(1, 1);
      }
      this.reset();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  reset(): void {
    this.guardReset = true;
    this.histFresh = new Set(this.histories.keys());
  }

  _chain(key: string, sizes: [number, number][]): RenderTarget[] {
    this._used?.add(key);
    let c = this.chains.get(key);
    if (!c) {
      c = [];
      try { for (const [w, h] of sizes) c.push(this.g.target(w, h)); }
      catch (error) { c.forEach((t) => this.g.free(t)); throw error; }
      this.chains.set(key, c);
    }
    return c;
  }

  _history(key: string): [RenderTarget, RenderTarget] {
    this._used?.add(key);
    let h = this.histories.get(key);
    if (!h) {
      const limit = this._historyLimit();
      // Free stale pairs before allocating the next cut's feedback. A count-only bound can retain
      // gigabytes at native 4K; never evict a pair already used by the current frame's render graph.
      while (this.histories.size >= limit) {
        const old = [...this.histories.keys()].find((k) => !this._used.has(k));
        if (old === undefined || limit < 1) throw new Error('This export uses too much feedback memory. Disable a feedback effect or choose a smaller export.');
        this.histories.get(old)!.forEach((t) => this.g.free(t));
        this.histories.delete(old);
        this.histFresh.delete(old);
      }
      const first = this.g.target(this.w, this.h);
      try { h = [first, this.g.target(this.w, this.h)]; }
      catch (error) { this.g.free(first); throw error; }
      this.histFresh.add(key);
    } else {
      this.histories.delete(key);
    }
    this.histories.set(key, h);
    return h;
  }

  _historyLimit(): number {
    const pairBytes = this.w * this.h * (this.g.hdr ? 8 : 4) * 2;
    return Math.min(16, Math.floor(HISTORY_BYTES / Math.max(1, pairBytes)));
  }

  _glow(input: RenderTarget, threshold: number, radius: number): RenderTarget {
    const g = this.g;
    const levels = Math.max(2, Math.min(7, 2 + Math.round(radius * 5)));
    const sizes: [number, number][] = [];
    let w = this.w / 2, h = this.h / 2;
    for (let i = 0; i < 7; i++) { sizes.push([w, h]); w = Math.max(2, w / 2); h = Math.max(2, h / 2); }
    const down = this._chain('down', sizes);
    const up = this._chain('up', sizes);
    g.draw('bright', S.BRIGHT, down[0], { ...this.U(down[0]), uThreshold: threshold, uKnee: 0.25 }, { uSrc: input });
    for (let i = 1; i < levels; i++) {
      g.draw('kdown', S.KAWASE_DOWN, down[i], { ...this.U(down[i]), uTexel: [1 / down[i - 1].w, 1 / down[i - 1].h] }, { uSrc: down[i - 1] });
    }
    let cur = down[levels - 1];
    for (let i = levels - 2; i >= 0; i--) {
      g.draw('kup', S.KAWASE_UP, up[i], { ...this.U(up[i]), uTexel: [1 / cur.w, 1 / cur.h], uAddW: 1 }, { uSrc: cur, uAdd: down[i] });
      cur = up[i];
    }
    return cur;
  }

  // Free feedback histories / effect chains of layers that were removed, reordered or switched off.
  _prune(): void {
    // End feedback when its clip/layer leaves the graph at every resolution. Keeping idle histories
    // only while they fit a resolution-dependent budget would make preview and export diverge.
    for (const [k, pair] of this.histories) {
      if (this._used.has(k)) continue;
      pair.forEach((t) => this.g.free(t));
      this.histories.delete(k);
      this.histFresh.delete(k);
    }
    for (const [k, chain] of this.chains) {
      if (this._used.has(k)) continue;
      chain.forEach((t) => this.g.free(t));
      this.chains.delete(k);
    }
  }

  // Common per-pass uniforms for a target size.
  U(t: { w: number; h: number }): Uniforms { return { ...this.frame?.globals, uRes: [t.w, t.h], uScale: t.h / 1920 }; }

  _next(cur: RenderTarget): RenderTarget {
    if (cur === this.ping) return this.pong ??= this.g.target(this.w, this.h);
    return this.ping ??= this.g.target(this.w, this.h);
  }

  _runChain(kind: string, cur: RenderTarget, p: Record<string, number>, key: string): RenderTarget {
    const g = this.g;
    const out = this._next(cur);
    if (kind === 'bloom') {
      const glow = this._glow(cur, p.p_threshold, p.p_radius);
      const w = p.p_warmth;
      const tint = w >= 0 ? [1, 1 - 0.18 * w, 1 - 0.35 * w] : [1 + 0.25 * w, 1 + 0.08 * w, 1 - 0.1 * w];
      g.draw('comp', S.COMPOSITE, out, { ...this.U(out), uTint: tint, uAmount: p.p_intensity * (p.uWet ?? 1) }, { uSrc: cur, uAdd: glow });
      return out;
    }
    if (kind === 'streaks') {
      const [a, b] = this._chain(`streak:${key}`, [[this.w / 4, this.h / 4], [this.w / 4, this.h / 4]]);
      g.draw('bright', S.BRIGHT, a, { ...this.U(a), uThreshold: p.p_threshold, uKnee: 0.2 }, { uSrc: cur });
      const reach = 0.4 + p.p_length * 2.2;
      let src = a, dst = b;
      for (const step of [1, 3, 9, 27]) {
        g.draw('dblur', S.DIR_BLUR, dst, { ...this.U(dst), uDir: [(step * reach) / a.w, 0] }, { uSrc: src });
        [src, dst] = [dst, src];
      }
      const rgb = hsv(p.p_hue, 0.75, 1);
      g.draw('comp', S.COMPOSITE, out, { ...this.U(out), uTint: rgb, uAmount: p.p_intensity * 1.6 * (p.uWet ?? 1) }, { uSrc: cur, uAdd: src });
      return out;
    }
    if (kind === 'rays') {
      const [a, b] = this._chain(`rays:${key}`, [[this.w / 2, this.h / 2], [this.w / 2, this.h / 2]]);
      g.draw('bright', S.BRIGHT, a, { ...this.U(a), uThreshold: p.p_threshold, uKnee: 0.3 }, { uSrc: cur });
      g.draw('radial', S.RADIAL_BLUR, b, { ...this.U(b), uCenterUv: [0.5, p.p_height], uLength: 0.25 + p.p_length * 0.7 }, { uSrc: a });
      g.draw('comp', S.COMPOSITE, out, { ...this.U(out), uTint: [1, 0.92, 0.8], uAmount: p.p_intensity * 1.4 * (p.uWet ?? 1) }, { uSrc: cur, uAdd: b });
      return out;
    }
    return cur;
  }

  // Run a stack of effect layers over `cur`; returns the texture holding the result.
  _layers(cur: RenderTarget, layers: ComposedLayer[], aux?: Samplers): RenderTarget {
    const g = this.g;
    for (const layer of layers) {
      const m = MODULES[layer.m];
      if (!m) continue;
      if (m.kind) { cur = this._runChain(m.kind, cur, layer.params, layer.key); continue; }
      let out = this._next(cur);
      const samplers: Samplers = { uSrc: cur };
      let hist: [RenderTarget, RenderTarget] | undefined;
      if (m.feedback) {
        hist = this._history(layer.key);
        if (this.histFresh.has(layer.key)) {
          g.draw('blit', S.BLIT, hist[0], this.U(hist[0]), { uSrc: cur });
          this.histFresh.delete(layer.key);
        }
        samplers.uPrev = hist[0];
        out = hist[1];
      }
      if (m.aux) samplers.uAux = aux?.[m.aux];
      g.draw(`m:${layer.m}`, fxSource(layer.m) || '', out, { uWet: 1, ...this.U(out), ...layer.params }, samplers);
      if (hist) hist.reverse();
      cur = out;
    }
    return cur;
  }

  render(frame: ComposedFrame, aux?: Samplers): RenderTarget {
    const g = this.g;
    this.frame = frame;
    // Protect feedback on both sides of a transition before allocating any new history: a layer
    // visited later in this frame still owns its previous frame's pixels.
    this._used = new Set([...frame.layers, ...(frame.pre || []).flat()]
      .filter((layer) => MODULES[layer.m]?.feedback).map((layer) => layer.key));
    const [A, B] = frame.sources || [];
    const pre = frame.pre;
    const cam = (s: ComposedSource, t: RenderTarget) => g.draw('source', S.SOURCE, t, {
      ...this.U(t), uVidRes: [s.vw, s.vh], uCenter: s.cam.center, uZoom: s.cam.zoom, uRot: s.cam.rot, uShake: s.cam.shake, uFlip: s.cam.flip ? 1 : 0,
    }, { uVideo: s.tex });

    if (A && this.srcA) cam(A, this.srcA);
    let cur = this.srcA as RenderTarget;
    const brollIdx = frame.needs?.findIndex((n) => n.aux === 'clipB');
    const brollSrc = brollIdx !== undefined && brollIdx !== -1 ? frame.sources?.[brollIdx] : null;
    if (brollSrc) {
      if (!this.brollT) this.brollT = g.target(this.w, this.h);
      cam(brollSrc, this.brollT);
      if (aux) aux.clipB = this.brollT;
      aux = { ...aux, clipB: this.brollT };
    }
    if (pre?.[0]?.length) cur = this._layers(cur, pre[0], aux);
    if (B && frame.trans) {
      this.srcB ??= g.target(this.w, this.h);
      this.mixT ??= g.target(this.w, this.h);
      let a = cur;
      // B's stack reuses ping/pong, so park A's result first.
      if (pre?.[1]?.length && (a === this.ping || a === this.pong)) {
        if (!this.hold) this.hold = g.target(this.w, this.h);
        g.draw('blit', S.BLIT, this.hold, this.U(this.hold), { uSrc: a });
        a = this.hold;
      }
      cam(B, this.srcB);
      let b = this.srcB;
      if (pre?.[1]?.length) b = this._layers(b, pre[1], aux);
      const tr = S.TRANSITIONS[frame.trans.name] || S.TRANSITIONS.dissolve;
      g.draw(`t:${frame.trans.name}`, tr.glsl, this.mixT, { ...this.U(this.mixT), uP: frame.trans.p }, { uA: a, uB: b });
      cur = this.mixT;
    }
    cur = this._layers(cur, frame.layers, aux);

    const f = frame.finish;
    const glow = f.p_halation > 0.001 ? this._glow(cur, 0.85, 0.75) : null;
    const lut = frame.lut || IDENTITY_LUT;
    if (this.final) g.draw('finish', S.FINISH, this.final, {
      ...this.U(this.final), ...f,
      uLutMix: frame.lut ? Math.min(1, Math.max(0, f.p_lutMix ?? 1)) : 0,
      uLutSize: lut.size, uLutMin: lut.domainMin, uLutMax: lut.domainMax,
    }, { uSrc: cur, uGlow: glow, uLut: g.lut(lut) });
    this._prune();
    if (!this.guard || !this.final || !this.stB || !this.stA || !this.outB || !this.outA) return this.final as RenderTarget;

    const gl = g.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.final.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    g.draw('gstate', S.GUARD_STATE, this.stB, { ...this.U(this.stB), uLimit: GUARD_LIMIT, uReset: this.guardReset ? 1 : 0 },
      { uCur: this.final, uState: this.stA });
    g.draw('gout', S.GUARD_OUT, this.outB, this.U(this.outB), { uCur: this.final, uPrevOut: this.guardReset ? this.final : this.outA, uState: this.stB });
    this.guardReset = false;
    [this.stA, this.stB] = [this.stB, this.stA];
    [this.outA, this.outB] = [this.outB, this.outA];
    return this.outA;
  }
}

export function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

// Owns the GL context, video textures, the main pipeline and thumbnail pipelines.
export class Engine {
  canvas: HTMLCanvasElement;
  gpu: GPU;
  main: Pipeline;
  thumbs: Map<string, Pipeline>;
  videoTex: Map<string, VideoTexture>;
  frameTex: Map<string, FrameTexture> = new Map();
  aux: Samplers;
  statsT: RenderTarget;
  printT?: RenderTarget;
  scopeT?: RenderTarget;
  lastOut: RenderTarget | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gpu = new GPU(canvas);
    this.main = new Pipeline(this.gpu, canvas.width, canvas.height, { guard: true });
    this.thumbs = new Map();
    this.videoTex = new Map();
    this.aux = { glyphs: this._glyphAtlas() };
    this.statsT = this.gpu.target(36, 64, { float: false });
  }

  get gl(): WebGL2RenderingContext { return this.gpu.gl; }

  dispose(): void {
    this.main.dispose();
    for (const key of this.thumbs.keys()) this.dropThumb(key);
    for (const key of this.videoTex.keys()) this.dropVideo(key);
    this.dropFrames();
    this.gpu.free(this.statsT);
    this.gpu.free(this.printT);
    this.gpu.free(this.scopeT);
    const glyphs = this.aux.glyphs;
    if (glyphs) this.gl.deleteTexture('tex' in glyphs ? glyphs.tex : glyphs);
    this.lastOut = null;
    this.aux = {};
    this.gpu.dispose();
  }

  resize(w: number, h: number): void {
    this.gpu.assertSize(w, h);
    if (this.main.w !== w || this.main.h !== h) this.lastOut = null;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.main.resize(w, h);
  }

  _videoTex(key: string): VideoTexture {
    const gl = this.gl;
    let v = this.videoTex.get(key);
    if (!v) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('Failed to create video texture');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      v = { tex, vw: 1, vh: 1, stamp: -1, el: null };
      this.videoTex.set(key, v);
    }
    return v;
  }

  _upload(v: VideoTexture, src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, v.tex);
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    try {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    }
    v.print = undefined;
  }

  // Upload the current frame of a <video> into its texture; returns {tex, vw, vh} or null.
  video(key: string, el: HTMLVideoElement | null, force: boolean = false): VideoTexture {
    const v = this._videoTex(key);
    if (el && el.readyState >= 2 && el.videoWidth) {
      const stamp = el.currentTime;
      if (force || stamp !== v.stamp || v.el !== el) {
        this._upload(v, el);
        v.vw = el.videoWidth; v.vh = el.videoHeight; v.stamp = stamp; v.el = el;
      }
    }
    return v;
  }

  // Upload an export frame (raw 4:2:0 planes, see clipFrames.ts) and convert it to RGB in a texture of
  // its own, laid out like an uploaded <video> frame. Nothing happens if that frame is already there.
  frame(key: string, f: { clipId: string; idx: number; w: number; h: number; data: Uint8Array }): FrameTexture {
    const gl = this.gl;
    let v = this.frameTex.get(key);
    if (v && (v.vw !== f.w || v.vh !== f.h)) {
      this.frameTex.delete(key);
      this._freeFrame(v);
      v = undefined;
    }
    if (!v) {
      const planes: WebGLTexture[] = [];
      const plane = (w: number, h: number) => {
        const t = gl.createTexture();
        if (!t) throw new Error('Failed to create a frame texture');
        planes.push(t);
        clearGlErrors(gl);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        checkGlAllocation(gl, `a ${w}×${h} frame plane`);
        return t;
      };
      const rt = this.gpu.target(f.w, f.h, { float: false });
      try {
        v = { rt, tex: rt.tex, y: plane(f.w, f.h), u: plane(f.w / 2, f.h / 2), v: plane(f.w / 2, f.h / 2), vw: f.w, vh: f.h, stamp: '' };
      } catch (error) {
        planes.forEach((texture) => gl.deleteTexture(texture));
        this.gpu.free(rt);
        throw error;
      }
      this.frameTex.set(key, v);
    }
    const stamp = `${f.clipId}:${f.idx}`;
    if (v.stamp !== stamp) {
      const { w, h, data } = f;
      const q = (w * h) / 4;
      const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
      try {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_2D, v.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data.subarray(0, w * h));
        gl.bindTexture(gl.TEXTURE_2D, v.u);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w / 2, h / 2, gl.RED, gl.UNSIGNED_BYTE, data.subarray(w * h, w * h + q));
        gl.bindTexture(gl.TEXTURE_2D, v.v);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w / 2, h / 2, gl.RED, gl.UNSIGNED_BYTE, data.subarray(w * h + q, w * h + 2 * q));
      } finally {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      }
      this.gpu.draw('yuv', S.YUV, v.rt, { uRes: [w, h] }, { uY: v.y, uU: v.u, uV: v.v });
      v.stamp = stamp;
      v.print = undefined;
    }
    return v;
  }

  _freeFrame(v: FrameTexture): void {
    this.gpu.free(v.rt);
    for (const t of [v.y, v.u, v.v]) this.gl.deleteTexture(t);
  }

  /** Free the export's frame textures. */
  dropFrames(): void {
    this.pruneFrames([]);
  }

  /** A cut owns decoded GPU textures only while it participates in the current frame. */
  pruneFrames(keys: Iterable<string>): void {
    const active = new Set(keys);
    for (const [key, value] of this.frameTex) {
      if (active.has(key)) continue;
      this._freeFrame(value);
      this.frameTex.delete(key);
    }
  }

  // Hashes of a 16×16 readback of each cut's frame texture, all in one read: they tell the export
  // whether a new frame really landed on the GPU.
  sourcePrints(keys: string[]): number[] {
    const gl = this.gl;
    const texOf = (k: string) => this.frameTex.get(k) ?? this.videoTex.get(k);
    const todo = [...new Set(keys.map(texOf).filter((v): v is VideoTexture | FrameTexture => v !== undefined && v.print === undefined))];
    if (!this.printT && todo.length) this.printT = this.gpu.target(64, 16, { float: false });
    for (let i = 0; i < todo.length; i += 4) {
      const part = todo.slice(i, i + 4);
      part.forEach((v, j) => this.gpu.draw('blit', S.BLIT, this.printT!, { uRes: [16, 16] }, { uSrc: v }, [16 * j, 0, 16, 16]));
      const px = new Uint8Array(64 * 16 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.printT!.fb);
      gl.readPixels(0, 0, 64, 16, gl.RGBA, gl.UNSIGNED_BYTE, px);
      part.forEach((v, j) => {
        const block = new Uint8Array(16 * 16 * 4);
        for (let y = 0; y < 16; y++) block.set(px.subarray((y * 64 + 16 * j) * 4, (y * 64 + 16 * j + 16) * 4), y * 64);
        v.print = fnv(block);
      });
    }
    return keys.map((k) => texOf(k)?.print ?? 0);
  }

  dropVideo(key: string): void {
    const v = this.videoTex.get(key);
    if (v) { this.gl.deleteTexture(v.tex); this.videoTex.delete(key); }
  }

  renderMain(frame: ComposedFrame): RenderTarget {
    if (this.gl.isContextLost()) throw new Error('The graphics context was lost during rendering. Reload the studio and try a smaller export.');
    const out = this.main.render(frame, this.aux);
    if (this.main.brollT) this.aux.clipB = this.main.brollT;
    this.lastOut = out;
    this.present();
    return out;
  }

  // Re-show the last rendered frame without advancing feedback or the flash guard.
  present(): boolean {
    const out = this.lastOut;
    if (!out || out.w !== this.main.w || out.h !== this.main.h) return false;
    this.gpu.draw('blit', S.BLIT, null, this.main.U(out), { uSrc: out });
    return true;
  }

  // Render a look into a small pipeline and copy it into a 2D canvas.
  // `restore: false` lets a caller drawing several thumbnails put the preview back once at the end.
  renderThumb(id: string, frame: ComposedFrame, ctx2d: CanvasRenderingContext2D, restore = true): void {
    const w = ctx2d.canvas.width, h = ctx2d.canvas.height;
    let p = this.thumbs.get(id);
    if (!p) { p = new Pipeline(this.gpu, w, h); this.thumbs.set(id, p); }
    p.resize(w, h);
    const out = p.render(frame, this.aux);
    const ch = this.canvas.height;
    this.gpu.draw('blit', S.BLIT, null, p.U(out), { uSrc: out }, [0, ch - h, w, h]);
    ctx2d.drawImage(this.canvas, 0, 0, w, h, 0, 0, w, h);
    // The thumbnail was staged in the corner of the visible canvas; put the preview back.
    if (restore) this.present();
  }

  dropThumb(id: string): void {
    const p = this.thumbs.get(id);
    if (!p) return;
    p.dispose();
    this.thumbs.delete(id);
  }

  // 36×64 RGBA8 readback of the last main output (mip-averaged) for export analysis.
  readStats(out: RenderTarget): Uint8Array {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, out.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.gpu.draw('stats', S.STATS, this.statsT, this.main.U(this.statsT), { uSrc: out });
    gl.bindTexture(gl.TEXTURE_2D, out.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const px = new Uint8Array(36 * 64 * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsT.fb);
    gl.readPixels(0, 0, 36, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  readFull(): Uint8Array<ArrayBuffer> {
    const gl = this.gl;
    const { width: w, height: h } = this.canvas;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  /** Small display-space readback for optional scopes. The visible canvas stays untouched. */
  readScope(): Uint8Array | null {
    if (!this.lastOut || this.gl.isContextLost()) return null;
    const gl = this.gl;
    this.scopeT ??= this.gpu.target(256, 144, { float: false });
    this.gpu.draw('blit', S.BLIT, this.scopeT, this.main.U(this.scopeT), { uSrc: this.lastOut });
    const px = new Uint8Array(256 * 144 * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scopeT.fb);
    gl.readPixels(0, 0, 256, 144, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  _glyphAtlas(): { tex: WebGLTexture } {
    const cell = 48, cols = 16;
    const c = document.createElement('canvas');
    c.width = cell * cols; c.height = cell * 2;
    const x = c.getContext('2d');
    if (!x) throw new Error('Failed to get 2d context for glyph atlas');
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `600 ${cell * 0.78}px "SF Mono", Menlo, Consolas, monospace`;
    const ramp = ' .,:;-=+*cox%#&@';
    const matrix = 'ｱｲｳｴｶｷｸｹｺｻｼｽ01Z';
    // GL samples with v=0 at the bottom: row 0 (ramp) must be drawn in the lower half.
    for (let i = 0; i < cols; i++) {
      x.fillText(ramp[i], i * cell + cell / 2, cell * 1.5 + 2);
      x.fillText(matrix[i], i * cell + cell / 2, cell * 0.5 + 2);
    }
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create glyph texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex };
  }

  // Compile every shader up front so the first switch to a look never hitches.
  warmup(): string[] {
    const errors: string[] = [];
    const tryCompile = (key: string, src: string) => { try { this.gpu.program(key, src); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); } };
    for (const id in MODULES) if (MODULES[id].glsl) {
      const src = fxSource(id);
      if (src) tryCompile(`m:${id}`, src);
    }
    for (const id in S.TRANSITIONS) tryCompile(`t:${id}`, S.TRANSITIONS[id].glsl);
    for (const [k, src] of Object.entries({ source: S.SOURCE, blit: S.BLIT, finish: S.FINISH, gstate: S.GUARD_STATE, gout: S.GUARD_OUT,
      bright: S.BRIGHT, kdown: S.KAWASE_DOWN, kup: S.KAWASE_UP, dblur: S.DIR_BLUR, radial: S.RADIAL_BLUR, comp: S.COMPOSITE, stats: S.STATS })) {
      tryCompile(k, src);
    }
    return errors;
  }
}
