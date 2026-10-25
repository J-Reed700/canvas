import './LibraryViewer.css';
import React from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';

/** One item large between arrows to the ones before and after it, with its details beside it. */
export const LibraryViewer: React.FC<{
  /** "export" or "clip", for the arrows' tooltips. */
  what: string;
  /** The button back to the grid: "All exports". */
  back: string;
  index: number;
  count: number;
  onStep: (d: number) => void;
  onBack: () => void;
  /** Width / height of the item, for sizing the player. */
  ar: number;
  player: React.ReactNode;
  children: React.ReactNode;
}> = ({ what, back, index, count, onStep, onBack, ar, player, children }) => (
  <div className="lib-view">
    <div className="lib-stage">
      <button className="lib-nav" disabled={index <= 0} onClick={() => onStep(-1)} title={`Previous ${what} (←)`}>
        <Icon d={ICONS.prev} />
      </button>
      <div className="lib-player" style={{ '--ar': ar } as React.CSSProperties}>
        {player}
      </div>
      <button className="lib-nav" disabled={index >= count - 1} onClick={() => onStep(1)} title={`Next ${what} (→)`}>
        <Icon d={ICONS.next} />
      </button>
    </div>

    <div className="lib-info">
      <div className="lib-crumb">
        <button className="btn sm" onClick={onBack}>
          <Icon d={ICONS.prev} /> {back}
        </button>
        {index >= 0 && (
          <span className="muted">
            {index + 1} of {count}
          </span>
        )}
      </div>
      {children}
    </div>
  </div>
);
