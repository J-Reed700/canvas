import { useStudioStore } from '../../state/StudioContext.tsx';
import React, { useMemo } from 'react';
import { EXPORT_KINDS, kindOf } from '../../lib/exportsView.ts';
import { FilterChips } from '../FilterChips/FilterChips.tsx';
import type { RenderRecord } from '../../engine/types.ts';
import { useExportActions } from '../../hooks/useExportActions.ts';

export const ExportKindChips: React.FC<{ renders: RenderRecord[] }> = ({ renders }) => {
  const { setFilter } = useExportActions();

  const kind = useStudioStore((s) => s.exportFilter.kind);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: renders.length };
    for (const r of renders) c[kindOf(r)] = (c[kindOf(r)] || 0) + 1;
    return c;
  }, [renders]);
  return <FilterChips kinds={EXPORT_KINDS} counts={counts} value={kind} onChange={(k) => setFilter({ kind: k })} />;
};
