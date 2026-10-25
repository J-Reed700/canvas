import React from 'react';
import { useStudioStore } from '../state/store.ts';
import { pendingClipCount } from '../state/mediaLoading.ts';

export const MediaLoading: React.FC = () => {
  const importing = useStudioStore((s) => s.mediaImport);
  const pending = useStudioStore(pendingClipCount);
  const total = useStudioStore((s) => s.selected.length);
  if (!importing && !pending) return null;

  return <div className="media-loading">
    <div className="media-loading-card" role="status" aria-label="Media loading" aria-live="polite" aria-atomic="true">
      <span className="media-loading-spinner" aria-hidden="true" />
      <h2>{importing ? 'Importing media…' : 'Preparing clips…'}</h2>
      <p>{importing
        ? importing.completed < importing.total ? `File ${importing.completed + 1} of ${importing.total}` : 'Finishing import…'
        : `${pending} clip${pending === 1 ? '' : 's'} left to prepare`}</p>
      {importing && <div className="media-loading-filename" title={importing.filename}>{importing.filename}</div>}
      <progress aria-label="Media loading progress" max={importing?.total ?? total} value={importing?.completed ?? total - pending} />
      <small>Playback and editing will be available when your media is ready.</small>
    </div>
  </div>;
};
