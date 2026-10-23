// Canvas Forge Studio — UI controller.
import { Engine } from './engine.js';
import { Transport, makeSampler } from './audio.js';
import { DIRECTIONS, RHYTHMS, planTimeline, rng } from './timeline.js';
import { LOOKS, chaosLook, clamp, cloneLook, evolveLook, mutate, randomLook } from './looks.js';
import { CAMERA, CATEGORIES, FINISH_DEF, MODULES, MOD_SOURCES, defaults } from './modules.js';
import { TRANSITIONS } from './shaders.js';
import { VideoBank, compose } from './composer.js';
import { exportLoop } from './exporter.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const fetchJSON = async (u, o) => { const r = await fetch(u, o); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const shuffle = (arr, rand = Math.random) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
};
const METERS = ['kick', 'snare', 'hats', 'bass', 'energy', 'bright'];
const BAR_CHOICES = [1, 2, 4, 8];
const TRANS_BEATS = [[0, 'Cut'], [0.25, '¼'], [0.5, '½'], [1, '1'], [2, '2']];
const KEY = 'canvasforge.studio.v1';

// State
const S = {
  clips: [], tracks: [], renders: [],
  trackId: '', features: null,
  selected: [],
  look: null, lookId: null, saved: [],
  bars: 4, loopStart: 0, bpmManual: 128, bpmOverride: {},
  seed: 2026, direction: 'forward', lockEdit: false,
  intensity: 1, clipMode: 'one', clipLooks: {}, editClip: null, evolveAmt: 0.45,
  rollOpts: { look: true, edit: true, perClip: true, clips: false, loop: false },
  customCuts: null, segOverrides: {},
  hud: true, safe: false, muted: false, tab: 'looks',
  exporting: false, exportOpts: { size: 'master', audio: true },
};
let engine, bank, ctx = null;
let version = 0; // bumped on every edit, so a paused frame re-renders exactly once per change
const touch = () => { version++; };
const transport = new Transport();
const clipDur = new Map();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      trackId: S.trackId, selected: S.selected, look: S.look, lookId: S.lookId, saved: S.saved, bars: S.bars, loopStart: S.loopStart,
      bpmManual: S.bpmManual, bpmOverride: S.bpmOverride, seed: S.seed, direction: S.direction, lockEdit: S.lockEdit, customCuts: S.customCuts, segOverrides: S.segOverrides,
      hud: S.hud, safe: S.safe, muted: S.muted, tab: S.tab, mode: transport.mode, exportOpts: S.exportOpts,
      intensity: S.intensity, clipMode: S.clipMode, clipLooks: S.clipLooks, evolveAmt: S.evolveAmt, rollOpts: S.rollOpts,
    }));
  } catch { /* storage unavailable: session-only */ }
}
function restore() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

const bpm = () => S.features?.bpm || S.bpmManual;
const beatDur = () => 60 / bpm();
const barDur = () => beatDur() * 4;
const validBars = () => BAR_CHOICES.filter((b) => b * barDur() >= 3 - 1e-6 && b * barDur() <= 8 + 1e-6);
function loopLen() {
  const vb = validBars();
  if (!vb.includes(S.bars)) S.bars = vb.length ? vb[vb.length - 1] : 0;
  return S.bars ? S.bars * barDur() : 8;
}

// Per-clip looks
// 'one': the main look runs after the transition (feedback flows across cuts). Every other mode
// gives each clip its own stack, run on that clip before the transition.
const CLIP_MODES = [['one', 'Same look'], ['evolve', 'Evolve'], ['cycle', 'Look per clip'], ['custom', 'Custom']];
let clipCache = { v: -1, map: new Map() };

function buildClipLooks() {
  const m = new Map();
  if (S.clipMode === 'evolve') {
    S.selected.forEach((id, i) => { if (i) m.set(id, evolveLook(S.look, S.evolveAmt, S.seed * 31 + i * 7919)); });
  } else if (S.clipMode === 'cycle') {
    const r = rng(S.seed + 99);
    const base = S.lookId?.replace(/^edit:/, '');
    const pool = [...S.saved, ...LOOKS].filter((l) => l.id !== base && l.id !== 'clean');
    shuffle(pool, r);
    S.selected.forEach((id, i) => { if (i) m.set(id, pool[(i - 1) % pool.length]); });
  } else if (S.clipMode === 'custom') {
    S.selected.forEach((id) => { if (S.clipLooks[id]) m.set(id, S.clipLooks[id]); });
  }
  return m;
}

function clipLookOf(id) {
  if (S.clipMode === 'one') return S.look;
  if (clipCache.v !== version) clipCache = { v: version, map: buildClipLooks() };
  return clipCache.map.get(id) || S.look;
}

// The look the Layers tab is editing: the main look, or one clip's own look in Custom mode.
function editLook() {
  if (S.clipMode === 'custom' && S.editClip && S.clipLooks[S.editClip] && S.selected.includes(S.editClip)) return S.clipLooks[S.editClip];
  return S.look;
}

function setClipMode(k) {
  if (k === 'custom' && S.clipMode !== 'custom' && S.clipMode !== 'one') {
    // keep what each clip shows right now, so it can be fine-tuned from there
    S.clipLooks = Object.fromEntries(S.selected.map((id) => [id, clipLookOf(id)]).filter(([, l]) => l !== S.look).map(([id, l]) => [id, cloneLook(l)]));
  }
  S.clipMode = k;
  if (k !== 'custom') S.editClip = null;
  engine.main.reset();
  rebuild(); renderLayers(); renderClips(); renderLooks();
}

function editClipLook(id) {
  if (id && S.clipMode !== 'custom') setClipMode('custom');
  if (id && !S.clipLooks[id]) S.clipLooks[id] = cloneLook(S.look);
  S.editClip = id;
  touch();
  setTab('layers');
  renderLayers(); renderClips(); renderLooks(); save();
}

function rollClips() {
  const base = (Date.now() % 1e6) | 0;
  S.clipLooks = Object.fromEntries(S.selected.map((id, i) => [id, chaosLook(base + i * 7919)]));
  S.clipMode = 'custom';
  S.editClip = null;
  engine.main.reset();
  rebuild(); renderLayers(); renderClips(); renderLooks(); save();
  toast(`🎲 ${S.selected.length} clips, ${S.selected.length} different stacks`);
}

// Toast / popover
let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
const pop = $('#pop');
function openPop(anchor, build, cls = '') {
  pop.className = `pop on ${cls}`;
  pop.innerHTML = '';
  build(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.right - pw, y = r.bottom + 6;
  if (x < 8) x = Math.min(r.left, innerWidth - pw - 8);
  if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
}
function closePop() { pop.className = 'pop'; }
document.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target) && !e.target.closest('[data-pop]')) closePop(); });

// Edit (timeline) rebuild
function rebuild() {
  touch();
  const L = loopLen();
  const bd = beatDur();
  const clips = S.selected.map((id) => S.clips.find((c) => c.id === id)).filter(Boolean)
    .map((c) => ({ id: c.id, duration: Math.max(0.5, Math.min(c.duration, 60)) }));
  clips.forEach((c) => clipDur.set(c.id, c.duration));
  $('#emptyStage').hidden = clips.length > 0;
  if (!clips.length) { ctx = null; drawTimeline(); renderChips(); return; }
  let hit = null;
  if (S.features) {
    const k = S.features.curves.kick, sn = S.features.curves.snare;
    const a = Math.round(S.loopStart * 30);
    hit = Array.from({ length: Math.round(L * 30) + 3 }, (_, i) => (k[a + i] || 0) + 0.6 * (sn[a + i] || 0));
  }
  const cut = S.look.cut;
  const tl = planTimeline({
    L, beatDur: bd, clips, rhythm: S.customCuts ? 'custom' : cut.rhythm, custom: S.customCuts, transitions: cut.transitions,
    transBeats: cut.beats, seed: S.seed, speed: S.look.camera.p.speed ?? 1, direction: S.direction, order: cut.order, hitCurve: hit,
  });
  for (const [i, o] of Object.entries(S.segOverrides)) {
    const s = tl.segs[+i];
    if (!s) continue;
    if (o.clipId && clips.some((c) => c.id === o.clipId)) s.clipId = o.clipId;
    if (o.trans) s.trans = o.trans;
  }
  ctx = {
    look: S.look, tl, L, beatDur: bd, seed: S.seed, clipDur: (id) => clipDur.get(id) || 10,
    intensity: S.intensity, clipLook: S.clipMode === 'one' ? null : clipLookOf,
    sampler: makeSampler({ features: S.features, loopStart: S.loopStart, beatDur: bd, seed: S.seed }),
  };
  transport.setLoop(S.loopStart, L);
  drawTimeline();
  renderChips();
  renderBars();
  renderRhythm();
  renderLoopChips();
  save();
}

function setLook(l, { keepEdit = false } = {}) {
  const prevCut = S.look?.cut;
  S.look = cloneLook(l);
  S.lookId = l.id;
  if ((S.lockEdit || keepEdit) && prevCut) S.look.cut = prevCut;
  else { S.customCuts = null; S.segOverrides = {}; }
  engine.main.reset();
  touch();
  rebuild();
  renderLooks();
  renderLayers();
  renderEdit();
}

// Render loop
let frameNo = 0, fpsAcc = 0, fpsN = 0, lastNow = performance.now(), thumbCursor = 0, lastFrame = null, lastKey = '';
const ambientCtx = $('#ambient').getContext('2d', { willReadFrequently: true });
const freeClock = () => (performance.now() / 1000);

function fitView(force = false) {
  const c = $('#view');
  const r = c.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  let w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
  if (w > 1080) { hh = Math.round((hh * 1080) / w); w = 1080; }
  if (hh < 400) { w = Math.round((w * 400) / hh); hh = 400; } // thumbnails borrow the top-left 216×384
  if (force || c.width !== w || c.height !== hh) engine.resize(w, hh);
}

