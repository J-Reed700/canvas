import test from 'node:test';
import assert from 'node:assert/strict';
import { GPU, Pipeline, Engine } from '../downbeat/studio/src/engine/engine.ts';
import { IDENTITY_LUT } from '../downbeat/studio/src/engine/lut.ts';

function allocator() {
  const live = new Set();
  const gpu = {
    failAfter: Infinity,
    assertSize(w, h) { if (w > 4096 || h > 4096) throw new Error('too large'); },
    target(w, h) {
      if (gpu.failAfter-- <= 0) throw new Error('allocation failed');
      const target = { w, h };
      live.add(target);
      return target;
    },
    free(t) { if (t) live.delete(t); },
  };
  return { gpu, live };
}

test('GPU rejects unsupported dimensions and lost contexts before allocating', () => {
  let lost = false;
  const gpu = { gl: { isContextLost: () => lost, getParameter: () => 4096 } };
  for (const size of [[8192, 1080], [1920, Infinity], [NaN, 1], [0, 1]]) {
    assert.throws(() => GPU.prototype.assertSize.call(gpu, ...size), /cannot render/);
  }
  GPU.prototype.assertSize.call(gpu, 3840, 3840);
  lost = true;
  assert.throws(() => GPU.prototype.assertSize.call(gpu, 10, 10), /context was lost/);
});

test('an incomplete framebuffer releases both GPU objects and reports allocation failure', () => {
  const deleted = [];
  const gl = {
    isContextLost: () => false, getParameter: () => 4096,
    NO_ERROR: 0, getError: () => 0,
    createTexture: () => 'texture', createFramebuffer: () => 'framebuffer',
    bindTexture() {}, texImage2D() {}, texParameteri() {}, bindFramebuffer() {}, framebufferTexture2D() {},
    checkFramebufferStatus: () => 'incomplete', FRAMEBUFFER_COMPLETE: 'complete',
    deleteTexture: (t) => deleted.push(t), deleteFramebuffer: (t) => deleted.push(t),
  };
  const gpu = { gl, hdr: false, assertSize: GPU.prototype.assertSize };
  assert.throws(() => GPU.prototype.target.call(gpu, 3840, 3840), /could not allocate/);
  assert.deepEqual(deleted.sort(), ['framebuffer', 'texture']);
});

test('LUT upload errors preserve unpack state, delete the failed texture and allow retry', () => {
  const deleted = [];
  let alignment = 4, error = 0, fail = true, created = 0, binding = 'old';
  const gl = {
    NO_ERROR: 0, UNPACK_ALIGNMENT: 'alignment', MAX_3D_TEXTURE_SIZE: 'max', TEXTURE_BINDING_3D: 'binding',
    isContextLost: () => false,
    getParameter: (name) => name === 'alignment' ? alignment : name === 'binding' ? binding : 256,
    getError: () => { const result = error; error = 0; return result; },
    createTexture: () => ++created, deleteTexture: (tex) => deleted.push(tex),
    bindTexture: (_, tex) => { binding = tex; },
    pixelStorei: (_, value) => { alignment = value; },
    texParameteri() {},
    texImage3D() { if (fail) error = 1285; },
  };
  const gpu = { gl, luts: new Map() };
  assert.throws(() => GPU.prototype.lut.call(gpu, IDENTITY_LUT), /could not allocate the LUT/);
  assert.equal(alignment, 4);
  assert.equal(binding, 'old');
  assert.equal(gpu.luts.size, 0);
  assert.deepEqual(deleted, [1]);
  fail = false;
  assert.equal(GPU.prototype.lut.call(gpu, IDENTITY_LUT).tex, 2);
  assert.equal(GPU.prototype.lut.call(gpu, IDENTITY_LUT).tex, 2, 'only a successful upload is cached');
});

test('mipmap allocation errors reject and free an otherwise valid render target', () => {
  let error = 0, deleted = false;
  const gl = {
    NO_ERROR: 0, isContextLost: () => false, getParameter: () => 4096,
    getError: () => { const result = error; error = 0; return result; },
    createTexture: () => 'texture', bindTexture() {}, texImage2D() {}, texParameteri() {}, bindFramebuffer() {},
    generateMipmap() { error = 1285; },
    deleteTexture() { deleted = true; },
  };
  const gpu = { gl, hdr: false, assertSize: GPU.prototype.assertSize };
  assert.throws(() => GPU.prototype.target.call(gpu, 3840, 3840, { mips: true }), /could not allocate/);
  assert.equal(deleted, true);
});

