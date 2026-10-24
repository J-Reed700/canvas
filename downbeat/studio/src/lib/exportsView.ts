// Search, filter, sort and paging for the exports panel and the exports browser.
import type { RenderCheck, RenderRecord } from '../engine/types.ts';

export const EXPORT_KINDS: [string, string][] = [
  ['all', 'All'],
  ['spotify', 'Canvas'],
  ['apple', 'Apple'],
  ['youtube', 'YouTube'],
  ['social', 'Social'],
  ['cover', 'Cover'],
];

export const EXPORT_SORTS: [string, string][] = [
  ['new', 'Newest'],
  ['old', 'Oldest'],
  ['big', 'Largest'],
  ['name', 'Name'],
];

const KIND_OF_FORMAT: Record<string, string> = {
  spotify: 'spotify',
  apple_tall: 'apple',
  apple_square: 'apple',
  youtube_16_9: 'youtube',
  social_square: 'social',
  cover_art: 'cover',
};

const FORMAT_LABEL: Record<string, string> = {
  spotify: 'Spotify Canvas',
  apple_tall: 'Apple Music 3:4',
  apple_square: 'Apple Music 1:1',
  youtube_16_9: 'YouTube 16:9',
  social_square: 'Social 1:1',
  cover_art: 'Cover art',
};

export const CHECK_ICONS: Record<RenderCheck['level'], string> = { ok: '✓', warn: '!', fail: '✕' };

export const kindOf = (r: RenderRecord): string => KIND_OF_FORMAT[r.format || 'spotify'] || 'spotify';
export const formatLabel = (r: RenderRecord): string => FORMAT_LABEL[r.format || 'spotify'] || 'Spotify Canvas';

export function titleOf(r: RenderRecord): string {
  if (r.look) return r.look;
  const slug = r.filename.replace(/\.mp4$/, '').replace(/^canvas-/, '').split(/-\d+bpm-/)[0];
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Width / height of the export, for sizing its preview. */
export function aspectOf(r: RenderRecord): number {
  const m = /^(\d+)x(\d+)$/.exec(r.resolution || '');
  return m ? +m[1] / +m[2] : 9 / 16;
}

export function specOf(r: RenderRecord): 'pass' | 'warn' | 'fail' | null {
  const checks = r.checks || [];
  if (!checks.length) return null;
  if (checks.some((c) => c.level === 'fail')) return 'fail';
  return checks.some((c) => c.level === 'warn') ? 'warn' : 'pass';
}

export function metaLine(r: RenderRecord): string {
  return [
    r.resolution?.replace('x', '×'),
    r.duration ? `${(+r.duration).toFixed(2)} s` : null,
    r.size_mb != null ? `${r.size_mb} MB` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function timeAgo(sec?: number): string {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function filterExports(renders: RenderRecord[], f: { q: string; kind: string; sort: string }): RenderRecord[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = renders.filter((r) => {
    if (f.kind !== 'all' && kindOf(r) !== f.kind) return false;
    if (!words.length) return true;
    const hay = [titleOf(r), r.filename, formatLabel(r), r.resolution, r.bpm ? `${Math.round(r.bpm)} bpm` : '']
      .join(' ')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const by: Record<string, (a: RenderRecord, b: RenderRecord) => number> = {
    new: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    old: (a, b) => (a.created_at || 0) - (b.created_at || 0),
    big: (a, b) => (b.size_mb || 0) - (a.size_mb || 0),
    name: (a, b) => titleOf(a).localeCompare(titleOf(b)),
  };
  return out.sort(by[f.sort] || by.new);
}

/** Page numbers to show around the current page, with null for a gap: 1 … 4 5 6 … 12. */
export function pageList(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i);
  const keep = new Set([0, pages - 1, page - 1, page, page + 1]);
  const out: (number | null)[] = [];
  for (let i = 0; i < pages; i++) {
    if (keep.has(i)) out.push(i);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}