function tick(now) {
  requestAnimationFrame(tick);
  frameNo++;
  const dt = now - lastNow; lastNow = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 500) { $('#fps').textContent = `${Math.round((1000 * fpsN) / fpsAcc)} fps`; fpsAcc = 0; fpsN = 0; }
  if (S.exporting) return;
  fitView();
  if (!ctx) return;
  const t = transport.loopTime();
  const fr = compose(ctx, t);
  bank.sync(fr.needs, transport.playing);
  if (transport.playing) {
    const ahead = compose(ctx, (t + 0.35) % ctx.L).needs.filter((n) => !fr.needs.some((m) => m.vkey === n.vkey));
    if (ahead.length) bank.prime(ahead);
  }
  const sources = fr.needs.map((n) => ({ ...engine.video(n.vkey, bank.get(n.vkey, n.clipId)), cam: n.cam }));
  const waiting = fr.needs.some((n) => bank.get(n.vkey, n.clipId).readyState < 2);
  const badge = $('#stageBadge');
  badge.style.display = waiting ? 'block' : 'none';
  if (waiting) badge.textContent = 'Preparing clip…';
  renderThumbs(transport.playing ? t : freeClock() % ctx.L, fr, sources);
  // The engine steps at the export's 30 fps, so feedback trails and the flash guard behave the
  // same on 60/120 Hz displays as in the file; in between, the last frame is re-presented.
  const key = `${Math.round(t * 30)}|${version}|${waiting ? frameNo : ''}|${engine.main.w}`;
  if (key !== lastKey || !engine.present()) { engine.renderMain({ ...fr, sources }); lastKey = key; }
  lastFrame = fr;
  if (frameNo % 5 === 0) ambient();
  updateLive(t, fr);
}

function ambient() {
  ambientCtx.drawImage($('#view'), 0, 0, 48, 85);
  if (frameNo % 30 === 0) {
    const d = ambientCtx.getImageData(0, 0, 48, 85).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 16) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 16;
    $('#phone').style.setProperty('--glow', `rgba(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0},0.55)`);
  }
}

function renderThumbs(t, fr, sources) {
  const jobs = varState.open ? varState.jobs : (S.tab === 'looks' ? lookJobs.filter((j) => j.visible) : []);
  if (!jobs.length) return;
  const texBy = new Map(fr.needs.map((n, i) => [n.vkey, sources[i]]));
  const per = Math.min(jobs.length, varState.open ? 3 : 3);
  for (let k = 0; k < per; k++) {
    const job = jobs[(thumbCursor + k) % jobs.length];
    const f = compose(ctx, t, job.look);
    const src = f.needs.map((n) => ({ ...(texBy.get(n.vkey) || sources[0]), cam: n.cam }));
    engine.renderThumb(job.id, { ...f, sources: src }, job.ctx2d);
  }
  thumbCursor += per;
}

const ghosts = [];
function updateLive(t, fr) {
  const L = ctx.L;
  $('#time').innerHTML = `${t.toFixed(2)} <small>/ ${L.toFixed(2)}</small>`;
  const beat = Math.floor(t / ctx.beatDur + 1e-6);
  $('#bbt').textContent = `${Math.floor(beat / 4) + 1}.${(beat % 4) + 1}`;
  const lane = $('#lane');
  $('#playhead').style.transform = `translateX(${(t / L) * lane.clientWidth}px)`;
  const mv = fr.mv;
  METERS.forEach((m, i) => { meterEls[i].style.height = `${clamp(mv[m], 0, 1) * 100}%`; });
  const dur = S.features?.duration || L;
  $('#hudProg').style.width = `${clamp((transport.songTime() / dur) * 100, 0, 100)}%`;
  for (const g of ghosts) {
    if (!g.el.isConnected) continue;
    const v = g.read(fr);
    if (v === undefined) continue;
    g.el.style.left = `${((v - g.def.min) / (g.def.max - g.def.min)) * 100}%`;
  }
  if (frameNo % 2 === 0 && S.features && transport.mode === 'listen') drawOverview();
}

// Top chips + transport
function renderChips() {
  const tr = S.tracks.find((t) => t.id === S.trackId);
  const L = ctx?.L ?? loopLen();
  $('#chips').replaceChildren(
    h('span', { class: `chip ${tr ? '' : 'dim'}` }, h('span', { class: 'dot' }), tr ? h('b', {}, tr.name.replace(/\.[^.]+$/, '')) : 'No track · BPM clock'),
    h('span', { class: 'chip' }, h('b', {}, bpm().toFixed(bpm() % 1 ? 2 : 0)), 'BPM'),
    h('span', { class: 'chip' }, h('b', {}, `${L.toFixed(2)}s`), S.bars ? `${S.bars} bar${S.bars > 1 ? 's' : ''} loop` : 'loop'),
    h('span', { class: 'chip' }, 'Look ', h('b', {}, S.look?.name || '')),
    h('span', { class: 'chip' }, h('b', {}, String(S.selected.length)), 'clips'),
  );
  $('#hudTitle').textContent = tr ? tr.name.replace(/\.[^.]+$/, '') : S.look?.name || 'Canvas Forge';
}

function renderTransport() {
  $('#btnPlay').innerHTML = transport.playing ? ICON.pause : ICON.play;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === transport.mode));
  $('#modeSeg').style.display = S.features ? '' : 'none';
  $('#tHud').classList.toggle('on', S.hud);
  $('#tSafe').classList.toggle('on', S.safe);
  $('#tMute').classList.toggle('on', !S.muted);
  $('#tMute').style.display = S.features ? '' : 'none';
  $('#hud').classList.toggle('hidden', !S.hud);
  $('#safe').classList.toggle('on', S.safe);
}

function renderBars() {
  const vb = validBars();
  $('#barsSeg').replaceChildren(...BAR_CHOICES.map((b) => h('button', {
    class: b === S.bars ? 'on' : '', disabled: !vb.includes(b), title: `${(b * barDur()).toFixed(2)} s`,
    onclick: () => { S.bars = b; S.customCuts = null; rebuild(); renderEdit(); },
  }, b === BAR_CHOICES[0] ? `${b} bar` : `${b}`)));
}

function renderRhythm() {
  const cur = S.customCuts ? 'custom' : S.look.cut.rhythm;
  const btns = Object.entries(RHYTHMS).map(([k, r]) => h('button', {
    class: k === cur ? 'on' : '', title: r.name, onclick: () => { S.look.cut.rhythm = k; S.customCuts = null; S.segOverrides = {}; rebuild(); renderEdit(); },
  }, r.short));
  if (S.customCuts) btns.push(h('button', { class: 'on', title: 'You dragged the cuts' }, 'Custom'));
  $('#rhythmSeg').replaceChildren(...btns);
}

// Track panel
const meterEls = [];
function buildMeters() {
  $('#meters').replaceChildren(...METERS.map((m) => {
    const i = h('i');
    meterEls.push(i);
    return h('div', { class: 'meter', style: `--c:${MOD_SOURCES[m].color}`, title: MOD_SOURCES[m].name }, h('div', { class: 'bar' }, i), h('span', {}, MOD_SOURCES[m].name.slice(0, 6)));
  }));
}

function renderTrack() {
  const sel = $('#trackSelect');
  sel.replaceChildren(h('option', { value: '' }, '⏱  No track — BPM clock'), ...S.tracks.map((t) => h('option', { value: t.id, selected: t.id === S.trackId }, t.name)));
  sel.value = S.trackId;
  const f = S.features;
  $('#trackMeta').replaceChildren(...(f
    ? [h('span', { class: 'bpm-edit', title: `Tempo ${f.bpm_source === 'manual' ? 'set by you' : f.bpm_source === 'filename' ? 'from the filename' : 'detected'} — click to type an exact BPM` },
        h('b', { contenteditable: 'plaintext-only', spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
          onblur: (e) => setTempo(parseFloat(e.target.textContent)) }, f.bpm.toFixed(f.bpm % 1 ? 2 : 0)), ' BPM'),
      h('button', { class: 'mini', title: 'Half tempo', onclick: () => setTempo(f.bpm / 2) }, '½×'),
      h('button', { class: 'mini', title: 'Double tempo', onclick: () => setTempo(f.bpm * 2) }, '2×'),
      S.bpmOverride[S.trackId] ? h('button', { class: 'mini', title: 'Back to the detected tempo', onclick: () => setTempo(null) }, 'auto') : null,
      h('span', { style: 'margin-left:auto' }, h('b', {}, fmt(f.duration)))].filter(Boolean)
    : [h('span', {}, 'Visuals follow a synthetic beat at the tempo set in Edit')]));
}

async function setTempo(v) {
  if (!S.trackId) return;
  if (v === null) delete S.bpmOverride[S.trackId];
  else if (Number.isFinite(v) && v >= 40 && v <= 220) S.bpmOverride[S.trackId] = +v.toFixed(2);
  else { renderTrack(); return; }
  await selectTrack(S.trackId, { keepLoop: true });
  toast(`Tempo ${bpm().toFixed(bpm() % 1 ? 2 : 0)} BPM — beat grid re-fitted`);
}

let trackToken = 0;
async function selectTrack(id, { initial = false, keepLoop = false } = {}) {
  const token = ++trackToken;
  S.trackId = id || '';
  $('#trackState').textContent = id ? 'Analysing…' : '';
  if (!id) {
    S.features = null;
    transport.unload();
    S.loopStart = 0;
    rebuild(); renderTrack(); renderTransport(); renderEdit();
    return;
  }
  try {
    const ov = S.bpmOverride[id];
    const [feats] = await Promise.all([
      fetchJSON(`/api/features/${id}${ov ? `?bpm=${ov}` : ''}`),
      transport.buffer && transport.trackId === id ? transport.buffer : transport.decode(`/api/track_audio/${id}`),
    ]).then(([f, buf]) => { if (token === trackToken) { transport.setBuffer(buf); transport.trackId = id; } return [f]; });
    if (token !== trackToken) return;
    S.features = feats;
    const savedOk = (initial || keepLoop) && S.loopStart > 0 && S.loopStart < feats.duration - 3;
    if (keepLoop) { S.bars = feats.loop_bars || S.bars; S.customCuts = null; }
    if (savedOk && keepLoop && feats.downbeats.length) {
      S.loopStart = feats.downbeats.reduce((a, d) => (Math.abs(d - S.loopStart) < Math.abs(a - S.loopStart) ? d : a), feats.downbeats[0]);
    }
    if (!savedOk) { S.loopStart = feats.loops[0]?.start ?? 0; S.bars = feats.loop_bars || 4; S.customCuts = null; S.segOverrides = {}; }
    $('#trackState').textContent = '';
  } catch (e) {
    $('#trackState').textContent = 'Analysis failed';
    S.features = null;
    console.error(e);
  }
  rebuild(); renderTrack(); renderTransport(); renderEdit();
}

