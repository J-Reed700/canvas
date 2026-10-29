// Exercise the real GPU/render pipeline on a deterministic drawing, including dry/wet endpoints
// and loop closure. The standalone Vite page needs neither a media library nor the Python server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { ROOT, chromePath, freePort, openBrowser, removeDir } from '../browserHarness.mjs';

test('photographic and drawn looks render distinctly, turn fully off, and close their loops on a real GPU', {
  skip: !chromePath ? 'needs Chrome or Chromium' : false,
  timeout: 120_000,
}, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'downbeat-filters-'));
  const port = await freePort();
  const server = await createServer({
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port, strictPort: true },
    plugins: [{
      name: 'filter-fixture',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/studio/filter-check') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><title>Filter render checks</title><body></body>');
        });
      },
    }],
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await removeDir(tmp);
  });
  await server.listen();
  browser = await openBrowser(join(tmp, 'chrome'));
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/studio/filter-check` });

  const result = await browser.run(`
    const [{ Engine, Pipeline }, { FILTER_LOOKS }, { FILTER_MODULES }, { cloneLook, chaosLook }, { makeSampler }, { planTimeline }, { compose }] = await Promise.all([
      import('/studio/src/engine/engine.ts'), import('/studio/src/engine/filterLooks.ts'),
      import('/studio/src/engine/filterModules.ts'), import('/studio/src/engine/looks.ts'),
      import('/studio/src/engine/audio.ts'), import('/studio/src/engine/timeline.ts'), import('/studio/src/engine/composer.ts'),
    ]);
    const w = 240, h = 320;
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const engine = new Engine(canvas), pipe = new Pipeline(engine.gpu, w, h);
    const errors = engine.warmup();
    if (errors.length) throw new Error(errors.join('; '));
    const gl = engine.gl;
    const source = document.createElement('canvas'); source.width = w; source.height = h;
    const x = source.getContext('2d');
    const sky = x.createLinearGradient(0, 0, w, h); sky.addColorStop(0, '#8db4ca'); sky.addColorStop(0.5, '#dfc4a4'); sky.addColorStop(1, '#3b6550');
    x.fillStyle = sky; x.fillRect(0, 0, w, h);
    x.fillStyle = '#fef7de'; x.beginPath(); x.arc(192, 47, 18, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#486b43';
    for (let i = 0; i < 19; i++) { x.beginPath(); x.ellipse(i * 16, 180 + 25 * Math.sin(i), 15, 65, i / 8, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = '#29363b'; x.beginPath(); x.ellipse(120, 140, 56, 75, 0, 0, Math.PI * 2); x.fill();
    const skin = x.createRadialGradient(105, 130, 3, 123, 152, 66); skin.addColorStop(0, '#e5b194'); skin.addColorStop(1, '#956e5b');
    x.fillStyle = skin; x.beginPath(); x.ellipse(121, 149, 42, 58, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#ba8d75'; x.fillRect(106, 192, 31, 46);
    const shirt = x.createLinearGradient(40, 230, 220, 320); shirt.addColorStop(0, '#eee6d8'); shirt.addColorStop(1, '#9b9791');
    x.fillStyle = shirt; x.beginPath(); x.moveTo(107, 219); x.lineTo(45, 250); x.lineTo(23, 320); x.lineTo(220, 320); x.lineTo(193, 250); x.lineTo(138, 219); x.closePath(); x.fill();
    x.fillStyle = '#293338'; x.beginPath(); x.ellipse(103, 146, 7, 3, 0, 0, Math.PI * 2); x.ellipse(139, 146, 7, 3, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#965f54'; x.lineWidth = 2; x.beginPath(); x.moveTo(107, 179); x.quadraticCurveTo(122, 186, 136, 177); x.stroke();
    x.fillStyle = '#313539'; x.beginPath(); x.moveTo(74, 134); x.bezierCurveTo(65, 61, 172, 55, 173, 130); x.bezierCurveTo(130, 111, 125, 89, 106, 107); x.closePath(); x.fill();
    // Fine edges and neutral patches expose blur, tonal and monochrome failures.
    for (let i = 0; i < 12; i++) { x.fillStyle = i % 2 ? '#d7c8b1' : '#5c625d'; x.fillRect(4 + i * 4, 275, 2, 40); }
    for (let i = 0; i < 5; i++) { x.fillStyle = 'rgb(' + i * 60 + ',' + i * 60 + ',' + i * 60 + ')'; x.fillRect(6 + i * 21, 6, 18, 10); }
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const sampler = makeSampler({ features: null, loopStart: 0, beatDur: 0.5, seed: 11, L: 8 });
    const tl = planTimeline({ L: 8, beatDur: 0.5, clips: [{ id: 'fixture', duration: 8 }], rhythm: 'bar2', transitions: ['cut'], transBeats: 0, seed: 11 });
    const render = (look, t = 2, context) => {
      const frame = compose(context || { look, tl, sampler, clipDur: () => 8, L: 8, beatDur: 0.5, seed: 11 }, t, look);
      frame.sources = frame.needs.map((need) => ({ tex: texture, vw: w, vh: h, cam: need.cam }));
      const out = pipe.render(frame, engine.aux);
      const pixels = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const err = gl.getError(); if (err) throw new Error('GL error ' + err);
      return pixels;
    };
    const neutral = cloneLook(FILTER_LOOKS[0]); neutral.layers = []; neutral.finish.p.vignette = 0;
    const dry = render(neutral);
    const difference = (a, b) => { let sum = 0, max = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); sum += d; max = Math.max(max, d); } return { mean: sum / (w * h * 3), max }; };
    const off = { editorial: { strength: 0 }, monochrome: { mix: 0 }, photoprint: { strength: 0 }, filmtexture: { dust: 0, scratches: 0, breath: 0 }, gateweave: { amount: 0, breath: 0 }, diffusion: { amount: 0 }, defocus: { amount: 0 }, gobo: { amount: 0 }, gel: { amount: 0 }, paper: { amount: 0 }, sketch: { mix: 0 }, watercolor: { mix: 0 } };
    const endpoints = [], seams = [];
    for (const id of Object.keys(FILTER_MODULES)) {
      const look = cloneLook(neutral); look.layers = [{ m: id, p: off[id], mods: {} }];
      endpoints.push({ id, ...difference(dry, render(look)) });
      look.layers[0].p = {};
      seams.push({ id, ...difference(render(look, 0), render(look, 8 - 1e-7)) });
    }
    const sheet = document.createElement('canvas'); sheet.width = 1200; sheet.height = 6 * 295;
    const sx = sheet.getContext('2d'); sx.fillStyle = '#17191c'; sx.fillRect(0, 0, sheet.width, sheet.height);
    const tile = document.createElement('canvas'); tile.width = w; tile.height = h; const tx = tile.getContext('2d');
    const addTile = (pixels, name, i) => {
      tx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
      const col = i % 6, row = Math.floor(i / 6);
      sx.save(); sx.translate(col * 200, row * 295 + 267); sx.scale(1, -1); sx.drawImage(tile, 0, 0, 200, 267); sx.restore();
      sx.fillStyle = '#e8e6e2'; sx.font = '12px sans-serif'; sx.fillText(name, col * 200 + 6, row * 295 + 285);
    };
    addTile(dry, 'Original', 0);
    const looks = [];
    for (let i = 0; i < FILTER_LOOKS.length; i++) {
      const look = FILTER_LOOKS[i], pixels = render(look);
      let hash = 2166136261, total = 0, chroma = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        total += pixels[p] + pixels[p + 1] + pixels[p + 2];
        chroma = Math.max(chroma, Math.abs(pixels[p] - pixels[p + 1]), Math.abs(pixels[p] - pixels[p + 2]));
        hash = Math.imul(hash ^ pixels[p], 16777619); hash = Math.imul(hash ^ pixels[p + 1], 16777619);
      }
      looks.push({ id: look.id, hash, mean: total / (w * h * 3), chroma, difference: difference(dry, pixels).mean });
      addTile(pixels, look.name, i + 1);
    }
    const png = sheet.toDataURL('image/png').split(',')[1];
    const remixes = [];
    sx.fillStyle = '#17191c'; sx.fillRect(0, 0, sheet.width, sheet.height); addTile(dry, 'Original', 0);
    for (const style of ['natural', 'monochrome', 'film', 'soft', 'light', 'illustrated']) {
      const variants = new Map();
      for (let seed = 1; seed < 100 && variants.size < 5; seed++) {
        const look = chaosLook(seed, style);
        variants.set(look.name, look);
      }
      for (const look of variants.values()) {
        const pixels = render(look), preset = FILTER_LOOKS.find((preset) => preset.name === look.name);
        remixes.push({ name: look.name, style, difference: difference(dry, pixels).mean, fromPreset: difference(render(preset), pixels).mean });
        addTile(pixels, look.name + ' · Remix', remixes.length);
      }
    }
    const remixPng = sheet.toDataURL('image/png').split(',')[1];
    // Reproduce the user's main-look roll being hidden by a previously styled appearance.
    const { createStudioRuntime } = await import('/studio/src/state/store.ts');
    const runtime = createStudioRuntime({ storage: null });
    runtime.store.setState({ clips: [{ id: 'fixture', duration: 8 }], selected: ['fixture'], look: cloneLook(neutral),
      rollStyle: 'film', rollOpts: { look: true, edit: false, perClip: false, clips: false, loop: false },
      blocks: [{ id: 'held', at: 0, clipId: 'fixture', in: 0, seed: 4, look: cloneLook(FILTER_LOOKS.find((look) => look.id === 'monochrome-silver')) }] });
    runtime.store.getState().rebuild();
    const before = runtime.store.getState(), oldPixels = render(before.look, 2, before.ctx);
    before.rollAll();
    const after = runtime.store.getState(), newPixels = render(after.look, 2, after.ctx);
    const scopedRemix = { difference: difference(oldPixels, newPixels).mean, ownLookCleared: !after.blocks[0].look,
      sameTiming: after.blocks[0].at === before.blocks[0].at && after.blocks[0].in === before.blocks[0].in };
    runtime.dispose();
    gl.deleteTexture(texture); pipe.dispose(); engine.dispose();
    return { endpoints, seams, looks, remixes, scopedRemix, png, remixPng };
  `);
  if (process.env.DOWNBEAT_FILTER_METRICS) writeFileSync(process.env.DOWNBEAT_FILTER_METRICS, JSON.stringify({ presets: result.looks, remixes: result.remixes }, null, 2));
  if (process.env.DOWNBEAT_REMIX_PREVIEW) writeFileSync(process.env.DOWNBEAT_REMIX_PREVIEW, Buffer.from(result.remixPng, 'base64'));
  for (const endpoint of result.endpoints) assert.ok(endpoint.max <= 2, `${endpoint.id} at zero strength changed the image: ${JSON.stringify(endpoint)}`);
  for (const seam of result.seams) assert.ok(seam.mean < 0.1, `${seam.id} jumped at its loop seam: ${JSON.stringify(seam)}`);
  for (const look of result.looks) {
    assert.ok(look.mean > 15 && look.mean < 245, `${look.id} rendered empty or clipped`);
    assert.ok(look.difference > 0.1, `${look.id} did not affect the picture`);
    if (look.id.startsWith('monochrome-') && look.id !== 'monochrome-selenium') assert.ok(look.chroma <= 1, `${look.id} has a color cast`);
  }
  assert.equal(new Set(result.looks.map((look) => look.hash)).size, result.looks.length, 'each preset produces a distinct image');
  assert.ok(result.scopedRemix.ownLookCleared && result.scopedRemix.sameTiming, 'Remix must reach an owned appearance without moving it');
  assert.ok(result.scopedRemix.difference >= 6, 'the actual composed appearance must visibly change after Remix');
  for (const remix of result.remixes) {
    assert.ok(remix.difference >= 6, `${remix.name} looks almost untreated: ${remix.difference.toFixed(2)}/255`);
    if (['natural', 'film', 'soft', 'light'].includes(remix.style)) {
      assert.ok(remix.fromPreset >= 2, `${remix.name} is too delicate for Remix: ${remix.fromPreset.toFixed(2)}/255`);
    }
  }
  assert.deepEqual(browser.problems, []);
  if (process.env.DOWNBEAT_FILTER_PREVIEW) writeFileSync(process.env.DOWNBEAT_FILTER_PREVIEW, Buffer.from(result.png, 'base64'));
});
