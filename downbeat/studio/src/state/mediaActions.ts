import { useStudioStore } from './store.ts';
import { fetchJSON, postJSON, shuffle, toast, detectSubject, sourceLabel, clipDisplayName, homeShort } from '../lib/utils.ts';
import { LOOKS } from '../engine/looks.ts';
import { resetHistory } from './historyController.ts';
import { uploadMedia, upsertMedia } from '../lib/mediaClient.ts';
import { clipIndex } from './mediaIndex.ts';
import type { ClipMeta, TrackMeta, RenderRecord, ClipPalette } from '../engine/types.ts';

/** The server's listing of the songs, the clips and the folders they come from. */
export interface LibraryInfo {
  ok?: boolean;
  error?: string;
  tracks: TrackMeta[];
  clips: ClipMeta[];
  folders: string[];
  suggestions: string[];
  can_pick: boolean;
  /** The folder just added, or null when the folder chooser was cancelled. */
  added?: string | null;
}

/** The clips a studio with nothing picked starts on: up to five, stock footage first. */
export const firstClips = (clips: ClipMeta[]) =>
  [...clips].sort((a, b) => (b.is_stock ? 1 : 0) - (a.is_stock ? 1 : 0)).slice(0, 5).map((c) => c.id);

/** A clip is loaded once it has been in the edit: its playback copy is made or being made. The other videos
 * in a folder are listed, dimmed, until they're added. */
export const isLoaded = (c: ClipMeta, selected: string[]) => c.proxy !== 'none' || selected.includes(c.id);

/** Asks the server to make playback copies for clips in the edit that don't have one yet. */
export async function requestProxies() {
  const s = useStudioStore.getState();
  const index = clipIndex(s.clips);
  const ids = s.selected.filter((id) => index.get(id)?.proxy === 'none');
  if (!ids.length) return;
  const requested = new Set(ids);
  const mark = (status: (id: string) => string | undefined) =>
    useStudioStore.setState((p) => ({ clips: p.clips.map((c) => (requested.has(c.id) ? { ...c, proxy: status(c.id) ?? c.proxy } : c)) }));
  mark(() => 'queued'); // so a second call while this one is out doesn't ask again
  const r = await postJSON<{ ok?: boolean; proxies?: Record<string, string> }>('/api/proxies', { ids }).catch(() => null);
  if (r?.proxies) mark((id) => r.proxies![id]);
}

const count = (n: number, what: string) => `${n || 'no'} ${what}${n === 1 ? '' : 's'}`;

/** Puts a listing from the server into the studio. Clips that are no longer listed leave the sequence. */
export function applyLibrary(r: LibraryInfo) {
  const s = useStudioStore.getState();
  const ids = new Set(r.clips.map((c) => c.id));
  const selected = s.selected.filter((id) => ids.has(id));
  useStudioStore.setState({ tracks: r.tracks, clips: r.clips, folders: r.folders, folderSuggestions: r.suggestions, canPick: r.can_pick, selected });
  if (selected.length !== s.selected.length) s.rebuild();
}

async function folderAdded(r: LibraryInfo) {
  const s = useStudioStore.getState();
  applyLibrary(r);
  if (!r.added) return;
  const folder = r.added;
  const clips = r.clips.filter((c) => c.path?.startsWith(folder + '/') || c.path?.startsWith(folder + '\\'));
  const songs = r.tracks.filter((t) => t.source === folder);
  const name = `the ${sourceLabel(folder)} folder`;
  toast(
    clips.length || songs.length
      ? `Added ${name}: ${count(clips.length, 'video')} and ${count(songs.length, 'song')}`
      : `Added ${name}. It has no videos or songs yet`,
    3600,
  );
  if (s.welcome) {
    // The studio was waiting on this folder: start it on a few of its clips and its newest song.
    useStudioStore.setState({ welcome: false, selected: firstClips(r.clips), blocks: null });
    s.rebuild();
    if (songs.length) await s.selectTrack(songs[0].id);
    resetHistory();
  }
}

/** Opens the system folder chooser (macOS only) and lists the folder picked. */
export async function pickFolder(): Promise<LibraryInfo> {
  const r = await postJSON<LibraryInfo>('/api/library/pick_folder', {});
  if (r.ok !== false) await folderAdded(r);
  return r;
}

