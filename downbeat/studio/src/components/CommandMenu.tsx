import React, { useEffect, useRef, useState } from 'react';
import { useStudioStore } from '../state/store.ts';
import { useWorkspaceStore } from '../state/workspaceStore.ts';
import { saveNow } from '../state/projectController.ts';
import { historyDepth } from '../state/historyController.ts';
import { closePop } from '../lib/utils.ts';
import { Icon, ICONS } from './ui.tsx';

interface Command { id: string; name: string; group: string; hint?: string; words?: string; run: () => void; disabled?: boolean }

export const CommandMenu: React.FC = () => {
  const open = useWorkspaceStore((s) => s.commands);
  const focus = useWorkspaceStore((s) => s.focus);
  const exporting = useStudioStore((s) => s.exporting);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => useWorkspaceStore.getState().setCommands(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    setQuery(''); setIndex(0); closePop(); input.current?.focus();
    const app = document.querySelector<HTMLElement>('.app');
    if (app) app.inert = true;
    return () => { if (app) app.inert = false; if (previous?.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => { if (exporting) close(); }, [exporting]);

  const studio = () => useStudioStore.getState();
  const openTab = (tab: 'looks' | 'layers' | 'edit') => { useWorkspaceStore.setState({ focus: false }); studio().setTab(tab); };
  const history = historyDepth();
  const commands: Command[] = [
    { id: 'export', name: 'Export canvas', group: 'Project', hint: 'E', words: 'render deliver prores movie', run: () => studio().openExport(), disabled: !studio().selected.length },
    { id: 'save', name: 'Save project', group: 'Project', hint: '⌘ S', run: () => { void saveNow(); } },
    { id: 'projects', name: 'Open projects', group: 'Project', hint: '⌘ O', run: () => useStudioStore.setState({ projectsOpen: true }) },
    { id: 'import', name: 'Import media', group: 'Project', words: 'add clips videos images music audio files', run: () => document.getElementById('fileInput')?.click() },
    { id: 'looks', name: 'Browse looks', group: 'Workspace', words: 'presets effects library style', run: () => openTab('looks') },
    { id: 'layers', name: 'Inspect layers & color', group: 'Workspace', words: 'grading lut scopes effects stack', run: () => openTab('layers') },
    { id: 'edit', name: 'Edit timing & transitions', group: 'Workspace', words: 'rhythm blocks cuts speed', run: () => openTab('edit') },
    { id: 'focus', name: focus ? 'Restore editing workspace' : 'Focus viewer', group: 'Workspace', hint: '⇧ F', words: 'panels hide cinema review', run: () => useWorkspaceStore.getState().toggleFocus() },
    { id: 'reset', name: 'Reset panel sizes', group: 'Workspace', words: 'layout default', run: () => useWorkspaceStore.getState().resetLayout() },
    { id: 'undo', name: 'Undo edit', group: 'Edit', hint: '⌘ Z', run: () => studio().undo(), disabled: !history.undo },
    { id: 'redo', name: 'Redo edit', group: 'Edit', hint: '⇧ ⌘ Z', run: () => studio().redo(), disabled: !history.redo },
    { id: 'variations', name: 'Explore look variations', group: 'Edit', hint: 'M', run: () => useStudioStore.setState({ varOpen: true }) },
    { id: 'guides', name: studio().safe ? 'Hide safe zones' : 'Show safe zones', group: 'View', hint: 'S', words: 'platform guides', run: () => { useStudioStore.setState((s) => ({ safe: !s.safe })); studio().save(); } },
    { id: 'shortcuts', name: 'Keyboard shortcuts', group: 'View', hint: '?', words: 'help controls', run: () => useStudioStore.setState({ helpOpen: true }) },
  ];
  const terms = query.toLowerCase().trim().split(/\s+/);
  const results = commands.filter((c) => terms.every((term) => `${c.name} ${c.group} ${c.words || ''}`.toLowerCase().includes(term)));
  const activeIndex = Math.min(index, Math.max(0, results.length - 1));
  const active = results[activeIndex];
  useEffect(() => { document.getElementById(`command-${active?.id}`)?.scrollIntoView?.({ block: 'nearest' }); }, [active?.id]);
  const run = (command: Command) => { if (!command.disabled && !studio().exporting) { close(); command.run(); } };
  if (!open) return null;

  return <div className="command-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div ref={dialog} className="command-menu" role="dialog" aria-modal="true" aria-label="Command menu" onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setIndex((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)); }
      else if (e.key === 'Enter' && active && e.target === input.current) { e.preventDefault(); run(active); }
      else if (e.key === 'Tab') {
        const stops = dialog.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])');
        if (!stops?.length) return;
        const first = stops[0], last = stops[stops.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }}>
      <div className="command-search"><Icon d={ICONS.search} /><input ref={input} type="text" role="combobox" aria-label="Search commands" aria-expanded="true" aria-controls="command-results" aria-autocomplete="list" aria-activedescendant={active ? `command-${active.id}` : undefined} placeholder="What would you like to do?" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} /><button onClick={close} aria-label="Close command menu"><kbd>esc</kbd></button></div>
      <div className="command-results" role="listbox" id="command-results" aria-label="Commands">
        {results.length ? results.map((command, i) => <React.Fragment key={command.id}>
          {(i === 0 || results[i - 1].group !== command.group) && <div className="command-group" role="presentation">{command.group}</div>}
          <button id={`command-${command.id}`} role="option" aria-selected={i === activeIndex} aria-disabled={command.disabled} tabIndex={-1} className={`command-option ${i === activeIndex ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => run(command)}>
            <span>{command.name}</span>{command.hint && <kbd>{command.hint}</kbd>}
          </button>
        </React.Fragment>) : <div className="command-empty">No commands match “{query}”.<small>Try “color”, “import”, or “export”.</small></div>}
      </div>
      <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to run</span><span>Downbeat Studio</span></div>
    </div>
  </div>;
};
