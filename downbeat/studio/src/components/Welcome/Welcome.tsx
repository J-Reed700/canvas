import './Welcome.css';
import { useStudioStore } from '../../state/StudioContext.tsx';
import React from 'react';
import { useFolderPicker } from '../../hooks/useFolderPicker.ts';
import { ChooserNote } from '../ChooserNote/ChooserNote.tsx';
import { FolderPathForm } from '../FolderPathForm/FolderPathForm.tsx';

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
