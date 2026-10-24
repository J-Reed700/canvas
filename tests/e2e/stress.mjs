// Preview stress test. It plays the studio's preview and makes random edits the way a person does: adds and
// removes clips, changes transitions and start points, moves and zooms the crop in the segment menu, rolls
// the dice, splits, deletes and undoes. Every few edits it stops for 6 s and checks that the clips on screen
// keep moving. It runs against a studio that is already running, with your clips, in a Chrome of its own
// with its own profile, so the session in your browser is left alone.
//
//   node tests/e2e/stress.mjs [--url http://127.0.0.1:8765/studio/] [--minutes 10] [--seed 7]
//                             [--clips id,id] [--headless] [--keep-going] [--new-clips] [--upload dir]
//
// It starts from the two biggest clips that have playback copies, or the ones given by --clips: big
// footage takes longest to seek and decode, which is where the preview has fallen behind before.
//
// A frame of the preview counts as frozen when the song plays, the cut on screen runs at a speed of 0.1 or
// more, and one of these holds:
//   - the cut has shown the same picture for over a quarter of a second while the video itself moved on
//     (drawn straight from the <video>, its picture changed)
//   - the cut has shown the same picture for over a quarter of a second while the video's clock stood
//     still for over 0.6 s: a download that stalled, a seek that never landed, a video that broke
//   - the screen has shown the same picture for over 0.4 s while the cut had a newer one
// Footage that is itself still doesn't count, and neither does a clip whose playback copy is still being
// made ("Preparing clip…"). A check that finds a fifth of the frames frozen, or the preview not drawing at
// all, is waited out for 15 s with no edits.
// If it's still frozen then, the state of every video is printed and the run ends with exit code 1 (with
// --keep-going it carries on and fails at the end).
//
// The edits add clips from your library, and the server makes playback copies of clips put in an edit, so
// only clips that already have one are added unless you pass --new-clips. With --upload, it also uploads
// the videos in that folder the way dropping them on the studio does, so each one becomes a new clip in
// the studio's library, with a playback copy made while the preview plays. A visible Chrome draws nothing
// once it thinks it's hidden, which includes the screen going to sleep, so the run stops there. On a Mac
// the window opens behind the app you're using. Headless Chrome decodes video differently and has not
// shown every problem the visible one does.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i < 0 ? def : argv[i + 1]; };
const flag = (name) => argv.includes(`--${name}`);
const URL_ = opt('url', 'http://127.0.0.1:8765/studio/');
const MINUTES = Number(opt('minutes', 10));
const SEED = Number(opt('seed', Date.now() % 100000));
const HEADLESS = flag('headless');
const KEEP_GOING = flag('keep-going');
const NEW_CLIPS = flag('new-clips');
const CLIPS = opt('clips', '');
const UPLOAD = opt('upload', '');
const uploads = UPLOAD ? readdirSync(UPLOAD).filter((f) => /\.(mp4|mov|m4v|webm|mkv)$/i.test(f)).map((f) => resolve(UPLOAD, f)) : [];
if (UPLOAD && !uploads.length) { console.error(`No videos in ${UPLOAD}`); process.exit(2); }