// Clips panel
let dragId = null;
function renderClips() {
  const ordered = [...S.selected.map((id) => S.clips.find((c) => c.id === id)).filter(Boolean), ...S.clips.filter((c) => !S.selected.includes(c.id))];
  $('#clips').replaceChildren(...ordered.map((c) => {
    const idx = S.selected.indexOf(c.id);
    const busy = c.proxy && c.proxy !== 'ready';
    return h('div', {
      class: `clip ${idx >= 0 ? 'on' : 'off'}`, draggable: idx >= 0 ? 'true' : 'false', title: `${c.name}\n${c.width}×${c.height} · ${c.duration}s`,
      style: `background-image:url(/api/thumb/${c.id}?w=240)`,
      onclick: () => toggleClip(c.id),
      ondragstart: (e) => { dragId = c.id; e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { if (dragId && idx >= 0) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); } },
      ondragleave: (e) => e.currentTarget.classList.remove('drag-over'),
      ondrop: (e) => {
        e.preventDefault(); e.stopPropagation();
        e.currentTarget.classList.remove('drag-over');
        if (!dragId || dragId === c.id || idx < 0) return;
        const from = S.selected.indexOf(dragId);
        S.selected.splice(from, 1);
        S.selected.splice(S.selected.indexOf(c.id) + (from <= idx ? 1 : 0), 0, dragId);
        dragId = null;
        S.segOverrides = {};
        renderClips(); rebuild();
      },
    }, idx >= 0 ? h('span', { class: 'num' }, String(idx + 1)) : null, busy ? h('span', { class: 'busy', title: 'Preparing playback proxy' }) : null,
    idx >= 0 && S.clipMode !== 'one' ? clipTag(c.id) : null,
    h('div', { class: 'cap' }, `${c.duration.toFixed(1)}s · ${c.name}`));
  }));
  $('#clipCount').textContent = `${S.selected.length} of ${S.clips.length}`;
}

function clipTag(id) {
  const l = clipLookOf(id);
  const own = l !== S.look;
  return h('button', {
    class: `lk ${own ? 'own' : ''} ${S.editClip === id ? 'on' : ''}`, title: `${own ? l.name : 'Main look'} — click to edit this clip's effects`,
    onclick: (e) => { e.stopPropagation(); editClipLook(id); },
  }, own ? l.name : 'Main');
}

function toggleClip(id) {
  const i = S.selected.indexOf(id);
  if (i >= 0) S.selected.splice(i, 1); else S.selected.push(id);
  S.segOverrides = {};
  renderClips(); rebuild();
}

// Exports list
function renderExports() {
  const list = S.renders.filter((r) => r.engine === 'gpu' || r.filename);
  $('#exportCount').textContent = list.length ? `${list.length}` : '';
  $('#exports').replaceChildren(...(list.length ? list.slice(0, 12).map((r) => {
    const checks = r.checks || [];
    const fails = checks.filter((c) => c.level === 'fail').length, warns = checks.filter((c) => c.level === 'warn').length;
    const badge = !checks.length ? null : fails ? h('span', { class: 'badge bad' }, `✕ ${fails}`) : warns ? h('span', { class: 'badge warn', title: 'Passed with notes' }, '✓ spec') : h('span', { class: 'badge' }, '✓ spec');
    return h('div', { class: 'exp' },
      h('div', { class: 'n', title: r.filename }, r.look || r.filename),
      h('div', { class: 'm' }, [r.resolution?.replace('x', '×'), r.duration ? `${(+r.duration).toFixed(2)}s` : null, `${r.size_mb} MB`].filter(Boolean).join(' · '), ' ', badge),
      h('div', { class: 'acts' },
        h('a', { class: 'btn sm icon', href: r.url, download: r.filename, title: 'Download' }, '↓'),
        h('button', { class: 'btn sm icon', title: 'Reveal in Finder', onclick: () => reveal(r.filename) }, '⌕')));
  }) : [h('div', { class: 'note' }, 'Exports appear here, each checked against the Spotify Canvas spec.')]));
}

async function reveal(filename) {
  const r = await fetchJSON('/api/reveal', { method: 'POST', body: JSON.stringify({ filename }) }).catch(() => ({}));
  if (!r.ok) toast(`Saved in out/${filename}`);
}

// Looks gallery
const lookJobs = [];
const lookIO = new IntersectionObserver((ents) => {
  for (const e of ents) { const j = lookJobs.find((x) => x.card === e.target); if (j) j.visible = e.isIntersecting; }
}, { root: $('#pane-looks') });

function renderLooks() {
  const all = [...S.saved.map((l) => ({ ...l, mine: true })), ...LOOKS];
  if (lookJobs.length !== all.length || lookJobs.some((j, i) => j.look.id !== all[i].id)) {
    lookJobs.forEach((j) => { lookIO.unobserve(j.card); engine.dropThumb(j.id); });
    lookJobs.length = 0;
    $('#looks').replaceChildren(...all.flatMap((l, i) => {
      const group = l.mine ? 'mine' : l.group || 'curated';
      const prev = i ? (all[i - 1].mine ? 'mine' : all[i - 1].group || 'curated') : null;
      const head = group !== prev ? h('div', { class: 'look-group' }, { mine: 'Your looks', curated: 'Studio looks', classic: 'Classic stacks' }[group]) : null;
      const cv = h('canvas', { width: 144, height: 256 });
      const card = h('div', { class: 'look', onclick: () => applyLook(l) }, cv,
        h('div', { class: 'lbl' }, h('b', {}, l.mine ? `★ ${l.name}` : l.name), h('span', {}, l.vibe)));
      const job = { id: `look:${l.id}`, look: l, card, ctx2d: cv.getContext('2d'), visible: false };
      lookJobs.push(job);
      lookIO.observe(card);
      return head ? [head, card] : [card];
    }));
  }
  const target = editLook();
  const activeId = target === S.look ? S.lookId : target.id;
  lookJobs.forEach((j) => j.card.classList.toggle('on', j.look.id === activeId));
  $('#lookCount').textContent = String(all.length);
  const banner = $('#lookTarget');
  banner.hidden = target === S.look;
  if (!banner.hidden) {
    banner.replaceChildren(h('span', {}, 'Clicking a look applies it to ', h('b', {}, `clip ${S.selected.indexOf(S.editClip) + 1}`)),
      h('button', { class: 'btn sm', onclick: () => editClipLook(null) }, 'Back to main'));
  }
}

function applyLook(l) {
  if (editLook() !== S.look) {
    const no = S.selected.indexOf(S.editClip) + 1;
    S.clipLooks[S.editClip] = cloneLook(l);
    touch(); rebuild(); renderLayers(); renderClips(); renderLooks(); save();
    toast(`Clip ${no} → ${l.name}`);
    return;
  }
  setLook(l);
  toast(l.name);
}

function stepLook(d) {
  const all = [...S.saved, ...LOOKS];
  const i = all.findIndex((l) => l.id === S.lookId);
  const l = all[(i + d + all.length) % all.length];
  setLook(l);
  toast(l.name);
  lookJobs.find((j) => j.look.id === l.id)?.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Layers pane
function fmtVal(p, v) { return p.step >= 1 ? String(Math.round(v)) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2); }

function paramRow(p, holder, readLive) {
  const values = holder.p, mods = holder.mods || (holder.mods = {});
  const stepped = p.opts || p.step >= 1;
  if (p.opts) {
    const row = h('div', { class: 'prm' }, h('label', {}, p.name), h('div', { class: 'opts' }, ...p.opts.map((o, i) => h('button', {
      class: Math.round(values[p.id] ?? p.def) === i ? 'on' : '',
      onclick: (e) => { values[p.id] = i; [...e.currentTarget.parentElement.children].forEach((b, j) => b.classList.toggle('on', j === i)); afterParam(p); },
    }, o))), h('span'));
    return row;
  }
  const v0 = values[p.id] ?? p.def;
  const input = h('input', { type: 'range', min: p.min, max: p.max, step: stepped ? p.step : (p.max - p.min) / 400, value: v0 });
  const fill = h('div', { class: 'fill' }), knob = h('div', { class: 'knob' }), ghost = h('div', { class: 'ghost' });
  const out = h('output', {}, fmtVal(p, v0));
  const paint = (v) => { const f = ((v - p.min) / (p.max - p.min)) * 100; fill.style.width = `${f}%`; knob.style.left = `${f}%`; out.textContent = fmtVal(p, v); };
  input.addEventListener('input', () => { const v = +input.value; values[p.id] = v; paint(v); afterParam(p); });
  input.addEventListener('dblclick', () => { values[p.id] = p.def; input.value = p.def; paint(p.def); afterParam(p); });
  paint(v0);
  const modBtn = h('button', { class: `modbtn ${stepped ? 'na' : ''}`, 'data-pop': true, title: 'Modulate with audio or an LFO' });
  const row = h('div', { class: 'prm' }, h('label', { title: `${p.name} — double-click the slider to reset` }, p.name),
    h('div', { class: 'slider' }, h('div', { class: 'trk' }), fill, ghost, knob, input), out, modBtn);
  const paintMod = () => {
    const m = mods[p.id];
    row.classList.toggle('modded', !!m);
    if (m) row.style.setProperty('--mc', MOD_SOURCES[m.src].color);
    modBtn.title = m ? `${MOD_SOURCES[m.src].name} × ${m.amt > 0 ? '+' : ''}${m.amt.toFixed(2)}` : 'Modulate with audio or an LFO';
  };
  paintMod();
  if (!stepped) {
    ghosts.push({ el: ghost, def: p, read: readLive });
    modBtn.addEventListener('click', () => openPop(modBtn, (box) => {
      box.append(h('div', { class: 'ph' }, `Modulate ${p.name}`));
      const amtRow = h('div', { class: 'amt' });
      const drawAmt = () => {
        const m = mods[p.id];
        amtRow.replaceChildren();
        if (!m) return;
        const o = h('output', {}, m.amt.toFixed(2));
        amtRow.append(h('input', { type: 'range', min: -1, max: 1, step: 0.01, value: m.amt, style: 'accent-color:var(--accent)',
          oninput: (e) => { m.amt = +e.target.value; o.textContent = m.amt.toFixed(2); paintMod(); touch(); save(); } }), o);
      };
      for (const [k, s] of Object.entries(MOD_SOURCES)) {
        box.append(h('button', { class: `pi ${mods[p.id]?.src === k ? 'on' : ''}`, style: `--c:${s.color}`, onclick: (e) => {
          mods[p.id] = { src: k, amt: mods[p.id]?.amt ?? 0.25 };
          $$('.pi', box).forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on');
          paintMod(); drawAmt(); touch(); save();
        } }, h('span', { class: 'sd' }), s.name, ['kick', 'snare', 'hats', 'bass', 'energy', 'bright'].includes(k) ? h('small', {}, S.features ? 'audio' : 'synthetic') : h('small', {}, 'clock')));
      }
      box.append(amtRow);
      box.append(h('button', { class: 'pi', onclick: () => { delete mods[p.id]; paintMod(); closePop(); touch(); save(); } }, h('span', { class: 'muted' }, 'Remove modulation')));
      drawAmt();
    }));
  }
  return row;
}

