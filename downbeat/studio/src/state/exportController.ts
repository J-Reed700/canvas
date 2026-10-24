import { useStudioStore } from './store.ts';
import { exportLoop } from '../engine/exporter.ts';
import { cloneLook } from '../engine/looks.ts';
import { FORMATS, SIZES, toast, h, postJSON, saveToDownloads, siblingTracks, fmt as fmtTime } from '../lib/utils.ts';
import type { RenderRecord, ComposeContext } from '../engine/types.ts';
import { CHECK_ICONS } from '../lib/exportsView.ts';

let exportAbortCtrl: AbortController | null = null;

export function autoSave(res: RenderRecord) {
  const s = useStudioStore.getState();
  if (s.exportOpts.autoSave === false) return;
  saveToDownloads(res.url, res.filename);
  if (res.promo_url) setTimeout(() => saveToDownloads(res.promo_url!, ''), 400);
  if (res.cover_url) setTimeout(() => saveToDownloads(res.cover_url!, ''), 800);
}

// The export sheet's form belongs to React. Progress and results go in #exportStatus, which React
// never renders into, and the form is hidden while they show. No nodes puts the form back.
function sheetStatus(...nodes: (Node | null)[]): void {
  const form = document.getElementById('exportForm');
  const status = document.getElementById('exportStatus');
  if (!form || !status) return;
  form.hidden = nodes.length > 0;
  status.replaceChildren(...nodes.filter((n): n is Node => !!n));
  if (nodes.length) useStudioStore.setState({ exportOpen: true });
}

function closeSheet(): void {
  useStudioStore.setState({ exportOpen: false });
  sheetStatus();
}

export function showResult(r: RenderRecord) {
  const checks = r.checks || [];
  const fails = checks.filter((c) => c.level === 'fail').length;

  let headerText = 'Ready for Spotify';
  if (r.format === 'cover_art') headerText = 'Cover art and loop exported';
  else if (r.format === 'youtube_16_9') headerText = 'YouTube video exported';
  else if (r.format === 'social_square') headerText = 'Square video exported';
  else if (r.format && r.format.startsWith('apple_')) headerText = 'Ready for Apple Music';

  sheetStatus(
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between' },
      h('h2', {}, fails ? 'Exported, but some checks failed' : headerText),
      h(
        'button',
        { class: 'btn icon', onclick: closeSheet },
        '✕',
      ),
    ),
    h(
      'div',
      { class: 'note' },
      `${r.filename} · ${r.size_mb} MB${r.seconds ? ` · rendered in ${r.seconds.toFixed(1)} s` : ''}${r.codec ? ` (${r.codec})` : ''}`,
    ),
    h(
      'div',
      { class: 'checks' },
      ...checks.map((c) =>
        h(
          'div',
          { class: `ck ${c.level}` },
          h('span', { class: 'ic' }, CHECK_ICONS[c.level]),
          h('b', {}, c.label),
          h('span', {}, c.detail || ''),
        ),
      ),
    ),
    h(
      'div',
      { class: 'actions', style: 'flex-wrap: wrap; gap: 8px;' },
      h('a', { class: 'btn primary', href: r.url, download: r.filename }, '↓ Download MP4'),
      r.cover_url ? h('a', { class: 'btn primary', href: r.cover_url, download: '' }, '↓ 3000×3000 Cover JPG') : null,
      r.audio_url ? h('a', { class: 'btn', href: r.audio_url, download: '' }, '↓ With audio') : null,
      r.promo_url ? h('a', { class: 'btn', href: r.promo_url, download: '' }, '↓ Promo with song') : null,
      h('button', { class: 'btn sm', onclick: () => useStudioStore.getState().exportCompanion({ filename: r.filename, kind: 'gif' }) }, '↓ GIF teaser'),
      h('button', { class: 'btn sm', onclick: () => useStudioStore.getState().exportCompanion({ filename: r.filename, kind: 'webp' }) }, '↓ WebP teaser'),
      h('button', { class: 'btn', onclick: () => useStudioStore.getState().reveal(r.filename) }, 'Reveal in Finder'),
    ),
  );
}

export async function renderOnce(onProgress?: (progress: any) => void): Promise<RenderRecord> {
  const s = useStudioStore.getState();
  if (!s.ctx || !s.look) throw new Error('No ctx or look');
  const o = s.exportOpts;
  const fmt = o.format || 'spotify';
  const isAudioFmt = fmt === 'spotify' || fmt === 'youtube_16_9' || fmt === 'social_square';
  const promoSeconds = s.features && isAudioFmt ? o.promo || 0 : 0;
  const withAudio = !!s.features && isAudioFmt && o.audio !== false;
  const [W, H] = (o.format && FORMATS[o.format]?.size) || (o.size && SIZES[o.size]) || SIZES.master;

  const wasPlaying = s.transport.playing;
  s.transport.pause();
  useStudioStore.setState({ exporting: true });
  document.body.classList.add('exporting');

  const snapshotCtx: ComposeContext = {
    ...s.ctx,
    look: cloneLook(s.ctx.look),
  };

  try {
    return await exportLoop({
      engine: s.engine,
      bank: s.bank,
      ctx: snapshotCtx,
      width: W,
      height: H,
      // 50 Mbps keeps short loops pristine; past a minute that's ~375 MB a minute, so drop to 20
      bitrate: fmt === 'spotify' ? undefined : s.ctx.L > 60 ? 20_000_000 : 50_000_000,
      meta: {
        look: s.look.name,
        bpm: s.bpm(),
        duration: s.ctx.L,
        track_id: s.trackId || null,
        audio_start: Math.max(0, s.audioStart()),
        format: fmt,
        with_audio: withAudio,
        promo_seconds: promoSeconds,
      },
      signal: exportAbortCtrl?.signal,
      onProgress,
    });
  } finally {
    useStudioStore.setState({ exporting: false });
    document.body.classList.remove('exporting');
    s.engine.main.reset();
    if (wasPlaying) s.transport.play();
  }
}

