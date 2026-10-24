// Small building blocks shared by the panels: icons, search field, two-click confirm, sliders and cards.
import React, { useEffect, useState } from 'react';

export const ICONS = {
  search: 'M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  download: 'M11 3h2v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6V3zM4 19h16v2H4z',
  folder: 'M3 5h7l2 2h9v12H3V5zm2 4v8h14V9H5z',
  expand: 'M4 4h7v2H7.4l4.3 4.3-1.4 1.4L6 7.4V11H4V4zm16 16h-7v-2h3.6l-4.3-4.3 1.4-1.4 4.3 4.3V13h2v7z',
  prev: 'M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z',
  next: 'M8.6 5.4 10 4l8 8-8 8-1.4-1.4 6.6-6.6z',
  trash: 'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9zm4 2v8h1.5v-8H10zm3.5 0v8H15v-8h-1.5z',
  undo: 'M9 5 3 10l6 5v-4h5a4 4 0 0 1 0 8h-3v2h3a6 6 0 0 0 0-12H9V5z',
  redo: 'M15 5l6 5-6 5v-4h-5a4 4 0 0 0 0 8h3v2h-3a6 6 0 0 1 0-12h5V5z',
};

export const Icon: React.FC<{ d: string }> = ({ d }) => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const SearchField: React.FC<{
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}> = ({ value, onChange, placeholder, autoFocus, className = '', inputRef, onKeyDown }) => (
  <label className={`exp-search ${className}`}>
    <Icon d={ICONS.search} />
    <input
      ref={inputRef}
      type="search"
      placeholder={placeholder}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  </label>
);

/** For destructive buttons: the first click arms, a second click within `ms` confirms. */
export function useArmed(ms = 3000): [boolean, (on: boolean) => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
  return [armed, setArmed];
}

interface SliderProps {
  min: number;
  max: number;
  step: number;
  value: number;
  /** Double-click resets to this value. */
  def?: number;
  onChange: (v: number) => void;
  /** Drawn between the fill and the knob, e.g. a modulation marker. */
  children?: React.ReactNode;
}

export const Slider: React.FC<SliderProps> = ({ min, max, step, value, def, onChange, children }) => {
  const pct = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className="slider">
      <div className="trk" />
      <div className="fill" style={{ width: pct }} />
      {children}
      <div className="knob" style={{ left: pct }} />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        onDoubleClick={def === undefined ? undefined : () => onChange(def)}
      />
    </div>
  );
};

/** Label, slider and value readout in the inspector's four-column row. */
export const SliderRow: React.FC<SliderProps & { label: string; title?: string; output: string }> = ({
  label,
  title,
  output,
  ...slider
}) => (
  <div className="prm">
    <label title={title}>{label}</label>
    <Slider {...slider} />
    <output>{output}</output>
    <span />
  </div>
);

export const Card: React.FC<{
  color: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** Controls at the right of the header. */
  actions?: React.ReactNode;
  className?: string;
  bodyStyle?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ color, title, sub, actions, className = '', bodyStyle, children }) => {
  // Clicking the header folds the card up, except on the controls in it.
  const [folded, setFolded] = useState(false);
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
