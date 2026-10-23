// Canvas Forge GPU engine: WebGL2 render graph shared by the live preview, the look
// thumbnails and the frame-exact exporter (so preview == export).
import * as S from './shaders.js';
import { MODULES, moduleSource } from './modules.js';

const GUARD_LIMIT = 18 / 255; // max mean-luma change per frame (display space), same limit as the CPU engine

export class GPU {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.programs = new Map();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vert = this._shader(gl.VERTEX_SHADER, S.VERT);
    this.black = this.target(1, 1, { float: false });
  }

  _shader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }

  program(key, fragSrc) {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    let frag;
    try {
      frag = this._shader(gl.FRAGMENT_SHADER, fragSrc);
    } catch (err) {
      throw new Error(`shader "${key}" failed to compile:\n${err.message}`);
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, this.vert);
    gl.attachShader(prog, frag);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`program "${key}" failed to link: ${gl.getProgramInfoLog(prog)}`);
    const locs = new Map();
    p = { prog, loc: (n) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(prog, n)); return locs.get(n); } };
    this.programs.set(key, p);
    return p;
  }

  target(w, h, { float = true, mips = false } = {}) {
    const gl = this.gl;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const hdr = float && this.hdr;
    gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h, mips };
  }

  free(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  // Run one full-screen pass. `target` null = default framebuffer (viewport may be given).
  draw(key, src, target, uniforms, samplers, viewport) {
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
      gl.bindTexture(gl.TEXTURE_2D, s && s.tex ? s.tex : s || this.black.tex);
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
const fxCache = new Map();
function fxSource(id) {
  if (!fxCache.has(id)) {
    const src = moduleSource(id);
    fxCache.set(id, src && `${src.replace(/void\s+main\s*\(\s*\)/, 'void fxMain()')}
uniform float uWet;
void main() {
  fxMain();
  if (uWet < 0.999) outColor = vec4(mix(texture(uSrc, vUv).rgb, outColor.rgb, uWet), 1.0);
}`);
  }
  return fxCache.get(id);
}

// One render path at one resolution (main stage, a thumbnail, a variation tile...).
export class Pipeline {
  constructor(gpu, w, h, { guard = false } = {}) {
    this.g = gpu;
    this.guard = guard;
    this.histories = new Map();
    this.chains = new Map();
    this.resize(w, h);
  }

  dispose() {
    const g = this.g;
    for (const t of [this.srcA, this.srcB, this.mixT, this.hold, this.ping, this.pong, this.final, this.outA, this.outB, this.stA, this.stB]) g.free(t);
    for (const pair of this.histories.values()) pair.forEach((t) => g.free(t));
    for (const chain of this.chains.values()) chain.forEach((t) => g.free(t));
    this.histories.clear();
    this.chains.clear();
    this.srcA = this.srcB = this.mixT = this.hold = this.ping = this.pong = this.final = this.outA = this.outB = this.stA = this.stB = null;
    this.w = this.h = 0;
  }

  resize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (this.w === w && this.h === h) return;
    const g = this.g;
    this.dispose();
    this.w = w; this.h = h;
    this.srcA = g.target(w, h); this.srcB = g.target(w, h); this.mixT = g.target(w, h);
    this.ping = g.target(w, h); this.pong = g.target(w, h);
    this.final = g.target(w, h, { float: false, mips: this.guard });
    if (this.guard) {
      this.outA = g.target(w, h, { float: false }); this.outB = g.target(w, h, { float: false });
      this.stA = g.target(1, 1); this.stB = g.target(1, 1);
    }
    this.reset();
  }

  reset() {
    this.guardReset = true;
    this.histFresh = new Set(this.histories.keys());
  }

  _chain(key, sizes) {
    this._used?.add(key);
    let c = this.chains.get(key);
    if (!c) { c = sizes.map(([w, h]) => this.g.target(w, h)); this.chains.set(key, c); }
    return c;
  }

  _history(key) {
    this._used?.add(key);
    let h = this.histories.get(key);
    if (!h) {
      h = [this.g.target(this.w, this.h), this.g.target(this.w, this.h)];
      this.histories.set(key, h);
      this.histFresh.add(key);
    }
    return h;
  }

  _glow(input, threshold, radius) {
    const g = this.g;
    const levels = Math.max(2, Math.min(7, 2 + Math.round(radius * 5)));
    const sizes = [];
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
  _prune() {
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
  U(t) { return { ...this.frame.globals, uRes: [t.w, t.h], uScale: t.h / 1920 }; }

  _next(cur) { return cur === this.ping ? this.pong : this.ping; }

  _runChain(kind, cur, p, key) {
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
  _layers(cur, layers, aux) {
    const g = this.g;
    for (const layer of layers) {
      const m = MODULES[layer.m];
      if (!m) continue;
      if (m.kind) { cur = this._runChain(m.kind, cur, layer.params, layer.key); continue; }
      let out = this._next(cur);
      const samplers = { uSrc: cur };
      let hist;
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
      g.draw(`m:${layer.m}`, fxSource(layer.m), out, { uWet: 1, ...this.U(out), ...layer.params }, samplers);
      if (hist) hist.reverse();
      cur = out;
    }
    return cur;
  }

  // frame: { globals, sources: [{tex, vw, vh, cam}], trans: {name, p} | null, layers: [{m, key, params}], finish,
  //          pre: [layersA, layersB] | null — per-clip stacks applied to each source before the transition }
  render(frame, aux) {
    const g = this.g;
    this.frame = frame;
    this._used = new Set(['down', 'up']);
    const [A, B] = frame.sources;
    const pre = frame.pre;
    const cam = (s, t) => g.draw('source', S.SOURCE, t, {
      ...this.U(t), uVidRes: [s.vw, s.vh], uCenter: s.cam.center, uZoom: s.cam.zoom, uRot: s.cam.rot, uShake: s.cam.shake, uFlip: s.cam.flip ? 1 : 0,
    }, { uVideo: s.tex });

    cam(A, this.srcA);
    let cur = this.srcA;
    if (pre?.[0]?.length) cur = this._layers(cur, pre[0], aux);
    if (B && frame.trans) {
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
    g.draw('finish', S.FINISH, this.final, { ...this.U(this.final), ...f }, { uSrc: cur, uGlow: glow });
    this._prune();
    if (!this.guard) return this.final;

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

export function hsv(h, s, v) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

// Owns the GL context, video textures, the main pipeline and thumbnail pipelines.
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.gpu = new GPU(canvas);
    this.main = new Pipeline(this.gpu, canvas.width, canvas.height, { guard: true });
    this.thumbs = new Map();
    this.videoTex = new Map();
    this.aux = { glyphs: this._glyphAtlas() };
    this.statsT = this.gpu.target(36, 64, { float: false });
  }

  get gl() { return this.gpu.gl; }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.main.resize(w, h);
  }

  // Upload the current frame of a <video> into its texture; returns {tex, vw, vh} or null.
  video(key, el, force = false) {
    const gl = this.gl;
    let v = this.videoTex.get(key);
    if (!v) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      v = { tex, vw: 1, vh: 1, stamp: -1, el: null };
      this.videoTex.set(key, v);
    }
    if (el && el.readyState >= 2 && el.videoWidth) {
      const stamp = el.currentTime;
      if (force || stamp !== v.stamp || v.el !== el) {
        gl.bindTexture(gl.TEXTURE_2D, v.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, el);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        v.vw = el.videoWidth; v.vh = el.videoHeight; v.stamp = stamp; v.el = el;
      }
    }
    return v;
  }

  dropVideo(key) {
    const v = this.videoTex.get(key);
    if (v) { this.gl.deleteTexture(v.tex); this.videoTex.delete(key); }
  }

  renderMain(frame) {
    const out = this.main.render(frame, this.aux);
    this.lastOut = out;
    this.present();
    return out;
  }

  // Re-show the last rendered frame without advancing feedback or the flash guard.
  present() {
    const out = this.lastOut;
    if (!out || out.w !== this.main.w) return false;
    this.gpu.draw('blit', S.BLIT, null, this.main.U(out), { uSrc: out });
    return true;
  }

  // Render a look into a small pipeline and copy it into a 2D canvas.
  renderThumb(id, frame, ctx2d) {
    const w = ctx2d.canvas.width, h = ctx2d.canvas.height;
    let p = this.thumbs.get(id);
    if (!p) { p = new Pipeline(this.gpu, w, h); this.thumbs.set(id, p); }
    p.resize(w, h);
    const out = p.render(frame, this.aux);
    const ch = this.canvas.height;
    this.gpu.draw('blit', S.BLIT, null, p.U(out), { uSrc: out }, [0, ch - h, w, h]);
    ctx2d.drawImage(this.canvas, 0, 0, w, h, 0, 0, w, h);
  }

  dropThumb(id) {
    const p = this.thumbs.get(id);
    if (!p) return;
    p.dispose();
    this.thumbs.delete(id);
  }

  // 36×64 RGBA8 readback of the last main output (mip-averaged) for export analysis.
  readStats(out) {
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

  readFull() {
    const gl = this.gl;
    const { width: w, height: h } = this.canvas;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  _glyphAtlas() {
    const cell = 48, cols = 16;
    const c = document.createElement('canvas');
    c.width = cell * cols; c.height = cell * 2;
    const x = c.getContext('2d');
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
  warmup() {
    const errors = [];
    const tryCompile = (key, src) => { try { this.gpu.program(key, src); } catch (e) { errors.push(e.message); } };
    for (const id in MODULES) if (MODULES[id].glsl) tryCompile(`m:${id}`, fxSource(id));
    for (const id in S.TRANSITIONS) tryCompile(`t:${id}`, S.TRANSITIONS[id].glsl);
    for (const [k, src] of Object.entries({ source: S.SOURCE, blit: S.BLIT, finish: S.FINISH, gstate: S.GUARD_STATE, gout: S.GUARD_OUT,
      bright: S.BRIGHT, kdown: S.KAWASE_DOWN, kup: S.KAWASE_UP, dblur: S.DIR_BLUR, radial: S.RADIAL_BLUR, comp: S.COMPOSITE, stats: S.STATS })) {
      tryCompile(k, src);
    }
    return errors;
  }
}
