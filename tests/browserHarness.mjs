// Shared real-browser harness for regression tests and reproducible performance runs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';
const RESULT_SLICE = 512 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The program's path on PATH, like `which`, which Windows doesn't have; there a bare name gets a PATHEXT ending. */
const which = (name) => {
  const endings = WINDOWS && !extname(name) ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ending of endings) {
      const p = join(dir, name + ending);
      try {
        accessSync(p, WINDOWS ? constants.F_OK : constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
};

function findChrome() {
  const windowsRoots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const paths = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...windowsRoots.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...windowsRoots.map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
  for (const p of paths) if (p && existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = which(name);
    if (p) return p;
  }
  return null;
}

const chromePath = findChrome();
// The checkout's virtual environment, as scripts/python.mjs finds it.
const venvPython = join(ROOT, WINDOWS ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const python = process.env.DOWNBEAT_PYTHON || (existsSync(venvPython) ? venvPython : WINDOWS ? 'python' : 'python3');

/** Deletes a test's temp folder. On Windows its files can stay locked for several seconds after the browser and
 *  encoders that used them exit (antivirus and the search indexer look at new files), so it keeps trying, and
 *  in the end leaves the folder with a warning rather than failing a test whose checks passed. */
async function removeDir(path) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!WINDOWS || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (Date.now() > deadline) {
        console.warn(`Left ${path} behind: ${error.code}`);
        return;
      }
      await sleep(250);
    }
  }
}

/** Ends a process and waits for it. On Windows that takes the processes it started too: killing the server
 *  alone leaves its ffmpeg children running, still holding files in the test's folder. */
async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  if (WINDOWS) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill();
  await Promise.race([exited, sleep(10_000)]);
}

/** The environment for a server whose home folder is `home` (Windows looks for ~ in USERPROFILE). */
const homeEnv = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
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
  const proc = spawn(chromePath, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError = '';
  proc.stderr.on('data', (data) => { launchError = (launchError + data.toString()).slice(-4000); });
  let ws;
  try {
    const portFile = join(userDir, 'DevToolsActivePort');
    for (let i = 0; i < 300 && !existsSync(portFile) && proc.exitCode === null; i++) await sleep(100);
    assert.ok(existsSync(portFile), `Chrome did not start its debugging endpoint (exit ${proc.exitCode ?? 'still running'}): ${launchError}`);
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
    let detached = '';
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
      if (m.method === 'Inspector.targetCrashed') detached = 'the page crashed';
      if (m.method === 'Inspector.detached') detached ||= `the page was detached (${m.params.reason})`;
    };
    ws.onclose = (ev) => {
      const why = detached ? `Chrome closed the page because ${detached}, during`
        : proc.exitCode === null && ev.code === 1006 ? 'The DevTools connection dropped (a message over 4 MiB does that) during'
          : `Chrome closed (exit ${proc.exitCode ?? 'still running'}) during`;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`${why} ${request.method}${launchError ? `. Its last output:\n${launchError}` : ''}`));
      }
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
    await send('Inspector.enable');
    const evaluate = async (expression, awaitPromise = false) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value;
    };
    /** Runs an async function body in the page and returns its JSON result; page errors become test failures.
     *  The result is fetched in slices: Node's WebSocket drops a compressed message over 4 MiB, and Chrome
     *  compresses, so a result with a few images in it would otherwise cut the connection. */
    const run = async (body) => {
      const first = await evaluate(`(async () => {
        const value = await (async () => { ${body} })();
        const json = value === undefined ? '' : JSON.stringify(value);
        if (json.length <= ${RESULT_SLICE}) return json;
        globalThis.__harnessResult = json;
        return { length: json.length };
      })()`, true);
      if (typeof first === 'string') return first ? JSON.parse(first) : undefined;
      let json = '';
      // 512K characters stay under the limit even if every one is sent as a \uXXXX escape.
      for (let at = 0; at < first.length; at += RESULT_SLICE) json += await evaluate(`globalThis.__harnessResult.slice(${at}, ${at + RESULT_SLICE})`);
      await evaluate('delete globalThis.__harnessResult');
      return JSON.parse(json);
    };
    /** Closes the page connection and waits for Chrome to exit, so its profile folder can be deleted. */
    const close = async () => {
      ws.close();
      await stopProcess(proc);
    };
    return { proc, ws, send, run, problems, close };
  } catch (error) { ws?.close(); proc.kill(); throw error; }
}

export { ROOT, sleep, which, chromePath, python, missing, freePort, writeSong, makeClip, openBrowser, removeDir, homeEnv, stopProcess };
