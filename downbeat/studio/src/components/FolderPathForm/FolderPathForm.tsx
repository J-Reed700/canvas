import './FolderPathForm.css';
import React from 'react';
import { type FolderPicker } from '../../hooks/useFolderPicker.ts';

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
