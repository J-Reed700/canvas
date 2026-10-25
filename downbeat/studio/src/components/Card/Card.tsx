import './Card.css';
import React, { useState } from 'react';

export const Card: React.FC<{
  color: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** Controls at the right of the header. */
  actions?: React.ReactNode;
  className?: string;
  bodyStyle?: React.CSSProperties;
  defaultFolded?: boolean;
  children?: React.ReactNode;
}> = ({ color, title, sub, actions, className = '', bodyStyle, defaultFolded = false, children }) => {
  // Clicking the header folds the card up, except on the controls in it.
  const [folded, setFolded] = useState(defaultFolded);
  return (
    <div className={`card ${className} ${folded ? 'collapsed' : ''}`}>
      <div
        className="card-h"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button, input, select, label, a, .sw')) setFolded(!folded);
        }}
      >
        <span className="cdot" style={{ ['--c' as string]: color }} />
        <span className="ct">
          {title}
          {sub !== undefined && <small>{sub}</small>}
        </span>
        {actions}
        <button
          className="ib fold"
          title={folded ? 'Unfold' : 'Fold up'}
          aria-label={folded ? 'Unfold' : 'Fold up'}
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
        >
          ▾
        </button>
      </div>
      {/* kept mounted while folded, so canvases and their drawing hooks stay put */}
      <div className="prms" style={bodyStyle}>
        {children}
      </div>
    </div>
  );
};
