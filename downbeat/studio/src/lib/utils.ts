import { TRANSITIONS } from '../engine/shaders.ts';
import { defaultEnv, SEQ_STEPS, ENV_POINTS } from '../engine/audio.ts';
import type { RollOptions, TrackMeta } from '../engine/types.ts';

export const h = (tag: string, attrs: Record<string, any> = {}, ...kids: any[]): HTMLElement => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, String(v));
  }
  for (const k of kids.flat()) {
    if (k != null && k !== false) {
      e.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
  }
  return e;
};

export const fetchJSON = async <T = any>(u: string, o?: RequestInit): Promise<T> => {
  const r = await fetch(u, o);
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return r.json();
};

/** POSTs JSON and returns the reply, error replies included, so their message can be shown.
 * A network failure comes back as `{ ok: false, error }`. */
export const postJSON = <T = { ok?: boolean; error?: string; [k: string]: any }>(u: string, body: unknown): Promise<T> =>
  fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch((e) => ({ ok: false, error: String(e) }) as T);

export const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// Loop lengths: seconds under a minute, m:ss above.
export const fmtLength = (s: number): string => (s < 60 ? `${s.toFixed(2)}s` : fmt(s));
// "2:30", "150", "150s" or "2.5m" -> seconds
export const parseLength = (v: string): number => {
  const t = v.trim().toLowerCase();
  const ms = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)\s*s?$/);
  if (ms) return (ms[1] ? +ms[1] * 60 : 0) + +ms[2];
  const m = t.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/);
  return m ? +m[1] * 60 : NaN;
};

export const shuffle = <T>(arr: T[], rand: () => number = Math.random): T[] => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

export const METERS = ['kick', 'snare', 'hats', 'bass', 'energy', 'bright'] as const;
export const BAR_CHOICES = [1, 2, 4, 8];
// Without a song to set the limit, a loop can run up to 10 minutes.
export const MAX_LOOP_SECONDS = 600;
export const TRANS_BEATS: [number, string][] = [[0, 'Cut'], [0.25, '¼'], [0.5, '½'], [1, '1'], [2, '2']];
export const CLIP_MODES: [string, string][] = [
  ['one', 'Same look'],
  ['evolve', 'Evolve'],
  ['cycle', 'Look per clip'],
  ['custom', 'Custom'],
];

export const POOLS: Record<string, string[]> = {
  All: Object.keys(TRANSITIONS).filter((k) => k !== 'cut'),
  Smooth: ['dissolve', 'luma', 'morph', 'flare', 'iris'],
  Kinetic: ['whip', 'whipX', 'zoom', 'swirl', 'kaleido'],
  Glitch: ['glitch', 'mosh', 'pixel', 'prism', 'slices'],
  'Hard cuts': ['cut'],
};

export const ROLL_OPTS: [keyof RollOptions, string, string][] = [
  ['look', 'Look & layers', 'effects, settings, grade, camera'],
  ['edit', 'Edit', 'rhythm, transitions, direction, speed, intensity, Rebound, and tempo without a song'],
  ['perClip', 'Per-clip FX', 'same / evolve / per-clip stacks'],
  ['clips', 'Clip order', 'shuffle the sequence'],
  ['loop', 'Song section', 'which part of the track loops'],
];

export const FORMATS: Record<string, { name: string; short: string; sub: string; size?: [number, number] }> = {
  spotify: { name: 'Spotify Canvas', short: 'Spotify 9:16', sub: '9:16 · 3–8 s · silent' },
  apple_tall: { name: 'Apple Music · 3:4', short: 'Apple 3:4', sub: 'Motion artwork 2048 × 2732', size: [2048, 2732] },
  apple_square: { name: 'Apple Music · 1:1', short: 'Apple 1:1', sub: 'Square motion art · rendered at 2048, delivered at 3840 × 3840', size: [2048, 2048] },
  youtube_16_9: { name: 'YouTube Visualizer · 16:9', short: 'YouTube 16:9', sub: '1920 × 1080 landscape visualizer with song audio', size: [1920, 1080] },
  social_square: { name: 'Social Feed · 1:1', short: 'Social 1:1', sub: '1080 × 1080 square loop + optional song promo', size: [1080, 1080] },
  cover_art: { name: 'Album Cover Art · 1:1', short: 'Cover 3000²', sub: '3000 × 3000 sRGB cover art JPEG + 1:1 motion preview', size: [1500, 1500] },
};

