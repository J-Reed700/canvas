import { useStudioStore } from './store.ts';
import { postJSON, toast } from '../lib/utils.ts';
import { editFields, editState, flushSave, resetHistory } from './historyController.ts';
import type { ProjectFile, ProjectRef, ProjectSummary } from '../engine/types.ts';

// Which project this browser has open, and the save of its file it last wrote or read.
const KEY = 'downbeat.project.v1';

// The edit as the open project's file has it, so a save that changes nothing isn't sent.
let written: string | null = null;
let writing: Promise<void> | null = null;
let again = false;

function remember(ref: ProjectRef | null) {
  try {
    if (ref) localStorage.setItem(KEY, JSON.stringify(ref));
    else localStorage.removeItem(KEY);
  } catch {
    /* the project still saves; this browser just won't reopen it on the next start */
  }
}

function readRef(): ProjectRef | null {
  try {
    const ref = JSON.parse(localStorage.getItem(KEY) || 'null');
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
  useStudioStore.setState({ project: ref, projectSync: 'saved' });
}

function lost(ref: ProjectRef) {
  setProject(null);
  useStudioStore.setState((s) => ({ projects: s.projects.filter((p) => p.id !== ref.id) }));
  toast(`${ref.name} has been deleted, so this edit isn't saved to a project now. Save it again to keep it.`, 5000);
}

/**
 * At startup: lists the projects and picks the edit the studio opens on. That's the session, unless the
 * open project's file was saved somewhere else (another tab or browser) after this browser last wrote it.
 */
export async function startingEdit(session: any): Promise<any> {
  written = null;
  const ref = readRef();
  const [list, file] = await Promise.all([
    getJSON<{ projects: ProjectSummary[] }>('/api/projects'),
    ref ? getJSON<{ project: ProjectFile }>(`/api/projects/${encodeURIComponent(ref.id)}`) : null,
  ]);
  useStudioStore.setState({ projects: list.body?.projects || [], project: null });
  if (!ref || !file) return session;
  if (file.status === 404) {
    lost(ref);
    return session;
  }
  if (!file.body) {
    // the server didn't answer: keep the project open and write to it once it does
    useStudioStore.setState({ project: ref });
    return session;
  }
  const p = file.body.project;
  setProject(refOf(p), p.data);
  return p.updated !== ref.updated ? { ...session, ...p.data } : session;
}

async function writeOnce(keepalive = false) {
  const { project } = useStudioStore.getState();
  if (!project) return;
  const json = JSON.stringify(editState());
  if (json === written) return;
  useStudioStore.setState({ projectSync: 'saving' });
  const r = await fetch('/api/projects/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: `{"id":${JSON.stringify(project.id)},"data":${json}}`,
    keepalive,
  })
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))
    .catch(() => ({ status: 0, body: {} as any }));
  if (useStudioStore.getState().project?.id !== project.id) return; // another project was opened meanwhile
  if (r.body.ok) {
    const p: ProjectSummary = r.body.project;
    setProject(refOf(p));
    written = json;
    useStudioStore.setState((s) => ({ projects: upsert(s.projects, p) }));
  } else if (r.status === 404) {
    lost(project);
  } else {
    // tried again on the next change
    useStudioStore.setState({ projectSync: 'failed' });
  }
}

/** Writes the edit to the open project's file if it changed. One write at a time; changes made while one is
 * out go in the next. Runs whenever the session is saved. */
