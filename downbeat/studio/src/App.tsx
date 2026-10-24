import React, { useEffect, useRef } from 'react';
import { useStudioStore } from './state/store.ts';
import { BAR_CHOICES, closePop, toast } from './lib/utils.ts';
import { nextScreen, screenOf } from './lib/screens.ts';
import type { SnapDiv } from './engine/blocks.ts';
import { TopBar } from './components/TopBar.tsx';
import { MediaPanel } from './components/MediaPanel.tsx';
import { StagePanel } from './components/StagePanel.tsx';
import { TimelinePanel } from './components/TimelinePanel.tsx';
import { InspectorPanel } from './components/InspectorPanel.tsx';
import { Modals } from './components/Modals.tsx';
import { ExportsLibrary } from './components/Exports.tsx';
import { Welcome } from './components/Folders.tsx';

export const App: React.FC = () => {
  const ambientRef = useRef<HTMLCanvasElement>(null);
  const initStudio = useStudioStore((s) => s.initStudio);

  useEffect(() => {
    const viewCanvas = document.getElementById('view') as HTMLCanvasElement;
    const bankContainer = document.getElementById('videoBank') as HTMLElement;
    const ambientCanvas = ambientRef.current || (document.getElementById('ambient') as HTMLCanvasElement);
    if (viewCanvas && bankContainer) {
      initStudio(viewCanvas, bankContainer, ambientCanvas);
    }
  }, [initStudio]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useStudioStore.getState();
      const target = e.target as HTMLElement | null;

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

      if (
        (e.metaKey || e.ctrlKey) &&
        (e.key === 'd' || e.key === 'D') &&
        !e.shiftKey &&
        !target?.closest?.('input, select, textarea, [contenteditable]')
      ) {
        e.preventDefault(); // or the browser bookmarks the page
        if (!s.exporting && !s.libraryOpen && !s.welcome) s.repeatSegment();
        return;
      }

      if (target?.closest?.('input, select, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || s.exporting || s.libraryOpen || s.welcome) {
        return;
      }

      const k = e.key;
      if (k === ' ') {
        e.preventDefault();
        s.transport.toggle();
      } else if (k === 'ArrowRight') {
        s.stepLook(1);
      } else if (k === 'ArrowLeft') {
        s.stepLook(-1);
      } else if (k === 'm' || k === 'M') {
        useStudioStore.setState((prev) => ({ varOpen: !prev.varOpen }));
      } else if (k === 'r' || k === 'R') {
        s.surprise();
      } else if (k === 'd') {
        s.rollAll();
      } else if (k === 'D') {
        s.undoRoll();
      } else if (k === 't' || k === 'T') {
        s.tapTempo();
      } else if (k === 'e' || k === 'E') {
        s.openExport();
      } else if (k === 'h' || k === 'H') {
        useStudioStore.setState((prev) => ({ hud: !prev.hud }));
        s.save();
      } else if (k === 's' || k === 'S') {
        useStudioStore.setState((prev) => ({ safe: !prev.safe }));
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
      } else if (k === 'n' || k === 'N') {
        const order: SnapDiv[] = [1, 2, 4, 0];
        s.setSnap(order[(order.indexOf(s.snap) + 1) % order.length]);
      } else if (k === '?') {
        useStudioStore.setState({ helpOpen: true });
      } else if (k === 'Escape') {
        useStudioStore.setState({ varOpen: false, helpOpen: false, exportOpen: false });
        if (!document.getElementById('pop')?.classList.contains('on')) s.selectBlock(null);
        closePop();
      } else if (k === '[' || k === ']') {
        const loops = s.features?.loops || [];
        if (!loops.length) return;
        const i = loops.findIndex((l) => Math.abs(l.start - s.loopStart) < 0.05);
        const l = loops[(i + (k === ']' ? 1 : -1) + loops.length) % loops.length];
        useStudioStore.setState({ loopStart: l.start, blocks: null });
        s.rebuild();
        toast(`Loop: ${l.label}`);
      } else if ('1234'.includes(k)) {
        const b = BAR_CHOICES[+k - 1];
        if (b <= s.maxBars()) s.setBars(b);
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        document.body.classList.add('dropping');
      }
    };

    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) document.body.classList.remove('dropping');
    };

    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      document.body.classList.remove('dropping');
      useStudioStore.getState().uploadFiles(Array.from(e.dataTransfer.files));
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <>
      <canvas id="ambient" ref={ambientRef} width="48" height="85" />
      <div className="grain-overlay" />

      <div className="app">
        <TopBar />
        <MediaPanel />
        <StagePanel />
        <TimelinePanel />
        <InspectorPanel />
      </div>

      <Modals />
      <ExportsLibrary />
      <Welcome />
    </>
  );
};
