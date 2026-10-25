import React from 'react';
import { StrokeIcon } from '../StrokeIcon/StrokeIcon.tsx';

export const MediaGlyph: React.FC<{ kind: 'check' | 'more' | 'frame' | 'plus' }> = ({ kind }) => {
  const paths = {
    check: 'm3.25 8.25 3 3 6.5-7',
    more: 'M3 8h.01M8 8h.01M13 8h.01',
    frame: 'M5.25 2.5H2.5v2.75M10.75 2.5h2.75v2.75M13.5 10.75v2.75h-2.75M5.25 13.5H2.5v-2.75M8 5.25v5.5M5.25 8h5.5',
    plus: 'M8 3v10M3 8h10',
  } as const;
  return <StrokeIcon d={paths[kind]} />;
};
