import './ProjectsModal.css';
import { useStudioStore, useStudioApi, useStudioRuntime } from '../../state/StudioContext.tsx';
import React, { useEffect, useState } from 'react';
import { timeAgo } from '../../lib/exportsView.ts';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';
import { Modal } from '../Modal/Modal.tsx';
import { useArmed } from '../../hooks/useArmed.ts';
import { FilterSearch } from '../FilterSearch/FilterSearch.tsx';
import { NoMatch } from '../NoMatch/NoMatch.tsx';
import type { ProjectSummary, TrackMeta } from '../../engine/types.ts';

const songName = (tracks: TrackMeta[], id?: string | null) => tracks.find((t) => t.id === id)?.name.replace(/\.[^.]+$/, '') || '';

const metaOf = (p: ProjectSummary, tracks: TrackMeta[]) =>
  [p.look, `${p.clips} clip${p.clips === 1 ? '' : 's'}`, p.bars ? `${p.bars} bar${p.bars === 1 ? '' : 's'}` : '', songName(tracks, p.track_id)]
    .filter(Boolean)
    .join(' · ');

// The search shows once the list is longer than the dialog shows without scrolling.
const SEARCH_FROM = 6;

/** Needs a second click within 3 s, like deleting an export. */
const DeleteProject: React.FC<{ p: ProjectSummary }> = ({ p }) => {
  const { projects: projectController } = useStudioRuntime();

  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`btn sm del ${armed ? 'armed' : 'icon'}`}
      title={armed ? `Click again to delete ${p.name}` : 'Delete'}
      aria-label={`Delete ${p.name}`}
      onClick={() => (armed ? projectController.deleteProject(p.id) : setArmed(true))}
    >
      {armed ? 'Delete?' : <Icon d={ICONS.trash} />}
    </button>
  );
};

/** The open project's name, renamed on Enter or when the field loses focus. */
const NameField: React.FC<{ id: string; name: string }> = ({ id, name }) => {
  const { projects: projectController } = useStudioRuntime();

  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === name) setDraft(name);
    else void projectController.renameProject(id, next);
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
  const store = useStudioApi();
  const { projects: projectController } = useStudioRuntime();

  const open = useStudioStore((s) => s.projectsOpen);
  const project = useStudioStore((s) => s.project);
  const projects = useStudioStore((s) => s.projects);
  const sync = useStudioStore((s) => s.projectSync);
  const tracks = useStudioStore((s) => s.tracks);
  const trackId = useStudioStore((s) => s.trackId);
  const lookName = useStudioStore((s) => s.look?.name);
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  // Opening a project or starting a new one replaces an edit that isn't in a project, so that asks first.
  const [confirm, setConfirm] = useState<{ what: string; run: () => Promise<unknown> } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setQ('');
    setConfirm(null);
    void projectController.refreshProjects();
  }, [open, projectController]);

  const close = () => store.setState({ projectsOpen: false });
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
  const save = () => go(() => projectController.saveAs(name.trim() || suggestion));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = projects.filter((p) => words.every((w) => `${p.name} ${metaOf(p, tracks)}`.toLowerCase().includes(w)));

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
        <button className="btn proj-new" disabled={busy} onClick={() => replace('Starting a new one', projectController.newProject)}>
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

      <div className="proj-list-h">
        <div className="lib-ph">Saved projects</div>
        {projects.length >= SEARCH_FROM && <FilterSearch value={q} onChange={setQ} placeholder="Search by name, look or song" />}
      </div>
      <div className="proj-list">
        {!projects.length && <div className="exp-empty">No saved projects yet. Name this edit above to save it.</div>}
        {projects.length > 0 && !shown.length && <NoMatch what="projects" onClear={() => setQ('')} />}
        {shown.map((p) => {
          const current = p.id === project?.id;
          return (
            <div className={`proj-row ${current ? 'on' : ''}`} key={p.id}>
              <button
                className="proj-open"
                disabled={current || busy}
                title={current ? 'This is the open project' : `Open ${p.name}`}
                onClick={() => replace(`Opening ${p.name}`, () => projectController.openProject(p.id))}
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
