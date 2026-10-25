import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, sleep, python, missing, freePort, writeSong, makeClip, openBrowser } from '../browserHarness.mjs';

if (process.env.DOWNBEAT_REQUIRE_E2E === '1' && missing.length) throw new Error(`The quality gate requires ${missing.join(', ')}`);

test('clip speed matches tempo in the browser, keeps cuts, and exports moving footage', {
  skip: missing.length ? `needs ${missing.join(', ')}` : false,
  timeout: 180_000,
}, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'downbeat-speed-'));
  const media = join(tmp, 'media');
  const out = join(tmp, 'out');
  mkdirSync(media);
  mkdirSync(out);
  makeClip(join(media, '1 bars.mp4'), 'testsrc2', '360x640');
  makeClip(join(media, '2 swirl.mp4'), 'mandelbrot', '640x360');
  writeSong(join(media, 'Test Song.wav'), 24, 120);
  writeFileSync(join(out, '.library.json'), JSON.stringify({ folders: [media] }));
  const port = await freePort();
  const launcher = [
    'import sys',
    'from downbeat.server import state, app',
    'state.OUT_DIR = app.OUT_DIR = sys.argv[1]',
    'state.STATE = app.STATE = state.StudioState()',
    'app.serve_studio(port=int(sys.argv[2]), open_browser=False)',
  ].join('\n');
  const server = spawn(python, ['-c', launcher, out, String(port)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (data) => { serverErr = (serverErr + data).slice(-4000); });
  let browser;
  t.after(async () => {
    browser?.ws.close();
    browser?.proc.kill();
    server.kill();
    await sleep(300);
    rmSync(tmp, { recursive: true, force: true });
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break; } catch {}
    assert.ok(i < 150, `the server did not start: ${serverErr}`);
    await sleep(200);
  }
  browser = await openBrowser(join(tmp, 'chrome'));
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  const PAGE = `
    const $ = (s) => document.querySelector(s);
    const S = window.__studio?.store;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 10000) => {
      const start = performance.now();
      while (!fn()) { if (performance.now() - start > ms) throw new Error('timed out: ' + fn); await sleep(100); }
    };
    const tap = async (el) => { if (!el) throw new Error('missing control'); el.click(); await sleep(0); };
    const byText = (selector, text) => [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text);
  `;
  // Wait for the debug handle before running helpers that capture the store.
  await browser.run(`
    const start = performance.now();
    while (!window.__studio?.ctx || !window.__studio.store.getState().features || !window.__studio.store.getState().clips.every((c) => c.proxy === 'ready')) {
      if (performance.now() - start > 90000) throw new Error('studio did not load');
      await new Promise((r) => setTimeout(r, 100));
    }
  `);
  const state = await browser.run(PAGE + `
    window.__studio.setLook({ id: 'speed-test', name: 'Speed test', vibe: '', layers: [],
      camera: { p: { zoom: 1, drift: 0, shake: 0, sway: 0, speed: 1 } },
      finish: { p: { contrast: 1, saturation: 1, split: 0, fade: 0, vignette: 0, grain: 0 } },
      cut: { rhythm: 'bar', transitions: ['cut'], beats: 0, velocity: 'none' } });
    S.getState().setBars(2);
    S.getState().setTab('edit');
    await sleep(0);
    const cuts = JSON.stringify(S.getState().ctx.tl.segs.map((s) => [s.t0, s.t1]));
    await tap(byText('#pane-edit .clip-speed button', '1.25×'));
    if (!S.getState().ctx.tl.segs.every((s) => s.speed === 1.25)) throw new Error('default speed did not apply');
    await tap(byText('#pane-edit .clip-speed button', '1×'));
    S.getState().transport.seek(0.5);
    await tap($('#blockTools .tl-edit'));
    await tap(byText('#pop .seg-tabs button', 'Playback'));
    const id = S.getState().selectedBlock;
    const bpm = S.getState().bpm();
    const input = $('#pop input[aria-label="Original clip BPM"]');
    input.value = String(bpm / 1.5);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tap($('#pop .seg-bpm button'));
    const seg = S.getState().ctx.tl.segs.find((s) => s.id === id);
    if (Math.abs(seg.speed - 1.5) > 1e-9 || seg.vel !== 'none') throw new Error('BPM match did not set constant 1.5×');
    if (JSON.stringify(S.getState().ctx.tl.segs.map((s) => [s.t0, s.t1])) !== cuts || S.getState().bpm() !== bpm) throw new Error('speed changed the cuts or song tempo');
    S.getState().transport.seek(seg.t0 + 0.4);
    S.getState().transport.play();
    await until(() => { const video = S.getState().bank.els.get(seg.clipId + '#' + id); return video && !video.paused && video.playbackRate === 1.5; });
    S.getState().transport.pause();
    $('.seg-speed').scrollIntoView({ block: 'center' });
    return { id, bpm, speed: seg.speed, cuts: JSON.parse(cuts) };
  `);
  assert.equal(state.speed, 1.5);
  if (process.env.DOWNBEAT_SPEED_SCREENSHOT_DIR) {
    mkdirSync(process.env.DOWNBEAT_SPEED_SCREENSHOT_DIR, { recursive: true });
    const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DOWNBEAT_SPEED_SCREENSHOT_DIR, 'clip-speed-desktop.png'), Buffer.from(screenshot.result.data, 'base64'));
  }
  await browser.run(PAGE + `await tap($('#pop .seg-x'));`);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await browser.run(PAGE + `
    await tap($('#blockTools .tl-edit'));
    await tap(byText('#pop .seg-tabs button', 'Playback'));
    $('.seg-speed').scrollIntoView({ block: 'center' });
    const box = $('#pop').getBoundingClientRect();
    if (box.left < 0 || box.right > innerWidth || box.height > innerHeight) throw new Error('speed menu leaves the narrow viewport');
    const button = $('#pop .seg-bpm button').getBoundingClientRect();
    if (button.left < box.left || button.right > box.right) throw new Error('BPM control overflows');
  `);
  if (process.env.DOWNBEAT_SPEED_SCREENSHOT_DIR) {
    const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DOWNBEAT_SPEED_SCREENSHOT_DIR, 'clip-speed-mobile.png'), Buffer.from(screenshot.result.data, 'base64'));
  }
  await browser.run(PAGE + `await tap($('#pop .seg-x'));`);
  await browser.send('Emulation.clearDeviceMetricsOverride');
  const rendered = await browser.run(PAGE + `
    S.setState({ exportOpts: { format: 'spotify', size: 'lite', autoSave: false, withSong: false } });
    S.getState().openExport();
    await sleep(0);
    await tap(byText('#exportForm button', 'Render & verify'));
    await until(() => !S.getState().exporting, 90000);
    const render = S.getState().renders[0];
    if (!render) throw new Error('export failed: ' + $('#exportStatus').textContent);
    return { duration: render.duration, resolution: render.resolution, footage: render.checks.find((c) => c.id === 'footage') };
  `);
  assert.equal(rendered.resolution, '720x1280');
  assert.equal(rendered.footage?.level, 'ok', JSON.stringify(rendered.footage));
  assert.ok(Math.abs(rendered.duration - 4 * 120 / state.bpm) < 0.05);
  assert.deepEqual(browser.problems, []);
});