function afterParam(p) {
  touch();
  if (p.id === 'speed') rebuild();
  if (editLook() !== S.look) { save(); return; }
  S.lookId = S.lookId?.startsWith('edit:') ? S.lookId : `edit:${S.lookId}`;
  renderLooksActive();
  save();
}
function renderLooksActive() { lookJobs.forEach((j) => j.card.classList.toggle('on', j.look.id === S.lookId)); }

function card({ title, sub, color, collapsed, onToggle, on, actions = [] }, body) {
  const c = h('div', { class: `card ${on === false ? 'off' : ''} ${collapsed ? 'collapsed' : ''}` });
  const head = h('div', { class: 'card-h', onclick: (e) => { if (e.target.closest('button,.sw')) return; c.classList.toggle('collapsed'); } },
    h('span', { class: 'cdot', style: `--c:${color}` }), h('span', { class: 'ct' }, title, sub ? h('small', {}, sub) : null),
    onToggle ? h('span', { class: `sw ${on ? 'on' : ''}`, title: 'Enable / bypass', onclick: (e) => { e.stopPropagation(); onToggle(); } }) : null, ...actions);
  c.append(head, h('div', { class: 'prms' }, ...body));
  return c;
}

function sliderRow(label, { min, max, step, value, fmt: f, def, title }, onInput) {
  const input = h('input', { type: 'range', min, max, step, value });
  const fill = h('div', { class: 'fill' }), knob = h('div', { class: 'knob' });
  const out = h('output', {}, f(value));
  const paint = (v) => { const k = ((v - min) / (max - min)) * 100; fill.style.width = `${k}%`; knob.style.left = `${k}%`; out.textContent = f(v); };
  input.addEventListener('input', () => { paint(+input.value); onInput(+input.value); });
  if (def !== undefined) input.addEventListener('dblclick', () => { input.value = def; paint(def); onInput(def); });
  paint(value);
  return h('div', { class: 'prm' }, h('label', { title }, label), h('div', { class: 'slider' }, h('div', { class: 'trk' }), fill, knob, input), out, h('span'));
}

const STAGE = ['space', 'warp', 'time', 'stylize', 'color', 'light'];
function addRandomLayer(look) {
  const pool = Object.keys(MODULES).filter((id) => !look.layers.some((x) => x.m === id));
  if (!pool.length) return;
  const id = pool[Math.floor(Math.random() * pool.length)];
  const at = look.layers.findIndex((x) => STAGE.indexOf(MODULES[x.m]?.cat) > STAGE.indexOf(MODULES[id].cat));
  look.layers.splice(at < 0 ? look.layers.length : at, 0, { m: id, on: true, p: defaults(MODULES[id].params), mods: {} });
  engine.main.reset(); renderLayers(); save();
  toast(`🎲 Added ${MODULES[id].name}`);
}

function findLayer(fr, key) { return fr.layers.find((x) => x.key === key) || fr.pre?.flat().find((x) => x.key === key); }

