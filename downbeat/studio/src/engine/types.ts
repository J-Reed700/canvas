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
  /** Changes the timeline (clip speed), so editing it rebuilds the edit. */
  retime?: boolean;
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
  /** "added" (copied into out/uploads), or the folder it was found in. */
  source?: string;
  /** Subfolder inside that folder, "" at its top. */
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

/** One spec check from delivery.verify(). */
export interface RenderCheck {
  id: string;
  label: string;
  level: 'ok' | 'warn' | 'fail';
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
  /** Plays this segment forward, reversed or ping-pong, whatever the edit's direction. */
  dir?: 'forward' | 'reverse' | 'pingpong';
  /** Frames this segment its own way, in place of its clip's framing and the look's drift. */
  frame?: SegmentFrame;
}

/** Where a segment's crop sits, as [x, y, zoom]: x and y are the crop centre from 0 to 1 across the clip
 * (y up), zoom runs 1 to 3 on top of the look's camera zoom. */
export type FramePoint = [number, number, number];

export interface SegmentFrame {
  /** The framing at the start of the segment. */
  a: FramePoint;
  /** The framing it moves to by the end. Without it the framing holds still. */
  b?: FramePoint;
  /** How the move gets from a to b: eased, at a steady speed, or a step on each beat. */
  ease?: 'smooth' | 'linear' | 'beats';
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
  frame?: SegmentFrame;
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
  /** The look layer this came from, so the inspector can show its live values. */
  src: LayerSpec;
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
