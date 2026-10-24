import type {
  ClipMeta,
  TrackMeta,
  RenderRecord,
  TrackFeatures,
  Look,
  ExportOptions,
  RollOptions,
  Block,
  BlockPatch,
  SegmentOverride,
  ComposeContext,
  ComposedFrame,
  ClipPalette,
  Segment,
  ProjectRef,
  ProjectSummary,
} from '../engine/types.ts';
import type { Transport } from '../engine/audio.ts';
import type { SnapDiv } from '../engine/blocks.ts';
import type { ScreenId } from '../lib/screens.ts';

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
  /** Evolve gives every cut its own mutation, not every clip. */
  evolveCuts: boolean;
  /** The loop plays the edit forward to the middle and then backward. */
  rebound: boolean;
  /** Split the longest cuts until every clip in the edit gets at least one. */
  fitAll: boolean;
  rollOpts: RollOptions;
  /** The edit's own blocks once one has been cut, split or set by hand; null while it follows the rhythm. */
  blocks: Block[] | null;
  /** A session saved before blocks: its dragged cuts and per-segment settings, turned into blocks once the song is in. */
  legacyEdit: { customCuts: number[] | null; segOverrides: Record<string, SegmentOverride> } | null;
  /** The block the timeline's buttons and keys act on. */
  selectedBlock: string | null;
  /** Lines per beat a dragged cut snaps to, 0 for none. */
  snap: SnapDiv;
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
  /** The folders the server lists videos and songs from, the ones it suggests adding, and whether it can open a folder chooser. */
  folders: string[];
  folderSuggestions: string[];
  canPick: boolean;
  /** First run: no folder picked and nothing added, so the studio waits on Pick a folder. */
  welcome: boolean;
  exportFilter: { q: string; kind: string; sort: string };
  /** The saved project the edit autosaves to, or null while the edit is only in this browser. */
  project: ProjectRef | null;
  /** Every saved project, the most recently saved first. */
  projects: ProjectSummary[];
  projectsOpen: boolean;
  /** Whether the open project's file has the latest edit. A failed write is tried again on the next change. */
  projectSync: 'saved' | 'saving' | 'failed';
  mutAmt: number;
  varSeed: number;
  trackStateText: string;
  /** Why the GPU engine couldn't start, shown on the stage instead of a blank preview. */
  glError: string | null;

  engine: any;
  bank: any;
  transport: Transport;
  ctx: ComposeContext | null;
  version: number;
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
  /** Preview on another screen shape, which also picks an export format of that shape. */
  setScreen: (id: ScreenId) => void;
  selectTrack: (id: string, opts?: { initial?: boolean; keepLoop?: boolean }) => Promise<void>;
  setTempo: (v: number | null) => Promise<void>;
  nudgeGrid: (d: number | null) => void;
  tapTempo: () => void;
  toggleClip: (id: string) => void;
  reorderClips: (action: 'all' | 'stock' | 'solo' | 'reverse' | 'shuffle' | { from: number; to: number }) => void;
  uploadFiles: (files: File[]) => Promise<void>;
  autoFrame: () => Promise<void>;
  setClipMode: (k: string) => void;
  editClipLook: (id: string | null) => void;
  rollClips: () => void;
  rollAll: () => void;
  undoRoll: () => void;
  selectBlock: (id: string | null) => void;
  splitAtPlayhead: () => void;
  splitBlockAt: (id: string, beat?: number) => void;
  deleteBlock: (id?: string) => void;
  repeatSegment: (id?: string) => void;
  insertClip: (clipId: string, where?: { id?: string }) => void;
  trimCut: (id: string, beat: number, div: SnapDiv) => void;
  setBlock: (id: string, patch: BlockPatch) => void;
  clearBlock: (id: string) => void;
  setSnap: (div: SnapDiv) => void;
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
  canvasBars: () => number[];
  maxBars: () => number;
  loopLen: () => number;
  setBars: (bars: number) => void;
  wholeSong: () => void;
  clipLookOf: (id: string, seg?: Segment) => Look;
  editLook: () => Look;
  drawTimeline: () => void;
  drawOverview: () => void;
  drawLane: () => void;
}