let seed = SEED;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${a.join(' ')}`);

function findChrome() {
  for (const p of [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
    if (p && existsSync(p)) return p;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

// -- Chrome ------------------------------------------------------------------------------------------
const chromePath = findChrome();
if (!chromePath) { console.error('Chrome or Chromium is needed (or set CHROME_PATH)'); process.exit(2); }
try { await fetch(URL_); } catch { console.error(`No studio at ${URL_}: start one with ./run.sh, or pass --url`); process.exit(2); }

const userDir = mkdtempSync(join(tmpdir(), 'downbeat-stress-'));
const args = ['--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1400,900', '--window-position=40,40',
  // keep drawing while other windows cover it
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
if (HEADLESS) args.unshift('--headless=new');
const app = chromePath.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
let proc = null;
if (app && !HEADLESS) execFileSync('open', ['-g', '-n', '-a', app, '--args', ...args, 'about:blank']); // opens behind the app in front
else proc = spawn(chromePath, [...args, 'about:blank'], { stdio: 'ignore' });
const quit = (code) => {
  try { ws.close(); } catch {}
  if (proc) proc.kill(); else spawnSync('pkill', ['-f', `user-data-dir=${userDir}`]);
  setTimeout(() => { try { rmSync(userDir, { recursive: true, force: true }); } catch {} process.exit(code); }, 500);
};
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, (e) => { console.error(e); quit(2); });
process.on('SIGINT', () => quit(130));

const portFile = join(userDir, 'DevToolsActivePort');
for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
const port = readFileSync(portFile, 'utf8').split('\n')[0];
let page;
for (let i = 0; i < 50 && !page; i++) {
  page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
  if (!page) await sleep(100);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const reqs = new Map(); // requests to the studio server still open
const host = new URL(URL_).host;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  const p = m.params;
  if (m.method === 'Network.requestWillBeSent' && p.request.url.includes(`${host}/api/`)) {
    reqs.set(p.requestId, { u: p.request.url.split(host)[1], t: Date.now(), range: p.request.headers.Range || '' });
  }
  if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
    const r = reqs.get(p.requestId);
    if (r && m.method === 'Network.loadingFailed' && !p.canceled) log('request failed:', r.u, r.range, p.errorText);
    reqs.delete(p.requestId);
  }
  if (m.method === 'Runtime.exceptionThrown') log('page exception:', p.exceptionDetails?.exception?.description?.split('\n').slice(0, 3).join(' | '));
  if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') log('console.error:', p.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (body) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL_ });

// -- two clips, the song the studio opens with, playing ----------------------------------------------
log(`seed ${SEED}:`, await run(`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 200 && !window.__studio?.store.getState().bank; i++) await sleep(100);
  const S = window.__studio;
  if (!S) throw new Error('the studio did not start');
  let st = S.store.getState();
  for (let i = 0; i < 100 && !st.clips.length; i++) { await sleep(100); st = S.store.getState(); }
  const ready = st.clips.filter((c) => c.proxy === 'ready' && !c.still);
  const pool = ready.length >= 2 ? ready : st.clips.filter((c) => !c.still);
  if (pool.length < 2) throw new Error('the library needs at least two videos');
  const given = ${JSON.stringify(CLIPS)}.split(',').filter(Boolean);
  const want = given.length ? given : [...pool].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)).slice(0, 2).map((c) => c.id);
  S.store.setState({ welcome: false, selected: want });
  S.rebuild();
  for (let i = 0; i < 100 && !S.ctx; i++) await sleep(100);
  const name = (id) => st.clips.find((c) => c.id === id)?.name || id;
  return st.clips.length + ' clips in the library, ' + ready.length + ' with playback copies; starting with ' + want.map((id) => id + ' (' + name(id) + ')').join(', ');