test('failed pipeline resize frees partial allocations and can be retried', () => {
  const { gpu, live } = allocator();
  const pipe = new Pipeline(gpu, 100, 100, { guard: true });
  gpu.failAfter = 3;
  assert.throws(() => pipe.resize(3840, 3840), /allocation failed/);
  assert.equal(live.size, 0, 'old and partially created resources are freed');
  assert.equal(pipe.w, 0);
  gpu.failAfter = Infinity;
  pipe.resize(100, 100);
  assert.ok(live.size > 0);
  pipe.dispose();
  assert.equal(live.size, 0);
});

test('failed effect chains and feedback histories do not leak partial targets', () => {
  const { gpu, live } = allocator();
  const pipe = new Pipeline(gpu, 100, 100);
  const baseline = live.size;
  gpu.failAfter = 1;
  assert.throws(() => pipe._chain('glow', [[50, 50], [25, 25]]), /allocation failed/);
  assert.equal(live.size, baseline);
  gpu.failAfter = 1;
  assert.throws(() => pipe._history('echo'), /allocation failed/);
  assert.equal(live.size, baseline);
  assert.equal(pipe.chains.size + pipe.histories.size, 0);
  pipe.dispose();
});

test('resizing the stage invalidates its prior frame instead of presenting a freed texture', () => {
  const { gpu } = allocator();
  const engine = { gpu, main: new Pipeline(gpu, 100, 100), canvas: { width: 100, height: 100 }, lastOut: {} };
  Engine.prototype.resize.call(engine, 200, 100);
  assert.equal(engine.lastOut, null);
  assert.equal(Engine.prototype.present.call(engine), false);
  engine.main.dispose();
});

test('4K feedback evicts stale histories before allocating and never frees the active frame', () => {
  const { gpu, live } = allocator();
  gpu.hdr = true;
  const pipe = new Pipeline(gpu, 3840, 3840);
  const a = pipe._history('cut-a');
  pipe._used.clear();
  const b = pipe._history('cut-b');
  pipe._used.clear();
  pipe._used.add('cut-b'); // also needed later in the same transition frame
  const before = live.size;
  const allocate = gpu.target;
  gpu.target = (...args) => {
    const value = allocate(...args);
    assert.ok(live.size <= before, 'stale feedback is freed before new GPU allocations');
    return value;
  };
  pipe._history('cut-c');
  assert.ok(a.every((target) => !live.has(target)));
  assert.ok(b.every((target) => live.has(target)));
  pipe._history('cut-b');
  assert.throws(() => pipe._history('cut-d'), /too much feedback memory/);
  assert.ok(b.every((target) => live.has(target)), 'active feedback stays valid');
  pipe.dispose();
  assert.equal(live.size, 0);
});

test('feedback ends when a clip leaves the graph at both preview and native resolution', () => {
  for (const [w, h] of [[720, 1280], [3840, 3840]]) {
    const { gpu, live } = allocator();
    gpu.hdr = true;
    const pipe = new Pipeline(gpu, w, h);
    const old = pipe._history('outgoing');
    pipe._used.clear();
    pipe._history('incoming');
    pipe._prune();
    assert.ok(old.every((target) => !live.has(target)));
    assert.equal(pipe.histories.size, 1);
    pipe._used.clear();
    const returned = pipe._history('outgoing');
    assert.notEqual(returned, old);
    assert.ok(pipe.histFresh.has('outgoing'), 'returning clips restart consistently');
    pipe.dispose();
  }
});