function renderLayers() {
  touch();
  ghosts.length = 0;
  const look = editLook();
  const clipEdit = look !== S.look;
  const clipNo = S.selected.indexOf(S.editClip) + 1;
  const pane = $('#pane-layers');
  const kids = [];
  const relayer = () => { engine.main.reset(); renderLayers(); renderClips(); save(); };

  // ---- master: FX intensity and per-clip looks
  const master = [
    sliderRow('FX intensity', { min: 0, max: 1.5, step: 0.01, value: S.intensity, def: 1, fmt: (v) => `${Math.round(v * 100)}%`,
      title: 'Below 100% fades every layer toward the clean footage; above 100% the audio modulation hits harder. Double-click to reset.' },
    (v) => { S.intensity = v; if (ctx) ctx.intensity = v; touch(); save(); }),
    h('div', { class: 'prm-wide' }, h('label', { title: 'Give each clip its own effects' }, 'Per clip'),
      h('div', { class: 'seg' }, ...CLIP_MODES.map(([k, label]) => h('button', { class: S.clipMode === k ? 'on' : '', onclick: () => setClipMode(k) }, label)))),
  ];
  const modeNote = {
    one: 'Every clip runs through the main look.',
    evolve: 'Clip 1 uses the main look; each later clip gets its own mutation of it.',
    cycle: 'Clip 1 uses the main look; each later clip gets a different curated look.',
    custom: 'Pick a clip to give it its own stack — or click a look while a clip is picked.',
  }[S.clipMode];
  master.push(h('div', { class: 'note', style: 'padding:2px 0 4px' }, modeNote));
  if (S.clipMode === 'evolve') {
    master.push(sliderRow('Evolve amount', { min: 0.1, max: 1, step: 0.01, value: S.evolveAmt, def: 0.45, fmt: (v) => `${Math.round(v * 100)}%` },
      (v) => { S.evolveAmt = v; touch(); renderClips(); save(); }));
  }
  if (S.clipMode === 'custom') {
    master.push(h('div', { class: 'clipstrip' },
      h('button', { class: `cs main ${clipEdit ? '' : 'on'}`, title: 'Edit the main look', onclick: () => editClipLook(null) }, 'Main'),
      ...S.selected.map((id, i) => h('button', {
        class: `cs ${S.editClip === id && clipEdit ? 'on' : ''} ${S.clipLooks[id] ? 'own' : ''}`,
        title: S.clipLooks[id] ? `Clip ${i + 1}: ${S.clipLooks[id].name}` : `Clip ${i + 1} uses the main look — click to give it its own`,
        style: `background-image:url(/api/thumb/${id}?w=120)`, onclick: () => editClipLook(id),
      }, h('span', {}, String(i + 1))))));
  }
  master.push(h('div', { class: 'row', style: 'margin-top:6px;flex-wrap:wrap;gap:6px' },
    h('button', { class: 'btn sm', title: 'Give every clip its own random stack', onclick: rollClips }, '🎲 Roll FX per clip'),
    S.clipMode !== 'one' ? h('button', { class: 'btn sm', title: 'Drop the per-clip looks', onclick: () => { S.clipLooks = {}; setClipMode('one'); toast('Main look on every clip'); } }, 'Same look on all') : null,
    clipEdit ? h('button', { class: 'btn sm', title: 'This clip follows the main look again', onclick: () => { delete S.clipLooks[S.editClip]; S.editClip = null; touch(); rebuild(); relayer(); renderLooks(); } }, `Reset clip ${clipNo}`) : null));
  kids.push(card({ title: clipEdit ? `Clip ${clipNo} · ${look.name}` : 'Master', sub: clipEdit ? 'this clip’s own stack' : 'intensity · per-clip looks', color: '#FF7AE6' }, master));

  // ---- layer tools
  const add = h('button', { class: 'btn sm', 'data-pop': true, title: 'Add an effect layer' }, '+ Add effect');
  add.addEventListener('click', () => openPop(add, (box) => {
    for (const [cat, meta] of Object.entries(CATEGORIES)) {
      box.append(h('div', { class: 'ph', style: `color:${meta.color}` }, meta.name));
      for (const [id, m] of Object.entries(MODULES)) {
        if (m.cat !== cat) continue;
        box.append(h('button', { class: 'pi', onclick: () => {
          look.layers.push({ m: id, on: true, p: defaults(m.params), mods: {} });
          closePop(); relayer(); toast(`Added ${m.name}`);
          pane.scrollTop = pane.scrollHeight;
        } }, h('b', {}, m.name), h('span', {}, m.desc)));
      }
    }
  }, 'menu'));
  kids.push(h('div', { class: 'layer-tools' }, add,
    h('button', { class: 'btn sm', title: 'Add a random effect at its natural place in the stack', onclick: () => addRandomLayer(look) }, '🎲 Random'),
    h('button', { class: 'btn sm', title: 'Shuffle the layer order', disabled: look.layers.length < 2, onclick: () => {
      shuffle(look.layers);
      relayer(); toast('Shuffled the stack');
    } }, '⇅ Shuffle'),
    h('button', { class: 'btn sm', title: 'Remove every layer (Revert brings them back)', disabled: !look.layers.length, onclick: () => { look.layers.length = 0; relayer(); toast('Cleared — Revert brings the look back'); } }, 'Clear')));

  // live values: the main look's layers run post-transition in 'one' mode, else inside a clip's stack
  const liveClip = clipEdit ? S.editClip : S.clipMode === 'one' ? null : S.selected.find((id) => clipLookOf(id) === S.look);
  const prefix = S.clipMode === 'one' ? '' : `c:${liveClip}:`;
  if (!clipEdit) {
    kids.push(card({ title: 'Camera', sub: 'framing · motion · clip speed', color: '#FFFFFF' },
      CAMERA.params.map((p) => paramRow(p, look.camera, (fr) => fr.camera[`p_${p.id}`]))));
  }
  look.layers.forEach((layer, i) => {
    const m = MODULES[layer.m];
    if (!m) return;
    layer.p = { ...defaults(m.params), ...layer.p };
    const btn = (label, title, fn) => h('button', { class: 'ib', title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    const key = `${prefix}${i}:${layer.m}`;
    kids.push(card({
      title: m.name, sub: CATEGORIES[m.cat].name, color: CATEGORIES[m.cat].color, on: layer.on !== false,
      onToggle: () => { layer.on = layer.on === false; relayer(); },
      actions: [
        btn('↑', 'Move up', () => { if (i > 0) { [look.layers[i - 1], look.layers[i]] = [look.layers[i], look.layers[i - 1]]; relayer(); } }),
        btn('↓', 'Move down', () => { if (i < look.layers.length - 1) { [look.layers[i + 1], look.layers[i]] = [look.layers[i], look.layers[i + 1]]; relayer(); } }),
        btn('✕', 'Remove', () => { look.layers.splice(i, 1); relayer(); }),
      ],
    }, [h('div', { class: 'note', style: 'margin-bottom:2px' }, m.desc), ...m.params.map((p) => paramRow(p, layer, (fr) => findLayer(fr, key)?.params[`p_${p.id}`]))]));
  });
  if (!look.layers.length) kids.push(h('div', { class: 'note', style: 'padding:6px 16px 4px' }, 'No effect layers — just the camera and the grade. Add one above, or hit 🎲.'));
  if (!clipEdit) {
    kids.push(card({ title: 'Finish', sub: 'grade · texture · safety', color: '#C8FF4D' },
      FINISH_DEF.params.map((p) => paramRow(p, look.finish, (fr) => fr.finish[`p_${p.id}`]))));
  } else {
    kids.push(h('div', { class: 'note', style: 'padding:4px 16px 8px' }, 'Camera, clip speed and the Finish grade are shared by every clip — edit them on Main.'));
  }
  kids.push(h('div', { class: 'row', style: 'padding: 2px 12px 16px; gap: 8px' },
    h('button', { class: 'btn', style: 'flex:1;justify-content:center', 'data-pop': true, onclick: saveLook }, '★ Save as look'),
    h('button', { class: 'btn', style: 'flex:1;justify-content:center', onclick: () => {
      const base = [...S.saved, ...LOOKS].find((l) => l.id === look.id.replace(/^edit:/, ''));
      if (!base) return;
      if (clipEdit) { S.clipLooks[S.editClip] = cloneLook(base); touch(); relayer(); } else setLook(base);
    } }, 'Revert')));
  pane.replaceChildren(...kids);
  $('#layerCount').textContent = String(look.layers.length);
}

function saveLook(e) {
  const anchor = e?.currentTarget || $('#pane-layers');
  openPop(anchor, (box) => {
    const input = h('input', { class: 'numin', style: 'width:100%;font-family:var(--font);font-weight:500', value: editLook().name, maxlength: 40 });
    const commit = () => {
      const name = input.value.trim();
      if (!name) return;
      const src = editLook();
      const l = cloneLook(src);
      if (src !== S.look) { l.camera = cloneLook(S.look.camera); l.finish = cloneLook(S.look.finish); l.cut = cloneLook(S.look.cut); }
      l.id = `mine-${Date.now()}`;
      l.name = name;
      l.vibe = l.layers.map((x) => MODULES[x.m]?.name).filter(Boolean).join(' + ') || 'Clean grade';
      S.saved.unshift(l);
      src.name = name;
      if (src === S.look) S.lookId = l.id; else src.id = l.id;
      closePop(); renderLooks(); renderChips(); save();
      toast(`Saved “${name}” to your looks`);
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); });
    box.append(h('div', { class: 'ph' }, 'Save look as'), h('div', { style: 'padding:4px 6px 8px' }, input),
      h('div', { class: 'row', style: 'padding:0 6px 6px' }, h('button', { class: 'btn primary sm', onclick: commit }, 'Save')));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// Edit pane
const POOLS = {
  All: Object.keys(TRANSITIONS).filter((k) => k !== 'cut'),
  Smooth: ['dissolve', 'luma', 'morph', 'flare', 'iris'],
  Kinetic: ['whip', 'whipX', 'zoom', 'swirl', 'kaleido'],
  Glitch: ['glitch', 'mosh', 'pixel', 'prism', 'slices'],
  'Hard cuts': ['cut'],
};

function renderEdit() {
  const look = S.look;
  const cut = look.cut;
  const field = (label, ...kids) => h('div', { class: 'field' }, h('label', {}, label), ...kids);
  const seg = (items, cur, onPick) => h('div', { class: 'seg' }, ...items.map(([v, label, extra = {}]) => h('button', { class: v === cur ? 'on' : '', onclick: () => onPick(v), ...extra }, label)));
  const vb = validBars();
  const kids = [
    field('Loop length', seg(BAR_CHOICES.map((b) => [b, `${b} bar${b > 1 ? 's' : ''}`, { disabled: !vb.includes(b) }]), S.bars, (b) => { S.bars = b; S.customCuts = null; rebuild(); renderEdit(); }),
      h('div', { class: 'note', style: 'margin-top:6px' }, `${loopLen().toFixed(3)} s at ${bpm().toFixed(2)} BPM. Whole bars keep every beat-synced effect phase-locked across the seam.`)),
    field('Cut rhythm', seg(Object.entries(RHYTHMS).map(([k, r]) => [k, r.name]), S.customCuts ? 'custom' : cut.rhythm, (k) => { cut.rhythm = k; S.customCuts = null; S.segOverrides = {}; rebuild(); renderEdit(); })),
    field('Transitions',
      h('div', { class: 'pools' }, ...Object.entries(POOLS).map(([name, ids]) => h('button', {
        class: `btn sm ${ids.length === cut.transitions.length && ids.every((k) => cut.transitions.includes(k)) ? 'on' : ''}`,
        onclick: () => { cut.transitions = [...ids]; S.segOverrides = {}; rebuild(); renderEdit(); },
      }, name))),
      h('div', { class: 'tgrid' }, ...Object.entries(TRANSITIONS).map(([k, t]) => h('button', {
        class: cut.transitions.includes(k) ? 'on' : '', title: `${t.name} — click to toggle, double-click to use only this one`,
        onclick: () => {
          const i = cut.transitions.indexOf(k);
          if (i >= 0 && cut.transitions.length > 1) cut.transitions.splice(i, 1); else if (i < 0) cut.transitions.push(k);
          S.segOverrides = {}; rebuild(); renderEdit();
        },
        ondblclick: () => { cut.transitions = [k]; S.segOverrides = {}; rebuild(); renderEdit(); },
      }, t.name)))),
    field('Transition length (beats)', seg(TRANS_BEATS.map(([b, l]) => [b, l]), cut.beats, (b) => { cut.beats = b; rebuild(); renderEdit(); })),
    field('Transition order', seg([['cycle', 'Cycle'], ['random', 'Shuffle']], cut.order || 'cycle', (o) => { cut.order = o; rebuild(); renderEdit(); })),
    field('Clip direction', seg(Object.entries(DIRECTIONS), S.direction, (d) => { S.direction = d; rebuild(); renderEdit(); })),
    field('Edit seed', h('div', { class: 'row' },
      h('input', { class: 'numin', type: 'number', value: S.seed, onchange: (e) => { S.seed = Math.round(+e.target.value) || 1; rebuild(); } }),
      h('button', { class: 'btn sm', onclick: () => { S.seed = Math.floor(Math.random() * 1e6); S.segOverrides = {}; rebuild(); renderEdit(); } }, '⚄ Re-roll in-points & order'))),
    !S.features ? field('Tempo (no track)', h('div', { class: 'row' },
      h('input', { type: 'range', min: 60, max: 180, step: 1, value: S.bpmManual, style: 'flex:1;accent-color:var(--accent)',
        oninput: (e) => { S.bpmManual = +e.target.value; e.target.nextSibling.textContent = `${S.bpmManual} BPM`; rebuild(); } }),
      h('span', { class: 'muted', style: 'min-width:64px;text-align:right' }, `${S.bpmManual} BPM`))) : null,
    field('Browsing looks', h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.lockEdit, onchange: (e) => { S.lockEdit = e.target.checked; save(); } }),
      'Keep my edit (cuts & transitions) when switching looks')),
    h('div', { class: 'note' }, h('b', {}, 'Seamless by construction. '), 'The loop seam is treated as one more beat-centred cut, noise fields cross-fade over exactly one loop, and feedback effects are pre-rolled before export. A GPU flash guard limits frame-to-frame brightness jumps.'),
  ];
  $('#pane-edit').replaceChildren(h('div', { style: 'padding:14px' }, ...kids.filter(Boolean)));
}

// Timeline
const thumbImgs = new Map();
function sizeCanvas(c) {
  const r = c.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), hh = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  return [w, hh, dpr];
}

function drawTimeline() { drawOverview(); drawLane(); renderTlInfo(); }

function renderTlInfo() {
  const f = S.features;
  $('#laneWrap').title = 'Drag a cut line to retime it on the beat grid · double-click a segment to change its clip or transition · click to seek';
  $('#tlInfo').innerHTML = ctx
    ? `<b>${ctx.tl.segs.length}</b> cuts${f ? ` · from <b>${fmt(S.loopStart)}</b>` : ''}`
    : '<span class="muted">Select clips to build the edit</span>';
}

function renderLoopChips() {
  const f = S.features;
  $('#loopChips').replaceChildren(...(f ? f.loops.map((l) => h('button', {
    class: Math.abs(l.start - S.loopStart) < 0.05 ? 'on' : '', title: `Starts at ${fmt(l.start)}`,
    onclick: () => { S.loopStart = l.start; S.customCuts = null; rebuild(); },
  }, l.label)) : []));
}

