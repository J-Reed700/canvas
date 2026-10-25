import './WorkspaceStatus.css';
import { useStudioStore, useWorkspaceApi } from '../../state/StudioContext.tsx';
import React from 'react';
import { FORMATS, SIZES } from '../../lib/utils.ts';

export const WorkspaceStatus: React.FC = () => {
  const workspace = useWorkspaceApi();

  const format = useStudioStore((s) => s.exportOpts.format || 'spotify');
  const size = useStudioStore((s) => s.exportOpts.size);
  const look = useStudioStore((s) => s.look?.name);
  const selected = useStudioStore((s) => s.selected.length);
  const exporting = useStudioStore((s) => s.exporting);
  const [w, h] = FORMATS[format]?.size || SIZES[size || 'master'] || SIZES.master;
  return <footer className="workspace-status">
    <div className="status-session"><span className="status-dot" aria-hidden="true" />{exporting ? 'Rendering export' : 'Local workspace'}<span className="status-divider" />{selected} clip{selected === 1 ? '' : 's'}<span className="status-look">{look}</span></div>
    <button className="status-shortcut" onClick={() => workspace.getState().setCommands(true)} title="Search commands (⌘K / Ctrl+K)">Command menu <kbd>⌘ K</kbd></button>
    <div className="status-format">{FORMATS[format]?.short}<span className="status-divider" />{w} × {h}<span className="status-divider" />30 fps</div>
  </footer>;
};