test('retired export cuts release their frame textures before the next cut allocates', () => {
  const freed = [];
  const engine = Object.assign(Object.create(Engine.prototype), {
    frameTex: new Map(),
    _freeFrame: (frame) => freed.push(frame),
  });
  for (let cut = 0; cut < 4096; cut++) {
    const keys = [`cut-${cut}`, `cut-${cut + 1}`];
    engine.pruneFrames(keys);
    for (const key of keys) if (!engine.frameTex.has(key)) engine.frameTex.set(key, { key });
    assert.equal(engine.frameTex.size, 2, 'only the current transition owns GPU frame textures');
  }
  engine.dropFrames();
  assert.equal(engine.frameTex.size, 0);
  assert.equal(freed.length, 4097, 'each texture is released exactly once');
});

test('failed YUV plane allocations release every partial texture and can be retried', () => {
  const live = new Set();
  let created = 0;
  let failAt = 3;
  const gl = {
    NO_ERROR: 0, UNPACK_ALIGNMENT: 'alignment',
    getError: () => 0, getParameter: () => 4,
    createTexture() {
      if (++created === failAt) return null;
      const texture = { id: created };
      live.add(texture);
      return texture;
    },
    deleteTexture: (texture) => live.delete(texture),
    bindTexture() {}, texStorage2D() {}, texParameteri() {}, texSubImage2D() {}, pixelStorei() {},
  };
  const engine = Object.assign(Object.create(Engine.prototype), {
    gpu: {
      gl, draw() {}, assertSize() {},
      target(w, h) { return { tex: gl.createTexture(), w, h }; },
      free(target) { gl.deleteTexture(target.tex); },
    },
    frameTex: new Map(),
  });
  const frame = { clipId: 'a', idx: 0, w: 2, h: 2, data: new Uint8Array(6) };
  assert.throws(() => engine.frame('a#0', frame), /create a frame texture/);
  assert.equal(live.size, 0, 'the RGB target and earlier planes are released');
  assert.equal(engine.frameTex.size, 0);
  failAt = Infinity;
  engine.frame('a#0', frame);
  assert.equal(live.size, 4);
  engine.dropFrames();
  assert.equal(live.size, 0);
});

test('closing a preview frees its pipelines, media textures and GPU resources exactly once', () => {
  const live = new Set();
  const allocate = (kind) => { const resource = { kind }; live.add(resource); return resource; };
  const release = (resource) => {
    if (resource) assert.ok(live.delete(resource), `${resource.kind} must be owned and released once`);
  };
  const gl = {
    isContextLost: () => false, getParameter: () => 4096,
    deleteTexture: release, deleteFramebuffer: release, deleteProgram: release,
    deleteShader: release, deleteBuffer: release, deleteVertexArray: release,
  };
  const gpu = Object.assign(Object.create(GPU.prototype), {
    gl, hdr: false,
    target: (w, h) => ({ tex: allocate('texture'), fb: allocate('framebuffer'), w, h }),
    programs: new Map([['shader', { prog: allocate('program') }]]),
    luts: new Map([[IDENTITY_LUT, { tex: allocate('LUT texture') }]]),
    vert: allocate('vertex shader'), vertexArray: allocate('vertex array'), vertexBuffer: allocate('vertex buffer'),
  });
  gpu.black = gpu.target(1, 1);
  const main = new Pipeline(gpu, 540, 960, { guard: true });
  main._history('feedback');
  main._chain('effect', [[270, 480]]);
  const engine = Object.assign(Object.create(Engine.prototype), {
    gpu, main,
    thumbs: new Map([['look', new Pipeline(gpu, 90, 160)]]),
    videoTex: new Map([['clip', { tex: allocate('video texture') }]]),
    frameTex: new Map([['cut', { rt: gpu.target(540, 960), y: allocate('Y plane'), u: allocate('U plane'), v: allocate('V plane') }]]),
    aux: { glyphs: { tex: allocate('glyph atlas') } },
    statsT: gpu.target(36, 64), printT: gpu.target(64, 16), scopeT: gpu.target(128, 72),
    lastOut: main.final,
  });
  assert.ok(live.size > 30, 'the fixture includes active pipelines, feedback and media resources');
  engine.dispose();
  assert.equal(live.size, 0);
  assert.equal(engine.thumbs.size, 0);
  assert.equal(engine.videoTex.size, 0);
  assert.equal(engine.frameTex.size, 0);
  assert.equal(engine.lastOut, null);
});
