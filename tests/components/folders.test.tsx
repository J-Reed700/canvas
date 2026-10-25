import React from 'react';
import { describe, expect, test } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { Welcome } from '../../downbeat/studio/src/components/Welcome/Welcome.tsx';
import { MediaPanel } from '../../downbeat/studio/src/components/MediaPanel/MediaPanel.tsx';
import { App } from '../../downbeat/studio/src/components/App/App.tsx';
import { S, SONG, posted, renderStudio, resetStudio, screen, serve, st, toastText, update } from './studio.tsx';

const FOLDER = '/Users/me/Movies/Canvas';
const clip = (id: string, name: string, extra = {}) => ({ id, name, path: `${FOLDER}/${name}`, duration: 8, width: 1080, height: 1920, proxy: 'queued', ...extra });
const LIB = {
  ok: true,
  clips: [clip('v1', 'beach.mp4'), clip('v2', 'city.mp4'), clip('v3', '0042_stock.mp4', { is_stock: true }), clip('v4', 'night.mov'), clip('v5', 'rain.mp4')],
  tracks: [
    { id: 's1', name: 'Newest.wav', path: `${FOLDER}/Newest.wav`, source: FOLDER, dir: '', mtime: 9 },
    { id: 's2', name: 'Older.mp3', path: `${FOLDER}/Older.mp3`, source: FOLDER, dir: '', mtime: 2 },
  ],
  folders: [FOLDER],
  suggestions: [],
  can_pick: true,
  added: FOLDER,
};

/** A studio opened for the first time: no folder, no clips, nothing picked. */
const firstRun = (over = {}) => resetStudio({ clips: [], selected: [], welcome: true, canPick: true, ...over });
const welcome = () => document.querySelector('.welcome');

describe('first run', () => {
  test('with no folder picked, the studio waits on one big Pick a folder button', async () => {
    const fetch = serve({ 'POST /api/library/pick_folder': () => LIB, '/api/features/*': () => ({ ...SONG, id: 's1' }) });
    firstRun();
    st().transport.decode = async () => ({ duration: 180 }) as any;
    renderStudio(<Welcome />);
    expect(screen.getByRole('dialog').textContent).toContain('Your studio starts here.');
    expect(Array.from(welcome()!.querySelectorAll('button.btn')).map((b) => b.textContent)).toEqual(['Pick a folder']);

    fireEvent.click(screen.getByText('Pick a folder'));
    expect(welcome()!.textContent).toContain('A folder chooser opened');
    expect((screen.getByText('Pick a folder') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(welcome()).toBeNull());
    expect(posted(fetch, '/api/library/pick_folder')).toEqual([{}]);
    expect(st().clips).toHaveLength(5);
    expect(st().selected, 'five clips, stock footage first').toEqual(['v3', 'v1', 'v2', 'v4', 'v5']);
    expect(st().folders).toEqual([FOLDER]);
    await waitFor(() => expect(st().trackId, 'the newest song in the folder').toBe('s1'));
    expect(toastText()).toBe('Added the Canvas folder: 5 videos and 2 songs');
  });

  test('cancelling the folder chooser keeps the button up', async () => {
    serve({ 'POST /api/library/pick_folder': () => ({ ...LIB, clips: [], tracks: [], folders: [], added: null }) });
    firstRun();
    renderStudio(<Welcome />);
    fireEvent.click(screen.getByText('Pick a folder'));
    await waitFor(() => expect((screen.getByText('Pick a folder') as HTMLButtonElement).disabled).toBe(false));
    expect(st().welcome).toBe(true);
    expect(welcome()!.textContent).not.toContain('A folder chooser opened');
  });

  test('without a folder chooser the button opens a path box, which reports a folder that is not there', async () => {
    const fetch = serve({
      'POST /api/library/folders': (_u, init) => {
        const add = JSON.parse(String(init.body)).add;
        return add === '/nope' ? new Response(JSON.stringify({ ok: false, error: 'No folder at /nope' }), { status: 400 }) : { ...LIB, tracks: [], added: add };
      },
    });
    firstRun({ canPick: false });
    renderStudio(<Welcome />);
    expect(screen.queryByText('Type a path instead'), 'there is nothing else to choose').toBeNull();
    fireEvent.click(screen.getByText('Pick a folder'));
    const input = screen.getByLabelText('Folder path') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/nope' } });
    fireEvent.submit(input.form!);
    await waitFor(() => expect(welcome()!.querySelector('.tp-err')!.textContent).toBe('No folder at /nope'));
    fireEvent.change(input, { target: { value: FOLDER } });
    fireEvent.submit(input.form!);
    await waitFor(() => expect(welcome()).toBeNull());
    expect(posted(fetch, '/api/library/folders').at(-1)).toEqual({ add: FOLDER });
    expect(st().trackId, 'no song in the folder, so none is picked').toBe('');
    expect(toastText()).toBe('Added the Canvas folder: 5 videos and no songs');
  });

  test('on a Mac a path can be typed instead of using the chooser', () => {
    serve({});
    firstRun();
    renderStudio(<Welcome />);
    fireEvent.click(screen.getByText('Type a path instead'));
    expect(screen.getByLabelText('Folder path')).toBeTruthy();
    expect(screen.queryByText('Type a path instead')).toBeNull();
  });

  test("the studio's shortcuts wait until a folder is picked", () => {
    firstRun();
    update(() => S.setState({ initStudio: (() => {}) as any }));
    renderStudio(<App />);
    const lookId = st().lookId;
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: ' ' });
    expect(st().lookId).toBe(lookId);
    expect(st().transport.playing).toBe(false);
  });
});

describe('adding a folder later', () => {
  test('+ Add a folder in Clips lists its videos and leaves the clips in use alone', async () => {
    serve({ 'POST /api/library/folders': (_u, init) => ({ ...LIB, clips: [...st().clips, ...LIB.clips], added: JSON.parse(String(init.body)).add }) });
    resetStudio();
    renderStudio(<MediaPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a folder' }));
    const input = screen.getByLabelText('Folder path') as HTMLInputElement;
    fireEvent.change(input, { target: { value: FOLDER } });
    fireEvent.submit(input.form!);
    await waitFor(() => expect(toastText()).toBe('Added the Canvas folder: 5 videos and 2 songs'));
    expect(screen.queryByLabelText('Folder path'), 'the path box closes').toBeNull();
    expect(document.querySelectorAll('#clips .clip')).toHaveLength(8);
    expect(st().selected).toEqual(['a', 'b', 'c']);
    expect(st().trackId, 'adding a folder later picks no song').toBe('');
  });

  test('clips from a folder that is taken away leave the sequence', async () => {
    const { removeFolder } = (await import('../../downbeat/studio/src/state/store.ts')).studioRuntime.media;
    serve({ 'POST /api/library/folders': () => ({ ...LIB, clips: [st().clips[0]], tracks: [], folders: [], added: null }) });
    resetStudio();
    await removeFolder(FOLDER);
    expect(st().clips.map((c) => c.id)).toEqual(['a']);
    expect(st().selected).toEqual(['a']);
  });
});