/** Lists the videos and songs in the folder at `path`. */
export async function addFolder(path: string): Promise<LibraryInfo> {
  const r = await postJSON<LibraryInfo>('/api/library/folders', { add: path });
  if (r.ok !== false) await folderAdded(r);
  return r;
}

/** Stops listing a folder's videos and songs. The files stay where they are. */
export async function removeFolder(path: string) {
  const r = await postJSON<LibraryInfo>('/api/library/folders', { remove: path });
  if (r.ok !== false) applyLibrary(r);
}

export async function uploadFiles(files: File[]) {
  let n = 0;
  let stills = 0;
  let refresh = false;
  let pendingTrack: string | null = null;
  for (const f of files) {
    // the library lists the usual video types; the server turns other videos into an .mp4 first
    const convert = !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name) && (f.type.startsWith('video/') || /\.(avi|mts|m2ts|ts|wmv|flv|mpe?g|3gp|vob|ogv)$/i.test(f.name));
    toast(convert ? `Uploading ${f.name} and converting it to .mp4…` : `Uploading ${f.name}…`, convert ? 60000 : 6000);
    const r = await uploadMedia(f);
    if (!r.ok) {
      toast(r.error, 5000);
      continue;
    }
    n++;
    if (r.kind === 'video' && r.clip) {
      const clip = r.clip;
      useStudioStore.setState((state) => ({ clips: upsertMedia(state.clips, clip) }));
    } else if (r.kind === 'audio' && r.track) {
      const track = r.track;
      useStudioStore.setState((state) => ({ tracks: upsertMedia(state.tracks, track) }));
    } else {
      refresh = true;
    }
    if (r.still) {
      stills++;
      const curLook = useStudioStore.getState().look;
      if (!curLook?.id.startsWith('art-')) {
        const artPreset = LOOKS.find((l) => l.id === 'art-living-cover' || l.id === 'art-breathe');
        if (artPreset) {
          useStudioStore.getState().setLook(artPreset);
          toast('Applied the Living Cover Art look to your image');
        }
      }
    }
    if (r.kind === 'video' && !useStudioStore.getState().selected.includes(r.id)) {
      useStudioStore.setState((prev) => ({ selected: [...prev.selected, r.id] }));
    }
    if (r.kind === 'audio') {
      pendingTrack = r.track ? null : r.id;
      if (r.track) await useStudioStore.getState().selectTrack(r.id);
    }
  }
  if (n) {
    if (refresh) {
      const state = await fetchJSON<{ clips: ClipMeta[]; tracks: TrackMeta[] }>('/api/state').catch(() => null);
      if (state) useStudioStore.setState({ clips: state.clips, tracks: state.tracks });
    }
    if (pendingTrack) await useStudioStore.getState().selectTrack(pendingTrack);
    useStudioStore.setState({ welcome: false });
    useStudioStore.getState().rebuild();
    toast(
      stills
        ? `Added ${n} file${n > 1 ? 's' : ''}. For images, try the Album art & stills looks.`
        : `Added ${n} file${n > 1 ? 's' : ''}`,
      stills ? 4200 : 2400,
    );
  }
}

/** Takes a clip out of the library. The server deletes its own uploaded copy, or hides a file that
 * came from a picked folder so it stays on disk but doesn't come back. */
export async function removeClip(id: string) {
  const c = useStudioStore.getState().clips.find((x) => x.id === id);
  const r = await postJSON('/api/clip/remove', { id });
  if (!r.ok) {
    toast(r.error || "Couldn't remove the clip");
    return;
  }
  const without = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== id));
  useStudioStore.setState((p) => ({
    clips: p.clips.filter((x) => x.id !== id),
    selected: p.selected.filter((x) => x !== id),
    clipFrame: without(p.clipFrame),
    clipLooks: without(p.clipLooks),
    editClip: p.editClip === id ? null : p.editClip,
    blocks: null,
  }));
  useStudioStore.getState().rebuild();
  const name = c?.name ? clipDisplayName({ name: c.name, still: c.still }) : 'the clip';
  toast(r?.deleted ? `Removed ${name} and deleted its uploaded copy` : `Removed ${name}. The file is still in its folder.`, 3600);
}

