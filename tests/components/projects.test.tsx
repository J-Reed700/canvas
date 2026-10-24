import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ProjectButton, ProjectsModal } from '../../downbeat/studio/src/components/Projects.tsx';
import { ExportsLibrary } from '../../downbeat/studio/src/components/Exports.tsx';
import { App } from '../../downbeat/studio/src/App.tsx';
import { LOOKS, S, SONG, TRACKS, posted, renderStudio, resetStudio, screen, serve, st, toastText, update, withSong } from './studio.tsx';

const NOW = Math.floor(Date.now() / 1000);
const PROJECTS = [
  { id: 'aaaaaaaaaaaa', name: 'Night Drive edit', updated: NOW - 120, clips: 3, first_clip: 'a', track_id: 't1', look: 'Neon Tide', bars: 4 },
  { id: 'bbbbbbbbbbbb', name: 'Square promo', updated: NOW - 7200, clips: 1, first_clip: null, track_id: null, look: 'Halftone', bars: 1 },
];
const FILE = { id: 'bbbbbbbbbbbb', name: 'Square promo', updated: NOW - 7200, data: { selected: ['c'], trackId: '', bars: 1, seed: 5 } };

/** A server with the two projects above that answers every project call. */
function projectServer(extra: Record<string, (u: string, i: RequestInit) => unknown> = {}) {
  return serve({
    '/api/projects': () => ({ ok: true, projects: PROJECTS }),
    '/api/projects/bbbbbbbbbbbb': () => ({ ok: true, project: FILE }),
    'POST /api/projects/create': (_u, i) => ({ ok: true, project: { ...PROJECTS[0], id: 'cccccccccccc', name: JSON.parse(String(i.body)).name, updated: NOW } }),
    'POST /api/projects/save': (_u, i) => ({ ok: true, project: { ...PROJECTS[0], id: JSON.parse(String(i.body)).id, updated: NOW } }),
    'POST /api/projects/rename': (_u, i) => ({ ok: true, project: { ...PROJECTS[0], name: JSON.parse(String(i.body)).name.trim() } }),
    'POST /api/projects/delete': () => ({ ok: true }),
    '/api/features/t1': () => SONG,
    ...extra,
  });
}

const openDialog = (over = {}) => {
  resetStudio({ projects: PROJECTS, projectsOpen: true, project: null, ...over });
  st().transport.decode = async () => ({ duration: 180 }) as any;
  return renderStudio(<ProjectsModal />);
};
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.proj-row'));
const confirmBar = () => document.querySelector('.proj-confirm');

describe('the top bar project button', () => {
  test('says when the edit is only in this browser, and opens Projects', () => {
    resetStudio({ project: null });
    renderStudio(<ProjectButton />);
    const btn = document.getElementById('btnProjects')!;
    expect(btn.textContent).toBe('UntitledNot saved');
    expect(btn.className).toContain('unsaved');
    fireEvent.click(btn);
    expect(st().projectsOpen).toBe(true);
  });

  test('names the open project and shows whether its file is up to date', () => {
    resetStudio({ project: { id: 'aaaaaaaaaaaa', name: 'Night Drive edit' }, projectSync: 'saved' });
    renderStudio(<ProjectButton />);
    const btn = () => document.getElementById('btnProjects')!;
    expect(btn().textContent).toBe('Night Drive editSaved');
    update(() => S.setState({ projectSync: 'saving' }));
    expect(btn().textContent).toBe('Night Drive editSaving');
    update(() => S.setState({ projectSync: 'failed' }));
    expect(btn().textContent).toBe("Night Drive editCouldn't save");
    expect(btn().title).toMatch(/tried again on the next change/);
  });
});