export function syncProject(): Promise<void> {
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
export function flushProject() {
  void writeOnce(true);
}

/** Finishes writing the edit to the project being left. */
async function leave() {
  flushSave();
  await syncProject();
}

/** Puts a saved edit in the studio: its clips, song, look and cuts. Undo starts over from it. */
async function loadEdit(data: any) {
  const s = useStudioStore.getState();
  useStudioStore.setState(editFields(data || {}, s.clips, s.tracks));
  s.engine?.main?.reset();
  await s.selectTrack(useStudioStore.getState().trackId, { initial: typeof data?.loopStart === 'number' });
  resetHistory();
}

/** Lists the projects again, which picks up ones saved in another tab. */
export async function refreshProjects() {
  const r = await getJSON<{ projects: ProjectSummary[] }>('/api/projects');
  if (r.body) useStudioStore.setState({ projects: r.body.projects });
}

/** Saves the edit as a new project and keeps working in it. A project that was open keeps its last save. */
export async function saveAs(name: string): Promise<boolean> {
  await leave();
  const data = editState();
  const r = await postJSON<{ ok?: boolean; error?: string; project: ProjectSummary }>('/api/projects/create', { name, data });
  if (!r.ok) {
    toast(r.error || "The project couldn't be saved");
    return false;
  }
  setProject(refOf(r.project), data);
  useStudioStore.setState((s) => ({ projects: upsert(s.projects, r.project) }));
  toast(`Saved as ${r.project.name}`);
  return true;
}

/** ⌘S: the open project saves itself, so this writes it now and says so. An edit that isn't in a project
 * opens Projects to get a name. */
export async function saveNow() {
  const s = useStudioStore.getState();
  if (!s.project) {
    useStudioStore.setState({ projectsOpen: true });
    return;
  }
  await leave();
  const after = useStudioStore.getState();
  if (after.project) toast(after.projectSync === 'failed' ? `${after.project.name} couldn't be saved. Is the studio's server running?` : `Saved ${after.project.name}`);
}

export async function openProject(id: string): Promise<boolean> {
  await leave();
  const r = await getJSON<{ project: ProjectFile }>(`/api/projects/${encodeURIComponent(id)}`);
  if (!r.body) {
    if (r.status === 404) {
      useStudioStore.setState((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
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
export async function newProject() {
  await leave();
  const s = useStudioStore.getState();
  setProject(null);
  await loadEdit({ bpmOverride: s.bpmOverride, gridNudge: s.gridNudge });
  toast('New edit. Name it in Projects to save it');
}

export async function renameProject(id: string, name: string): Promise<boolean> {
  const r = await postJSON<{ ok?: boolean; error?: string; project: ProjectSummary }>('/api/projects/rename', { id, name });
  if (!r.ok) {
    toast(r.error || "The project couldn't be renamed");
    return false;
  }
  const p = r.project;
  useStudioStore.setState((s) => ({ projects: upsert(s.projects, p) }));
  if (useStudioStore.getState().project?.id === id) {
    remember(refOf(p));
    useStudioStore.setState({ project: refOf(p) });
  }
  return true;
}

/** Deletes the project's file. If it's the open one, the edit stays in the studio, saved only in this browser. */
export async function deleteProject(id: string) {
  const s = useStudioStore.getState();
  const name = s.projects.find((p) => p.id === id)?.name || 'The project';
  const r = await postJSON('/api/projects/delete', { id });
  if (!r.ok) {
    toast(r.error || "The project couldn't be deleted");
    return;
  }
  useStudioStore.setState((prev) => ({ projects: prev.projects.filter((p) => p.id !== id) }));
  if (useStudioStore.getState().project?.id === id) {
    setProject(null);
    toast(`Deleted ${name}. Its edit is still open here, but not saved to a project`, 4000);
  } else {
    toast(`Deleted ${name}`);
  }
}

/** Opens the edit an export was made from. It isn't in a project until it's saved as one. */
export async function openExportEdit(filename: string, title: string): Promise<boolean> {
  const r = await getJSON<{ data: unknown }>(`/api/projects/exports/${encodeURIComponent(filename)}`);
  if (!r.body?.data) {
    toast("This export doesn't have its edit saved with it");
    return false;
  }
  await leave();
  setProject(null);
  await loadEdit(r.body.data);
  useStudioStore.setState({ libraryOpen: false, libraryItem: null });
  toast(`Opened the edit of ${title}. Save it as a project to keep your changes`, 4000);
  return true;
}
