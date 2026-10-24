import { create } from 'zustand';
import { Engine } from '../engine/engine.ts';
import { Transport, makeSampler } from '../engine/audio.ts';
import { planTimeline, resolve } from '../engine/timeline.ts';
import { fromLegacy } from '../engine/blocks.ts';
import { LOOKS, clamp, cloneLook } from '../engine/looks.ts';
import { VideoBank } from '../engine/composer.ts';
import type {
  ClipMeta,
  TrackMeta,
  RenderRecord,
  TrackFeatures,
  Look,
  ComposeContext,
  TimelinePlanOptions,
  Segment,
} from '../engine/types.ts';
import {
  fetchJSON,
  BAR_CHOICES,
  MAX_LOOP_SECONDS,
  toast,
  FORMATS,
} from '../lib/utils.ts';
import { SCREENS, formatFor } from '../lib/screens.ts';
import { drawOverview, drawLane, drawTimeline } from '../canvas/timelineCanvas.ts';
import { startRenderLoop, pollProxies } from '../canvas/renderLoop.ts';
import {
  openExport,
  runExport,
  runBatch,
  reveal,
  exportCompanion,
} from './exportController.ts';
import { surprise, rollClips, rollAll, undoRoll } from './rollController.ts';
import { save, restore, snapshot, applySnapshot, undo, redo, resetHistory, saveLook, rememberLook, editFields, sanitizeLutLooks } from './historyController.ts';
import { startingEdit, syncProject } from './projectController.ts';
import { uploadFiles, autoFrame, reorderClips, toggleClip, fetchPalette, requestProxies } from './mediaActions.ts';
import { selectBlock, splitAtPlayhead, splitBlockAt, deleteBlock, repeatSegment, insertClip, trimCut, setBlock, clearBlock, setSnap } from './blockActions.ts';
import type { StudioState } from './storeTypes.ts';
import { ClipLookResolver, editingLook } from './clipLooks.ts';
import { clipIndex } from './mediaIndex.ts';

export type { LookJob, GhostItem, StudioState } from './storeTypes.ts';

const transportInstance = new Transport();
const clipDurMap = new Map<string, number>();
// These callbacks must be created outside rebuild(). Closures created in that activation can
// share its captured `s` with other callbacks, retaining every previous state/context and sampler.
const liveClipDuration = (id: string): number => clipDurMap.get(id) || 10;
const liveClipLook = (id: string, seg?: Segment): Look => useStudioStore.getState().clipLookOf(id, seg);
let tapTimes: number[] = [];
let tapTimer: ReturnType<typeof setTimeout> | undefined;
let trackTokenVal = 0;
const clipLooks = new ClipLookResolver();
let lastVbBd = -1;
let lastVb: number[] = BAR_CHOICES;

