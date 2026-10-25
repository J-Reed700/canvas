import './RemoveClipButton.css';
import { useStudioRuntime } from '../../state/StudioContext.tsx';
import React from 'react';
import { useArmed } from '../../hooks/useArmed.ts';

/** Needs a second click within 3 s, like deleting an export. */
export const RemoveClipButton: React.FC<{ id: string }> = ({ id }) => {
  const { media } = useStudioRuntime();

  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`rm ${armed ? 'armed' : ''}`}
      title={armed ? 'Click again to remove this clip' : 'Remove from the library'}
      aria-label={armed ? 'Click again to remove this clip' : 'Remove from the library'}
      type="button"
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) media.removeClip(id);
        else setArmed(true);
      }}
    >
      {armed ? 'Remove?' : '✕'}
    </button>
  );
};
