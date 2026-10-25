import type { StudioState } from './storeTypes.ts';
import { clipIndex } from './mediaIndex.ts';

type MediaState = Pick<StudioState, 'clips' | 'selected' | 'mediaImport'>;
let lastClips: MediaState['clips'] | undefined;
let lastSelected: MediaState['selected'] | undefined;
let pending = 0;

/** Reuse readiness between animation frames; metadata and selections change by replacement. */
export function pendingClipCount(s: Pick<MediaState, 'clips' | 'selected'>): number {
  if (s.clips !== lastClips || s.selected !== lastSelected) {
    const index = clipIndex(s.clips);
    pending = s.selected.reduce((n, id) => {
      const status = index.get(id)?.proxy;
      return n + (status === 'queued' || status === 'building' ? 1 : 0);
    }, 0);
    lastClips = s.clips;
    lastSelected = s.selected;
  }
  return pending;
}

export const isMediaLoading = (s: MediaState): boolean => !!s.mediaImport || pendingClipCount(s) > 0;
