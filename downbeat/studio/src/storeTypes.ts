import type {
  ClipMeta,
  TrackMeta,
  RenderRecord,
  TrackFeatures,
  Look,
  ExportOptions,
  RollOptions,
  SegmentOverride,
  ComposeContext,
  ComposedFrame,
  ClipPalette,
} from '../types.ts';
import type { Transport } from '../audio.ts';

export interface LookJob {
  id: string;
  look: Look;
  card?: HTMLElement | null;
  ctx2d?: CanvasRenderingContext2D | null;
  visible: boolean;
}

export interface GhostItem {
  el: HTMLElement;
  def: any;
  read: (fr: ComposedFrame) => number | undefined;
}

export interface StudioState {
  clips: ClipMeta[];
  tracks: TrackMeta[];
  renders: RenderRecord[];
  palettes: Record<string, ClipPalette>;
  trackId: string;
  features: TrackFeatures | null;
  selected: string[];
  look: Look | null;
  lookId: string | null;
  saved: Look[];
  bars: number;
  loopStart: number;
  bpmManual: number;
  bpmOverride: Record<string, number>;
  seed: number;
  direction: string;
  lockEdit: boolean;
  intensity: number;
  clipMode: string;
  clipLooks: Record<string, Look>;
  editClip: string | null;
  evolveAmt: number;
  rollOpts: RollOptions;
  customCuts: number[] | null;
  segOverrides: Record<string | number, SegmentOverride>;
  clipFrame: Record<string, [number, number, number]>;
  gridNudge: Record<string, number>;
  hud: boolean;
  safe: boolean;
  muted: boolean;
  tab: 'looks' | 'layers' | 'edit';
  exporting: boolean;
  exportOpts: ExportOptions;
  varOpen: boolean;
  helpOpen: boolean;
  exportOpen: boolean;
  /** Exports browser: open flag, the export shown in its viewer, and the search shared with the side panel. */
  libraryOpen: boolean;
  libraryItem: string | null;
  exportFilter: { q: string; kind: string; sort: string };
  mutAmt: number;
  varSeed: number;
  fpsText: string;
  timeText: string;
  bbtText: string;
  stageWaiting: boolean;
  trackStateText: string;

  engine: any;
  bank: any;
  transport: Transport;
  ctx: ComposeContext | null;
  version: number;
  lastFrame: ComposedFrame | null;
  clipDur: Map<string, number>;
  lookJobs: LookJob[];
  varJobs: LookJob[];
  ghosts: GhostItem[];
  modUI: any;

  initStudio: (viewCanvas: HTMLCanvasElement, bankContainer: HTMLElement, ambientCanvas?: HTMLCanvasElement) => Promise<void>;
  save: () => void;
  restore: () => any;
  touch: () => void;
  rebuild: () => void;
  setLook: (l: Look, opts?: { keepEdit?: boolean }) => void;
  applyLook: (l: Look) => void;
  stepLook: (d: number) => void;
  surprise: () => void;
  setTab: (tab: 'looks' | 'layers' | 'edit') => void;
  selectTrack: (id: string, opts?: { initial?: boolean; keepLoop?: boolean }) => Promise<void>;
  setTempo: (v: number | null) => Promise<void>;
  nudgeGrid: (d: number | null) => void;
  tapTempo: () => void;
  toggleClip: (id: string) => void;
  reorderClips: (action: 'all' | 'solo' | 'reverse' | 'shuffle' | { from: number; to: number }) => void;
  uploadFiles: (files: File[]) => Promise<void>;
  autoFrame: () => Promise<void>;
  setClipMode: (k: string) => void;
  editClipLook: (id: string | null) => void;
  rollClips: () => void;
  rollAll: () => void;
  undoRoll: () => void;
  undo: () => void;
  redo: () => void;
  snapshot: () => string;
  applySnapshot: (snap: string) => void;
  fetchPalette: (clipId: string) => Promise<void>;
  exportCompanion: (opts: { filename?: string; clip_id?: string; kind: string; at_sec?: number }) => Promise<any>;
  openExport: () => void;
  runExport: () => Promise<void>;
  runBatch: (kind: 'rolls' | 'tracks') => Promise<void>;
  reveal: (filename: string) => Promise<void>;
  saveLook: (name?: string) => void;
  bpm: () => number;
  audioStart: () => number;
  beatDur: () => number;
  barDur: () => number;
  validBars: () => number[];
  loopLen: () => number;
  clipLookOf: (id: string) => Look;
  editLook: () => Look;
  drawTimeline: () => void;
  drawOverview: () => void;
  drawLane: () => void;
}
