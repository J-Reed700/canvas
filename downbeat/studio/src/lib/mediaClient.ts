import type { ClipMeta, TrackMeta } from '../engine/types.ts';

type UploadResult = { ok: false; error: string } | (
  { ok: true; id: string; name?: string; still?: boolean; converted?: boolean } &
  ({ kind: 'video'; clip?: ClipMeta } | { kind: 'audio'; track?: TrackMeta })
);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isClip = (value: unknown): value is ClipMeta => isRecord(value) && typeof value.id === 'string' && typeof value.duration === 'number' && Number.isFinite(value.duration);
const isTrack = (value: unknown): value is TrackMeta => isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';

/** The transport owns response validation; editor actions decide what an imported file does. */
export async function uploadMedia(file: File): Promise<UploadResult> {
  try {
    const response = await fetch('/api/upload', {
      method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file,
    });
    const result: unknown = await response.json();
    if (!isRecord(result)) return { ok: false, error: `The server returned an invalid upload result for ${file.name}` };
    if (!response.ok || !result.ok) return { ok: false, error: `Could not add ${file.name}${typeof result.error === 'string' ? `: ${result.error}` : ''}` };
    if (typeof result.id !== 'string' || !result.id || (result.kind !== 'video' && result.kind !== 'audio')) {
      return { ok: false, error: `The server returned an invalid upload result for ${file.name}` };
    }
    // Older servers return only an id; the caller can reconcile the whole batch once.
    const common = { ok: true as const, id: result.id, name: typeof result.name === 'string' ? result.name : undefined };
    return result.kind === 'video'
      ? { ...common, kind: 'video', still: result.still === true, converted: result.converted === true, clip: isClip(result.clip) && result.clip.id === result.id ? result.clip : undefined }
      : { ...common, kind: 'audio', track: isTrack(result.track) && result.track.id === result.id ? result.track : undefined };
  } catch (error) {
    return { ok: false, error: `Could not add ${file.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Preserve library order and replace a changed item's metadata without creating duplicates. */
export function upsertMedia<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((value) => value.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((value, i) => i === index ? item : value);
}