export const useStudioStore = create<StudioState>((set, get) => ({
  clips: [],
  tracks: [],
  renders: [],
  palettes: {},
  trackId: '',
  features: null,
  selected: [],
  look: null,
  lookId: null,
  saved: [],
  bars: 4,
  loopStart: 0,
  bpmManual: 128,
  bpmOverride: {},
  seed: 2026,
  direction: 'forward',
  lockEdit: false,
  intensity: 1,
  clipMode: 'one',
  clipLooks: {},
  editClip: null,
  evolveAmt: 0.45,
  evolveCuts: false,
  rebound: false,
  fitAll: true,
  rollOpts: { look: true, edit: true, perClip: true, clips: false, loop: false },
  blocks: null,
  legacyEdit: null,
  selectedBlock: null,
  snap: 1,
  clipFrame: {},
  gridNudge: {},
  hud: false,
  safe: false,
  muted: false,
  tab: 'looks',
  exporting: false,
  exportOpts: { size: 'master', withSong: false, format: 'spotify', promo: 0, autoSave: true },
  varOpen: false,
  helpOpen: false,
  exportOpen: false,
  libraryOpen: false,
  libraryItem: null,
  clipsOpen: false,
  clipsItem: null,
  clipFilter: { q: '', kind: 'all', sort: 'folder' },
  folders: [],
  folderSuggestions: [],
  canPick: false,
  welcome: false,
  exportFilter: { q: '', kind: 'all', sort: 'new' },
  project: null,
  projects: [],
  projectsOpen: false,
  projectSync: 'saved',
  mutAmt: 0.45,
  varSeed: 1,
  trackStateText: '',
  glError: null,

  engine: null,
  bank: null,
  transport: transportInstance,
  ctx: null,
  version: 0,
  clipDur: clipDurMap,
  lookJobs: [],
  varJobs: [],
  ghosts: [],
  modUI: null,

  bpm: () => {
    const s = get();
    return s.features?.bpm || s.bpmManual;
  },
  audioStart: () => {
    const s = get();
    return s.loopStart + (s.gridNudge[s.trackId] || 0);
  },
  beatDur: () => 60 / get().bpm(),
  barDur: () => get().beatDur() * 4,
  // Lengths that fit Spotify's 3-8 s Canvas window. Longer loops are fine for visualizers.
  canvasBars: () => {
    const bd = get().barDur();
    if (bd !== lastVbBd) {
      lastVbBd = bd;
      lastVb = BAR_CHOICES.filter((b) => b * bd >= 3 - 1e-6 && b * bd <= 8 + 1e-6);
    }
    return lastVb;
  },
  // The longest loop: the song from its first downbeat, or MAX_LOOP_SECONDS without a song.
  maxBars: () => {
    const s = get();
    const f = s.features;
    const room = f?.duration ? f.duration - (f.downbeats?.[0] ?? 0) : MAX_LOOP_SECONDS;
    return Math.max(1, Math.floor(room / s.barDur() + 1e-6));
  },
  loopLen: () => {
    const s = get();
    return clamp(Math.round(s.bars) || 1, 1, s.maxBars()) * s.barDur();
  },
  setBars: (b: number) => {
    set({ bars: clamp(Math.round(b) || 1, 1, get().maxBars()), blocks: null });
    get().rebuild();
  },
  wholeSong: () => {
    set({ loopStart: get().features?.downbeats?.[0] ?? 0 });
    get().setBars(get().maxBars());
  },

  clipLookOf: (id, seg) => clipLooks.resolve(get(), id, seg),
  editLook: () => editingLook(get()),

  save: () => save(),
  restore: () => restore(),
  touch: () => {
    set((state) => ({ version: state.version + 1 }));
  },

  rebuild: () => {
    const s = get();
    s.touch();
    const L = s.loopLen();
    const bd = s.beatDur();
    // The song can't loop past its end, so a long loop starts at the last downbeat that leaves room.
    const f = s.features;
    if (f?.duration && s.loopStart + L > f.duration + 1e-3) {
      const fits = (f.downbeats || []).filter((d) => d + L <= f.duration! + 1e-3);
      set({ loopStart: fits.length ? fits[fits.length - 1] : (f.downbeats?.[0] ?? 0) });
    }
    const index = clipIndex(s.clips);
    const clips = s.selected
      .map((id) => index.get(id))
      .filter((c): c is ClipMeta => c !== undefined)
      .map((c) => ({
        id: c.id,
        duration: Math.max(0.5, Math.min(c.duration, 60)),
        focus: s.clipFrame[c.id] || null,
      }));
    s.clipDur.clear();
    clips.forEach((c) => s.clipDur.set(c.id, c.duration));

    if (!clips.length || !s.look) {
      set({ ctx: null });
      return;
    }

    let hit: number[] | null = null;
    if (s.features && s.features.curves) {
      const k = s.features.curves.kick || [];
      const sn = s.features.curves.snare || [];
      const a = Math.round(s.audioStart() * 30);
      hit = Array.from({ length: Math.round(L * 30) + 3 }, (_, i) => (k[a + i] || 0) + 0.6 * (sn[a + i] || 0));
    }

    const cut = s.look.cut;
    const opts: TimelinePlanOptions = {
      // a Rebound loop's edit is its first half, played forward and then backward
      L: s.rebound ? L / 2 : L,
      rebound: s.rebound,
      fitAll: s.fitAll,
      beatDur: bd,
      clips,
      rhythm: cut.rhythm,
      transitions: cut.transitions,
      transBeats: cut.beats,
      seed: s.seed,
      speed: s.look.camera.p.speed ?? 1,
      direction: s.direction,
      order: cut.order,
      hitCurve: hit,
      velocity: cut.velocity || 'none',
    };
    // An older session's cut lines are in seconds, so they wait for the song's tempo.
    if (s.legacyEdit && (s.features || !s.trackId)) {
      set({ blocks: fromLegacy(opts, s.legacyEdit.customCuts, s.legacyEdit.segOverrides), legacyEdit: null });
    }
    const blocks = get().blocks;
    const tl = blocks ? resolve(blocks, opts) : planTimeline(opts);
    if (s.selectedBlock && !tl.segs.some((x) => x.id === s.selectedBlock)) set({ selectedBlock: null });

    const ctx: ComposeContext = {
      look: s.look,
      tl,
      L,
      beatDur: bd,
      seed: s.seed,
      clipDur: liveClipDuration,
      intensity: s.intensity,
      clipLook: s.clipMode === 'one' ? null : liveClipLook,
      sampler: makeSampler({
        features: s.features,
        loopStart: s.audioStart(),
        beatDur: bd,
        seed: s.seed,
        L,
      }),
      clips: s.clips,
    };

    s.transport.setLoop(Math.max(0, s.audioStart()), L);
    // TimelinePanel redraws when ctx changes.
    set({ ctx });
    s.save();
  },

  setLook: (l: Look, { keepEdit = false }: { keepEdit?: boolean } = {}) => {
    const s = get();
    const prevCut = s.look?.cut;
    rememberLook(l);
    const nextLook = cloneLook(l);
    if ((s.lockEdit || keepEdit) && prevCut) {
      nextLook.cut = prevCut;
    } else {
      set({ blocks: null });
    }
    set({ look: nextLook, lookId: l.id });
    if (s.engine?.main) s.engine.main.reset();
    s.touch();
    s.rebuild();
  },

  applyLook: (l: Look) => {
    const s = get();
    if (!s.look) return;
    if (s.editLook() !== s.look && s.editClip) {
      const no = s.selected.indexOf(s.editClip) + 1;
      rememberLook(l);
      const nextClipLooks = { ...s.clipLooks, [s.editClip]: cloneLook(l) };
      set({ clipLooks: nextClipLooks });
      s.touch();
      s.rebuild();
      s.save();
      toast(`Clip ${no} → ${l.name}`);
      return;
    }
    s.setLook(l);
    toast(l.name);
  },

  stepLook: (d: number) => {
    const s = get();
    const all = [...s.saved, ...LOOKS];
    const id = s.lookId?.replace(/^edit:/, '');
    const i = all.findIndex((l) => l.id === id);
    const l = all[(i + d + all.length) % all.length];
    s.setLook(l);
    toast(l.name);
  },

  surprise: () => surprise(),
  setTab: (tab: 'looks' | 'layers' | 'edit') => {
    set({ tab });
    get().save();
  },
  setScreen: (id) => {
    const screen = SCREENS.find((x) => x.id === id) || SCREENS[0];
    const o = get().exportOpts;
    const format = formatFor(screen, o.format);
    set({ exportOpts: { ...o, format } });
    get().save();
    toast(`${screen.name} · exports as ${FORMATS[format].short}`);
  },

  selectTrack: async (id: string, { initial = false, keepLoop = false }: { initial?: boolean; keepLoop?: boolean } = {}) => {
    const token = ++trackTokenVal;
    set({ trackId: id || '', trackStateText: id ? 'Analyzing…' : '' });
    const s = get();

    if (!id) {
      s.transport.unload();
      set({ features: null, loopStart: 0, trackStateText: '' });
      s.rebuild();
      return;
    }

    try {
      const ov = s.bpmOverride[id];
      // The song plays as soon as it's decoded. The analysis can take much longer, for instance while
      // playback copies of big clips are being made, and the loop moves to its suggestion when it's in.
      const audio = (
        s.transport.buffer && s.transport.trackId === id ? Promise.resolve(s.transport.buffer) : s.transport.decode(`/api/track_audio/${id}`)
      ).then((buf) => {
        if (token === trackTokenVal) {
          s.transport.setBuffer(buf);
          s.transport.trackId = id;
        }
      });
      const [feats] = await Promise.all([fetchJSON<TrackFeatures>(`/api/features/${id}${ov ? `?bpm=${ov}` : ''}`), audio]);

      if (token !== trackTokenVal) return;

      const savedOk = (initial || keepLoop) && s.loopStart >= 0 && s.loopStart < (feats.duration || 60) - 3;
      let nextLoopStart = s.loopStart;
      let nextBars = s.bars;

      if (keepLoop) {
        nextBars = feats.loop_bars || s.bars;
        // blocks are placed in beats, so they keep their places at a new tempo, but not in a new loop length
        if (nextBars !== s.bars) set({ blocks: null });
      }
      if (savedOk && keepLoop && feats.downbeats?.length) {
        nextLoopStart = feats.downbeats.reduce(
          (a, d) => (Math.abs(d - s.loopStart) < Math.abs(a - s.loopStart) ? d : a),
          feats.downbeats[0],
        );
      }
      if (!savedOk) {
        nextLoopStart = feats.loops?.[0]?.start ?? 0;
        nextBars = feats.loop_bars || 4;
        set({ blocks: null, legacyEdit: null });
      }

      set({ features: feats, loopStart: nextLoopStart, bars: nextBars, trackStateText: '' });
    } catch (e) {
      if (token !== trackTokenVal) return;
      console.error(e);
      set({ trackStateText: 'Analysis failed', features: null });
    }

    get().rebuild();
  },

  setTempo: async (v: number | null) => {
    const s = get();
    if (!s.trackId) return;
    const nextOverrides = { ...s.bpmOverride };
    if (v === null) {
      delete nextOverrides[s.trackId];
    } else if (Number.isFinite(v) && v >= 40 && v <= 220) {
      nextOverrides[s.trackId] = +v.toFixed(2);
    } else {
      toast('The tempo can be 40 to 220 BPM');
      return;
    }
    set({ bpmOverride: nextOverrides });
    await s.selectTrack(s.trackId, { keepLoop: true });
    toast(`Tempo ${s.bpm().toFixed(s.bpm() % 1 ? 2 : 0)} BPM, beat grid updated`);
  },

  nudgeGrid: (d: number | null) => {
    const s = get();
    if (!s.trackId) return;
    const nextNudge = { ...s.gridNudge };
    if (d === null) {
      delete nextNudge[s.trackId];
    } else {
      nextNudge[s.trackId] = clamp(Math.round(((nextNudge[s.trackId] || 0) + d) * 1000) / 1000, -0.25, 0.25);
    }
    set({ gridNudge: nextNudge });
    s.rebuild();
  },

  tapTempo: () => {
    const now = performance.now() / 1000;
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2) tapTimes = [];
    tapTimes.push(now);
    if (tapTimes.length > 12) tapTimes.shift();
    if (tapTimes.length < 4) {
      toast(`Tap ${4 - tapTimes.length} more…`, 1200);
      return;
    }
    const span = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
    const v = Math.round((60 / span) * 10) / 10;
    const s = get();
    if (!s.trackId) {
      const nextBpm = clamp(Math.round(v), 60, 180);
      set({ bpmManual: nextBpm });
      s.rebuild();
      toast(`${nextBpm} BPM`, 1200);
      return;
    }
    clearTimeout(tapTimer);
    toast(`${v.toFixed(1)} BPM: keep tapping or wait to apply`, 1400);
    tapTimer = setTimeout(() => {
      s.setTempo(v);
      tapTimes = [];
    }, 1600);
  },

  toggleClip: (id: string) => toggleClip(id),
  reorderClips: (action) => reorderClips(action),
  uploadFiles: (files: File[]) => uploadFiles(files),
  autoFrame: () => autoFrame(),

  setClipMode: (k: string) => {
    const s = get();
    let nextClipLooks = { ...s.clipLooks };
    if (k === 'custom' && s.clipMode !== 'custom' && s.clipMode !== 'one') {
      nextClipLooks = Object.fromEntries(
        s.selected
          .map((id) => [id, s.clipLookOf(id)] as [string, Look])
          .filter(([, l]) => l !== s.look)
          .map(([id, l]) => [id, cloneLook(l)]),
      );
    }
    set({ clipMode: k, editClip: k === 'custom' ? s.editClip : null, clipLooks: nextClipLooks });
    if (s.engine?.main) s.engine.main.reset();
    s.rebuild();
  },

  editClipLook: (id: string | null) => {
    const s = get();
    if (id && s.clipMode !== 'custom') s.setClipMode('custom');
    const nextClipLooks = { ...s.clipLooks };
    if (id && !nextClipLooks[id] && s.look) {
      nextClipLooks[id] = cloneLook(s.look);
    }
    set({ editClip: id, clipLooks: nextClipLooks, tab: 'layers' });
    s.touch();
    s.save();
  },

  rollClips: () => rollClips(),
  rollAll: () => rollAll(),
  undoRoll: () => undoRoll(),
  selectBlock: (id) => selectBlock(id),
  splitAtPlayhead: () => splitAtPlayhead(),
  splitBlockAt: (id, beat) => splitBlockAt(id, beat),
  deleteBlock: (id) => deleteBlock(id),
  repeatSegment: (id) => repeatSegment(id),
  insertClip: (clipId, where) => insertClip(clipId, where),
  trimCut: (id, beat, div) => trimCut(id, beat, div),
  setBlock: (id, patch) => setBlock(id, patch),
  clearBlock: (id) => clearBlock(id),
  setSnap: (div) => setSnap(div),
  snapshot: () => snapshot(),
  applySnapshot: (snap: string) => applySnapshot(snap),
  undo: () => undo(),
  redo: () => redo(),
  fetchPalette: (clipId: string) => fetchPalette(clipId),

  exportCompanion: (opts) => exportCompanion(opts),
  openExport: () => openExport(),
  runExport: () => runExport(),
  runBatch: (kind) => runBatch(kind),
  reveal: (filename) => reveal(filename),

  saveLook: (name) => saveLook(name),

  drawTimeline: () => {
    drawTimeline(get(), () => get().drawLane());
  },

  drawOverview: () => {
    drawOverview(get());
  },

  drawLane: () => {
    drawLane(get(), () => get().drawLane());
  },

  initStudio: async (viewCanvas: HTMLCanvasElement, bankContainer: HTMLElement, ambientCanvas?: HTMLCanvasElement) => {
    let engineObj: Engine;
    try {
      engineObj = new Engine(viewCanvas);
    } catch (e) {
      console.error(e);
      set({ glError: e instanceof Error ? e.message : String(e) });
      return;
    }
    engineObj.warmup();

    const bankObj = new VideoBank(
      bankContainer,
      (id: string) => {
        const c = clipIndex(get().clips).get(id);
        return !c?.proxy || c.proxy === 'ready' ? `/api/proxy/${id}` : null;
      },
      (k: string) => engineObj.dropVideo(k),
    );

    set({ engine: engineObj, bank: bankObj });

    type ServerState = { clips: ClipMeta[]; tracks: TrackMeta[]; renders: RenderRecord[]; folders?: string[]; can_pick?: boolean };
    const st = await fetchJSON<ServerState>('/api/state').catch((): ServerState => ({ clips: [], tracks: [], renders: [] }));
    // The session, or the open project's file when another tab or browser saved it since this one did.
    const saved = await startingEdit(get().restore());

    set({
      clips: st.clips,
      tracks: st.tracks,
      renders: st.renders,
      folders: st.folders || [],
      canPick: !!st.can_pick,
      welcome: !!st.folders && !st.folders.length && !st.clips.length,
      ...editFields(saved, st.clips, st.tracks),
      saved: Array.isArray(saved.saved) ? sanitizeLutLooks(saved.saved) : [],
      rollOpts: saved.rollOpts || { look: true, edit: true, perClip: true, clips: false, loop: false },
      snap: [0, 1, 2, 4].includes(saved.snap) ? saved.snap : 1,
      hud: saved.hud ?? false,
      safe: saved.safe ?? false,
      muted: saved.muted ?? false,
      tab: saved.tab || 'looks',
    });

    if (saved.mode) transportInstance.mode = saved.mode;
    transportInstance.setMuted(!!saved.muted);

    await get().selectTrack(get().trackId, { initial: typeof saved.loopStart === 'number' });
    // Undo goes back as far as the session the studio opened with.
    resetHistory();
    // an edit made after the last write reached the project's file goes there now
    void syncProject();

    startRenderLoop(viewCanvas, ambientCanvas);
    // Clips put in the edit get their playback copies made, however they got there.
    requestProxies();
    useStudioStore.subscribe((s, prev) => {
      if (s.selected !== prev.selected || s.clips !== prev.clips) requestProxies();
    });
    pollProxies();
  },
}));

// Looks are edited in place because the render loop reads them every frame, so React can't see
// those edits by reference. Every in-place edit ends with touch(), which bumps `version`; any panel
// that renders look data (layers, params, modulators, cut settings) subscribes to it.
export const useVersion = () => useStudioStore((s) => s.version);

// Debug handle for the browser console and headless QA scripts.
if (typeof window !== 'undefined') {
  (window as any).__studio = {
    store: useStudioStore,
    get engine() {
      return useStudioStore.getState().engine;
    },
    get transport() {
      return useStudioStore.getState().transport;
    },
    get ctx() {
      return useStudioStore.getState().ctx;
    },
    get bank() {
      return useStudioStore.getState().bank;
    },
    rebuild: () => useStudioStore.getState().rebuild(),
    setLook: (l: Look) => useStudioStore.getState().setLook(l),
  };
}
