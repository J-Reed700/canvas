// A real studio, real media/proxies, real GPU preview and real export, entirely in a temporary home.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ROOT, missing, freePort, makeClip, openBrowser, python, sleep, removeDir, homeEnv, stopProcess } from '../browserHarness.mjs';

assert.equal(missing.length, 0, `Performance qualification requires ${missing.join(', ')}`);
const soakSeconds = Number(process.env.DOWNBEAT_SOAK_SECONDS || 60);
assert.ok(Number.isFinite(soakSeconds) && soakSeconds >= 10 && soakSeconds <= 3600, 'DOWNBEAT_SOAK_SECONDS must be 10–3600');
const temporary = mkdtempSync(join(tmpdir(), 'downbeat-performance-'));
const home = join(temporary, 'home'), out = join(temporary, 'out'), media = join(home, 'Media');
mkdirSync(media, { recursive: true }); mkdirSync(out);
let server, browser;
try {
  makeClip(join(media, '1 bars.mp4'), 'testsrc2', '360x640');
  makeClip(join(media, '2 swirl.mp4'), 'mandelbrot', '640x360');
  const port = await freePort();
  const launcher = [
    'import sys', 'from downbeat.server import state, app', 'state.OUT_DIR = app.OUT_DIR = sys.argv[1]',
    'state.STATE = app.STATE = state.StudioState()', 'app.serve_studio(port=int(sys.argv[2]), open_browser=False)',
  ].join('\n');
  server = spawn(python, ['-c', launcher, out, String(port)], { cwd: ROOT, env: homeEnv(home), stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  server.stderr.on('data', (data) => { errors += data; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break; } catch {}
    assert.ok(i < 100 && server.exitCode === null, `Server startup failed: ${errors.slice(-1000)}`);
    await sleep(100);
  }
  const library = await fetch(`http://127.0.0.1:${port}/api/library/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add: media }) });
  assert.ok(library.ok, 'The fixture library could not be loaded');
  browser = await openBrowser(join(temporary, 'chrome'));
  await browser.send('Performance.enable');
  const started = performance.now();
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await browser.run(`
    const end = performance.now() + 90000;
    while (!(window.__studio?.ctx && window.__studio.store.getState().clips.every((clip) => clip.proxy === 'ready'))) {
      if (performance.now() > end) throw new Error('Studio/proxy startup timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    window.__studio.transport.pause();
    window.__studio.store.getState().setScreen('landscape');
    // Commit the screen choice before exercising undo. Otherwise the first immediate undo
    // can correctly coalesce it with the look change and restore the portrait startup format.
    const historyEnd = performance.now() + 5000;
    while (document.getElementById('btnUndo').disabled) {
      if (performance.now() > historyEnd) throw new Error('The benchmark screen choice did not enter history');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    document.querySelector('[aria-label="Focus viewer"]').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (window.__studio.engine.main.w < 800) throw new Error('The performance fixture needs a full-size landscape viewer');
  `);
  const startupMs = performance.now() - started;
  console.log(`Studio ready in ${Math.round(startupMs)} ms; warming preview and history.`);
  const heap = async () => {
    await browser.send('HeapProfiler.collectGarbage');
    const result = await browser.send('Performance.getMetrics');
    const metrics = Object.fromEntries(result.result.metrics.map(({ name, value }) => [name, value]));
    return { js_heap_bytes: metrics.JSHeapUsedSize, dom_nodes: metrics.Nodes, documents: metrics.Documents };
  };
  const initial = await heap();
  // Warm shaders, media, UI and undo caches before measuring retained growth.
  await browser.run(`
    const s = window.__studio.store;
    for (let i = 0; i < 40; i++) { s.getState().stepLook(1); s.getState().undo(); }
    s.getState().transport.play();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (s.getState().exportOpts.format !== 'youtube_16_9' || window.__studio.engine.main.w < 800) throw new Error('Undo changed the benchmark viewer format');
  `);
  const warmed = await heap();
  console.log(`Measuring ${soakSeconds} seconds of playback, look changes and undo.`);
  const workload = await browser.run(`
    const store = window.__studio.store, engine = window.__studio.engine;
    const intervals = [], commits = [], longTasks = [];
    let lastRaf, lastCommit, edits = 0;
    const observer = new MutationObserver(() => { const now = performance.now(); if (lastCommit !== undefined) commits.push(now - lastCommit); lastCommit = now; });
    observer.observe(document.getElementById('viewerTimecode'), { childList: true, characterData: true, subtree: true });
    const tasks = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes.includes('longtask') ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))) : null;
    tasks?.observe({ type: 'longtask' });
    const end = performance.now() + ${soakSeconds * 1000};
    await new Promise((resolve) => {
      const frame = (now) => {
        if (lastRaf !== undefined) intervals.push(now - lastRaf);
        lastRaf = now;
        if (now >= end) return resolve();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const edit = () => {
        const state = store.getState();
        if (performance.now() >= end) return;
        state.stepLook(1); state.undo();
        edits++;
        setTimeout(edit, 250);
      };
      edit();
    });
    observer.disconnect(); tasks?.disconnect();
    store.getState().transport.pause();
    const summary = (samples) => {
      samples.sort((a, b) => a - b);
      return { samples: samples.length, median_ms: samples[Math.floor(samples.length / 2)] || 0, p95_ms: samples[Math.floor(samples.length * .95)] || 0, max_ms: samples.at(-1) || 0 };
    };
    const gl = engine.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { edits, raf: summary(intervals), timecode_updates: summary(commits), long_tasks: summary(longTasks), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), resolution: [engine.main.w, engine.main.h], format: store.getState().exportOpts.format, look: store.getState().lookId, context_lost: gl.isContextLost(), playback_players: store.getState().bank.els.size, history_depth: document.getElementById('btnUndo')?.disabled === false };
  `);
  const afterSoak = await heap();
  const exportStart = performance.now();
  const exported = await browser.run(`
    const store = window.__studio.store;
    store.setState({ exportOpts: { format: 'spotify', size: 'lite', withSong: false, autoSave: false } });
    store.getState().setBars(2);
    const before = store.getState().renders.length;
    await store.getState().runExport();
    if (store.getState().renders.length !== before + 1) throw new Error('The measured export failed: ' + document.getElementById('exportStatus')?.textContent);
    const rendered = store.getState().renders[0];
    return { resolution: rendered.resolution, duration: rendered.duration, size_mb: rendered.size_mb, codec: rendered.codec, checks: rendered.checks };
  `);
  const exportMs = performance.now() - exportStart;
  const afterExport = await heap();
  const bundle = await browser.run(`return document.querySelector('script[type="module"][src]')?.getAttribute('src');`);
  const report = {
    schema: 1, timestamp: new Date().toISOString(), host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    runtime: process.version, bundle, startup_ready_ms: startupMs, soak_seconds: soakSeconds,
    workload: 'Two generated moving clips; focused landscape viewer (resolution recorded below); live preview with a look change and undo every 250 ms; forced-GC JS heap snapshots; one actual 720×1280 H.264 export. RAF and timecode timings include browser scheduling; they are not GPU timer-query measurements.',
    preview: workload, memory: { initial, warmed, after_soak: afterSoak, after_export: afterExport, retained_soak_growth_bytes: afterSoak.js_heap_bytes - warmed.js_heap_bytes },
    export: { ...exported, wall_ms: exportMs }, errors: browser.problems,
    budgets: { startup_ms: 90000, raf_p95_ms: 50, retained_soak_growth_bytes: 8 * 1024 * 1024, playback_players: 20, export_wall_ms: 120000 },
  };
  const destination = resolve(process.env.DOWNBEAT_BROWSER_PERF_REPORT || 'artifacts/performance/studio.json');
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${destination}`);
  if (process.argv.includes('--check')) {
    assert.equal(workload.context_lost, false, 'GPU context was lost');
    assert.ok(workload.format === 'youtube_16_9' && workload.resolution[0] >= 800, 'The measured viewer format changed during the workload');
    assert.deepEqual(browser.problems, [], 'Browser runtime errors');
    assert.ok(startupMs < report.budgets.startup_ms, 'Startup exceeded its budget');
    assert.ok(workload.raf.samples > soakSeconds * 5, 'Too few preview frames to qualify');
    assert.ok(workload.raf.p95_ms < report.budgets.raf_p95_ms, 'Preview scheduling exceeded its budget');
    assert.ok(report.memory.retained_soak_growth_bytes < report.budgets.retained_soak_growth_bytes, 'Retained JS heap growth exceeded its budget');
    assert.ok(workload.playback_players <= report.budgets.playback_players, 'Playback video elements exceeded their bound');
    assert.ok(exportMs < report.budgets.export_wall_ms, 'Export exceeded its budget');
    assert.equal(exported.resolution, '720x1280', 'Export benchmark dimensions changed');
    assert.ok(exported.duration >= 3 && exported.duration <= 8, 'Export benchmark length changed');
    assert.ok(!(exported.checks || []).some((check) => check.level === 'fail'), 'The measured export failed its media QA');
  }
} finally {
  await browser?.close();
  await stopProcess(server);
  await removeDir(temporary);
}