function drawOverview() {
  const c = $('#overview');
  const [w, hh, dpr] = sizeCanvas(c);
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, hh);
  const f = S.features;
  if (!f) {
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('No track selected — the canvas follows a synthetic beat clock', w / 2, hh / 2);
    return;
  }
  const D = f.duration, L = ctx?.L ?? loopLen();
  const x0 = (S.loopStart / D) * w, x1 = ((S.loopStart + L) / D) * w;
  const n = f.peaks.length;
  for (let px = 0; px < w; px += 2 * dpr) {
    const v = f.peaks[Math.floor((px / w) * n)] || 0;
    const bh = Math.max(1, v * hh * 0.82);
    x.fillStyle = px >= x0 && px <= x1 ? 'rgba(200,255,77,0.95)' : 'rgba(255,255,255,0.24)';
    x.fillRect(px, (hh - bh) / 2, 1.2 * dpr, bh);
  }
  x.fillStyle = 'rgba(200,255,77,0.12)';
  x.fillRect(x0, 0, x1 - x0, hh);
  x.strokeStyle = 'rgba(200,255,77,0.9)'; x.lineWidth = 1.5 * dpr;
  x.strokeRect(x0, 0.75 * dpr, x1 - x0, hh - 1.5 * dpr);
  for (const l of f.loops) {
    const lx = (l.start / D) * w;
    x.fillStyle = '#fff';
    x.beginPath(); x.moveTo(lx - 4 * dpr, 0); x.lineTo(lx + 4 * dpr, 0); x.lineTo(lx, 5 * dpr); x.fill();
  }
  if (transport.mode === 'listen' && transport.playing) {
    const sx = (transport.songTime() / D) * w;
    x.fillStyle = '#fff'; x.fillRect(sx - dpr, 0, 2 * dpr, hh);
  }
}

function thumbFor(clipId, t) {
  const k = `${clipId}@${t.toFixed(1)}`;
  let img = thumbImgs.get(k);
  if (!img) {
    img = new Image();
    img.onload = () => drawLane();
    img.src = `/api/thumb/${clipId}?w=200&t=${t.toFixed(2)}`;
    thumbImgs.set(k, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function roundRect(x, X, Y, W, H, r) {
  x.beginPath();
  x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

let selSeg = -1;
function drawLane() {
  const c = $('#lane');
  const [w, hh, dpr] = sizeCanvas(c);
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, hh);
  if (!ctx) return;
  const { L, beatDur: bd, tl } = ctx;
  const X = (t) => (t / L) * w;
  for (let b = 0; b * bd < L - 1e-6; b++) {
    x.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
    x.fillRect(Math.round(X(b * bd)), 0, dpr, hh);
    if (b % 4 === 0) { x.fillStyle = 'rgba(255,255,255,0.4)'; x.font = `600 ${9 * dpr}px ui-monospace, Menlo, monospace`; x.fillText(String(b / 4 + 1), X(b * bd) + 3 * dpr, 10 * dpr); }
  }
  const top = 15 * dpr, bot = hh - 26 * dpr;
  tl.segs.forEach((s, i) => {
    const a = X(s.t0) + 1.5 * dpr, W = X(s.t1) - X(s.t0) - 3 * dpr;
    x.save();
    roundRect(x, a, top, W, bot - top, 7 * dpr);
    x.clip();
    const img = thumbFor(s.clipId, s.in);
    if (img) {
      const ir = img.naturalWidth / img.naturalHeight, cr = W / (bot - top);
      let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
      if (ir > cr) { sw = sh * cr; sx = (img.naturalWidth - sw) / 2; } else { sh = sw / cr; sy = (img.naturalHeight - sh) / 2; }
      x.drawImage(img, sx, sy, sw, sh, a, top, W, bot - top);
    } else { x.fillStyle = '#1b1b22'; x.fillRect(a, top, W, bot - top); }
    const grd = x.createLinearGradient(0, top, 0, bot);
    grd.addColorStop(0, 'rgba(0,0,0,0.05)'); grd.addColorStop(1, 'rgba(0,0,0,0.65)');
    x.fillStyle = grd; x.fillRect(a, top, W, bot - top);
    x.fillStyle = '#fff'; x.font = `700 ${10 * dpr}px ui-monospace, Menlo, monospace`;
    const ci = S.selected.indexOf(s.clipId) + 1;
    if (W > 22 * dpr) x.fillText(`#${ci}`, a + 6 * dpr, bot - 7 * dpr);
    x.restore();
    if (i === selSeg) { x.strokeStyle = '#C8FF4D'; x.lineWidth = 2 * dpr; roundRect(x, a, top, W, bot - top, 7 * dpr); x.stroke(); }
  });
  // transitions centred on their cuts (the seam at 0 wraps to the right edge)
  tl.segs.forEach((s) => {
    const cx = X(s.t0);
    const half = (tl.transDur / 2 / L) * w;
    if (s.trans !== 'cut' && tl.transDur > 0) {
      x.fillStyle = 'rgba(255,79,163,0.28)';
      x.fillRect(cx - half, top, half * 2, bot - top);
      if (s.t0 === 0) x.fillRect(w - half, top, half, bot - top);
    }
    x.fillStyle = s.trans === 'cut' ? '#fff' : '#FF4FA3';
    x.save(); x.translate(cx === 0 ? 5 * dpr : cx, top); x.rotate(Math.PI / 4);
    x.fillRect(-4 * dpr, -4 * dpr, 8 * dpr, 8 * dpr); x.restore();
    if (s.t0 > 0) { x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillRect(cx - 0.75 * dpr, top, 1.5 * dpr, bot - top); }
  });
  // audio curves
  const curveY = (v) => hh - 3 * dpr - v * (20 * dpr);
  const plot = (key, color, fill) => {
    x.beginPath();
    for (let px = 0; px <= w; px += 2 * dpr) {
      const v = ctx.sampler((px / w) * L)[key];
      px === 0 ? x.moveTo(px, curveY(v)) : x.lineTo(px, curveY(v));
    }
    if (fill) { x.lineTo(w, hh); x.lineTo(0, hh); x.fillStyle = fill; x.fill(); } else { x.strokeStyle = color; x.lineWidth = 1.2 * dpr; x.stroke(); }
  };
  plot('energy', null, 'rgba(124,255,155,0.10)');
  plot('kick', MOD_SOURCES.kick.color);
  plot('hats', 'rgba(90,216,255,0.6)');
}

function laneTime(e) {
  const r = $('#lane').getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 0.9999) * ctx.L;
}
function nearestCut(e) {
  if (!ctx) return -1;
  const r = $('#lane').getBoundingClientRect();
  const px = e.clientX - r.left;
  let best = -1, bd = 7;
  ctx.tl.segs.forEach((s, i) => { if (i === 0) return; const d = Math.abs((s.t0 / ctx.L) * r.width - px); if (d < bd) { bd = d; best = i; } });
  return best;
}
function segAt(t) { return ctx.tl.segs.findIndex((s) => t >= s.t0 && t < s.t1); }

function bindTimeline() {
  const lane = $('#lane');
  let drag = null;
  lane.addEventListener('pointermove', (e) => {
    if (!ctx) return;
    if (drag) {
      const bd = ctx.beatDur;
      const cuts = S.customCuts;
      const lo = (drag.i > 1 ? cuts[drag.i - 2] : 0) + bd, hi = (drag.i < cuts.length ? cuts[drag.i] : ctx.L) - bd;
      const snapped = clamp(Math.round(laneTime(e) / bd) * bd, lo, hi);
      if (snapped !== cuts[drag.i - 1]) { cuts[drag.i - 1] = snapped; drag.moved = true; rebuild(); }
      return;
    }
    lane.style.cursor = nearestCut(e) > 0 ? 'ew-resize' : 'pointer';
  });
  lane.addEventListener('pointerdown', (e) => {
    if (!ctx) return;
    const i = nearestCut(e);
    if (i > 0) {
      S.customCuts = ctx.tl.segs.slice(1).map((s) => s.t0);
      drag = { i, moved: false };
      lane.setPointerCapture(e.pointerId);
      return;
    }
    transport.seek(laneTime(e));
  });
  lane.addEventListener('pointerup', () => { if (drag) { drag = null; renderRhythm(); save(); } });
  lane.addEventListener('dblclick', (e) => {
    if (!ctx) return;
    const i = segAt(laneTime(e));
    if (i < 0) return;
    selSeg = i; drawLane();
    const anchor = h('div', { style: `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:1px;height:1px` });
    document.body.append(anchor);
    openPop(anchor, (box) => {
      const s = ctx.tl.segs[i];
      box.append(h('div', { class: 'ph' }, `Segment ${i + 1} · clip`));
      S.selected.forEach((id, k) => {
        const c = S.clips.find((x) => x.id === id);
        box.append(h('button', { class: `pi ${s.clipId === id ? 'on' : ''}`, onclick: () => { (S.segOverrides[i] ||= {}).clipId = id; rebuild(); closePop(); } },
          h('span', { class: 'sd', style: '--c:#C8FF4D' }), `#${k + 1} ${c?.name || id}`));
      });
      box.append(h('div', { class: 'ph' }, i === 0 ? 'Transition into this segment (loop seam)' : 'Transition into this segment'));
      const g = h('div', { class: 'tgrid', style: 'padding:4px 6px 6px' }, ...Object.entries(TRANSITIONS).map(([k, t]) => h('button', {
        class: s.trans === k ? 'on' : '', onclick: () => { (S.segOverrides[i] ||= {}).trans = k; rebuild(); closePop(); },
      }, t.name)));
      box.append(g);
    });
    anchor.remove();
  });

  const ov = $('#overview');
  let od = null;
  const snapDown = (t) => {
    const f = S.features;
    const L = ctx?.L ?? loopLen();
    let best = f.downbeats[0] ?? 0;
    for (const d of f.downbeats) { if (d + L > f.duration) break; if (Math.abs(d - t) < Math.abs(best - t)) best = d; }
    return best;
  };
  ov.addEventListener('pointerdown', (e) => {
    if (!S.features) return;
    const r = ov.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * S.features.duration;
    const L = ctx?.L ?? loopLen();
    od = { x: e.clientX, start: t >= S.loopStart && t <= S.loopStart + L ? S.loopStart : snapDown(t - L / 2), w: r.width };
    ov.setPointerCapture(e.pointerId);
    ov.style.cursor = 'grabbing';
    if (od.start !== S.loopStart) { S.loopStart = od.start; S.customCuts = null; rebuild(); }
  });
  ov.addEventListener('pointermove', (e) => {
    if (!od) return;
    const t = od.start + ((e.clientX - od.x) / od.w) * S.features.duration;
    const s = snapDown(t);
    if (s !== S.loopStart) { S.loopStart = s; S.customCuts = null; rebuild(); }
  });
  ov.addEventListener('pointerup', () => { od = null; ov.style.cursor = ''; });
  new ResizeObserver(() => drawTimeline()).observe($('#laneWrap'));
}

// Variations modal
const varState = { open: false, jobs: [], seed: 1 };
function openVariations() {
  varState.open = true;
  $('#varModal').classList.add('on');
  $('#varSub').textContent = `Mutations of “${S.look.name}”, live on your footage. Click one to keep it.`;
  buildVariations();
}
function buildVariations() {
  varState.jobs.forEach((j) => engine.dropThumb(j.id));
  const amt = +$('#mutAmt').value;
  varState.seed += 6;
  varState.jobs = Array.from({ length: 6 }, (_, k) => {
    const l = mutate(S.look, amt, Math.floor(Math.random() * 1e9) + k);
    const cv = h('canvas', { width: 216, height: 384 });
    const card = h('div', { class: 'look', onclick: () => { setLook(l, { keepEdit: true }); closeModals(); toast(`Kept “${l.name}”`); } }, cv,
      h('div', { class: 'lbl' }, h('b', {}, l.name), h('span', {}, l.layers.map((x) => MODULES[x.m]?.name).join(' + '))));
    return { id: `var:${k}`, look: l, card, ctx2d: cv.getContext('2d'), visible: true };
  });
  $('#vars').replaceChildren(...varState.jobs.map((j) => j.card));
}
function closeModals() {
  $$('.modal-bg').forEach((m) => m.classList.remove('on'));
  if (varState.open) { varState.open = false; varState.jobs.forEach((j) => engine.dropThumb(j.id)); varState.jobs = []; }
}

// Export sheet
let exportAbort = null;
function openExport() {
  if (!ctx) { toast('Select at least one clip first'); return; }
  const pending = S.clips.filter((c) => S.selected.includes(c.id) && c.proxy && c.proxy !== 'ready');
  if (pending.some((c) => c.proxy === 'error')) { toast('A selected clip could not be converted — deselect it to export'); return; }
  if (pending.length) { toast(`Still preparing ${pending.length} clip${pending.length > 1 ? 's' : ''} for playback — one moment`); return; }
  if (S.exporting) return;
  const sheet = $('#exportSheet');
  sheet.classList.add('on');
  const o = S.exportOpts;
  const L = ctx.L, frames = Math.round(L * 30);
  const sizeCard = (key, title, sub) => h('div', { class: `opt-card ${o.size === key ? 'on' : ''}`, onclick: () => { o.size = key; save(); openExport(); } },
    h('span', { class: 'radio' }), h('div', {}, h('b', {}, title), h('span', {}, sub)));
  sheet.replaceChildren(...[
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, 'Export Canvas'), h('button', { class: 'btn icon', onclick: () => sheet.classList.remove('on') }, '✕')),
    h('div', { class: 'note' }, 'Every frame is rendered on the GPU, frame-exact, encoded to H.264 in hardware and verified against the Spotify Canvas spec.'),
    sizeCard('master', '1080 × 1920 · Master', 'The widely used Canvas size, sharpest on modern phones'),
    sizeCard('lite', '720 × 1280 · Lite', 'Smaller file, still crisp on most phones'),
    sizeCard('strict', '608 × 1080 · Spec-literal', 'Fits Spotify’s listed “720–1080 px tall” — use if an upload is rejected'),
    S.features ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.audio, onchange: (e) => { o.audio = e.target.checked; save(); } }),
      'Also save a copy with the audio slice (Reels / TikTok / previews)') : null,
    h('div', { class: 'summary' },
      h('span', {}, 'Look'), h('b', {}, S.look.name),
      h('span', {}, 'Length'), h('b', {}, `${L.toFixed(3)} s · ${frames} frames @ 30 fps`),
      h('span', {}, 'Tempo'), h('b', {}, `${bpm().toFixed(2)} BPM · ${S.bars || '—'} bars`),
      h('span', {}, 'Edit'), h('b', {}, `${ctx.tl.segs.length} cuts · ${S.selected.length} clips`),
      h('span', {}, 'Audio'), h('b', {}, S.features ? `${fmt(S.loopStart)} → ${fmt(S.loopStart + L)}` : 'none (silent canvas)')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: runExport }, 'Render & verify'), h('button', { class: 'btn', onclick: () => sheet.classList.remove('on') }, 'Cancel')),
  ].filter(Boolean));
}

