import './ExportThumb.css';
import React, { useRef } from 'react';
import { aspectOf } from '../../lib/exportsView.ts';
import type { RenderRecord } from '../../engine/types.ts';

/** First frame of the export; plays on hover. */
export const ExportThumb: React.FC<{ r: RenderRecord }> = ({ r }) => {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <span
      className="exp-thumb"
      style={{ '--ar': aspectOf(r) } as React.CSSProperties}
      onPointerEnter={() => ref.current?.play().catch(() => {})}
      onPointerLeave={() => ref.current?.pause()}
    >
      <video ref={ref} src={`${r.url}#t=0.3`} muted loop playsInline preload="metadata" />
    </span>
  );
};
