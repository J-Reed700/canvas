import { useStudioStore } from './store.ts';
import { fetchJSON, postJSON, shuffle, toast, detectSubject } from '../lib/utils.ts';
import { LOOKS } from '../engine/looks.ts';
import type { ClipMeta, TrackMeta, RenderRecord, ClipPalette } from '../engine/types.ts';

export async function uploadFiles(files: File[]) {
  let n = 0;
  let stills = 0;
  for (const f of files) {
    toast(`Uploading ${f.name}…`, 6000);
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(f.name) },
      body: f,
    })
      .then((x) => x.json())
      .catch(() => ({}));
    if (!r.ok) {
      toast(`Could not add ${f.name}`);
      continue;
    }
    n++;
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
    const st = await fetchJSON<{ clips: ClipMeta[]; tracks: TrackMeta[]; renders: RenderRecord[] }>('/api/state').catch(
      () => null,
    );
    if (st) useStudioStore.setState({ clips: st.clips, tracks: st.tracks });
    if (r.kind === 'video' && !useStudioStore.getState().selected.includes(r.id)) {
      useStudioStore.setState((prev) => ({ selected: [...prev.selected, r.id] }));
    }
    if (r.kind === 'audio') {
      await useStudioStore.getState().selectTrack(r.id);
    }
  }
  if (n) {
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
 * came from ~/Downloads so it stays on disk but doesn't come back. */
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
    segOverrides: {},
  }));
  useStudioStore.getState().rebuild();
  const name = c?.still ? c.name.replace(/\.still\.mp4$/, '') : c?.name || 'the clip';
  toast(r?.deleted ? `Removed ${name} and deleted its uploaded copy` : `Removed ${name}. The file is still in your Downloads folder.`, 3600);
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

export function reorderClips(action: 'all' | 'solo' | 'reverse' | 'shuffle' | { from: number; to: number }) {
  const s = useStudioStore.getState();
  if (!s.selected.length) return;
  let next = [...s.selected];
  if (action === 'all') {
    next = [...s.selected, ...s.clips.map((c) => c.id).filter((id) => !s.selected.includes(id))];
    toast(`Using all ${next.length} clips`);
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
  useStudioStore.setState({ selected: next, segOverrides: {} });
  s.rebuild();
}

export function toggleClip(id: string) {
  const s = useStudioStore.getState();
  const idx = s.selected.indexOf(id);
  const nextSelected = [...s.selected];
  if (idx >= 0) nextSelected.splice(idx, 1);
  else nextSelected.push(id);
  useStudioStore.setState({ selected: nextSelected, segOverrides: {} });
  s.rebuild();
}

export async function fetchPalette(clipId: string) {
  if (!clipId || useStudioStore.getState().palettes[clipId]) return;
  const r = await fetchJSON<ClipPalette & { ok?: boolean }>(`/api/palette/${encodeURIComponent(clipId)}`).catch(() => null);
  if (r?.ok && r.colors) useStudioStore.setState((prev) => ({ palettes: { ...prev.palettes, [clipId]: r } }));
}
