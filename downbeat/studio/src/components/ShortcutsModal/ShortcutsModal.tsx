import './ShortcutsModal.css';
import { useStudioStore, useStudioApi } from '../../state/StudioContext.tsx';
import React from 'react';
import { Modal } from '../Modal/Modal.tsx';
import { ShortcutItem } from '../ShortcutItem/ShortcutItem.tsx';

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  [', .', 'Previous / next frame (pauses playback)'],
  ['⌘ K', 'Search studio commands (Ctrl+K on Windows and Linux)'],
  ['⇧ F', 'Focus viewer / restore workspace'],
  ['← →', 'Previous / next look, or previous / next segment while editing one in Edit'],
  ['M', 'Variations of the current look. Press it again for six more'],
  ['D', '🎲 Roll everything: look, layers, edit, per-clip FX'],
  ['⇧ D', 'Undo the last roll'],
  ['R', 'Surprise me: random look'],
  ['E', 'Export the canvas'],
  ['[ ]', 'Previous / next loop suggestion (Drop, Peaks…)'],
  ['1–4', 'Loop length in bars (1, 2, 4, 8)'],
  ['H', 'Toggle the Spotify player overlay'],
  ['S', 'Toggle safe zones'],
  ['O', 'Next screen: phone, landscape, tablet, square'],
  ['L', 'Loop / Listener audition'],
  ['T', 'Tap tempo (tap along to the beat)'],
  ['B', 'Split the segment at the playhead, on the snap grid'],
  ['⌘ D', 'Repeat the selected segment: its first half plays twice'],
  ['Delete', 'Delete the selected segment. The one before plays on'],
  ['N', 'What cuts snap to: beat, ½, ¼, off'],
  ['⌘ S', 'Save the project now, or name the edit to save it as one'],
  ['⌘ O', 'Projects: open, start, rename or delete one'],
  ['⌘ Z', 'Undo any edit · ⇧⌘Z or ⌘Y redo · Ctrl on Windows and Linux'],
  ['?', 'This list'],
  ['Esc', 'Close menus and dialogs, or clear the selected block'],
  ['Drag', 'On the preview: reframe the current clip · scroll to zoom · double-click to reset'],
  ['⇧ Drag', 'On a cut line: move it off the snap grid'],
  ['⌥ Drag', 'On a timeline segment: slip to a different moment of the clip'],
  ['Dbl-click', 'On a timeline segment: select it and open the inspector’s Edit tab, with its timing, clip, in-point, speed ramp, transition and framing. Right-click, Enter, Edit segment or a long press do the same'],
];

export const ShortcutsModal: React.FC = () => {
  const store = useStudioApi();

  const helpOpen = useStudioStore((s) => s.helpOpen);
  const closeModals = () => {
    store.setState({ varOpen: false, helpOpen: false, exportOpen: false });
  };

  return (
    <Modal
      id="helpModal"
      open={helpOpen}
      onClose={closeModals}
      title="Shortcuts"
      className="modal-help"
      style={{ width: 'min(520px, 94vw)' }}
    >
      <div className="keys">
        {SHORTCUTS.map(([kbd, desc]) => (
          <ShortcutItem key={kbd} kbd={kbd} desc={desc} />
        ))}
      </div>
    </Modal>
  );
};