describe('the projects dialog', () => {
  test('lists the projects with their look, clips, length, song and age', () => {
    projectServer();
    openDialog({ tracks: TRACKS.map((t) => ({ ...t })), project: { id: 'aaaaaaaaaaaa', name: 'Night Drive edit' } });
    expect(rows().map((r) => r.querySelector('b')!.textContent)).toEqual(['Night Drive edit', 'Square promo']);
    const [first, second] = rows().map((r) => Array.from(r.querySelectorAll('.proj-cap span')).map((s) => s.textContent));
    expect(first).toEqual(['Neon Tide · 3 clips · 4 bars · Night Drive', 'Open now']);
    expect(second).toEqual(['Halftone · 1 clip · 1 bar', 'Saved 2 h ago']);
    expect(rows()[0].className).toContain('on');
    expect(rows()[0].querySelector<HTMLButtonElement>('.proj-open')!.disabled).toBe(true);
    expect((rows()[0].querySelector('.proj-thumb') as HTMLElement).style.backgroundImage).toContain('/api/thumb/a?w=120');
  });

  test('saves an unsaved edit under the name typed, or the song and look when left empty', async () => {
    const fetch = projectServer({ '/api/projects': () => ({ ok: true, projects: [] }) });
    withSong();
    st().transport.decode = async () => ({ duration: 180 }) as any;
    update(() => S.setState({ projectsOpen: true }));
    renderStudio(<ProjectsModal />);
    expect(screen.getByText("This edit isn't in a project yet")).toBeTruthy();
    expect(screen.getByText('No saved projects yet. Name this edit above to save it.')).toBeTruthy();
    const name = screen.getByLabelText('Project name') as HTMLInputElement;
    expect(name.placeholder).toBe(`Night Drive · ${LOOKS[0].name}`);
    fireEvent.click(screen.getByText('Save as project'));
    await waitFor(() => expect(st().projectsOpen).toBe(false));
    expect(posted(fetch, '/api/projects/create')[0].name).toBe(`Night Drive · ${LOOKS[0].name}`);
    expect(posted(fetch, '/api/projects/create')[0].data.trackId).toBe('t1');
    expect(st().project!.id).toBe('cccccccccccc');
    expect(toastText()).toBe(`Saved as Night Drive · ${LOOKS[0].name}`);
  });

  test('opening a project over an unsaved edit asks first', async () => {
    const fetch = projectServer();
    openDialog();
    fireEvent.click(within(rows()[1]).getByTitle('Open Square promo'));
    expect(confirmBar()!.textContent).toMatch(/^This edit isn't saved to a project\. Opening Square promo replaces it\./);
    fireEvent.click(within(confirmBar() as HTMLElement).getByText('Cancel'));
    expect(confirmBar()).toBeNull();
    expect(fetch.mock.calls.some(([u]) => String(u) === '/api/projects/bbbbbbbbbbbb')).toBe(false);

    fireEvent.click(within(rows()[1]).getByTitle('Open Square promo'));
    fireEvent.click(within(confirmBar() as HTMLElement).getByText('Replace it'));
    await waitFor(() => expect(st().projectsOpen).toBe(false));
    expect([st().project?.name, st().selected, st().bars, st().seed]).toEqual(['Square promo', ['c'], 1, 5]);
    expect(toastText()).toBe('Opened Square promo');
  });

  test('with a project open, another one opens straight away and New needs no confirmation', async () => {
    projectServer();
    openDialog({ project: { id: 'aaaaaaaaaaaa', name: 'Night Drive edit' } });
    fireEvent.click(within(rows()[1]).getByTitle('Open Square promo'));
    expect(confirmBar()).toBeNull();
    await waitFor(() => expect(st().project?.name).toBe('Square promo'));

    update(() => S.setState({ projectsOpen: true }));
    fireEvent.click(screen.getByText('New project'));
    await waitFor(() => expect(st().projectsOpen).toBe(false));
    expect(st().project).toBeNull();
    expect(toastText()).toBe('New edit. Name it in Projects to save it');
  });

  test('the open project is renamed in its name field, and Escape puts the name back', async () => {
    const fetch = projectServer();
    openDialog({ project: { id: 'aaaaaaaaaaaa', name: 'Night Drive edit' } });
    const field = screen.getByLabelText('Project name') as HTMLInputElement;
    expect(field.value).toBe('Night Drive edit');
    fireEvent.change(field, { target: { value: 'Typo' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.value).toBe('Night Drive edit');
    fireEvent.blur(field);
    expect(posted(fetch, '/api/projects/rename')).toEqual([]);

    field.focus();
    fireEvent.change(field, { target: { value: '  Club mix ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(st().project?.name).toBe('Club mix'));
    expect(posted(fetch, '/api/projects/rename')).toEqual([{ id: 'aaaaaaaaaaaa', name: 'Club mix' }]);
    // the copy is named after the project
    expect((screen.getByLabelText('Name of the copy') as HTMLInputElement).placeholder).toBe('Club mix copy');
    expect(screen.getByText('Save a copy')).toBeTruthy();
  });

  test('deleting a project takes a second click', async () => {
    const fetch = projectServer();
    openDialog({ project: { id: 'aaaaaaaaaaaa', name: 'Night Drive edit' } });
    const del = within(rows()[1]).getByLabelText('Delete Square promo');
    fireEvent.click(del);
    expect(del.textContent).toBe('Delete?');
    expect(posted(fetch, '/api/projects/delete')).toEqual([]);
    fireEvent.click(del);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(posted(fetch, '/api/projects/delete')).toEqual([{ id: 'bbbbbbbbbbbb' }]);
    expect(toastText()).toBe('Deleted Square promo');
  });
});

describe('project shortcuts', () => {
  function renderApp() {
    update(() => S.setState({ initStudio: vi.fn() } as any));
    return render(<App />);
  }
  const press = (key: string, o: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key, ...o });

  test('⌘S asks for a name when the edit has no project, ⌘O opens Projects, Escape closes it', async () => {
    projectServer();
    resetStudio({ project: null, tab: 'looks' });
    renderApp();
    press('s', { metaKey: true });
    await waitFor(() => expect(st().projectsOpen).toBe(true));
    expect(st().safe, 'not the safe-zone toggle').toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Project name'));
    press('Escape');
    expect(st().projectsOpen).toBe(false);
    press('o', { ctrlKey: true });
    expect(st().projectsOpen).toBe(true);
    // letter shortcuts wait while the dialog is open
    const look = st().lookId;
    press('d');
    expect(st().lookId).toBe(look);
  });

  test('⌘S saves the open project now', async () => {
    const fetch = projectServer();
    resetStudio({ project: { id: 'aaaaaaaaaaaa', name: 'Night Drive edit' }, tab: 'looks' });
    renderApp();
    act(() => st().setBars(2));
    press('s', { metaKey: true });
    await waitFor(() => expect(toastText()).toBe('Saved Night Drive edit'));
    expect(posted(fetch, '/api/projects/save').at(-1).data.bars).toBe(2);
    expect(st().projectsOpen).toBe(false);
  });
});

describe('opening an export\'s edit', () => {
  const RENDER = { filename: 'canvas-neon-120bpm-8.0s-1080x1920-20261024.mp4', url: '/out/neon.mp4', look: 'Neon', format: 'spotify', size_mb: 2, checks: [] };

  test('shows only for exports that kept their edit, and asks before replacing an unsaved one', async () => {
    const fetch = projectServer({
      [`/api/projects/exports/${RENDER.filename}`]: () => ({ ok: true, data: { selected: ['b'], trackId: '', bars: 2, seed: 42 } }),
    });
    resetStudio({ renders: [RENDER], libraryOpen: true, libraryItem: RENDER.filename, project: null });
    st().transport.decode = async () => ({ duration: 180 }) as any;
    const { unmount } = renderStudio(<ExportsLibrary />);
    expect(screen.queryByText('Open the edit')).toBeNull();
    unmount();

    resetStudio({ renders: [{ ...RENDER, has_edit: true }], libraryOpen: true, libraryItem: RENDER.filename, project: null });
    renderStudio(<ExportsLibrary />);
    fireEvent.click(screen.getByText('Open the edit'));
    expect(screen.getByText('Replace the unsaved edit?')).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).includes('/api/projects/exports/'))).toBe(false);
    fireEvent.click(screen.getByText('Replace the unsaved edit?'));
    await waitFor(() => expect(st().libraryOpen).toBe(false));
    expect([st().selected, st().bars, st().seed, st().project]).toEqual([['b'], 2, 42, null]);
    expect(toastText()).toBe('Opened the edit of Neon. Save it as a project to keep your changes');
  });
});