async function runExport() {
  const sheet = $('#exportSheet');
  const [W, H] = { master: [1080, 1920], lite: [720, 1280], strict: [608, 1080] }[S.exportOpts.size] || [1080, 1920];
  const pct = h('div', { class: 'pct' }, '0%'), bar = h('i'), info = h('div', { class: 'note' }, 'Preparing clips…');
  exportAbort = new AbortController();
  sheet.replaceChildren(h('h2', {}, 'Rendering…'), h('div', { class: 'progress' }, pct, h('div', { class: 'pbar' }, bar), info),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => exportAbort.abort() }, 'Cancel')));
  const was = transport.playing;
  transport.pause(); renderTransport();
  S.exporting = true;
  document.body.classList.add('exporting');
  const snapshot = { ...ctx, look: cloneLook(ctx.look) }; // edits can't leak into a running export
  const badge = $('#stageBadge');
  badge.style.display = 'block';
  badge.textContent = `Rendering ${W}×${H} · frame-exact`;
  try {
    const res = await exportLoop({
      engine, bank, ctx: snapshot, width: W, height: H,
      meta: { look: S.look.name, bpm: bpm(), duration: ctx.L, track_id: S.trackId || null, audio_start: S.loopStart, with_audio: !!S.features && S.exportOpts.audio },
      signal: exportAbort.signal,
      onProgress: ({ frame, total, speed }) => {
        const p = Math.round((frame / total) * 100);
        pct.textContent = `${p}%`; bar.style.width = `${p}%`;
        info.textContent = `Frame ${frame} / ${total} · ${speed.toFixed(1)}× real-time`;
      },
    });
    S.renders = [res, ...S.renders.filter((r) => r.filename !== res.filename)];
    renderExports();
    showResult(res);
  } catch (e) {
    console.error(e);
    sheet.replaceChildren(h('h2', {}, e.name === 'AbortError' ? 'Export cancelled' : 'Export failed'), h('div', { class: 'note' }, String(e.message || e)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => sheet.classList.remove('on') }, 'Close')));
  } finally {
    S.exporting = false;
    document.body.classList.remove('exporting');
    badge.style.display = 'none';
    engine.main.reset();
    fitView(true);
    if (was) { transport.play(); renderTransport(); }
  }
}

function showResult(r) {
  const checks = r.checks || [];
  const fails = checks.filter((c) => c.level === 'fail').length;
  const ic = { ok: '✓', warn: '!', fail: '✕' };
  $('#exportSheet').replaceChildren(
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, fails ? 'Exported — needs attention' : 'Spotify-ready'), h('button', { class: 'btn icon', onclick: () => $('#exportSheet').classList.remove('on') }, '✕')),
    h('div', { class: 'note' }, `${r.filename} · ${r.size_mb} MB · rendered in ${r.seconds.toFixed(1)} s (${r.codec})`),
    h('div', { class: 'checks' }, ...checks.map((c) => h('div', { class: `ck ${c.level}` }, h('span', { class: 'ic' }, ic[c.level]), h('b', {}, c.label), h('span', {}, c.detail)))),
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary', href: r.url, download: r.filename }, '↓ Download MP4'),
      r.audio_url ? h('a', { class: 'btn', href: r.audio_url, download: '' }, '↓ With audio') : null,
      h('button', { class: 'btn', onclick: () => reveal(r.filename) }, 'Reveal in Finder')),
  );
}

// Uploads + polling
async function uploadFiles(files) {
  let n = 0;
  for (const f of files) {
    toast(`Uploading ${f.name}…`, 6000);
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f }).then((x) => x.json()).catch(() => ({}));
    if (!r.ok) { toast(`Could not add ${f.name}`); continue; }
    n++;
    await refreshState();
    if (r.kind === 'video' && !S.selected.includes(r.id)) S.selected.push(r.id);
    if (r.kind === 'audio') await selectTrack(r.id);
  }
  if (n) { renderClips(); renderTrack(); rebuild(); toast(`Added ${n} file${n > 1 ? 's' : ''}`); }
}

async function refreshState() {
  const st = await fetchJSON('/api/state').catch(() => null);
  if (!st) return;
  S.clips = st.clips; S.tracks = st.tracks;
  renderClips();
}

function pollProxies() {
  setTimeout(async () => {
    if (S.clips.some((c) => c.proxy && c.proxy !== 'ready' && c.proxy !== 'error')) await refreshState();
    pollProxies();
  }, 2500);
}

