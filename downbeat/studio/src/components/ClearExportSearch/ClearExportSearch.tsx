import React from 'react';
import { NoMatch } from '../NoMatch/NoMatch.tsx';
import { useExportActions } from '../../hooks/useExportActions.ts';

export const ClearExportSearch: React.FC = () => {
  const { setFilter } = useExportActions();
  return <NoMatch what="exports" onClear={() => setFilter({ q: '', kind: 'all' })} />;
};
