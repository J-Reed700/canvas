import React from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';
import { useArmed } from '../../hooks/useArmed.ts';
import type { RenderRecord } from '../../engine/types.ts';
import { useExportActions } from '../../hooks/useExportActions.ts';

/** Needs a second click within 3 s, so one stray click can't delete an export. */
export const ExportDeleteButton: React.FC<{ r: RenderRecord; wide?: boolean }> = ({ r, wide }) => {
  const { deleteExport } = useExportActions();

  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`btn del ${wide ? '' : 'sm icon'} ${armed ? 'armed' : ''}`}
      title={armed ? 'Click again to delete this export and its extra files' : 'Delete'}
      onClick={() => (armed ? deleteExport(r) : setArmed(true))}
    >
      {armed ? (
        wide ? 'Click again to delete' : 'Delete?'
      ) : (
        <>
          <Icon d={ICONS.trash} />
          {wide ? ' Delete' : null}
        </>
      )}
    </button>
  );
};