// Input
function bindUI() {
  $('#btnPlay').addEventListener('click', () => { transport.toggle(); renderTransport(); });
  $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => { transport.setMode(b.dataset.mode); renderTransport(); save(); }));
  $('#tHud').addEventListener('click', () => { S.hud = !S.hud; renderTransport(); save(); });
  $('#tSafe').addEventListener('click', () => { S.safe = !S.safe; renderTransport(); save(); });
  $('#tMute').addEventListener('click', () => { S.muted = !S.muted; transport.setMuted(S.muted); renderTransport(); save(); });
  $('#trackSelect').addEventListener('change', (e) => selectTrack(e.target.value));
  const reorder = (fn, msg) => { if (!S.selected.length) return; fn(); S.segOverrides = {}; renderClips(); rebuild(); renderLayers(); if (msg) toast(msg); };
  $('#btnShuffle').addEventListener('click', () => reorder(() => {
    shuffle(S.selected);
  }, 'Shuffled the sequence'));
  $('#btnReverse').addEventListener('click', () => reorder(() => S.selected.reverse(), 'Reversed the sequence'));
  $('#btnAllClips').addEventListener('click', () => { S.selected = [...S.selected, ...S.clips.map((c) => c.id).filter((id) => !S.selected.includes(id))]; reorder(() => {}, `Using all ${S.selected.length} clips`); });
  $('#btnSoloClip').addEventListener('click', () => { if (S.selected.length) { S.selected = [S.selected[0]]; reorder(() => {}, 'Solo: first clip only'); } });
  $('#btnAddMedia').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) uploadFiles(files); });
  $('#btnRoll').addEventListener('click', rollAll);
  $('#btnRollOpts').addEventListener('click', (e) => openRollOpts(e.currentTarget));
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#btnVariations').addEventListener('click', openVariations);
  $('#btnSurprise').addEventListener('click', surprise);
  $('#btnMutate').addEventListener('click', buildVariations);
  $('#btnExport').addEventListener('click', openExport);
  $('#btnHelp').addEventListener('click', () => $('#helpModal').classList.add('on'));
  $$('.modal-bg').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); }));

  addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, [contenteditable]') || e.metaKey || e.ctrlKey) return;
    if (S.exporting) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); transport.toggle(); renderTransport(); }
    else if (k === 'ArrowRight') stepLook(1);
    else if (k === 'ArrowLeft') stepLook(-1);
    else if (k === 'm' || k === 'M') varState.open ? buildVariations() : openVariations();
    else if (k === 'r' || k === 'R') surprise();
    else if (k === 'd') rollAll();
    else if (k === 'D') undoRoll();
    else if (k === 'e' || k === 'E') openExport();
    else if (k === 'h' || k === 'H') { S.hud = !S.hud; renderTransport(); save(); }
    else if (k === 's' || k === 'S') { S.safe = !S.safe; renderTransport(); save(); }
    else if (k === 'l' || k === 'L') { transport.setMode(transport.mode === 'loop' ? 'listen' : 'loop'); renderTransport(); save(); }
    else if (k === '?') $('#helpModal').classList.add('on');
    else if (k === 'Escape') { closeModals(); closePop(); $('#exportSheet').classList.remove('on'); }
    else if (k === '[' || k === ']') {
      const loops = S.features?.loops || [];
      if (!loops.length) return;
      const i = loops.findIndex((l) => Math.abs(l.start - S.loopStart) < 0.05);
      const l = loops[(i + (k === ']' ? 1 : -1) + loops.length) % loops.length];
      S.loopStart = l.start; S.customCuts = null; rebuild(); toast(`Loop: ${l.label}`);
    } else if ('1234'.includes(k)) {
      const b = BAR_CHOICES[+k - 1];
      if (validBars().includes(b)) { S.bars = b; S.customCuts = null; rebuild(); renderEdit(); }
    }
  });

  addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    document.body.classList.remove('dropping');
    uploadFiles([...e.dataTransfer.files]);
  });
}

function setTab(tab) {
  S.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.id === `pane-${tab}`));
  save();
}

// Roll everything
const ROLL_OPTS = [
  ['look', 'Look & layers', 'effects, settings, grade, camera'],
  ['edit', 'Edit', 'rhythm, transitions, direction, speed, intensity'],
  ['perClip', 'Per-clip FX', 'same / evolve / per-clip stacks'],
  ['clips', 'Clip order', 'shuffle the sequence'],
  ['loop', 'Song section', 'which part of the track loops'],
];
const rollStack = [];
let rollSeed = (Date.now() % 1e9) >>> 0;

function snapshot() {
  return JSON.stringify({ look: S.look, lookId: S.lookId, direction: S.direction, seed: S.seed, intensity: S.intensity, clipMode: S.clipMode,
    clipLooks: S.clipLooks, editClip: S.editClip, evolveAmt: S.evolveAmt, selected: S.selected, loopStart: S.loopStart, bars: S.bars,
    customCuts: S.customCuts, segOverrides: S.segOverrides });
}

function refreshAll() {
  engine.main.reset();
  rebuild();
  renderClips(); renderLooks(); renderLayers(); renderEdit(); renderTransport();
}

function rollAll() {
  if (!S.selected.length) { toast('Pick a few clips first'); return; }
  rollStack.push(snapshot());
  if (rollStack.length > 40) rollStack.shift();
  rollSeed = (Math.imul(rollSeed ^ (rollSeed >>> 13), 1103515245) + 12345) >>> 0;
  const seed = rollSeed % 1000000007;
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const o = S.rollOpts;
  const prev = S.look;
  const l = o.look ? chaosLook(seed) : cloneLook(prev);
  if (o.edit) {
    const ids = shuffle(Object.keys(TRANSITIONS).filter((k) => k !== 'cut'), r);
    const pool = ids.slice(0, 3 + Math.floor(r() * 4));
    if (r() < 0.3) pool.push('cut');
    l.cut = {
      rhythm: pick(['hits', 'hits', 'beat', 'half', 'half', 'bar', 'bar', 'bar2', 'sync', 'build', 'varied', 'even', 'twice', 'eighth']),
      transitions: pool, beats: pick([0.25, 0.5, 0.5, 1, 1, 2]), order: pick(['cycle', 'random', 'random']),
    };
    S.direction = pick(['forward', 'forward', 'forward', 'alternate', 'reverse', 'pingpong', 'random']);
    l.camera.p.speed = pick([0.6, 0.8, 1, 1, 1, 1.25, 1.5]);
    S.seed = Math.floor(r() * 1e6);
    S.intensity = pick([0.85, 1, 1, 1.1, 1.25, 1.4]);
  } else {
    l.cut = cloneLook(prev.cut);
    l.camera.p.speed = prev.camera.p.speed;
  }
  if (o.clips && S.selected.length > 1) {
    shuffle(S.selected, r);
  }
  if (o.loop && S.features?.loops?.length) {
    S.loopStart = pick(S.features.loops).start;
    const vb = validBars();
    if (vb.length) S.bars = pick(vb);
  }
  if (o.perClip) {
    S.clipMode = S.selected.length > 1 ? pick(['one', 'one', 'evolve', 'cycle', 'custom', 'custom']) : 'one';
    S.editClip = null;
    if (S.clipMode === 'custom') S.clipLooks = Object.fromEntries(S.selected.slice(1).map((id, i) => [id, chaosLook(seed + (i + 1) * 7919)]));
    if (S.clipMode === 'evolve') S.evolveAmt = pick([0.3, 0.45, 0.6, 0.8]);
  }
  S.look = l;
  S.lookId = l.id;
  S.customCuts = null;
  S.segOverrides = {};
  refreshAll();
  const mode = CLIP_MODES.find(([k]) => k === S.clipMode)[1].toLowerCase();
  toast(`🎲 ${l.name} · ${l.layers.length} layers · ${RHYTHMS[l.cut.rhythm]?.name || 'custom'} cuts${S.clipMode === 'one' ? '' : ` · ${mode}`}`, 3200);
}

function undoRoll() {
  const snap = rollStack.pop();
  if (!snap) { toast('Nothing to undo'); return; }
  Object.assign(S, JSON.parse(snap));
  refreshAll();
  toast(`↶ Back to ${S.look.name}`);
}

function openRollOpts(anchor) {
  openPop(anchor, (box) => {
    box.append(h('div', { class: 'ph' }, 'A roll changes'));
    for (const [k, label, sub] of ROLL_OPTS) {
      box.append(h('label', { class: 'pi chk' }, h('input', { type: 'checkbox', checked: !!S.rollOpts[k], onchange: (e) => { S.rollOpts[k] = e.target.checked; save(); } }),
        h('span', { class: 'chk-t' }, h('b', {}, label), h('small', {}, sub))));
    }
    box.append(h('button', { class: 'pi', disabled: !rollStack.length, onclick: () => { closePop(); undoRoll(); } }, '↶ Undo last roll', h('small', {}, 'Shift + D')));
  });
}

let surpriseSeed = Date.now() % 1e6;
function surprise() {
  const l = randomLook(++surpriseSeed);
  setLook(l);
  toast(`✦ ${l.name}`);
}

// Boot
async function init() {
  try {
    engine = new Engine($('#view'));
  } catch (e) {
    $('#emptyStage').hidden = false;
    $('#emptyStage').innerHTML = `<b>WebGL2 unavailable</b>${e.message}. Use a current Chrome, Edge, Safari or Firefox — or the <a href="/classic" style="color:var(--accent)">classic studio</a>.`;
    return;
  }
  const errs = engine.warmup();
  if (errs.length) console.error('Shader errors:', errs);
  bank = new VideoBank($('#videoBank'), (id) => `/api/proxy/${id}`, (k) => engine.dropVideo(k));
  const st = await fetchJSON('/api/state');
  S.clips = st.clips; S.tracks = st.tracks; S.renders = st.renders;
  const saved = restore();
  Object.assign(S, Object.fromEntries(Object.entries(saved).filter(([k]) => k in S && !['clips', 'tracks', 'renders', 'features'].includes(k))));
  S.selected = (S.selected || []).filter((id) => S.clips.some((c) => c.id === id));
  if (!S.selected.length) S.selected = [...S.clips].sort((a, b) => (b.is_stock ? 1 : 0) - (a.is_stock ? 1 : 0)).slice(0, 4).map((c) => c.id);
  if (S.trackId && !S.tracks.some((t) => t.id === S.trackId)) S.trackId = '';
  if (!('trackId' in saved) && S.tracks.length) S.trackId = S.tracks[0].id;
  if (!S.look || !Array.isArray(S.look.layers)) { S.look = cloneLook(LOOKS[0]); S.lookId = LOOKS[0].id; }
  if (saved.mode) transport.mode = saved.mode;
  transport.setMuted(!!S.muted);

  buildMeters();
  bindUI();
  bindTimeline();
  setTab(S.tab || 'looks');
  renderClips(); renderTrack(); renderExports(); renderLooks(); renderLayers(); renderEdit(); renderTransport();
  await selectTrack(S.trackId, { initial: true });
  requestAnimationFrame(tick);
  pollProxies();
  window.__studio = { S, engine, transport, get ctx() { return ctx; }, bank, rebuild, setLook };
}

init();
