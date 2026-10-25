import './Icon.css';
import React from 'react';

export const Icon: React.FC<{ d: string }> = ({ d }) => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);
