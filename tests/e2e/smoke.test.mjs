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
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = (name) => {
  const r = spawnSync('which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

function findChrome() {
  const paths = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const p of paths) if (p && existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = which(name);
    if (p) return p;
  }
  return null;
}

const chromePath = findChrome();
const python = existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3';
const missing = [
  !chromePath && 'Chrome or Chromium (set CHROME_PATH)',
  !which('ffmpeg') && 'ffmpeg',
  !existsSync(join(ROOT, 'downbeat/studio/dist/index.html')) && 'the built studio (npm run build)',
].filter(Boolean);

const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

/** 16-bit stereo WAV of kick-like thumps on every beat. */
function writeSong(path, seconds, bpm) {
  const rate = 22050;
  const n = Math.round(rate * seconds);
  const pcm = new Int16Array(n * 2);
  for (let t = 0.1; t < seconds - 0.2; t += 60 / bpm) {
    const i0 = Math.round(t * rate);
    for (let k = 0; k < rate * 0.1 && i0 + k < n; k++) {
      const v = Math.sin((2 * Math.PI * 60 * k) / rate) * Math.exp(-k / (rate * 0.03)) * 28000;
      pcm[(i0 + k) * 2] = pcm[(i0 + k) * 2 + 1] = v;
    }
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.byteLength, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(path, Buffer.concat([head, Buffer.from(pcm.buffer)]));
}

function makeClip(path, source, size) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${source}=size=${size}:rate=30`, '-t', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]);
  assert.equal(r.status, 0, String(r.stderr));
}

// Minimal Chrome DevTools Protocol client.
async function openBrowser(userDir) {
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run',
    '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1600,1000'];
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  else args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const proc = spawn(chromePath, [...args, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(userDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    if (!page) await sleep(100);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  /** Runs an async function body in the page and returns its JSON result; page errors become test failures. */
  const run = async (body) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { proc, ws, send, run, problems };
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
  const browser = await openBrowser(join(tmp, 'chrome'));
  t.after(async () => {
    browser.ws.close();
    browser.proc.kill();
    server.kill();
    await sleep(300);
    rmSync(tmp, { recursive: true, force: true });
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break; } catch {}
    assert.ok(i < 150, `the server did not start: ${serverErr.slice(-1500)}`);
    await sleep(200);
  }

  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  // Steps run in order on one page; after a failure the rest are skipped rather than failing for the same reason.
  let broken = null;
  const step = (name, body) =>
    t.test(name, { skip: broken ? `an earlier step failed: ${broken}` : false }, async () => {
      try {
        await browser.run(PAGE + body);
      } catch (e) {
        broken = name;
        const files = readdirSync(out).filter((f) => !f.startsWith('.')).map((f) => `${f} (${statSync(join(out, f)).size} B)`);
        throw new Error(`${e.message}\nout/: ${files.join(', ') || 'empty'}\nserver: ${serverErr.slice(-800)}`);
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

  await t.test('no errors in the page', () => {
    assert.deepEqual(browser.problems, []);
  });
});
