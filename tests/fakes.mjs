// Small stand-ins for the browser pieces the studio touches (DOM elements, <video>, canvas 2D,
// fetch, localStorage), so its logic runs under plain Node. Only what the studio calls is here.

export class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = { cssText: '' };
    this.className = '';
    this._text = '';
    this.innerHTML = '';
    this.parent = null;
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    this.offsetWidth = 0;
    this.offsetHeight = 0;
  }
  get isConnected() { return !!this.parent; }
  // like the DOM: reading joins the children's text, writing replaces the children
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { for (const c of [...this.children]) c.remove(); this._text = String(v); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { this.className = [...new Set([...names(), ...c])].join(' '); },
      remove: (...c) => { this.className = names().filter((n) => !c.includes(n)).join(' '); },
      contains: (c) => names().includes(c),
    };
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn, opts) { (this.listeners[type] ||= []).push({ fn, once: !!opts?.once }); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((l) => l.fn !== fn); }
  dispatch(type, ev = {}) {
    for (const l of [...(this.listeners[type] || [])]) {
      if (l.once) this.removeEventListener(type, l.fn);
      l.fn({ type, target: this, ...ev });
    }
  }
  append(...kids) {
    for (const k of kids) {
      if (k.parent) k.remove();
      k.parent = this;
      this.children.push(k);
    }
  }
  appendChild(k) { this.append(k); return k; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceChildren(...kids) { for (const k of [...this.children]) k.remove(); this.append(...kids); }
  contains(n) { for (let p = n; p; p = p.parent) if (p === this) return true; return false; }
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const d = c.find?.(pred); if (d) return d; } return null; }
  get text() { return this.children.length ? this.children.map((c) => c.text).join(' ') : this.textContent; }
  closest() { return null; }
  click() { this.dispatch('click'); }
  getBoundingClientRect() { return this.rect; }
}

// A <video> whose seeks land a tick later, like a real decoder.
export class FakeVideo extends FakeElement {
  constructor() {
    super('video');
    this.readyState = 4;
    this.paused = true;
    this.seeking = false;
    this.playbackRate = 1;
    this._t = 0;
    this.plays = 0;
    this.seeks = [];
    this.loads = 0;
    this.land = (t) => t; // where a seek ends up
  }
  get src() { return this.attributes.src || ''; }
  set src(v) { this.attributes.src = v; }
  get currentTime() { return this._t; }
  set currentTime(t) {
    this.seeks.push(t);
    this.seeking = true;
    setTimeout(() => { this._t = this.land(t); this.seeking = false; this.dispatch('seeked'); }, 0);
  }
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() { this.loads++; }
}

// Records every call and property write on a canvas 2D context.
export function recordingContext() {
  const calls = [];
  const state = {};
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'calls') return calls;
      if (prop in target) return target[prop];
      if (prop === 'createLinearGradient') return () => gradient;
      return (...args) => { calls.push({ fn: prop, args, fillStyle: target.fillStyle }); };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return ctx;
}

export function fakeCanvas(width, height, ctx = recordingContext()) {
  const c = new FakeElement('canvas');
  c.width = 0;
  c.height = 0;
  c.rect = { left: 0, top: 0, right: width, bottom: height, width, height };
  c.getContext = () => ctx;
  return c;
}

/** Installs document, window-less globals and localStorage. Returns handles to inspect them. */
export function installDom() {
  const byId = new Map();
  const queries = new Map();
  const body = new FakeElement('body');
  const toast = new FakeElement('div');
  byId.set('toast', toast);
  const toasts = [];
  // record every message, not just the last one
  Object.defineProperty(toast, 'textContent', { get: () => toasts.at(-1) || '', set: (v) => { toasts.push(v); } });
  const docListeners = {};
  globalThis.document = {
    body,
    listeners: docListeners,
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => queries.get(sel) || null,
    createElement: (tag) => (tag === 'video' ? new FakeVideo() : tag === 'canvas' ? fakeCanvas(0, 0) : new FakeElement(tag)),
    createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: text, nodeType: 3 }),
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
  };
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
    },
  });
  globalThis.getComputedStyle = () => ({ fontFamily: 'sans-serif' });
  return { byId, queries, body, toasts, storage: store };
}

/**
 * Replaces fetch with a router: routes maps "METHOD /path" (or "/path" for GET) to a function
 * (url, init) => body. A body that is a Response is sent as is; anything else becomes JSON.
 */
export function stubFetch(routes) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = String(url).split('?')[0];
    requests.push({ url: String(url), method, path, body: init.body, headers: init.headers });
    const handler = routes[`${method} ${path}`] || (method === 'GET' ? routes[path] : undefined) ||
      Object.entries(routes).find(([k]) => k.endsWith('*') && `${method} ${path}`.startsWith(k.slice(0, -1)))?.[1];
    if (!handler) return new Response(JSON.stringify({ ok: false, error: `no route for ${method} ${path}` }), { status: 404 });
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return requests;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// GPU engine whose stats frames have the luminance luma(frameIndex).
export function fakeEngine(luma = () => 0.5) {
  const eng = {
    canvas: {},
    renders: 0,
    resets: 0,
    resize(w, h) { eng.size = [w, h]; },
    main: { reset() { eng.resets++; } },
    video: (vkey) => ({ vkey }),
    renderMain() { return eng.renders++; },
    readFull: () => new Uint8Array(16),
    readStats: (i) => new Uint8Array(36 * 64 * 4).fill(Math.round(luma(i) * 255)),
  };
  return eng;
}

export const fakeBank = (calls = []) => ({ calls, exact: async (needs) => { calls.push(needs); }, get: () => ({}) });

export function exportServer(o = {}) {
  return stubFetch({
    'POST /api/export/raw/begin': () => ({ ok: true, sid: 'canvas-x.mp4' }),
    'POST /api/export/raw/frames': o.frames || (() => ({ ok: true, frames: 1 })),
    'POST /api/export/raw/abort': () => ({ ok: true }),
    'POST /api/export/raw/end': o.end || (() => ({ ok: true, render: { filename: 'canvas-x.mp4', checks: [] } })),
  });
}

// WebCodecs H.264 encoder that only takes the second codec on the list, with hardware, so the
// exporter's fallback runs. Set FakeEncoder.failAt to make it report an error on that frame.
export class FakeEncoder {
  static ok = new Set(['avc1.640033']);
  static async isConfigSupported(cfg) { return { supported: FakeEncoder.ok.has(cfg.codec) && cfg.hardwareAcceleration === 'prefer-hardware', config: cfg }; }
  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.state = 'unconfigured';
    this.encodeQueueSize = 0;
    this.frames = [];
    FakeEncoder.last = this;
  }
  configure(cfg) { this.cfg = cfg; this.state = 'configured'; }
  encode(vf, opts) {
    this.frames.push({ ts: vf.timestamp, dur: vf.duration, key: opts.keyFrame });
    if (FakeEncoder.failAt === this.frames.length) this.error(new Error('encoder crashed'));
    const bytes = new Uint8Array([0, 0, 0, 1, 0x65, this.frames.length & 255]);
    this.output({ byteLength: bytes.length, copyTo: (b) => b.set(bytes) });
  }
  async flush() {}
  close() { this.state = 'closed'; }
}

export class FakeFrame {
  constructor(_src, { timestamp, duration }) { this.timestamp = timestamp; this.duration = duration; }
  close() {}
}
