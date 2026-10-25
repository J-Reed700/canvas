import './WorkspaceLayout.css';
import { useWorkspaceStore } from '../../state/StudioContext.tsx';
import React from 'react';

/** Keep panel resize updates in the layout container so its children retain their render identity. */
export const WorkspaceLayout: React.FC<React.PropsWithChildren> = ({ children }) => {
  const layout = useWorkspaceStore((state) => state.layout);
  const focus = useWorkspaceStore((state) => state.focus);
  return (
    <div
      className={`app studio-workspace ${focus ? 'workspace-focus' : ''}`}
      style={{ '--library-width': `${layout.library}px`, '--inspector-width': `${layout.inspector}px`, '--timeline-height': `${layout.timeline}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
};
