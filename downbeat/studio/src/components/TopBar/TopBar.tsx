import './TopBar.css';
import { useStudioStore, useStudioApi, useWorkspaceApi, useStudioRuntime } from '../../state/StudioContext.tsx';
import React, { useSyncExternalStore } from 'react';
import { openPop, closePop, h, ROLL_OPTS, fmtLength } from '../../lib/utils.ts';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';
import { ProjectButton } from '../ProjectButton/ProjectButton.tsx';
import { isMediaLoading } from '../../state/mediaLoading.ts';
import { normalizeRollStyle, ROLL_STYLES } from '../../engine/lookStyles.ts';

export const TopBar: React.FC = () => {
  const store = useStudioApi();
  const workspace = useWorkspaceApi();
  const { history: historyController } = useStudioRuntime();

  const trackId = useStudioStore((s) => s.trackId);
  const tracks = useStudioStore((s) => s.tracks);
  const look = useStudioStore((s) => s.look);
  const selected = useStudioStore((s) => s.selected);
  const barDur = useStudioStore((s) => s.barDur());
  const bpm = useStudioStore((s) => s.bpm());
  const loopLen = useStudioStore((s) => s.loopLen());
  const rollOpts = useStudioStore((s) => s.rollOpts);
  const rollStyle = useStudioStore((s) => s.rollStyle);
  const rollAll = useStudioStore((s) => s.rollAll);
  const undoRoll = useStudioStore((s) => s.undoRoll);
  const openExport = useStudioStore((s) => s.openExport);
  const save = useStudioStore((s) => s.save);
  const undo = useStudioStore((s) => s.undo);
  const redo = useStudioStore((s) => s.redo);
  const exporting = useStudioStore((s) => s.exporting);
  const mediaLoading = useStudioStore(isMediaLoading);
  const history = useSyncExternalStore(historyController.subscribeHistory, historyController.historyDepth);

  const tr = tracks.find((t) => t.id === trackId);
  const currentBpm = bpm;
  const loopDuration = loopLen;
  const loopBars = Math.round(loopLen / barDur);

  const handleRollOpts = (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    openPop(anchor, (box) => {
      const styleSelect = h('select', {
        'aria-label': 'Remix style',
        onchange: (event: Event) => {
          store.setState({ rollStyle: normalizeRollStyle((event.target as HTMLSelectElement).value) });
          save();
        },
      }, ROLL_STYLES.map((style) => h('option', { value: style.id }, style.name))) as HTMLSelectElement;
      styleSelect.value = rollStyle;
      box.append(h('label', { class: 'pi roll-style-control' },
        h('span', { class: 'chk-t' }, h('b', {}, 'Randomize style'), h('small', {}, 'Also used by Surprise and per-clip rolls')),
        styleSelect,
      ));
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
                store.setState((prev) => ({ rollOpts: { ...prev.rollOpts, [k]: on } }));
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
        <span className="studio-logo" aria-hidden="true"><i /><i /><i /><i /></span>
        <span>downbeat<small>STUDIO</small></span>
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
        <button className="btn command-trigger" aria-label="Search commands" title="Search commands (⌘K / Ctrl+K)" disabled={exporting} onClick={() => workspace.getState().setCommands(true)}>
          <Icon d={ICONS.search} /><span>Commands</span><kbd>⌘ K</kbd>
        </button>
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
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={() => store.setState({ helpOpen: true })}
        >
          ?
        </button>
        <div className="split">
          <button
            className="btn roll"
            id="btnRoll"
            title="Roll everything: look, layers, edit and per-clip FX (D) · Shift+D undoes"
            onClick={rollAll}
            disabled={exporting}
          >
            <svg className="studio-stroke" viewBox="0 0 20 20" aria-hidden="true"><path d="m4 16 9-9M11 3v4m-2-2h4m3 7v4m-2-2h4M4 3v4M2 5h4" /></svg> Remix <span className="kbd">D</span>
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
        <button className="btn primary" id="btnExport" onClick={openExport} disabled={exporting || mediaLoading}>
          <Icon d={ICONS.download} />Export <span className="kbd">E</span>
        </button>
      </div>
    </header>
  );
};
