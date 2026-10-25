import './ProjectButton.css';
import { useStudioStore, useStudioApi } from '../../state/StudioContext.tsx';
import React from 'react';

/** The top bar's name of the open project and whether its file is up to date. Opens Projects. */
export const ProjectButton: React.FC = () => {
  const store = useStudioApi();

  const openDialog = () => store.setState({ projectsOpen: true });
  const project = useStudioStore((s) => s.project);
  const sync = useStudioStore((s) => s.projectSync);
  const status = !project ? 'Not saved' : sync === 'failed' ? "Couldn't save" : sync === 'saving' ? 'Saving' : 'Saved';
  const title = !project
    ? 'This edit is only saved in this browser. Name it to save it as a project (⌘S)'
    : sync === 'failed'
      ? `${project.name} couldn't be saved. It's tried again on the next change`
      : `${project.name} saves itself as you work · Projects (⌘O)`;
  return (
    <button className={`btn proj-btn ${project ? sync : 'unsaved'}`} id="btnProjects" title={title} onClick={openDialog}>
      <span className="proj-dot" />
      <span className="proj-name">{project?.name || 'Untitled'}</span>
      <small>{status}</small>
    </button>
  );
};
