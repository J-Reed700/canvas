// Shared real-browser harness for regression tests and reproducible performance runs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
  let ws;
  try {
    const portFile = join(userDir, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile) && proc.exitCode === null; i++) await sleep(100);
    assert.ok(existsSync(portFile), 'Chrome did not start its debugging endpoint');
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      if (!page) await sleep(100);
    }
    assert.ok(page, 'Chrome did not open a page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map();
    const problems = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const request = pending.get(m.id);
        pending.delete(m.id); clearTimeout(request.timer);
        if (m.error) request.reject(new Error(`${request.method}: ${m.error.message}`));
        else request.resolve(m);
      }
      if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    };
    ws.onclose = () => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Chrome closed during ${request.method}`)); }
      pending.clear();
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => { pending.delete(i); reject(new Error(`Chrome timed out during ${method}`)); }, method === 'Runtime.evaluate' ? 3_700_000 : 30_000);
      timer.unref();
      pending.set(i, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    /** Runs an async function body in the page and returns its JSON result; page errors become test failures. */
    const run = async (body) => {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value;
    };
    return { proc, ws, send, run, problems };
  } catch (error) { ws?.close(); proc.kill(); throw error; }
}

export { ROOT, sleep, which, chromePath, python, missing, freePort, writeSong, makeClip, openBrowser };
