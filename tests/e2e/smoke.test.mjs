// End-to-end smoke test: the real server, the built studio in headless Chrome (WebGL and all), clicks
// on the controls people use most, and one real export checked by the server.
//
// Run it with `make e2e` or `node --test tests/e2e/`. It needs Chrome or Chromium, ffmpeg and the
// built studio (downbeat/studio/dist); it skips itself when one is missing. Everything happens in a
// temporary folder that stands in for your home directory and out/, so your files are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT, sleep, python, missing, freePort, writeSong, makeClip, openBrowser } from '../browserHarness.mjs';

if (process.env.DOWNBEAT_REQUIRE_E2E === '1' && missing.length) {
  throw new Error(`The quality gate requires ${missing.join(', ')}`);
}

// Helpers defined in the page before each step.
const PAGE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const S = { getState: () => window.__studio.store.getState() };
  const until = async (fn, ms = 20000, what = 'a condition') => {
    const t0 = performance.now();
    for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(100); }
  };
  const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim() === text);
  const card = (title) => $$('.card').find((c) => c.querySelector('.ct')?.firstChild?.textContent === title);
  const setRange = (input, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  // A person's clicks are separate events, so React redraws between them; give it that chance.
  const tap = async (el) => { el.click(); await sleep(0); };
`;

test('the studio works end to end in a real browser', { skip: missing.length ? `needs ${missing.join(', ')}` : false, timeout: 240_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'downbeat-e2e-'));
  const home = join(tmp, 'home');
  const out = join(tmp, 'out');
  const media = join(home, 'Movies', 'Canvas');
  mkdirSync(media, { recursive: true });
  mkdirSync(join(home, 'Downloads'));
  mkdirSync(out);
  makeClip(join(media, '1 bars.mp4'), 'testsrc2', '360x640');
  makeClip(join(media, '2 swirl.mp4'), 'mandelbrot', '640x360');
  writeSong(join(media, 'Test Song.wav'), 24, 120);
  makeClip(join(home, 'Downloads', '3 ignored.mp4'), 'testsrc2', '360x640'); // Downloads isn't looked in

  // The real server, pointed at the temporary out/ folder.
  const port = await freePort();
  const launcher = [
    'import sys',
    'from downbeat.server import state, app',
    'state.OUT_DIR = app.OUT_DIR = sys.argv[1]',
    'state.STATE = app.STATE = state.StudioState()',
    'app.serve_studio(port=int(sys.argv[2]), open_browser=False)',
  ].join('\n');
  const server = spawn(python, ['-c', launcher, out, String(port)], { cwd: ROOT, env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  let browser;
  t.after(async () => {
    browser?.ws.close();
    browser?.proc.kill();
    server.kill();
    await sleep(300);
    rmSync(tmp, { recursive: true, force: true });
  });
  browser = await openBrowser(join(tmp, 'chrome'));
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break; } catch {}
    assert.ok(i < 150, `the server did not start: ${serverErr.slice(-1500)}`);
    await sleep(200);
  }

  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  // Steps run in order on one page; after a failure the rest are skipped rather than failing for the same reason.
  let broken = null;
  const step = (name, body, viewport = null) =>
    t.test(name, { skip: broken ? `an earlier step failed: ${broken}` : false }, async () => {
      try {
        if (viewport) await browser.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
        await browser.run(PAGE + body);
      } catch (e) {
        broken = name;
        const diagnostics = await browser.run(`
          const canvas = document.querySelector('.video-scope');
          const state = window.__studio?.store.getState();
          const ancestors = [];
          for (let el = canvas; el; el = el.parentElement) {
            const r = el.getBoundingClientRect(), css = getComputedStyle(el);
            ancestors.push({ tag: el.tagName, id: el.id, className: el.className,
              rect: [r.x, r.y, r.width, r.height], display: css.display, visibility: css.visibility,
              scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight });
          }
          return { hidden: document.hidden, viewport: [innerWidth, innerHeight],
            tab: state?.tab, exporting: state?.exporting, lastOut: !!state?.engine?.lastOut,
            contextLost: state?.engine?.gl.isContextLost(), scopeMode: document.querySelector('.scope-toolbar button.on')?.textContent,
            ancestors };
        `).catch((error) => ({ error: error.message }));
        const files = readdirSync(out).filter((f) => !f.startsWith('.')).map((f) => `${f} (${statSync(join(out, f)).size} B)`);
        throw new Error(`${e.message}\nout/: ${files.join(', ') || 'empty'}\nserver: ${serverErr.slice(-800)}\ndiagnostics: ${JSON.stringify(diagnostics)}`);
      } finally {
        if (viewport) await browser.send('Emulation.clearDeviceMetricsOverride');
      }
    });

  await step('opens on Pick a folder, and the folder typed in loads its clips and song', `
    await until(() => $('#btnPickFolder'), 30000, 'the Pick a folder button');
    if (S.getState().clips.length) throw new Error('clips listed before a folder was picked');
    // The Mac folder chooser can't be driven from here, so type the path as Linux does.
    await tap(S.getState().canPick ? byText('.welcome button', 'Type a path instead') : $('#btnPickFolder'));
    const input = await until(() => $('.welcome input'), 2000, 'the path box');
    setRange(input, ${JSON.stringify(media)});
    input.form.requestSubmit();
    await until(() => !$('.welcome'), 30000, 'the welcome screen to close');
    if (!$('#toast').textContent.includes('2 videos and 1 song')) throw new Error('toast: ' + $('#toast').textContent);
  `);

  await step('loads the clips and the song, with every clip ready to play', `
    await until(() => window.__studio?.ctx, 30000, 'the studio to start');
    await until(() => S.getState().features && !S.getState().trackStateText, 30000, 'the song analysis');
    await until(() => S.getState().clips.length === 2 && S.getState().clips.every((c) => c.proxy === 'ready'), 90000, 'playback proxies');
    if (!$('#trackSelect').textContent.includes('Test Song')) throw new Error('song not picked: ' + $('#trackSelect').textContent);
    if (Math.abs(S.getState().bpm() - 120) > 1) throw new Error('tempo ' + S.getState().bpm());
  `);

  await step('the workspace command menu, focus viewer, panel sizing and frame stepping work', `
    const originalView = $('#view');
    const originalLook = S.getState().lookId;
    const originalTab = S.getState().tab;
    const inputEvent = (element, key, extras = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extras }));
    inputEvent(window, 'k', { metaKey: true });
    const commands = await until(() => $('[role="combobox"][aria-label="Search commands"]'), 2000, 'commands');
    setRange(commands, 'color');
    await until(() => $$('.command-option').length === 1, 2000, 'filtered commands');
    inputEvent(commands, 'Enter');
    await until(() => $('#pane-layers') && !$('.command-menu'), 2000, 'the layer inspector');
    await tap(byText('.layers-subnav button', 'Color'));
    if (!$('#layer-effects-section').hidden || $('#layer-color-section').hidden) throw new Error('Color section did not isolate');
    await tap(byText('.layers-subnav button', 'All'));
    await tap($('[aria-label="Focus viewer"]'));
    if (getComputedStyle($('.media')).display !== 'none' || getComputedStyle($('.inspector')).display !== 'none') throw new Error('panels did not hide');
    if ($('#view') !== originalView) throw new Error('focus remounted the GPU canvas');
    key('Escape');
    await until(() => !$('.workspace-focus'), 2000, 'restored workspace');
    const divider = $('[aria-label="Resize library"]');
    const width = +divider.getAttribute('aria-valuenow');
    inputEvent(divider, 'ArrowRight');
    await until(() => +divider.getAttribute('aria-valuenow') === width + 10, 2000, 'panel resize');
    inputEvent(divider, 'Home');
    S.getState().transport.pause(); S.getState().transport.seek(0);
    await tap($('[aria-label="Next frame"]'));
    if (Math.abs(S.getState().transport.loopTime() - 1/30) > 1e-6) throw new Error('not one frame');
    await until(() => $('#viewerTimecode').textContent === '00:00:00:01', 2000, 'frame timecode');
    if (S.getState().lookId !== originalLook) throw new Error('workspace navigation changed the edit');
    S.getState().setTab(originalTab);
    S.getState().transport.seek(0);
  `);

  const responsiveControls = `
    await sleep(150);
    const reachable = (selector) => {
      const element = $(selector);
      if (!element) throw new Error('missing control ' + selector);
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || !element.checkVisibility()) throw new Error('hidden control ' + selector);
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (target !== element && !element.contains(target)) throw new Error('obscured control ' + selector + ' by ' + target?.className);
      return element;
    };
    for (const selector of ['#btnAddMedia', '#trackSelect', '#btnAddFolder', '.clip-arrange > summary', '#btnAutoFrame', '#tScreen', '#tHud', '#tSafe', '#btnPlay', '#modeSeg button[data-mode="listen"]', '#barsSeg button', '#loopChips button', '#rhythmSeg button:last-child', '#btnRoll', '#btnRollOpts', '#btnUndo', '#btnRedo', '#btnHelp', '#btnExport', '#tabs button:last-child']) reachable(selector);
    const wasHud = S.getState().hud, wasSafe = S.getState().safe;
    await tap(reachable('#tHud'));
    if (S.getState().hud === wasHud) throw new Error('player UI toggle failed');
    await tap(reachable('#tHud'));
    await tap(reachable('#tSafe'));
    if (S.getState().safe === wasSafe) throw new Error('safe guide toggle failed');
    await tap(reachable('#tSafe'));
    await tap(reachable('#modeSeg button[data-mode="listen"]'));
    if (S.getState().transport.mode !== 'listen') throw new Error('Listener mode unavailable');
    await tap(reachable('#tOffSync'));
    if (!S.getState().transport.phase) throw new Error('off-sync unavailable');
    await tap(reachable('#tOffSync'));
    await tap(reachable('#modeSeg button[data-mode="loop"]'));
    window.scrollTo(0, 0);
    if (document.documentElement.scrollWidth > innerWidth) throw new Error('workspace overflows the window');
  `;
  await step('existing controls remain reachable and work in a narrow desktop window', responsiveControls, { width: 1024, height: 768 });
  await step('existing controls remain reachable and work in a phone-width window', responsiveControls, { width: 390, height: 844 });

  await step('the compact Sequence menu preserves All, Solo, Reverse and Shuffle actions', `
    const selected = [...S.getState().selected];
    const menu = $('.clip-arrange');
    const arrange = async (id) => {
      await tap(menu.querySelector('summary'));
      if (!menu.open) throw new Error('Sequence menu did not open');
      const control = $('#' + id);
      const r = control.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(control).visibility === 'hidden') throw new Error(id + ' unavailable');
      await tap(control);
      if (menu.open) throw new Error('Sequence menu did not close');
    };
    await arrange('btnReverse');
    if (JSON.stringify(S.getState().selected) !== JSON.stringify([...selected].reverse())) throw new Error('Reverse changed behavior');
    await arrange('btnShuffle');
    if ([...S.getState().selected].sort().join() !== [...selected].sort().join()) throw new Error('Shuffle lost clips');
    await arrange('btnSoloClip');
    if (S.getState().selected.length !== 1) throw new Error('Solo did not isolate a clip');
    await arrange('btnAllClips');
    if (S.getState().selected.length !== S.getState().clips.length) throw new Error('All did not select loaded clips');
    window.__studio.store.setState({ selected }); S.getState().rebuild();
  `);

  await step('Clips: the search narrows the panel, and the browser shows a clip with its folder', `
    setRange($('.clip-find input'), 'swirl');
    await until(() => $$('#clips .clip').length === 1 && $('#clipCount').textContent === '1 of 2 shown', 2000, 'the clip search');
    setRange($('.clip-find input'), '');
    await until(() => $$('#clips .clip').length === 2, 2000, 'the search to clear');
    await tap($('#btnBrowseClips'));
    await until(() => $$('.clip-card').length === 2, 5000, 'the clips browser');
    await tap($$('.clip-card .lib-open').find((b) => b.textContent.includes('2 swirl.mp4')));
    await until(() => $('.lib-view video'), 5000, 'the clip player');
    const rows = $$('.lib-view .summary b').map((b) => b.textContent);
    if (!rows.includes('Canvas') || !rows.includes('640 × 360 · Landscape')) throw new Error('details: ' + rows.join(' | '));
    key('Escape');
    await until(() => !$('.lib-view') && $('.clip-card'), 2000, 'the grid');
    key('Escape');
    await until(() => !S.getState().clipsOpen, 2000, 'the browser to close');
  `);

  await step('every effect, transition and render pass compiles on this GPU', `
    const errors = S.getState().engine.warmup();
    if (errors.length) throw new Error(errors.join('\\n'));
  `);

  await step('Color studio imports a LUT, applies it in the finish pass, and draws scopes', `
    S.getState().setTab('layers');
    await until(() => document.querySelector('[aria-label="Import 3D LUT"]'), 5000, 'the color studio');
    const upload = document.querySelector('[aria-label="Import 3D LUT"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['TITLE "Test red"\\nLUT_3D_SIZE 2\\n' + Array(8).fill('1 0 0').join('\\n')], 'red.cube'));
    upload.files = transfer.files;
    upload.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => S.getState().look.finish.lut?.name === 'Test red', 5000, 'the grade to import');
    await until(() => S.getState().engine.main.frame?.lut?.name === 'Test red', 5000, 'the composed LUT');
    const engine = S.getState().engine, gpu = engine.gpu, gl = engine.gl;
    const dest = gpu.target(4, 4, { float: false });
    const lut = S.getState().look.finish.lut;
    const uniforms = { ...engine.main.U(dest), p_exposure: 0, p_contrast: 1, p_saturation: 1, p_temp: 0, p_tint: 0, p_fade: 0,
      p_split: 0, p_splitHue: 0, p_vignette: 0, p_grain: 0, p_bars: 0, p_halation: 0,
      uLutSize: 2, uLutMin: [0,0,0], uLutMax: [1,1,1], uLutMix: 1 };
    const draw = (mix) => {
      gpu.draw('finish', '', dest, { ...uniforms, uLutMix: mix }, { uSrc: gpu.black, uGlow: gpu.black, uLut: gpu.lut(lut) });
      const px = new Uint8Array(4 * 4 * 4);
      gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [...px.slice(0, 3)];
    };
    const red = draw(1), half = draw(0.5), black = draw(0);
    if (red[0] < 254 || red[1] > 1 || red[2] > 1) throw new Error('3D LUT output ' + red);
    if (half[0] < 126 || half[0] > 129 || half[1] > 1) throw new Error('LUT mix ' + half);
    if (black.some((v) => v > 1)) throw new Error('LUT bypass ' + black);
    gpu.free(dest);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error after grading');
    await tap(byText('.scope-toolbar button', 'RGB parade'));
    $('.video-scope').scrollIntoView({ block: 'end', behavior: 'instant' });
    await until(() => {
      const canvas = $('.video-scope');
      return canvas && canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 !== 3 && v > 40);
    }, 5000, 'visible scopes to draw actual pixels');
    await tap(byText('.scope-toolbar button', 'Off'));
    await tap(byText('.grade-actions button', 'Remove LUT'));
    if (S.getState().look.finish.lut) throw new Error('LUT not removed');
    S.getState().setTab('looks');
    await sleep(0);
  `);

  await step('renders a native 3840-square frame and returns to the preview', `
    const engine = S.getState().engine, gl = engine.gl;
    const width = engine.main.w, height = engine.main.h;
    const frame = engine.main.frame;
    window.__studio.store.setState({ exporting: true });
    try {
      engine.resize(3840, 3840);
      const out = engine.renderMain({ ...frame, sources: frame.sources.slice(0, 1), needs: frame.needs.slice(0, 1),
        broll: null, trans: null, pre: null, layers: [], finish: { ...frame.finish, p_halation: 0 } });
      if (out.w !== 3840 || out.h !== 3840) throw new Error('Native render was resized');
      const pixels = engine.readStats(out);
      if (!pixels.some((v, i) => i % 4 !== 3 && v > 10)) throw new Error('Native render is black');
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error at native square size');
    } finally {
      engine.resize(width, height);
      engine.main.reset();
      window.__studio.store.setState({ exporting: false });
    }
  `);

  await step('Layers: the step grid, a layer switch, Add effect, a macro and the palette respond', `
    byText('#tabs button', 'Layers ' + $('#layerCount').textContent).click();
    await until(() => $('#pane-layers'), 5000, 'the Layers tab');
    const n = S.getState().look.layers.length;
    const cell = $$('.seqgrid button')[5];
    const was = cell.className;
    await tap(cell);
    await until(() => $$('.seqgrid button')[5].className !== was, 2000, 'the step to light');
    const firstCard = $$('.card').find((c) => c.querySelector('.sw'));
    await tap(firstCard.querySelector('.sw'));
    await until(() => firstCard.className.includes('off'), 2000, 'the layer switch');
    await tap(byText('.layer-tools button', '+ Add effect'));
    await tap($$('#pop button').find((b) => b.textContent.startsWith('Feedback Trails')));
    await until(() => card('Feedback Trails') && $('#layerCount').textContent === String(n + 1), 2000, 'the new layer card');
    const macro = $$('.prm').find((r) => r.querySelector('label')?.textContent === 'Macro A');
    setRange(macro.querySelector('input'), 0.7);
    await until(() => macro.querySelector('output').textContent === '70%', 2000, 'the macro slider');
    await until(() => $('.pal-row'), 20000, 'the clip palette');
    await tap($('.pal-row'));
    await until(() => $('.pal-row').className.includes('on'), 2000, 'the palette tint');
  `);

  if (!broken && process.env.DOWNBEAT_E2E_SCREENSHOT) {
    await browser.run(PAGE + `
      const color = card('Color studio');
      color?.scrollIntoView({ block: 'end' });
      await tap(byText('.scope-toolbar button', 'Waveform'));
      $('.video-scope')?.scrollIntoView({ block: 'end' });
      await sleep(300);
    `);
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) writeFileSync(process.env.DOWNBEAT_E2E_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
    await browser.run(PAGE + `await tap(byText('.scope-toolbar button', 'Off'));`);
  }

  await step('Edit and transport: a 2-bar loop, play and pause, and the readouts move', `
    byText('#tabs button', 'Edit').click();
    await until(() => $('#pane-edit'), 5000, 'the Edit tab');
    byText('#pane-edit .seg button', '2 bars').click();
    await until(() => S.getState().bars === 2 && Math.abs(S.getState().ctx.L - 2 * S.getState().barDur()) < 1e-6, 2000, 'the 2-bar loop');
    key(' ');
    await until(() => S.getState().transport.playing, 2000, 'playback');
    const t0 = $('#timeNow').textContent;
    await until(() => $('#timeNow').textContent !== t0, 5000, 'the time readout');
    key(' ');
    await until(() => !S.getState().transport.playing, 2000, 'pause');
    await until(() => /^\\d+ fps$/.test($('#fps').textContent), 2000, 'the frame rate readout');
  `);

  await step('Block edits: B splits at the playhead, the toolbar deletes and repeats, and the cut shows as Custom', `
    await tap(byText('#rhythmSeg button', 'Bar'));
    const n = () => S.getState().ctx.tl.segs.length;
    const bd = S.getState().beatDur();
    await until(() => n() === 2, 2000, 'a cut a bar in the 2-bar loop');
    S.getState().transport.seek(bd * 2.2);
    key('b');
    await until(() => n() === 3, 2000, 'the split');
    await tap(byText('#blockTools button', 'Delete'));
    await until(() => n() === 2, 2000, 'the delete');
    S.getState().transport.seek(bd * 1.1);
    key('b');
    await until(() => n() === 3, 2000, 'a split at beat 2');
    await tap(byText('#blockTools button', 'Repeat'));
    await until(() => n() === 4 && S.getState().ctx.tl.handCut, 2000, 'the repeat');
    await until(() => byText('#rhythmSeg button', 'Custom'), 2000, 'the Custom chip');
    // the export that follows renders this hand cut
  `);

  await step('exports a Spotify Canvas that passes every check', `
    key('e');
    await until(() => S.getState().exportOpen, 2000, 'the export sheet');
    await tap(byText('.fmt-seg button', 'Spotify 9:16'));
    await tap($$('.opt-card').find((c) => c.textContent.includes('720 × 1280')));
    const auto = $$('#exportForm label.check').find((l) => l.textContent.includes('Downloads folder')).querySelector('input');
    if (auto.checked) await tap(auto);
    const song = $$('#exportForm label.check').find((l) => l.textContent.includes('copy with the song')).querySelector('input');
    if (song.checked) throw new Error('the copy with the song should start unchecked');
    await tap(song);
    await tap(byText('#exportForm button', 'Render & verify'));
    try {
      await until(() => /^(Ready for Spotify|Exported, but some checks failed|Export failed.*|Export cancelled)$/.test($('#exportStatus h2')?.textContent || ''), 120000, 'the export');
    } catch (e) {
      throw new Error(e.message + ': ' + ($('#exportStatus')?.textContent || 'no status'));
    }
    const h2 = $('#exportStatus h2').textContent;
    const r = S.getState().renders[0];
    const fails = (r?.checks || []).filter((c) => c.level === 'fail').map((c) => c.label + ': ' + c.detail);
    if (h2 !== 'Ready for Spotify') throw new Error(h2 + ' ' + ($('#exportStatus .note')?.textContent || '') + ' ' + fails.join('; '));
    if (getComputedStyle($('#exportForm')).display !== 'none') throw new Error('the export form still shows above the result');
    if (r.resolution !== '720x1280') throw new Error('size ' + r.resolution);
    if (!(r.stats.mean_luminance > 0.02)) throw new Error('the render is black: ' + JSON.stringify(r.stats));
    const foot = r.checks.find((c) => c.id === 'footage');
    if (foot?.level !== 'ok') throw new Error('the footage check: ' + JSON.stringify(foot));
    if (!r.audio_url) throw new Error('no copy with the song');
    window.__render = r.filename;
    window.__audio = decodeURIComponent(r.audio_url.split('/').pop());
  `);

  await t.test('the export landed in out/ at the right length, silent, with a copy that has the song', { skip: broken ? 'no export' : false }, async () => {
    const name = await browser.run('return window.__render;');
    const file = join(out, name);
    assert.ok(existsSync(file), file);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', file], { encoding: 'utf8' });
    const [s] = JSON.parse(probe.stdout).streams;
    assert.deepEqual([s.width, s.height, +s.nb_frames], [720, 1280, 120]);
    const withSong = join(out, await browser.run('return window.__audio;'));
    const kinds = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', withSong], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(kinds.stdout).streams.map((x) => x.codec_type).sort(), ['audio', 'video'], 'the copy has the song');
    const silent = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(silent.stdout).streams.map((x) => x.codec_type), ['video'], 'the Canvas itself stays silent');
  });

  await step('the screen menu and O reshape the preview, and the export takes the same shape', `
    key('Escape');
    const shape = () => $('#view').width / $('#view').height;
    await tap($('#tScreen'));
    await tap($$('#pop button').find((b) => b.textContent.startsWith('Landscape')));
    await until(() => Math.abs(shape() - 16 / 9) < 0.02, 3000, 'a 16:9 preview');
    if (S.getState().exportOpts.format !== 'youtube_16_9') throw new Error('format ' + S.getState().exportOpts.format);
    key('o');
    key('o');
    await until(() => Math.abs(shape() - 1) < 0.02, 3000, 'a square preview');
    key('e');
    await until(() => S.getState().exportOpen, 2000, 'the export sheet');
    if (byText('.fmt-seg button', 'Social 1:1')?.className !== 'on') throw new Error('the sheet should have Social 1:1 picked');
    await tap(byText('#exportForm button', 'Render & verify'));
    await until(() => /^(Square video exported|Exported, but some checks failed|Export failed|Export cancelled)$/.test($('#exportStatus h2')?.textContent || ''), 120000, 'the square export');
    const r = S.getState().renders[0];
    const fails = (r?.checks || []).filter((c) => c.level === 'fail').map((c) => c.label + ': ' + c.detail);
    if ($('#exportStatus h2').textContent !== 'Square video exported') throw new Error($('#exportStatus h2').textContent + ' ' + fails.join('; '));
    if (r.resolution !== '1080x1080') throw new Error('size ' + r.resolution);
    if (!(r.stats.mean_luminance > 0.02)) throw new Error('the render is black: ' + JSON.stringify(r.stats));
  `);

  await step('a plain hard-cut edit exports footage that moves, not stills', `
    key('Escape');
    const W = window.__studio;
    W.store.setState({ exportOpts: { ...S.getState().exportOpts, format: 'spotify', size: 'lite', autoSave: false } });
    W.setLook({ id: 'plain', name: 'Plain', vibe: '', layers: [], camera: { p: { zoom: 1, drift: 0, shake: 0, sway: 0, speed: 1 } },
      finish: { p: { contrast: 1, saturation: 1, split: 0, fade: 0, vignette: 0, grain: 0 } },
      cut: { rhythm: 'bar', transitions: ['cut'], beats: 0, order: 'cycle', velocity: 'none' } });
    await until(() => W.ctx?.look?.id === 'plain', 3000, 'the plain look');
    window.__cuts = W.ctx.tl.segs.map((g) => g.t0);
    key('e');
    await until(() => S.getState().exportOpen, 2000, 'the export sheet');
    await tap(byText('#exportForm button', 'Render & verify'));
    await until(() => /^(Ready for Spotify|Exported, but some checks failed|Export failed.*|Export cancelled)$/.test($('#exportStatus h2')?.textContent || ''), 120000, 'the plain export');
    const r = S.getState().renders[0];
    const foot = r.checks.find((c) => c.id === 'footage');
    if (foot?.level !== 'ok') throw new Error($('#exportStatus h2').textContent + ': ' + JSON.stringify(foot));
    window.__plain = r.filename;
  `);

  await t.test('in the plain export every cut moves from frame to frame', { skip: broken ? 'no export' : false }, async () => {
    const { name, cuts } = await browser.run('return { name: window.__plain, cuts: window.__cuts };');
    const [w, h] = [36, 64];
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', join(out, name), '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 }).stdout;
    const n = raw.length / (w * h);
    assert.ok(n >= 60, `${n} frames`);
    const near = (f) => cuts.some((t0) => Math.abs(f - t0 * 30) < 1.5);
    let steps = 0, still = [];
    for (let f = 1; f < n; f++) {
      if (near(f)) continue; // a cut changes the picture; only steps inside a cut count
      let d = 0;
      for (let i = 0; i < w * h; i++) d += Math.abs(raw[f * w * h + i] - raw[(f - 1) * w * h + i]);
      steps++;
      if (d / (w * h) < 0.3) still.push(f);
    }
    assert.ok(still.length <= steps * 0.05, `${still.length} of ${steps} steps inside cuts show no change: frames ${still.slice(0, 20).join(', ')}`);
  });

  await step('saves the edit as a project, which keeps saving itself, and opens it again after a new one', `
    key('Escape');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
    const name = await until(() => $('#projectsModal input[aria-label="Project name"]'), 2000, 'Projects to ask for a name');
    setRange(name, 'E2E project');
    await tap(byText('#projectsModal button', 'Save as project'));
    await until(() => S.getState().project?.name === 'E2E project' && !S.getState().projectsOpen, 5000, 'the project to save');
    if ($('#btnProjects .proj-name').textContent !== 'E2E project') throw new Error('top bar: ' + $('#btnProjects').textContent);
    const id = S.getState().project.id;
    const look = S.getState().look.name;
    byText('#tabs button', 'Edit').click();
    await until(() => $('#pane-edit'), 5000, 'the Edit tab');
    byText('#pane-edit .seg button', '4 bars').click();
    const file = async () => (await (await fetch('/api/projects/' + id)).json()).project;
    // the autosave lands a moment after the change
    for (let i = 0; i < 50 && (await file()).data.bars !== 4; i++) await sleep(100);
    if ((await file()).data.bars !== 4) throw new Error('the project file has ' + (await file()).data.bars + ' bars');

    await tap($('#btnProjects'));
    await tap(await until(() => byText('#projectsModal button', 'New project'), 2000, 'New project'));
    await until(() => S.getState().project === null && !S.getState().projectsOpen, 5000, 'a new edit');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true, bubbles: true }));
    await tap(await until(() => $('#projectsModal .proj-open[title="Open E2E project"]'), 2000, 'the project in the list'));
    // the new edit isn't saved, so opening asks first
    await tap(await until(() => byText('.proj-confirm button', 'Replace it'), 2000, 'the confirmation'));
    await until(() => S.getState().project?.id === id && S.getState().bars === 4 && S.getState().look.name === look, 10000, 'the project to open');
    window.__project = id;
  `);

  await t.test('the project is a file in out/projects', { skip: broken ? 'no project' : false }, async () => {
    const id = await browser.run('return window.__project;');
    const saved = JSON.parse(readFileSync(join(out, 'projects', `${id}.json`), 'utf8'));
    assert.deepEqual([saved.name, saved.data.bars], ['E2E project', 4]);
    assert.equal(readdirSync(join(out, 'projects', 'exports')).length, 3, 'every export kept its edit');
  });

  await t.test('after a reload the project is still open', { skip: broken ? 'no project' : false }, async () => {
    await browser.send('Page.reload');
    await sleep(1500);
    await browser.run(PAGE + `
      await until(() => window.__studio?.ctx && S.getState().project, 30000, 'the studio to start');
      if (S.getState().project.name !== 'E2E project' || S.getState().bars !== 4) throw new Error(JSON.stringify(S.getState().project) + ' ' + S.getState().bars);
      if ($('#btnProjects .proj-name').textContent !== 'E2E project') throw new Error('top bar: ' + $('#btnProjects').textContent);
    `);
  });

  await step('an export opens the edit it was made from', `
    await until(() => window.__studio?.ctx && S.getState().features, 30000, 'the song');
    // the first Spotify export, the hand-cut one (the list is newest first)
    const r = S.getState().renders.filter((x) => x.resolution === '720x1280').at(-1);
    if (!r?.has_edit) throw new Error('the Spotify export has no edit: ' + JSON.stringify(r));
    S.getState().transport.pause();
    window.__studio.store.setState({ libraryOpen: true, libraryItem: r.filename });
    await tap(await until(() => byText('#libraryModal button', 'Open the edit'), 2000, 'Open the edit'));
    await until(() => !S.getState().libraryOpen && S.getState().bars === 2 && S.getState().ctx.tl.handCut, 10000, "the export's edit");
    if (S.getState().project !== null) throw new Error("the export's edit should open outside the project");
    if (S.getState().exportOpts.format !== 'spotify') throw new Error('format ' + S.getState().exportOpts.format);
  `);

  await step('bulk imports preserve metadata and selection without full-library refreshes', `
    const original = window.fetch;
    const source = S.getState().clips[0];
    const bytes = await (await original('/api/proxy/' + encodeURIComponent(source.id))).arrayBuffer();
    let refreshes = 0;
    const before = S.getState().clips.length;
    const selected = [...S.getState().selected];
    window.fetch = (input, options) => {
      if (input === '/api/state') refreshes++;
      return original.call(window, input, options);
    };
    try {
      await S.getState().uploadFiles(['Import check one.mp4', 'Import check two.mp4'].map((name) => new File([bytes], name, { type: 'video/mp4' })));
      if (refreshes !== 0) throw new Error('bulk import refreshed the whole library ' + refreshes + ' times');
      const added = S.getState().clips.filter((clip) => clip.name.startsWith('Import check'));
      if (S.getState().clips.length !== before + 2 || added.length !== 2) throw new Error('imported clips missing');
      if (added.some((clip) => !(clip.width > 0 && clip.height > 0 && clip.duration > 0) || clip.source !== 'added')) throw new Error('upload metadata was lost');
      if (selected.some((id) => !S.getState().selected.includes(id)) || added.some((clip) => !S.getState().selected.includes(clip.id))) throw new Error('import changed existing selection');
      await until(() => added.every((clip) => S.getState().clips.find((current) => current.id === clip.id)?.proxy === 'ready'), 30000, 'imported playback copies');
    } finally { window.fetch = original; }
  `);

  await t.test('no errors in the page', () => {
    assert.deepEqual(browser.problems, []);
  });
});