`));

// -- the probe ---------------------------------------------------------------------------------------
await run(`
  const S = window.__studio, E = S.engine, B = S.bank;
  const M = window.__probe = { needs: [], playing: false, track: {}, samples: [], lastRender: performance.now(), out: NaN, outAt: performance.now() };
  const c2 = Object.assign(document.createElement('canvas'), { width: 16, height: 16 }).getContext('2d', { willReadFrequently: true });
  const hash = (d) => { let h = 2166136261; for (let j = 0; j < d.length; j += 4) h = Math.imul(h ^ (d[j] + d[j + 1] * 3 + d[j + 2] * 7), 16777619); return h; };
  const trackOf = (k, now) => {
    const tr = M.track[k] ||= { print: NaN, pAt: now, h2: NaN, h2At: now, ct: NaN, ctAt: now, seen: now };
    // a cut back on screen after a while starts counting again
    if (now - tr.seen > 250) tr.pAt = tr.h2At = tr.ctAt = now;
    tr.seen = now;
    return tr;
  };
  // What the video itself shows, before sync moves it on: drawn through a 2D canvas.
  const sync = B.sync.bind(B);
  let n = 0;
  B.sync = (needs, playing) => {
    M.needs = needs; M.playing = playing;
    if (n++ % 4 === 0) {
      const now = performance.now();
      for (const need of needs) {
        const el = B.els.get(need.vkey);
        const tr = trackOf(need.vkey, now);
        // whether the video's own clock moves: still footage moves it, a stalled or broken video doesn't
        if (el && el.currentTime !== tr.ct) { tr.ct = el.currentTime; tr.ctAt = now; }
        if (!el || el.readyState < 2) continue;
        try { c2.drawImage(el, 0, 0, 16, 16); const h = hash(c2.getImageData(0, 0, 16, 16).data); if (h !== tr.h2) { tr.h2 = h; tr.h2At = now; } } catch {}
      }
    }
    return sync(needs, playing);
  };
  // What the preview drew: a 16×16 print of each cut's texture, every frame drawn.
  const render = E.renderMain.bind(E);
  let r = 0;
  E.renderMain = (fr) => {
    const out = render(fr);
    const now = M.lastRender = performance.now();
    // what reached the screen, after the effects and the flash guard
    if (r++ % 3 === 0) try { c2.drawImage(E.canvas, 0, 0, 16, 16); const h = hash(c2.getImageData(0, 0, 16, 16).data); if (h !== M.out) { M.out = h; M.outAt = now; } } catch {}
    let prints;
    try { prints = E.sourcePrints(fr.needs.map((x) => x.vkey)); } catch { prints = []; }
    fr.needs.forEach((need, i) => {
      const tr = trackOf(need.vkey, now);
      const changed = prints[i] !== tr.print;
      if (changed) { tr.print = prints[i]; tr.pAt = now; }
      const el = B.els.get(need.vkey);
      if (i === 0) M.samples.push({ now, k: need.vkey, changed, pic: now - tr.pAt, vid: now - tr.h2At, ct: now - tr.ctAt, src: !!el?._url, out: now - M.outAt, on: M.playing, rate: need.rate, rev: need.rev });
    });
    if (M.samples.length > 8000) M.samples.splice(0, 4000);
    return out;
  };
  M.check = (secs) => {
    const now = performance.now();
    const win = M.samples.filter((s) => now - s.now < secs * 1000);
    const moving = win.filter((s) => s.on && s.rate >= 0.1);
    // see the top of this file
    const frozen = moving.filter((s) => (s.pic > 250 && (s.vid < s.pic - 150 || (s.src && s.ct > 600))) || (s.out > 400 && s.pic < s.out - 150));
    const unseen = frozen.filter((s) => s.out > 400 && s.pic < s.out - 150);
    const stalled = frozen.filter((s) => !(s.vid < s.pic - 150));
    let dur = 0;
    for (let i = 1; i < win.length; i++) if (win[i].on && win[i].rate >= 0.1) dur += Math.min(0.1, (win[i].now - win[i - 1].now) / 1000);
    const per = {};
    for (const s of win) {
      const q = per[s.k] ||= { n: 0, frozen: 0, stalled: 0, rev: 0, pic: 0, changes: 0 };
      q.n++; if (frozen.includes(s)) q.frozen++; if (stalled.includes(s)) q.stalled++; if (s.rev) q.rev++; if (s.changed) q.changes++; q.pic = Math.max(q.pic, Math.round(s.pic));
    }
    return { hidden: document.visibilityState !== 'visible', n: win.length, moving: moving.length, frozen: frozen.length, stalled: stalled.length, unseen: unseen.length, videos: B.els.size,
      perSec: dur ? moving.filter((s) => s.changed).length / dur : 0,
      sinceDraw: Math.round(now - M.lastRender), playing: S.transport.playing, t: S.transport.loopTime(),
      cuts: Object.entries(per).map(([k, q]) => k + ': ' + q.n + ' frames, ' + q.changes + ' new pictures, ' + q.frozen + ' frozen (' + q.stalled + ' with the video stalled), ' + q.rev + ' shown by seeking, picture held up to ' + q.pic + ' ms') };
  };
  M.dump = () => {
    const now = performance.now();
    const on = new Set(M.needs.map((x) => x.vkey));
    const st = S.store.getState();
    return {
      onScreen: M.needs.map((x) => x.vkey + ' at ' + x.time.toFixed(2) + ' s, speed ' + x.rate.toFixed(2) + (x.rev ? ', by seeking' : '') + (x.aux ? ', b-roll' : '')),
      videos: [...B.els.entries()].map(([k, e]) => {
        const buf = [];
        for (let i = 0; i < e.buffered.length; i++) buf.push(e.buffered.start(i).toFixed(1) + '-' + e.buffered.end(i).toFixed(1));
        const tr = M.track[k];
        return (on.has(k) ? '* ' : '  ') + k + ' time ' + e.currentTime.toFixed(2) + ' readyState ' + e.readyState + ' networkState ' + e.networkState +
          (e.paused ? ' paused' : ' playing') + (e.seeking ? ' SEEKING' : '') + (e.error ? ' ERROR ' + e.error.code + ' ' + e.error.message : '') +
          ' buffered [' + buf.join(', ') + ']' + (tr ? ' picture held ' + Math.round(now - tr.pAt) + ' ms' : '');
      }),
      webglLost: E.gl.isContextLost(), badge: document.getElementById('stageBadge')?.style.display === 'block',
      clips: st.clips.filter((c) => st.selected.includes(c.id)).map((c) => c.id + ' ' + c.name + ' (' + c.proxy + ')'),
      cuts: S.ctx?.tl.segs.length, direction: st.direction, rebound: st.rebound,
    };
  };
  S.transport.play();
