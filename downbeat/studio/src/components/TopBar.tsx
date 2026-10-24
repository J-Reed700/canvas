import React from 'react';
import { useStudioStore } from '../store.ts';
import { openPop, closePop, h, ROLL_OPTS, fmtLength } from '../utils.ts';

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
        <button
          className="btn icon"
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
