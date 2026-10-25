import React from 'react';
import { specOf } from '../../lib/exportsView.ts';
import type { RenderRecord } from '../../engine/types.ts';

export const ExportSpecBadge: React.FC<{ r: RenderRecord }> = ({ r }) => {
  const spec = specOf(r);
  if (!spec) return null;
  const n = (r.checks || []).filter((c) => c.level === 'fail').length;
  return spec === 'fail' ? (
    <span className="badge bad" title={`${n} spec check${n > 1 ? 's' : ''} failed`}>✕ {n}</span>
  ) : (
    <span className={`badge ${spec === 'warn' ? 'warn' : ''}`} title={spec === 'warn' ? 'Passed with notes' : 'Passed every spec check'}>
      ✓ spec
    </span>
  );
};