`);

// -- the edits ---------------------------------------------------------------------------------------
await run(`
  const S = window.__studio;
  const st = () => S.store.getState();
  const segs = () => S.ctx?.tl.segs || [];
  const pk = (a) => a[Math.floor(Math.random() * a.length)];
  const seg = () => pk(segs());
  const TRANS = ['cut', 'dissolve', 'luma', 'zoom', 'whip', 'whipX', 'glitch', 'mosh', 'ripple', 'iris', 'pixel', 'swirl', 'prism', 'flare', 'slices', 'kaleido', 'morph'];
  window.__edits = {
    addClip: () => {
      const s = st();
      const pool = s.clips.filter((c) => !s.selected.includes(c.id) && !c.still && (${NEW_CLIPS} || c.proxy === 'ready'));
      if (!pool.length || s.selected.length >= 6) return 'nothing to add';
      const c = pk(pool); s.toggleClip(c.id); return c.name;
    },
    removeClip: () => { const s = st(); if (s.selected.length < 2) return 'only one clip'; const c = pk(s.selected); s.toggleClip(c); return c; },
    shuffle: () => { st().reorderClips('shuffle'); return ''; },
    roll: () => { document.getElementById('btnRoll')?.click(); return st().direction + (st().rebound ? ', rebound' : ''); },
    rollClips: () => { st().rollClips(); return ''; },
    surprise: () => { st().surprise(); return ''; },
    stepLook: () => { st().stepLook(Math.random() < 0.5 ? 1 : -1); return st().look?.name; },
    transition: () => { const g = seg(); const name = pk(TRANS); st().setBlock(g.id, { trans: name }); return g.id + ' ' + name; },
    transLength: () => { const g = seg(); const b = pk([0, 0.25, 0.5, 1, 2]); st().setBlock(g.id, { transBeats: b }); return g.id + ' ' + b + ' beats'; },
    startPoint: () => {
      const g = seg(); const dur = st().clipDur.get(g.clipId) || 10; const v = +(Math.random() * Math.max(0, dur - g.dur * g.speed - 0.1)).toFixed(2);
      st().setBlock(g.id, { in: v }); S.transport.seek(g.t0 + Math.min(g.dur / 2, 0.25)); return g.id + ' at ' + v + ' s';
    },
    framing: () => {
      const g = seg(); const p = () => [+Math.random().toFixed(2), +Math.random().toFixed(2), +(1 + 2 * Math.random()).toFixed(2)];
      const f = Math.random() < 0.5 ? { a: p() } : { a: p(), b: p(), ease: pk(['smooth', 'linear', 'beats']) };
      st().setBlock(g.id, { frame: f }); return g.id + ' ' + JSON.stringify(f);
    },
    clearFraming: () => { const g = seg(); st().setBlock(g.id, { frame: undefined }); return g.id; },
    direction: () => { const g = seg(); const d = pk(['forward', 'reverse', 'pingpong']); st().setBlock(g.id, { dir: d }); return g.id + ' ' + d; },
    speedCurve: () => { const g = seg(); const v = pk(['none', 'surge', 'swell', 'hold', 'wave', 'ramp']); st().setBlock(g.id, { vel: v }); return g.id + ' ' + v; },
    swapClip: () => { const g = seg(); const c = pk(st().selected); st().setBlock(g.id, { clipId: c }); return g.id + ' to ' + c; },
    split: () => { st().splitAtPlayhead(); return segs().length + ' cuts'; },
    remove: () => { if (segs().length < 3) return 'too few cuts'; const g = seg(); st().deleteBlock(g.id); return g.id; },
    repeat: () => { const g = seg(); st().repeatSegment(g.id); return g.id; },
    insert: () => { const g = seg(); const c = pk(st().selected); st().insertClip(c, { id: g.id }); return c + ' at ' + g.id; },
    bars: () => { const b = pk(st().canvasBars()); st().setBars(b); return b + ' bars'; },
    rhythm: () => { const s = st(); const rh = pk(['hits', 'eighth', 'beat', 'half', 'bar', 'bar2']); S.setLook({ ...s.look, cut: { ...s.look.cut, rhythm: rh } }); return rh; },
    undo: () => { st().undo(); return ''; },
    redo: () => { st().redo(); return ''; },
    seek: () => { const t = Math.random() * (S.ctx?.L || 4); S.transport.seek(t); return t.toFixed(2) + ' s'; },
    pausePlay: async () => { S.transport.pause(); await new Promise((x) => setTimeout(x, 300 + 1500 * Math.random())); S.transport.play(); return ''; },
  };
