import './Slider.css';
import React from 'react';

export interface SliderProps {
  id?: string;
  label?: string;
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

export const Slider: React.FC<SliderProps> = ({ id, label, min, max, step, value, def, onChange, children }) => {
  const pct = `${max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) * 100 : 0}%`;
  return (
    <div className="slider">
      <div className="trk" />
      <div className="fill" style={{ width: pct }} />
      {children}
      <div className="knob" style={{ left: pct }} />
      <input
        id={id}
        aria-label={label}
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
