import React, { useRef } from 'react';
import { DEFAULT_LAYOUT, PANEL_LIMITS, useWorkspaceStore, type PanelSize } from '../state/workspaceStore.ts';
import { useStudioStore } from '../state/store.ts';
import { FORMATS, SIZES } from '../lib/utils.ts';

export const PanelDivider: React.FC<{ panel: PanelSize }> = ({ panel }) => {
  const value = useWorkspaceStore((s) => s.layout[panel]);
  const resize = useWorkspaceStore((s) => s.resize);
  const drag = useRef<{ position: number; size: number } | null>(null);
  const horizontal = panel === 'timeline';
  const sign = panel === 'library' ? 1 : -1;
  const visibleSize = () => {
    const pane = document.querySelector(horizontal ? '.timeline' : panel === 'library' ? '.media' : '.inspector');
    const rect = pane?.getBoundingClientRect();
    return (horizontal ? rect?.height : rect?.width) || value;
  };
  const finish = () => { if (drag.current) resize(panel, useWorkspaceStore.getState().layout[panel]); drag.current = null; };
  return <div
    className={`panel-divider divider-${panel}`}
    role="separator" tabIndex={0} aria-label={`Resize ${panel}`} aria-orientation={horizontal ? 'horizontal' : 'vertical'}
    aria-valuemin={PANEL_LIMITS[panel][0]} aria-valuemax={PANEL_LIMITS[panel][1]} aria-valuenow={value}
    title={`Drag to resize ${panel} · double-click to reset`}
    onDoubleClick={() => resize(panel, DEFAULT_LAYOUT[panel])}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      drag.current = { position: horizontal ? e.clientY : e.clientX, size: visibleSize() };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    }}
    onPointerMove={(e) => {
      if (!drag.current) return;
      const position = horizontal ? e.clientY : e.clientX;
      resize(panel, drag.current.size + (position - drag.current.position) * sign, false);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(e) => {
      const delta = horizontal ? (e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0)
        : (e.key === 'ArrowRight' ? sign : e.key === 'ArrowLeft' ? -sign : 0);
      if (delta) { e.preventDefault(); e.stopPropagation(); resize(panel, visibleSize() + delta * (e.shiftKey ? 40 : 10)); }
      if (e.key === 'Home') { e.preventDefault(); resize(panel, DEFAULT_LAYOUT[panel]); }
    }}
  />;
};

export const WorkspaceStatus: React.FC = () => {
  const format = useStudioStore((s) => s.exportOpts.format || 'spotify');
  const size = useStudioStore((s) => s.exportOpts.size);
  const look = useStudioStore((s) => s.look?.name);
  const selected = useStudioStore((s) => s.selected.length);
  const exporting = useStudioStore((s) => s.exporting);
  const [w, h] = FORMATS[format]?.size || SIZES[size || 'master'] || SIZES.master;
  return <footer className="workspace-status">
    <div className="status-session"><span className="status-dot" aria-hidden="true" />{exporting ? 'Rendering export' : 'Local workspace'}<span className="status-divider" />{selected} clip{selected === 1 ? '' : 's'}<span className="status-look">{look}</span></div>
    <button className="status-shortcut" onClick={() => useWorkspaceStore.getState().setCommands(true)} title="Search commands (⌘K / Ctrl+K)">Command menu <kbd>⌘ K</kbd></button>
    <div className="status-format">{FORMATS[format]?.short}<span className="status-divider" />{w} × {h}<span className="status-divider" />30 fps</div>
  </footer>;
};