`);

// The segment menu with real mouse and keys: double-click a cut, then drag the crop box, pick a start
// frame, move the sliders or step to the next cut, and usually close it.
const mouse = (type, x, y, clickCount = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
const press = async (key, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
};
// The preview itself: drag to move the framing, scroll to zoom, double-click to reset.
async function stage(what) {
  const v = await run(`const r = document.getElementById('view')?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null;`);
  if (!v) return 'no preview';
  let x = v[0] + v[2] * (0.3 + 0.4 * rnd()), y = v[1] + v[3] * (0.3 + 0.4 * rnd());
  if (what === 'drag') {
    await mouse('mousePressed', x, y);
    for (let i = 0; i < 10 + rnd() * 30; i++) {
      x += (rnd() - 0.5) * 40; y += (rnd() - 0.5) * 40;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    await mouse('mouseReleased', x, y);
  } else if (what === 'scroll') {
    for (let i = 0; i < 3 + rnd() * 15; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: (rnd() < 0.5 ? -1 : 1) * 40 });
      await sleep(16);
    }
  } else {
    await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
    await mouse('mousePressed', x, y, 2); await mouse('mouseReleased', x, y, 2);
  }
  return '';
}

// A file dropped on the studio, through a file input of the test's own that calls the same upload.
// Each upload goes under a name of its own, so it's a new clip and not a file put over one in use.
let uploaded = 0;
async function upload() {
  const src = pick(uploads);
  const dir = join(userDir, 'uploads');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `stress-${SEED}-${++uploaded}-${src.split('/').pop()}`);
  symlinkSync(src, file);
  await run(`
    let i = document.getElementById('stressUpload');
    if (!i) {
      i = Object.assign(document.createElement('input'), { type: 'file', id: 'stressUpload', hidden: true });
      i.onchange = () => { const f = [...i.files]; i.value = ''; window.__studio.store.getState().uploadFiles(f); };
      document.body.append(i);
    }`);
  const { root } = (await send('DOM.getDocument')).result;
  const { nodeId } = (await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#stressUpload' })).result;
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
  return file.split('/').pop();
}

async function segmentMenu() {
  const lane = await run(`const r = document.getElementById('lane')?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null;`);
  if (!lane) return 'no lane';
  const x = lane[0] + 10 + rnd() * (lane[2] - 20), y = lane[1] + lane[3] / 2;
  await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
  await mouse('mousePressed', x, y, 2); await mouse('mouseReleased', x, y, 2);
  await sleep(400);
  const done = [];
  for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
    const what = pick(['crop', 'crop', 'start frame', 'next cut', 'slider']);
    if (what === 'crop') {
      const box = await run(`const b = document.querySelector('.pop.seg-menu .seg-crop'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return [r.left, r.top, r.width, r.height];`);
      if (!box) continue;
      let px = box[0] + box[2] / 2, py = box[1] + box[3] / 2;
      await mouse('mousePressed', px, py);
      for (let i = 0; i < 12; i++) {
        px += (rnd() - 0.5) * 30; py += (rnd() - 0.5) * 30;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'left', buttons: 1 });
        await sleep(30);
      }
      await mouse('mouseReleased', px, py);
    } else if (what === 'start frame') {
      if (!(await run(`const b = [...document.querySelectorAll('.pop.seg-menu .seg-strip button')]; if (!b.length) return false; b[Math.floor(Math.random() * b.length)].click(); return true;`))) continue;
    } else if (what === 'next cut') {
      await press('ArrowRight', 'ArrowRight', 39);
    } else if (!(await run(`
      const ins = [...document.querySelectorAll('.pop.seg-menu input[type=range]')];
      if (!ins.length) return false;
      const i = ins[Math.floor(Math.random() * ins.length)];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, String(+i.min + Math.random() * (+i.max - +i.min)));
      i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`))) continue;
    done.push(what);
    await sleep(150 + rnd() * 800);
  }
  if (rnd() < 0.7) await press('Escape', 'Escape', 27);
  return done.join(', ') || 'opened and closed';
}

const WEIGHTS = {
  addClip: 6, removeClip: 3, shuffle: 2, roll: 8, rollClips: 3, surprise: 2, stepLook: 3, transition: 8, transLength: 4,
  startPoint: 8, framing: 8, clearFraming: 2, direction: 3, speedCurve: 3, swapClip: 4, split: 3, remove: 2, repeat: 2,
  insert: 3, bars: 3, rhythm: 3, undo: 4, redo: 2, seek: 3, pausePlay: 2, segmentMenu: 10, stageDrag: 6, stageScroll: 4,
  stageReset: 2,
};
if (uploads.length) WEIGHTS.upload = 2;
const STAGE = { stageDrag: 'drag', stageScroll: 'scroll', stageReset: 'reset' };
const bag = Object.entries(WEIGHTS).flatMap(([k, w]) => Array(w).fill(k));

async function check(label, secs) {
  await run(`if (!window.__studio.transport.playing) window.__studio.transport.play();`);
  await sleep(secs * 1000);
  const r = await run(`return window.__probe.check(${secs - 1})`);
  const pct = r.moving ? Math.round((100 * r.frozen) / r.moving) : 0;
  const bad = !r.hidden && (pct >= 20 || r.sinceDraw > 2000 || !r.playing);
  const slow = [...reqs.values()].filter((q) => Date.now() - q.t > 10_000).length;
  log(`${label}: ${r.perSec.toFixed(1)} new pictures a second, ${pct}% of frames frozen (${r.frozen} of ${r.moving} that should move, ${r.stalled} with the video stalled, ${r.unseen} drawn but not shown)${r.sinceDraw > 2000 ? `, nothing drawn for ${r.sinceDraw} ms` : ''}${r.playing ? '' : ', NOT PLAYING'}, ${r.videos} videos${slow ? `, ${slow} requests open over 10 s` : ''}`);
  if (bad || pct) for (const c of r.cuts) log('   ', c);
  return { ...r, pct, bad };
}

const end = Date.now() + MINUTES * 60_000;
let edits = 0;
let freezes = 0;
let stuck = 0;
while (Date.now() < end) {
  for (let i = 4 + Math.floor(rnd() * 12); i > 0; i--) {
    const e = pick(bag);
    let res;
    try { res = e === 'segmentMenu' ? await segmentMenu() : e === 'upload' ? await upload() : STAGE[e] ? await stage(STAGE[e]) : await run(`return String(await window.__edits.${e}())`); } catch (err) { res = 'threw ' + String(err.message).split('\n')[0]; }
    log(`#${++edits} ${e} ${res}`);
    await sleep(rnd() < 0.3 ? 50 + rnd() * 200 : 300 + rnd() * 2200);
  }
  const q = await check(`check after ${edits} edits`, 6);
  if (q.hidden) { log('Chrome says the page is hidden (is the screen asleep?), so it has stopped drawing. Stopping.'); break; }
  if (!q.bad) continue;
  freezes++;
  const again = await check('15 s later, no edits', 15);
  if (!again.bad) { log('it came back by itself'); continue; }
  stuck++;
  log('STILL FROZEN. Videos (* = on screen):\n' + JSON.stringify(await run(`return window.__probe.dump()`), null, 1));
  log('requests still open:', JSON.stringify([...reqs.values()].map((r) => `${((Date.now() - r.t) / 1000).toFixed(1)} s ${r.u} ${r.range}`), null, 1));
  if (!KEEP_GOING) break;
}
log(`${edits} edits, ${freezes} freezes, ${stuck} that lasted`);
quit(stuck ? 1 : 0);
