import { useStudioStore } from '../../state/StudioContext.tsx';
import React from 'react';
import { FilterSearch } from '../FilterSearch/FilterSearch.tsx';
import { useExportActions } from '../../hooks/useExportActions.ts';

export const ExportSearch: React.FC<{ autoFocus?: boolean; inputRef?: React.Ref<HTMLInputElement> }> = ({ autoFocus, inputRef }) => {
  const { setFilter } = useExportActions();

  const q = useStudioStore((s) => s.exportFilter.q);
  return (
    <FilterSearch value={q} onChange={(v) => setFilter({ q: v })} placeholder="Search by look, format or size" autoFocus={autoFocus} inputRef={inputRef} />
  );
};
