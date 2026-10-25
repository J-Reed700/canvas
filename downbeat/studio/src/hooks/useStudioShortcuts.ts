import { useStudioApi, useWorkspaceApi, useStudioRuntime, useSegmentMenu } from '../state/StudioContext.tsx';
import { BAR_CHOICES, closePop, toast } from '../lib/utils.ts';
import { nextScreen, screenOf } from '../lib/screens.ts';
import { stepFrame } from '../lib/playback.ts';
import { isMediaLoading } from '../state/mediaLoading.ts';
import type { SnapDiv } from '../engine/blocks.ts';
import { useWindowEvent } from './useWindowEvent.ts';

export function useStudioShortcuts() {
  const store = useStudioApi();
  const workspace = useWorkspaceApi();
  const { blocks, projects: projectController } = useStudioRuntime();
  const menus = useSegmentMenu();
  const onKeyDown = (e: KeyboardEvent) => {
    if (document.querySelector('[data-modal-blocks-shortcuts]')) return;
    const s = store.getState();
    const target = e.target as HTMLElement | null;
    if (isMediaLoading(s)) {
      const command = e.metaKey || e.ctrlKey;
      if ([' ', 'Backspace'].includes(e.key) || (command && ['k', 's', 'o', 'd', 'z', 'y'].includes(e.key.toLowerCase()))) e.preventDefault();
      return;
    }
    const workspaceState = workspace.getState();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!s.exporting && !s.welcome && !s.projectsOpen && !s.libraryOpen && !s.clipsOpen && !s.varOpen && !s.helpOpen && !s.exportOpen) workspaceState.setCommands(!workspaceState.commands);
      return;
    }
    if (workspaceState.commands) return;

    if (
      (e.metaKey || e.ctrlKey) &&
      (e.key === 'z' || e.key === 'Z' || e.key === 'y') &&
      !target?.closest?.('input[type=text], input[type=number], textarea, [contenteditable]')
    ) {
      if (s.exporting || s.welcome) return;
      e.preventDefault();
      if (e.key === 'y' || e.shiftKey) s.redo();
      else s.undo();
      return;
    }

    if (e.key === 'Escape' && s.projectsOpen) {
      store.setState({ projectsOpen: false });
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 's' || e.key === 'o')) {
      e.preventDefault(); // or the browser saves the page or opens a file
      if (s.exporting || s.welcome) return;
      if (e.key === 's') void projectController.saveNow();
      else store.setState({ projectsOpen: true });
      return;
    }

    if (
      (e.metaKey || e.ctrlKey) &&
      (e.key === 'd' || e.key === 'D') &&
      !e.shiftKey &&
      !target?.closest?.('input, select, textarea, [contenteditable]')
    ) {
      e.preventDefault(); // or the browser bookmarks the page
      if (!s.exporting && !s.libraryOpen && !s.clipsOpen && !s.projectsOpen && !s.welcome) s.repeatSegment();
      return;
    }

    if (target?.closest?.('input, select, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || s.exporting || s.libraryOpen || s.clipsOpen || s.projectsOpen || s.welcome) {
      return;
    }

    const k = e.key;
    if (e.shiftKey && k.toLowerCase() === 'f') {
      e.preventDefault();
      workspaceState.toggleFocus();
    } else if (k === ',' || k === '.') {
      e.preventDefault();
      stepFrame(s.transport, k === ',' ? -1 : 1);
    } else if (k === ' ') {
      if (target?.closest?.('button, a, summary, [role=button]')) return;
      e.preventDefault();
      s.transport.toggle();
    } else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      // with a segment's settings showing in the Edit tab, ← → step through the segments, else through the looks
      if (e.defaultPrevented || target?.closest?.('.seg-zoom, [role=tablist]')) return;
      if (menus.stepSegment(k === 'ArrowRight' ? 1 : -1)) e.preventDefault();
      else s.stepLook(k === 'ArrowRight' ? 1 : -1);
    } else if (k === 'm' || k === 'M') {
      // opens Variations, and deals six more while it's open (Esc closes it)
      store.setState((prev) => (prev.varOpen ? { varSeed: prev.varSeed + 1 } : { varOpen: true }));
    } else if (k === 'r' || k === 'R') {
      s.surprise();
    } else if (k === 'd') {
      // the inspector's target: the selected segment, all uses of a clip, or the whole edit
      s.remix();
    } else if (k === 'D') {
      s.undoRoll();
    } else if (k === 't' || k === 'T') {
      s.tapTempo();
    } else if (k === 'e' || k === 'E') {
      s.openExport();
    } else if (k === 'h' || k === 'H') {
      store.setState((prev) => ({ hud: !prev.hud }));
      s.save();
    } else if (k === 's' || k === 'S') {
      store.setState((prev) => ({ safe: !prev.safe }));
      s.save();
    } else if (k === 'o' || k === 'O') {
      s.setScreen(nextScreen(screenOf(s.exportOpts.format)).id);
    } else if (k === 'l' || k === 'L') {
      s.transport.setMode(s.transport.mode === 'loop' ? 'listen' : 'loop');
      s.touch();
      s.save();
    } else if (k === 'b' || k === 'B') {
      s.splitAtPlayhead();
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      s.deleteBlock();
    } else if (k === 'Enter') {
      // a focused button takes Enter itself, and an open menu stays as it is; Enter shows the segment in the inspector
      if (target?.closest?.('button, a, [role=button]') || document.getElementById('pop')?.classList.contains('on')) return;
      const id = blocks.targetBlock();
      if (id) {
        e.preventDefault();
        menus.revealSegment(id);
      }
    } else if (k === 'n' || k === 'N') {
      const order: SnapDiv[] = [1, 2, 4, 0];
      s.setSnap(order[(order.indexOf(s.snap) + 1) % order.length]);
    } else if (k === '?') {
      store.setState({ helpOpen: true });
    } else if (k === 'Escape') {
      if (workspaceState.focus && !s.varOpen && !s.helpOpen && !s.exportOpen && !document.getElementById('pop')?.classList.contains('on')) { workspaceState.toggleFocus(); return; }
      store.setState({ varOpen: false, helpOpen: false, exportOpen: false });
      if (!document.getElementById('pop')?.classList.contains('on')) s.selectBlock(null);
      closePop();
    } else if (k === '[' || k === ']') {
      const loops = s.features?.loops || [];
      if (!loops.length) return;
      const i = loops.findIndex((l) => Math.abs(l.start - s.loopStart) < 0.05);
      const l = loops[(i + (k === ']' ? 1 : -1) + loops.length) % loops.length];
      store.setState({ loopStart: l.start, blocks: null });
      s.rebuild();
      toast(`Loop: ${l.label}`);
    } else if ('1234'.includes(k)) {
      const b = BAR_CHOICES[+k - 1];
      if (b <= s.maxBars()) s.setBars(b);
    }
  };
  useWindowEvent('keydown', onKeyDown);
}
