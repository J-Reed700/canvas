import React, { useEffect, useState } from 'react';
import { useStudioStore } from '../state/store.ts';
import { deleteProject, newProject, openProject, refreshProjects, renameProject, saveAs } from '../state/projectController.ts';
import { timeAgo } from '../lib/exportsView.ts';
import { Icon, ICONS, Modal, useArmed } from './ui.tsx';
import type { ProjectSummary, TrackMeta } from '../engine/types.ts';

const songName = (tracks: TrackMeta[], id?: string | null) => tracks.find((t) => t.id === id)?.name.replace(/\.[^.]+$/, '') || '';

const metaOf = (p: ProjectSummary, tracks: TrackMeta[]) =>
  [p.look, `${p.clips} clip${p.clips === 1 ? '' : 's'}`, p.bars ? `${p.bars} bar${p.bars === 1 ? '' : 's'}` : '', songName(tracks, p.track_id)]
    .filter(Boolean)
    .join(' · ');

const openDialog = () => useStudioStore.setState({ projectsOpen: true });

/** The top bar's name of the open project and whether its file is up to date. Opens Projects. */
export const ProjectButton: React.FC = () => {
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

/** Needs a second click within 3 s, like deleting an export. */
const DeleteProject: React.FC<{ p: ProjectSummary }> = ({ p }) => {
  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`btn sm del ${armed ? 'armed' : 'icon'}`}
      title={armed ? `Click again to delete ${p.name}` : 'Delete'}
      aria-label={`Delete ${p.name}`}
      onClick={() => (armed ? deleteProject(p.id) : setArmed(true))}
    >
      {armed ? 'Delete?' : <Icon d={ICONS.trash} />}
    </button>
  );
};

/** The open project's name, renamed on Enter or when the field loses focus. */
const NameField: React.FC<{ id: string; name: string }> = ({ id, name }) => {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === name) setDraft(name);
    else void renameProject(id, next);
  };
  return (
    <input
      className="numin proj-input"
      aria-label="Project name"
      title="Rename the project"
      value={draft}
      maxLength={80}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape' && draft !== name) {
          e.stopPropagation();
          setDraft(name);
        }
      }}
    />
  );
};

export const ProjectsModal: React.FC = () => {
  const open = useStudioStore((s) => s.projectsOpen);
  const project = useStudioStore((s) => s.project);
  const projects = useStudioStore((s) => s.projects);
  const sync = useStudioStore((s) => s.projectSync);
  const tracks = useStudioStore((s) => s.tracks);
  const trackId = useStudioStore((s) => s.trackId);
  const lookName = useStudioStore((s) => s.look?.name);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Opening a project or starting a new one replaces an edit that isn't in a project, so that asks first.
  const [confirm, setConfirm] = useState<{ what: string; run: () => Promise<unknown> } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setConfirm(null);
    void refreshProjects();
  }, [open]);

  const close = () => useStudioStore.setState({ projectsOpen: false });
  const go = async (run: () => Promise<unknown>) => {
    setConfirm(null);
    setBusy(true);
    try {
      if ((await run()) !== false) close();
    } finally {
      setBusy(false);
    }
  };
  const replace = (what: string, run: () => Promise<unknown>) => (project ? go(run) : setConfirm({ what, run }));
  const suggestion = project ? `${project.name} copy` : [songName(tracks, trackId), lookName].filter(Boolean).join(' · ') || 'Untitled';
  const save = () => go(() => saveAs(name.trim() || suggestion));

  return (
    <Modal
      id="projectsModal"
      open={open}
      onClose={close}
      title="Projects"
      subtitle="Each project is a file in out/projects. The open one saves itself as you work."
      className="proj"
    >
      <div className="proj-now">
        {project ? (
          <>
            <label className="proj-label">
              Open now
              <small className={`proj-sync ${sync}`}>
                {sync === 'failed' ? "Couldn't save. It's tried again on the next change" : sync === 'saving' ? 'Saving' : `Saved ${timeAgo(project.updated)}`}
              </small>
            </label>
            <NameField id={project.id} name={project.name} />
          </>
        ) : (
          <label className="proj-label">
            This edit isn't in a project yet
            <small className="proj-sync unsaved">It's only saved in this browser</small>
          </label>
        )}
        <form
          className="proj-save"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="numin proj-input"
            aria-label={project ? 'Name of the copy' : 'Project name'}
            placeholder={suggestion}
            value={name}
            maxLength={80}
            autoFocus={!project}
            onChange={(e) => setName(e.target.value)}
          />
          <button className={`btn ${project ? '' : 'primary'}`} type="submit" disabled={busy}>
            {project ? 'Save a copy' : 'Save as project'}
          </button>
        </form>
        <button className="btn proj-new" disabled={busy} onClick={() => replace('Starting a new one', newProject)}>
          New project
        </button>
      </div>

      {confirm && (
        <div className="proj-confirm" role="alert">
          <span>This edit isn't saved to a project. {confirm.what} replaces it.</span>
          <button className="btn sm" onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button className="btn sm del armed" onClick={() => go(confirm.run)}>
            Replace it
          </button>
        </div>
      )}

      <div className="lib-ph">Saved projects</div>
      <div className="proj-list">
        {!projects.length && <div className="exp-empty">No saved projects yet. Name this edit above to save it.</div>}
        {projects.map((p) => {
          const current = p.id === project?.id;
          return (
            <div className={`proj-row ${current ? 'on' : ''}`} key={p.id}>
              <button
                className="proj-open"
                disabled={current || busy}
                title={current ? 'This is the open project' : `Open ${p.name}`}
                onClick={() => replace(`Opening ${p.name}`, () => openProject(p.id))}
              >
                <span className="proj-thumb" style={p.first_clip ? { backgroundImage: `url(/api/thumb/${p.first_clip}?w=120)` } : undefined} />
                <span className="proj-cap">
                  <b>{p.name}</b>
                  <span>{metaOf(p, tracks)}</span>
                  <span>{current ? 'Open now' : `Saved ${timeAgo(p.updated)}`}</span>
                </span>
              </button>
              <DeleteProject p={p} />
            </div>
          );
        })}
      </div>
    </Modal>
  );
};