export function openExport(): void {
  const s = useStudioStore.getState();
  if (!s.ctx) {
    toast('Select at least one clip first');
    return;
  }
  const pending = s.clips.filter((c) => s.selected.includes(c.id) && c.proxy && c.proxy !== 'ready');
  if (pending.some((c) => c.proxy === 'error')) {
    toast("One of the selected clips couldn't be converted. Deselect it to export.");
    return;
  }
  if (pending.length) {
    toast(`Still preparing ${pending.length} clip${pending.length > 1 ? 's' : ''} for playback. Try again in a moment.`);
    return;
  }
  if (s.exporting) return;
  sheetStatus();
  useStudioStore.setState({ exportOpen: true });
}

export async function runExport(): Promise<void> {
  const s = useStudioStore.getState();
  if (!s.ctx || !s.look) return;
  exportAbortCtrl = new AbortController();

  const pct = h('div', { class: 'pct' }, '0%');
  const bar = h('i');
  const info = h('div', { class: 'note' }, 'Preparing clips…');
  sheetStatus(
    h('h2', {}, 'Rendering…'),
    h('div', { class: 'progress' }, pct, h('div', { class: 'pbar' }, bar), info),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => exportAbortCtrl?.abort() }, 'Cancel')),
  );

  try {
    const res = await renderOnce(({ frame, total, speed }) => {
      const p = Math.round((frame / total) * 100);
      pct.textContent = `${p}%`;
      bar.style.width = `${p}%`;
      const left = speed > 0 ? (total - frame) / 30 / speed : 0;
      info.textContent = `Frame ${frame} / ${total} · ${speed.toFixed(1)}× real-time${left >= 1 ? ` · about ${fmtTime(left)} left` : ''}`;
    });

    useStudioStore.setState((prev) => ({ renders: [res, ...prev.renders.filter((r) => r.filename !== res.filename)] }));
    autoSave(res);
    showResult(res);
    toast(`Exported ${res.filename}`);
  } catch (e: any) {
    console.error(e);
    sheetStatus(
      h('h2', {}, e.name === 'AbortError' ? 'Export cancelled' : 'Export failed'),
      h('div', { class: 'note' }, String(e.message || e)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: closeSheet }, 'Close')),
    );
    toast(e.name === 'AbortError' ? 'Export cancelled' : 'Export failed');
  }
}

export async function runBatch(kind: 'rolls' | 'tracks'): Promise<void> {
  const s = useStudioStore.getState();
  exportAbortCtrl = new AbortController();
  const beforeSnap = s.snapshot();
  const trackBefore = s.trackId;
  const jobs = kind === 'tracks' ? siblingTracks(s.tracks, s.trackId).map((t) => t.id) : [1, 2, 3, 4];

  try {
    for (let i = 0; i < jobs.length; i++) {
      if (exportAbortCtrl.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (kind === 'tracks') {
        await s.selectTrack(jobs[i] as string);
        useStudioStore.setState((prev) => ({ loopStart: prev.features?.loops?.[0]?.start ?? prev.loopStart }));
        s.rebuild();
      } else {
        s.rollAll();
      }
      await new Promise((r) => setTimeout(r, 400));
      await s.runExport();
    }
  } catch (e: any) {
    console.error(e);
  } finally {
    // `s` is the state from before the batch; read the song that's loaded now.
    if (kind === 'tracks' && useStudioStore.getState().trackId !== trackBefore) await s.selectTrack(trackBefore, { keepLoop: true });
    if (beforeSnap) s.applySnapshot(beforeSnap);
  }
}

export async function reveal(filename: string): Promise<void> {
  const r = await postJSON('/api/reveal', { filename });
  if (!r.ok) toast(`Saved in out/${filename}`);
}

export async function exportCompanion(opts: { filename?: string; clip_id?: string; kind: string; at_sec?: number }): Promise<void> {
  toast(`Generating ${opts.kind.replace(/_/g, ' ')}…`, 8000);
  const res = await postJSON('/api/export/companion', opts);
  if (res.ok && res.url) {
    saveToDownloads(res.url, res.filename);
    toast(`Downloaded ${res.filename || opts.kind}`);
  } else {
    toast(res.error || 'Companion export failed');
  }
}
