import type { StudioStore } from './storeTypes.ts';
import type { StudioStorage } from '../lib/storage.ts';
import { postJSON, toast } from '../lib/utils.ts';
import { editFields, type HistoryController } from './historyController.ts';
import type { ProjectFile, ProjectRef, ProjectSummary } from '../engine/types.ts';

/** Owns projects state for one studio instance. */
export function createProjectController(store: StudioStore, history: Pick<HistoryController, 'editState' | 'flushSave' | 'resetHistory'>, storage: StudioStorage | null) {
  const { editState, flushSave, resetHistory } = history;

  // Which project this browser has open, and the save of its file it last wrote or read.
  const KEY = 'downbeat.project.v1';

  // The edit as the open project's file has it, so a save that changes nothing isn't sent.
  let written: string | null = null;
  let writing: Promise<void> | null = null;
  let again = false;

  function remember(ref: ProjectRef | null) {
    try {
      if (ref) storage?.setItem(KEY, JSON.stringify(ref));
      else storage?.removeItem(KEY);
    } catch {
      /* the project still saves; this browser just won't reopen it on the next start */
    }
  }

  function readRef(): ProjectRef | null {
    try {
      const ref = JSON.parse(storage?.getItem(KEY) || 'null');
      return ref && typeof ref.id === 'string' ? ref : null;
    } catch {
      return null;
    }
  }

  /** A GET that tells a missing project (404) apart from a server that didn't answer (status 0). */
  async function getJSON<T>(url: string): Promise<{ status: number; body: T | null }> {
    try {
      const r = await fetch(url);
      return { status: r.status, body: r.ok ? await r.json() : null };
    } catch {
      return { status: 0, body: null };
    }
  }

  const byUpdated = (list: ProjectSummary[]) => [...list].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const upsert = (list: ProjectSummary[], p: ProjectSummary) => byUpdated([...list.filter((x) => x.id !== p.id), p]);

  const refOf = (p: ProjectSummary | ProjectFile): ProjectRef => ({ id: p.id, name: p.name, updated: p.updated });

  /** Points the studio at a project whose file has `data`, or at none, which leaves the edit in this browser only. */
  function setProject(ref: ProjectRef | null, data?: unknown) {
    written = ref && data !== undefined ? JSON.stringify(data) : null;
    remember(ref);
    store.setState({ project: ref, projectSync: 'saved' });
  }

  function lost(ref: ProjectRef) {
    setProject(null);
    store.setState((s) => ({ projects: s.projects.filter((p) => p.id !== ref.id) }));
    toast(`${ref.name} has been deleted, so this edit isn't saved to a project now. Save it again to keep it.`, 5000);
  }

  /**
   * At startup: lists the projects and picks the edit the studio opens on. That's the session, unless the
   * open project's file was saved somewhere else (another tab or browser) after this browser last wrote it.
   */
  async function startingEdit(session: any, isCurrent = () => true): Promise<any> {
    written = null;
    const ref = readRef();
    const [list, file] = await Promise.all([
      getJSON<{ projects: ProjectSummary[] }>('/api/projects'),
      ref ? getJSON<{ project: ProjectFile }>(`/api/projects/${encodeURIComponent(ref.id)}`) : null,
    ]);
    if (!isCurrent()) return session;
    store.setState({ projects: list.body?.projects || [], project: null });
    if (!ref || !file) return session;
    if (file.status === 404) {
      lost(ref);
      return session;
    }
    if (!file.body) {
      // the server didn't answer: keep the project open and write to it once it does
      store.setState({ project: ref });
      return session;
    }
    const p = file.body.project;
    setProject(refOf(p), p.data);
    return p.updated !== ref.updated ? { ...session, ...p.data } : session;
  }

  async function writeOnce(keepalive = false) {
    const { project } = store.getState();
    if (!project) return;
    const json = JSON.stringify(editState());
    if (json === written) return;
    store.setState({ projectSync: 'saving' });
    const r = await fetch('/api/projects/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"id":${JSON.stringify(project.id)},"data":${json}}`,
      keepalive,
    })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))
      .catch(() => ({ status: 0, body: {} as any }));
    if (store.getState().project?.id !== project.id) return; // another project was opened meanwhile
    if (r.body.ok) {
      const p: ProjectSummary = r.body.project;
      setProject(refOf(p));
      written = json;
      store.setState((s) => ({ projects: upsert(s.projects, p) }));
    } else if (r.status === 404) {
      lost(project);
    } else {
      // tried again on the next change
      store.setState({ projectSync: 'failed' });
    }
  }

  /** Writes the edit to the open project's file if it changed. One write at a time; changes made while one is
   * out go in the next. Runs whenever the session is saved. */
  function syncProject(): Promise<void> {
    if (writing) {
      again = true;
      return writing;
    }
    writing = (async () => {
      do {
        again = false;
        await writeOnce();
      } while (again);
    })().finally(() => {
      writing = null;
    });
    return writing;
  }

  /** The page is closing: send the last edit with a request that outlives the page. */
  function flushProject() {
    void writeOnce(true);
  }

  /** Finishes writing the edit to the project being left. */
  async function leave() {
    flushSave();
    await syncProject();
  }

  /** Puts a saved edit in the studio: its clips, song, look and cuts. Undo starts over from it. */
  async function loadEdit(data: any) {
    const s = store.getState();
    store.setState(editFields(data || {}, s.clips, s.tracks));
    s.engine?.main?.reset();
    await s.selectTrack(store.getState().trackId, { initial: typeof data?.loopStart === 'number' });
    resetHistory();
  }

  /** Lists the projects again, which picks up ones saved in another tab. */
  async function refreshProjects() {
    const r = await getJSON<{ projects: ProjectSummary[] }>('/api/projects');
    if (r.body) store.setState({ projects: r.body.projects });
  }

  /** Saves the edit as a new project and keeps working in it. A project that was open keeps its last save. */
  async function saveAs(name: string): Promise<boolean> {
    await leave();
    const data = editState();
    const r = await postJSON<{ ok?: boolean; error?: string; project: ProjectSummary }>('/api/projects/create', { name, data });
    if (!r.ok) {
      toast(r.error || "The project couldn't be saved");
      return false;
    }
    setProject(refOf(r.project), data);
    store.setState((s) => ({ projects: upsert(s.projects, r.project) }));
    toast(`Saved as ${r.project.name}`);
    return true;
  }

  /** ⌘S: the open project saves itself, so this writes it now and says so. An edit that isn't in a project
   * opens Projects to get a name. */
  async function saveNow() {
    const s = store.getState();
    if (!s.project) {
      store.setState({ projectsOpen: true });
      return;
    }
    await leave();
    const after = store.getState();
    if (after.project) toast(after.projectSync === 'failed' ? `${after.project.name} couldn't be saved. Is the studio's server running?` : `Saved ${after.project.name}`);
  }

  async function openProject(id: string): Promise<boolean> {
    await leave();
    const r = await getJSON<{ project: ProjectFile }>(`/api/projects/${encodeURIComponent(id)}`);
    if (!r.body) {
      if (r.status === 404) {
        store.setState((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
        toast('That project has been deleted');
      } else {
        toast("The project couldn't be opened");
      }
      return false;
    }
    const p = r.body.project;
    setProject(refOf(p), p.data);
    await loadEdit(p.data);
    toast(`Opened ${p.name}`);
    return true;
  }

  /** Starts over on the first look, the first few clips and the newest song, in no project until it's saved.
   * Tempo fixes for songs carry over, since they belong to the song. */
  async function newProject() {
    await leave();
    const s = store.getState();
    setProject(null);
    await loadEdit({ bpmOverride: s.bpmOverride, gridNudge: s.gridNudge });
    toast('New edit. Name it in Projects to save it');
  }

  async function renameProject(id: string, name: string): Promise<boolean> {
    const r = await postJSON<{ ok?: boolean; error?: string; project: ProjectSummary }>('/api/projects/rename', { id, name });
    if (!r.ok) {
      toast(r.error || "The project couldn't be renamed");
      return false;
    }
    const p = r.project;
    store.setState((s) => ({ projects: upsert(s.projects, p) }));
    if (store.getState().project?.id === id) {
      remember(refOf(p));
      store.setState({ project: refOf(p) });
    }
    return true;
  }

  /** Deletes the project's file. If it's the open one, the edit stays in the studio, saved only in this browser. */
  async function deleteProject(id: string) {
    const s = store.getState();
    const name = s.projects.find((p) => p.id === id)?.name || 'The project';
    const r = await postJSON('/api/projects/delete', { id });
    if (!r.ok) {
      toast(r.error || "The project couldn't be deleted");
      return;
    }
    store.setState((prev) => ({ projects: prev.projects.filter((p) => p.id !== id) }));
    if (store.getState().project?.id === id) {
      setProject(null);
      toast(`Deleted ${name}. Its edit is still open here, but not saved to a project`, 4000);
    } else {
      toast(`Deleted ${name}`);
    }
  }

  /** Opens the edit an export was made from. It isn't in a project until it's saved as one. */
  async function openExportEdit(filename: string, title: string): Promise<boolean> {
    const r = await getJSON<{ data: unknown }>(`/api/projects/exports/${encodeURIComponent(filename)}`);
    if (!r.body?.data) {
      toast("This export doesn't have its edit saved with it");
      return false;
    }
    await leave();
    setProject(null);
    await loadEdit(r.body.data);
    store.setState({ libraryOpen: false, libraryItem: null });
    toast(`Opened the edit of ${title}. Save it as a project to keep your changes`, 4000);
    return true;
  }

  return { startingEdit, syncProject, flushProject, refreshProjects, saveAs, saveNow, openProject, newProject, renameProject, deleteProject, openExportEdit };
}

export type ProjectController = ReturnType<typeof createProjectController>;
