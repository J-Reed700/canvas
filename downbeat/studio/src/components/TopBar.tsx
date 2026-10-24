import React, { useSyncExternalStore } from 'react';
import { useStudioStore } from '../state/store.ts';
import { historyDepth, subscribeHistory } from '../state/historyController.ts';
import { openPop, closePop, h, ROLL_OPTS, fmtLength } from '../lib/utils.ts';
import { Icon, ICONS } from './ui.tsx';
import { ProjectButton } from './Projects.tsx';

export const TopBar: React.FC = () => {
  const trackId = useStudioStore((s) => s.trackId);
  const tracks = useStudioStore((s) => s.tracks);
  const look = useStudioStore((s) => s.look);
  const selected = useStudioStore((s) => s.selected);
  const barDur = useStudioStore((s) => s.barDur());
  const bpm = useStudioStore((s) => s.bpm());
  const loopLen = useStudioStore((s) => s.loopLen());
  const rollOpts = useStudioStore((s) => s.rollOpts);
  const rollAll = useStudioStore((s) => s.rollAll);
  const undoRoll = useStudioStore((s) => s.undoRoll);
  const openExport = useStudioStore((s) => s.openExport);
  const save = useStudioStore((s) => s.save);
  const undo = useStudioStore((s) => s.undo);
  const redo = useStudioStore((s) => s.redo);
  const exporting = useStudioStore((s) => s.exporting);
  const history = useSyncExternalStore(subscribeHistory, historyDepth);

  const tr = tracks.find((t) => t.id === trackId);
  const currentBpm = bpm;
  const loopDuration = loopLen;
  const loopBars = Math.round(loopLen / barDur);

  const handleRollOpts = (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    openPop(anchor, (box) => {
      box.append(h('div', { class: 'ph' }, 'A roll changes'));
      for (const [k, label, sub] of ROLL_OPTS) {
        box.append(
          h(
            'label',
            { class: 'pi chk' },
            h('input', {
              type: 'checkbox',
              checked: !!rollOpts[k],
              onchange: (ev: Event) => {
                const on = (ev.target as HTMLInputElement).checked;
                useStudioStore.setState((prev) => ({ rollOpts: { ...prev.rollOpts, [k]: on } }));
                save();
              },
            }),
            h('span', { class: 'chk-t' }, h('b', {}, label), h('small', {}, sub)),
          ),
        );
      }
      box.append(
        h(
          'button',
          {
            class: 'pi',
            onclick: () => {
              closePop();
              undoRoll();
            },
          },
          '↶ Undo last roll',
          h('small', {}, 'Shift + D'),
        ),
      );
    });
  };

  return (
    <header className="top">
      <div className="brand">
        <span className="logo" />
        Downbeat <small>Studio</small>
      </div>
      <ProjectButton />

      <div className="chips" id="chips">
        <span className={`chip ${tr ? '' : 'dim'}`}>
          <span className="dot" />
          {tr ? <b>{tr.name.replace(/\.[^.]+$/, '')}</b> : 'No track · BPM clock'}
        </span>
        <span className="chip">
          <b>{currentBpm.toFixed(currentBpm % 1 ? 2 : 0)}</b> BPM
        </span>
        <span className="chip">
          <b>{fmtLength(loopDuration)}</b> {loopBars} bar{loopBars > 1 ? 's' : ''} loop
        </span>
        <span className="chip">
          Look <b>{look?.name || ''}</b>
        </span>
        <span className="chip">
          <b>{selected.length}</b> clips
        </span>
      </div>

      <div className="top-actions">
        <div className="split hist">
          <button className="btn icon" id="btnUndo" title="Undo (⌘Z)" aria-label="Undo" disabled={exporting || !history.undo} onClick={undo}>
            <Icon d={ICONS.undo} />
          </button>
          <button className="btn icon" id="btnRedo" title="Redo (⇧⌘Z)" aria-label="Redo" disabled={exporting || !history.redo} onClick={redo}>
            <Icon d={ICONS.redo} />
          </button>
        </div>
        <button
          className="btn icon hide-sm"
          id="btnHelp"
          title="Keyboard shortcuts (?)"
          onClick={() => useStudioStore.setState({ helpOpen: true })}
        >
          ?
        </button>
        <div className="split">
          <button
            className="btn roll"
            id="btnRoll"
            title="Roll everything: look, layers, edit and per-clip FX (D) · Shift+D undoes"
            onClick={rollAll}
          >
            🎲 Roll <span className="kbd">D</span>
          </button>
          <button
            className="btn roll caret"
            id="btnRollOpts"
            data-pop
            title="Choose what a roll changes · undo"
            onClick={handleRollOpts}
          >
            ▾
          </button>
        </div>
        <button className="btn primary" id="btnExport" onClick={openExport}>
          Export<span className="hide-sm"> Canvas</span> <span className="kbd">E</span>
        </button>
      </div>
    </header>
  );
};