export function saveToDownloads(url: string, filename?: string) {
  const a = h('a', { href: url, download: filename || '' }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
}

export const SIZES: Record<string, [number, number]> = {
  master: [1080, 1920],
  lite: [720, 1280],
  strict: [608, 1080],
};

export const SEQ_PRESETS: Record<string, () => number[]> = {
  Four: () => Array.from({ length: SEQ_STEPS }, (_, i) => +(i % 4 === 0)),
  Offbeat: () => Array.from({ length: SEQ_STEPS }, (_, i) => +(i % 4 === 2)),
  Clave: () => [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0],
  Rolls: () => [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1],
  Random: () => Array.from({ length: SEQ_STEPS }, (_, i) => +(i % 4 === 0 || Math.random() < 0.3)),
};

export const ENV_PRESETS: Record<string, () => number[]> = {
  Arc: defaultEnv,
  Ramp: () => Array.from({ length: ENV_POINTS }, (_, i) => +(i / (ENV_POINTS - 1)).toFixed(3)),
  Dip: () => defaultEnv().map((v: number) => +(1 - v).toFixed(3)),
  Pulses: () => Array.from({ length: ENV_POINTS }, (_, i) => (i % 4 === 0 ? 1 : i % 4 === 1 ? 0.45 : 0.1)),
  Random: () => Array.from({ length: ENV_POINTS }, () => +Math.random().toFixed(3)),
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, ms = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

export function openPop(anchor: HTMLElement, build: (p: HTMLElement) => void, cls = '') {
  const p = document.getElementById('pop');
  if (!p) return;
  p.className = `pop on ${cls}`;
  p.style.width = ''; // a menu that was placed beside the preview set its own
  p.onscroll = null;
  p.scrollTop = 0;
  p.innerHTML = '';
  build(p);
  const r = anchor.getBoundingClientRect();
  const pw = p.offsetWidth;
  const ph = p.offsetHeight;
  let x = r.right - pw;
  let y = r.bottom + 6;
  if (x < 8) x = r.left;
  x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  p.style.left = `${x}px`;
  p.style.top = `${y}px`;
}

export function closePop() {
  const p = document.getElementById('pop');
  if (p) p.className = 'pop';
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    const p = document.getElementById('pop');
    if (p && !p.contains(e.target as Node) && !(e.target as HTMLElement)?.closest?.('[data-pop]')) {
      closePop();
    }
  });
}

export function sizeCanvas(c: HTMLCanvasElement): [number, number, number] {
  const r = c.getBoundingClientRect();
  const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio || 1 : 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const hh = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== hh) {
    c.width = w;
    c.height = hh;
  }
  return [w, hh, dpr];
}

export function roundRect(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, r: number) {
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

export function clipAspect(clip?: { width?: number; height?: number } | null): number {
  if (!clip || !clip.height) return 9 / 16;
  return (clip.width || 0) / Math.max(1, clip.height);
}

export function clipDisplayName(clip: { name: string; still?: boolean }): string {
  return clip.still ? clip.name.replace(/\.still\.mp4$/, '') : clip.name;
}

/** The share of a clip that a canvas of aspect `ca` (width / height) shows, and how far its crop can move. Matches the SOURCE shader. */
export function room(c: { width?: number; height?: number }, zoom: number, ca = 9 / 16): { frac: [number, number]; room: [number, number] } {
  const va = clipAspect(c);
  const frac: [number, number] = va > ca ? [ca / va, 1] : [1, va / ca];
  return { frac, room: [Math.max(0, (1 - frac[0] / zoom) / 2), Math.max(0, (1 - frac[1] / zoom) / 2)] };
}

/** The part of a clip a crop centred on x, y (y up) shows at `zoom`, as [left, top, width, height] from 0 to 1 with
 * top measured down from the clip's top edge. Matches the SOURCE shader. */
export function cropRect(c: { width?: number; height?: number }, zoom: number, x: number, y: number, ca = 9 / 16): [number, number, number, number] {
  const { frac, room: rm } = room(c, zoom, ca);
  const w = frac[0] / zoom, hh = frac[1] / zoom;
  const cx = 0.5 + Math.max(-rm[0], Math.min(rm[0], x - 0.5));
  const cy = 0.5 + Math.max(-rm[1], Math.min(rm[1], y - 0.5));
  return [cx - w / 2, 1 - cy - hh / 2, w, hh];
}

export const detectSubject = (clipId: string): Promise<any> => fetchJSON(`/api/autoframe/${clipId}`).catch(() => null);

export const songTitle = (t: TrackMeta): string => t.name.replace(/\.[^.]+$/, '');

/** Where a song was found, as shown in the track picker. */
export function sourceLabel(source = ''): string {
  if (source === 'added') return 'Added in the studio';
  return source.split('/').filter(Boolean).pop() || source;
}

/** A path with the home folder written as ~. */
export const homeShort = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

/** Songs in the same folder as this one, newest first: the set a "this look on every song" batch renders. */
export function siblingTracks(tracks: TrackMeta[], id: string, max = 12): TrackMeta[] {
  const cur = tracks.find((t) => t.id === id);
  if (!cur) return [];
  return tracks
    .filter((t) => t.source === cur.source && (t.dir || '') === (cur.dir || ''))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, max);
}
