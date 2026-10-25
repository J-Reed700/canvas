import React, { useId } from 'react';
import { type SliderProps, Slider } from '../Slider/Slider.tsx';

/** Label, slider and value readout in the inspector's four-column row. */
export const SliderRow: React.FC<SliderProps & { label: string; title?: string; output: string }> = ({
  label,
  title,
  output,
  ...slider
}) => {
  const id = useId();
  return (
    <div className="prm">
      <label title={title} htmlFor={id}>{label}</label>
      <Slider {...slider} id={id} />
      <output htmlFor={id}>{output}</output>
      <span />
    </div>
  );
};
