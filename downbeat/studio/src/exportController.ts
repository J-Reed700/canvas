import { useStudioStore } from './store.ts';
import { exportLoop } from '../exporter.ts';
import { cloneLook } from '../looks.ts';
import { FORMATS, SIZES, toast, h, fetchJSON, saveToDownloads, siblingTracks } from './utils.ts';
import type { RenderRecord, ComposeContext } from '../types.ts';

let exportAbortCtrl: AbortController | null = null;

export function autoSave(res: RenderRecord) {
  const s = useStudioStore.getState();
  if (s.exportOpts.autoSave === false) return;
  saveToDownloads(res.url, res.filename);
  if (res.promo_url) setTimeout(() => saveToDownloads(res.promo_url!, ''), 400);
  if (res.cover_url) setTimeout(() => saveToDownloads(res.cover_url!, ''), 800);
}

export function showResult(r: RenderRecord) {
  const sheet = document.getElementById('exportSheet');
  if (!sheet) return;
  sheet.classList.add('on');
  const checks = r.checks || [];
  const fails = checks.filter((c) => c.level === 'fail').length;
  const ic: Record<string, string> = { ok: '✓', warn: '!', fail: '✕', pass: '✓' };

  let headerText = 'Ready for Spotify';
  if (r.format === 'cover_art') headerText = 'Cover art and loop exported';
  else if (r.format === 'youtube_16_9') headerText = 'YouTube video exported';
  else if (r.format === 'social_square') headerText = 'Square video exported';
  else if (r.format && r.format.startsWith('apple_')) headerText = 'Ready for Apple Music';

  sheet.replaceChildren(
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between' },
      h('h2', {}, fails ? 'Exported, but some checks failed' : headerText),
      h(
        'button',
        {
          class: 'btn icon',
          onclick: () => {
            useStudioStore.setState({ exportOpen: false });
            sheet.classList.remove('on');
          },
        },
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
      ...checks.map((c: any) =>
        h(
          'div',
          { class: `ck ${c.level || (c.pass ? 'pass' : 'fail')}` },
          h('span', { class: 'ic' }, ic[c.level] || (c.pass ? '✓' : '✕')),
          h('b', {}, c.name || c.label || ''),
          h('span', {}, c.detail || c.desc || ''),
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
  let promoSeconds = 0;
  if (s.features && isAudioFmt) {
    promoSeconds = fmt === 'youtube_16_9' ? (o.promo || 30) : (o.promo || 0);
  }
  const withAudio = !!s.features && isAudioFmt && (fmt === 'youtube_16_9' || o.audio !== false);
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
      bitrate: fmt === 'spotify' ? undefined : 50_000_000,
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
  useStudioStore.setState({ exportOpen: true });
}

export async function runExport(): Promise<void> {
  const s = useStudioStore.getState();
  if (!s.ctx || !s.look) return;
  exportAbortCtrl = new AbortController();

  const sheet = document.getElementById('exportSheet');
  const pct = h('div', { class: 'pct' }, '0%');
  const bar = h('i');
  const info = h('div', { class: 'note' }, 'Preparing clips…');
  if (sheet) {
    sheet.classList.add('on');
    sheet.replaceChildren(
      h('h2', {}, 'Rendering…'),
      h('div', { class: 'progress' }, pct, h('div', { class: 'pbar' }, bar), info),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => exportAbortCtrl?.abort() }, 'Cancel')),
    );
  }

  try {
    const res = await renderOnce(({ frame, total, speed }) => {
      const p = Math.round((frame / total) * 100);
      pct.textContent = `${p}%`;
      bar.style.width = `${p}%`;
      info.textContent = `Frame ${frame} / ${total} · ${speed.toFixed(1)}× real-time`;
    });

    useStudioStore.setState((prev) => ({ renders: [res, ...prev.renders.filter((r) => r.filename !== res.filename)] }));
    autoSave(res);
    showResult(res);
    toast(`Exported ${res.filename}`);
  } catch (e: any) {
    console.error(e);
    if (sheet) {
      sheet.replaceChildren(
        h('h2', {}, e.name === 'AbortError' ? 'Export cancelled' : 'Export failed'),
        h('div', { class: 'note' }, String(e.message || e)),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { useStudioStore.setState({ exportOpen: false }); sheet.classList.remove('on'); } }, 'Close')),
      );
    }
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
    if (kind === 'tracks' && s.trackId !== trackBefore) await s.selectTrack(trackBefore, { keepLoop: true });
    if (beforeSnap) s.applySnapshot(beforeSnap);
  }
}

export async function reveal(filename: string): Promise<void> {
  const r = await fetchJSON<{ ok?: boolean }>('/api/reveal', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  }).catch(() => ({ ok: false }));
  if (!r?.ok) toast(`Saved in out/${filename}`);
}

export async function exportCompanion(opts: { filename?: string; clip_id?: string; kind: string; at_sec?: number }): Promise<any> {
  toast(`Generating ${opts.kind.replace(/_/g, ' ')}…`, 8000);
  try {
    const res = await fetch('/api/export/companion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    })
      .then((x) => x.json())
      .catch((err) => ({ ok: false, error: String(err) }));
    if (res?.ok && res.url) {
      saveToDownloads(res.url, res.filename);
      toast(`Downloaded ${res.filename || opts.kind}`);
      return res;
    } else {
      toast(res?.error || 'Companion export failed');
      return res;
    }
  } catch (e: any) {
    console.error('exportCompanion failed', e);
    toast('Companion export failed');
    return { ok: false, error: String(e) };
  }
}
