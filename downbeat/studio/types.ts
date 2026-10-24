// Downbeat Studio type definitions.

export type CategoryId = 'space' | 'warp' | 'time' | 'light' | 'stylize' | 'color';

export interface CategoryMeta {
  name: string;
  color: string;
}

export type ModSourceKind = 'audio' | 'clock' | 'user';

export interface ModSourceMeta {
  name: string;
  color: string;
  kind: ModSourceKind;
  short?: string;
}

export interface Modulation {
  src: string;
  amt: number;
}

export type ModValues = Record<string, number>;

export interface ParamDef {
  id: string;
  name: string;
  min: number;
  max: number;
  def: number;
  step: number;
  opts?: string[];
}

export interface ModuleDef {
  name: string;
  cat?: CategoryId;
  desc?: string;
  params: ParamDef[];
  glsl?: string;
  kind?: string;
  feedback?: boolean;
  aux?: string;
}

export interface LayerSpec {
  m: string;
  on?: boolean;
  p: Record<string, number>;
  mods?: Record<string, Modulation>;
}

export interface HolderSpec {
  p: Record<string, number>;
  mods?: Record<string, Modulation>;
}

export interface CutSpec {
  rhythm: string;
  transitions: string[];
  beats: number;
  order?: string;
  velocity?: string;
}

export interface Look {
  id: string;
  name: string;
  vibe: string;
  group?: string;
  mine?: boolean;
  layers: LayerSpec[];
  camera: HolderSpec;
  finish: HolderSpec;
  cut: CutSpec;
  env?: number[];
  seq?: number[];
  macro?: { a: number; b: number };
  lfos?: LfoSpec[];
}

export interface LfoSpec {
  shape: string;
  /** Bars per cycle; 0 means one cycle per loop. */
  rate: number;
  /** Start point in the cycle, 0..1. */
  phase: number;
  /** Picks the pattern for the random shapes. */
  seed?: number;
}

export interface ClipMeta {
  id: string;
  name?: string;
  path?: string;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  is_stock?: boolean;
  still?: boolean;
  proxy?: string;
  focus?: [number, number, number] | null;
}

export interface PaletteSwatch {
  hex: string;
  rgb: [number, number, number];
  role: string;
  hue: number;
  share: number;
}

export interface ClipPalette {
  colors: PaletteSwatch[];
  css_gradient: string;
  primary_hue: number;
}

export interface TrackMeta {
  id: string;
  name: string;
  path?: string;
  duration?: number;
  bpm?: number;
  /** "added" (copied into out/uploads), "downloads", or the music folder it was found in. */
  source?: string;
  /** Subfolder inside a music folder, "" at its top. */
  dir?: string;
  mtime?: number;
}

export interface LoopSuggestion {
  start: number;
  score: number;
  label?: string;
}

export interface TrackFeatures {
  id?: string;
  name?: string;
  duration?: number;
  fps?: number;
  bpm?: number;
  beats?: number[];
  downbeats?: number[];
  loop_bars?: number;
  loop_seconds?: number;
  loops?: LoopSuggestion[];
  curves?: Record<string, number[]>;
  peaks?: number[];
  bpm_source?: string;
}

export interface RenderCheck {
  name: string;
  desc?: string;
  pass: boolean;
  level?: 'pass' | 'warn' | 'fail' | string;
  detail?: string;
}

export interface RenderRecord {
  filename: string;
  url: string;
  cover_url?: string | null;
  audio_url?: string | null;
  promo_url?: string | null;
  format?: string;
  size_mb?: number;
  created_at?: number;
  resolution?: string;
  duration?: number;
  bpm?: number;
  preset?: string;
  look?: string;
  checks?: RenderCheck[];
  engine?: string;
  stats?: Record<string, unknown>;
  codec?: string;
  seconds?: number;
}

export interface ExportOptions {
  format?: 'spotify' | 'apple_tall' | 'apple_square' | string;
  size?: 'master' | 'lite' | 'strict' | string;
  audio?: boolean;
  promo?: number;
  autoSave?: boolean;
}

export interface RollOptions {
  look?: boolean;
  edit?: boolean;
  perClip?: boolean;
  clips?: boolean;
  loop?: boolean;
}

export interface SegmentOverride {
  clipId?: string;
  trans?: string;
  vel?: string;
  in?: number;
}

export interface Segment {
  i: number;
  t0: number;
  t1: number;
  clipId: string;
  dur: number;
  speed: number;
  vel: string;
  bd: number;
  focus?: [number, number, number] | null;
  rev: boolean;
  pp: boolean;
  in: number;
  trans: string;
  seed: number;
}

export interface TimelinePlan {
  L: number;
  beatDur: number;
  segs: Segment[];
  transDur: number;
}

export interface TimelineSamplePart {
  seg: Segment;
  local: number;
  key: string;
}

export interface TimelineSample {
  a: TimelineSamplePart;
  b: TimelineSamplePart | null;
  p: number;
  trans: string | null;
}

export interface CameraTransform {
  center: [number, number];
  zoom: number;
  rot: number;
  shake: [number, number];
  flip: boolean;
}

export interface VideoNeed {
  vkey: string;
  clipId: string;
  time: number;
  rate: number;
  rev: boolean;
  cam: CameraTransform;
  aux?: string;
}

export interface ComposedLayer {
  m: string;
  key: string;
  params: Record<string, number>;
}

export interface ComposedFrame {
  needs: VideoNeed[];
  broll?: VideoNeed;
  trans: { name: string; p: number } | null;
  seg: TimelineSample;
  layers: ComposedLayer[];
  pre: ComposedLayer[][] | null;
  finish: Record<string, number>;
  camera: Record<string, number>;
  mv: ModValues;
  globals: Record<string, number>;
  sources?: any[];
}

export interface ComposeContext {
  look: Look;
  tl: TimelinePlan;
  sampler: (t: number) => ModValues;
  clipDur: (id: string) => number;
  L: number;
  beatDur: number;
  seed: number;
  intensity?: number;
  clipLook?: ((clipId: string) => Look | null | undefined) | null;
  clips?: ClipMeta[];
}

export interface TransitionDef {
  name: string;
  glsl: string;
}

export interface VelocityDef {
  name: string;
  per: number;
  desc?: string;
  v: (x: number) => number;
  f: (x: number) => number;
}

export interface RhythmDef {
  name: string;
  short: string;
  beats: number | null;
}

export interface TimelinePlanOptions {
  L: number;
  beatDur: number;
  clips: ClipMeta[];
  transitions: string[];
  transBeats: number;
  seed: number;
  speed?: number;
  direction?: string;
  order?: string;
  velocity?: string;
  rhythm?: string;
  custom?: number[] | null;
  hitCurve?: number[] | null;
  nClips?: number;
}

export interface RenderTarget {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  w: number;
  h: number;
  mips: boolean;
}

export interface ProgramInfo {
  prog: WebGLProgram;
  loc: (name: string) => WebGLUniformLocation | null;
}

export interface SamplerOptions {
  features?: TrackFeatures | null;
  loopStart: number;
  beatDur: number;
  seed: number;
  L?: number;
}

export interface ExportProgress {
  frame: number;
  total: number;
  speed: number;
}

export interface ExportLoopOptions {
  engine: any;
  bank: any;
  ctx: ComposeContext;
  width: number;
  height: number;
  fps?: number;
  bitrate?: number;
  meta: Record<string, any>;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}
