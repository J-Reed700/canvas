// Search, filter and sort for the clips panel and the clips browser.
import type { ClipMeta } from '../engine/types.ts';
import { clipDisplayName, sourceLabel } from './utils.ts';

export type ClipFilter = { q: string; kind: string; sort: string };

export const CLIP_KINDS: [string, string][] = [
  ['all', 'All'],
  ['edit', 'In the edit'],
  ['video', 'Videos'],
  ['still', 'Stills'],
];

// The side panel always keeps the edit's order, so its clips can be dragged into place. In the browser,
// adding a clip doesn't move its card unless the sort is "In the edit first".
export const CLIP_SORTS: [string, string][] = [
  ['folder', 'Folder order'],
  ['edit', 'In the edit first'],
  ['name', 'Name'],
  ['long', 'Longest'],
  ['short', 'Shortest'],
];

export const clipName = (c: ClipMeta): string => clipDisplayName({ name: c.name || '', still: c.still });

/** The chips a clip counts under. Every clip counts under 'all'. */
export function kindsOf(c: ClipMeta, selected: string[]): string[] {
  return ['all', selected.includes(c.id) ? 'edit' : '', c.still ? 'still' : 'video'].filter(Boolean);
}

export function kindCounts(clips: ClipMeta[], selected: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of clips) for (const k of kindsOf(c, selected)) counts[k] = (counts[k] || 0) + 1;
  return counts;
}

/** The folder a clip is listed from and the subfolders inside it: Canvas › Night drive. */
export function folderOf(c: ClipMeta): string {
  if (!c.source) return '';
  return [sourceLabel(c.source), ...(c.dir || '').split(/[\\/]/)].filter(Boolean).join(' › ');
}

export function shapeOf(c: ClipMeta): string {
  if (!c.width || !c.height) return '';
  const r = c.width / c.height;
  return r < 0.95 ? 'Vertical' : r > 1.05 ? 'Landscape' : 'Square';
}

export function clipMetaLine(c: ClipMeta): string {
  return [
    c.still ? 'Still' : `${(c.duration || 0).toFixed(1)} s`,
    c.width && c.height ? `${c.width}×${c.height}` : '',
    !c.still && c.fps ? `${c.fps} fps` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The clips in the edit first, in their order, then the rest as the library lists them. */
export function editOrder(clips: ClipMeta[], selected: string[]): ClipMeta[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  return [...(selected.map((id) => byId.get(id)).filter(Boolean) as ClipMeta[]), ...clips.filter((c) => !selected.includes(c.id))];
}

export function filterClips(clips: ClipMeta[], selected: string[], f: ClipFilter): ClipMeta[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = (f.sort === 'edit' ? editOrder(clips, selected) : clips).filter((c) => {
    if (f.kind !== 'all' && !kindsOf(c, selected).includes(f.kind)) return false;
    if (!words.length) return true;
    const hay = [c.name, folderOf(c), c.width && c.height ? `${c.width}x${c.height} ${c.width}×${c.height}` : '', shapeOf(c), c.still ? 'still' : 'video']
      .join(' ')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const by: Record<string, (a: ClipMeta, b: ClipMeta) => number> = {
    name: (a, b) => clipName(a).localeCompare(clipName(b), undefined, { numeric: true }),
    long: (a, b) => (b.duration || 0) - (a.duration || 0),
    short: (a, b) => (a.duration || 0) - (b.duration || 0),
  };
  return by[f.sort] ? out.sort(by[f.sort]) : out;
}
