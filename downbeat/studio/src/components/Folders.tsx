import React, { useState } from 'react';
import { useStudioStore } from '../state/store.ts';
import { addFolder, pickFolder } from '../state/mediaActions.ts';

/**
 * Adding a folder: the system folder chooser on a Mac, or a path typed in a box elsewhere, or when the
 * chooser doesn't open. The welcome screen, the Clips section and the track picker share it.
 */
export function useFolderPicker() {
  const canPick = useStudioStore((s) => s.canPick);
  const [waiting, setWaiting] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  const [err, setErr] = useState('');

  const choose = async () => {
    setErr('');
    if (!canPick) {
      setTyping(true);
      return;
    }
    setWaiting(true);
    const r = await pickFolder();
    setWaiting(false);
    if (r.ok === false) {
      setTyping(true);
      setErr(r.error || 'The folder chooser did not open. Type the path instead.');
    }
  };

  const add = async (p: string) => {
    setErr('');
    const r = await addFolder(p);
    if (r.ok === false) {
      setErr(r.error || 'That folder could not be added');
      return;
    }
    setTyping(false);
    setPath('');
  };

  /** Closes the path box and clears any error. */
  const reset = () => {
    setTyping(false);
    setErr('');
  };

  return { canPick, waiting, typing, setTyping, path, setPath, err, choose, add, reset };
}

type FolderPicker = ReturnType<typeof useFolderPicker>;

export const FolderPathForm: React.FC<{ f: FolderPicker }> = ({ f }) => (
  <form
    className="tp-path"
    onSubmit={(e) => {
      e.preventDefault();
      if (f.path.trim()) f.add(f.path.trim());
    }}
  >
    <input
      className="numin"
      autoFocus
      aria-label="Folder path"
      placeholder="~/Movies"
      value={f.path}
      onChange={(e) => f.setPath(e.target.value)}
    />
    <button className="btn sm" type="submit">
      Add folder
    </button>
  </form>
);

/** Shown while the folder chooser is open, which can land behind the browser window. */
export const ChooserNote: React.FC = () => (
  <div className="note">A folder chooser opened. If you don't see it, look behind the browser window.</div>
);

/** First run: the studio has nothing to show until a folder of videos is picked. */
export const Welcome: React.FC = () => {
  const show = useStudioStore((s) => s.welcome);
  const f = useFolderPicker();
  if (!show) return null;

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle">
      <div className="welcome-in">
        <div className="brand">
          <span className="studio-logo" aria-hidden="true"><i /><i /><i /><i /></span>
          <span>downbeat<small>STUDIO</small></span>
        </div>
        <h1 id="welcomeTitle">Your studio starts here.</h1>
        <p>Choose a folder of footage and music to build your library. Downbeat includes its subfolders and keeps your files where they are.</p>
        <button className="btn primary welcome-pick" id="btnPickFolder" disabled={f.waiting} onClick={f.choose}>
          Pick a folder
        </button>
        {f.waiting && <ChooserNote />}
        {f.typing && <FolderPathForm f={f} />}
        {f.err && <div className="tp-err">{f.err}</div>}
        {f.canPick && !f.typing && (
          <button className="link welcome-type" onClick={() => f.setTyping(true)}>
            Type a path instead
          </button>
        )}
      </div>
    </div>
  );
};