/** Shows a clip's file in the Finder, or says where it is on a system without one. */
export async function revealClip(id: string) {
  const r = await postJSON<{ ok?: boolean; path?: string }>('/api/reveal', { clip_id: id });
  const path = useStudioStore.getState().clips.find((c) => c.id === id)?.path || r.path;
  if (!r.ok && path) toast(`The file is at ${homeShort(path)}`, 4000);
}

export async function autoFrame() {
  const s = useStudioStore.getState();
  if (!s.selected.length) {
    toast('Pick a few clips first');
    return;
  }
  toast('Finding subjects…');
  const found = { subject: 0, center: 0 };
  const nextFrame = { ...s.clipFrame };
  try {
    await Promise.all(
      s.selected.map(async (id) => {
        const r = await detectSubject(id);
        if (!r?.ok) return;
        if (r.method === 'subject') found.subject++;
        else found.center++;
        if (r.method === 'center') {
          delete nextFrame[id];
          return;
        }
        nextFrame[id] = [r.focus[0], 1 - r.focus[1], nextFrame[id]?.[2] || 1];
      }),
    );
  } finally {
    useStudioStore.setState({ clipFrame: nextFrame });
    s.rebuild();
    const parts = [found.subject && `${found.subject} on the subject`, found.center && `${found.center} centered`].filter(
      Boolean,
    );
    toast(parts.length ? `Auto-framed ${parts.join(', ')}. Drag the preview to adjust.` : 'Could not analyze the clips');
  }
}

export function reorderClips(action: 'all' | 'stock' | 'solo' | 'reverse' | 'shuffle' | { from: number; to: number }) {
  const s = useStudioStore.getState();
  if (!s.selected.length && action !== 'all' && action !== 'stock') return;
  let next = [...s.selected];
  if (action === 'all') {
    // Loaded clips only: adding every video in a big folder would start a playback copy for each.
    // With nothing loaded yet, it starts on a few, as a new studio does.
    const loaded = s.clips.filter((c) => isLoaded(c, s.selected));
    if (!loaded.length) {
      next = firstClips(s.clips);
      if (!next.length) {
        toast('No clips yet. Add videos or pick a folder first');
        return;
      }
      toast(`Using ${next.length} clip${next.length === 1 ? '' : 's'} to start. Click others to add them`);
    } else {
      next = [...s.selected, ...loaded.map((c) => c.id).filter((id) => !s.selected.includes(id))];
      const n = next.length;
      toast(`Using ${n === 1 ? 'the one' : `all ${n}`}${loaded.length < s.clips.length ? ' loaded' : ''} clip${n === 1 ? '' : 's'}`);
    }
  } else if (action === 'stock') {
    next = s.clips.filter((c) => c.is_stock).slice(0, 5).map((c) => c.id);
    if (!next.length) {
      toast('There are no stock clips in the library');
      return;
    }
    toast(`Using ${next.length} stock clip${next.length === 1 ? '' : 's'}`);
  } else if (action === 'solo') {
    next = [s.selected[0]];
    toast('Solo: first clip only');
  } else if (action === 'reverse') {
    next.reverse();
    toast('Reversed the sequence');
  } else if (action === 'shuffle') {
    shuffle(next);
    toast('Shuffled the sequence');
  } else if (typeof action === 'object') {
    const [item] = next.splice(action.from, 1);
    next.splice(action.to, 0, item);
  }
  useStudioStore.setState({ selected: next, blocks: null });
  s.rebuild();
}

export function toggleClip(id: string) {
  const s = useStudioStore.getState();
  const idx = s.selected.indexOf(id);
  const nextSelected = [...s.selected];
  if (idx >= 0) nextSelected.splice(idx, 1);
  else nextSelected.push(id);
  useStudioStore.setState({ selected: nextSelected, blocks: null });
  s.rebuild();
}

export async function fetchPalette(clipId: string) {
  if (!clipId || useStudioStore.getState().palettes[clipId]) return;
  const r = await fetchJSON<ClipPalette & { ok?: boolean }>(`/api/palette/${encodeURIComponent(clipId)}`).catch(() => null);
  if (r?.ok && r.colors) useStudioStore.setState((prev) => ({ palettes: { ...prev.palettes, [clipId]: r } }));
}
