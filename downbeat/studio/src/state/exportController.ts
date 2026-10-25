import { useStudioStore } from './store.ts';
import { exportLoop, type Frame0Reference } from '../engine/exporter.ts';
import { ClipFrames } from '../engine/clipFrames.ts';
import { cloneLook } from '../engine/looks.ts';
import { FORMATS, SIZES, toast, h, postJSON, saveToDownloads, siblingTracks, fmt as fmtTime } from '../lib/utils.ts';
import type { RenderRecord, ComposeContext, ExportProgress } from '../engine/types.ts';
import { CHECK_ICONS } from '../lib/exportsView.ts';
import { editState } from './historyController.ts';

let exportAbortCtrl: AbortController | null = null;
let frame0Reference: Frame0Reference | undefined;
let frame0ReferenceRequest = 0;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
async function fingerprint(file: File): Promise<string> {
  const data = await file.arrayBuffer();
  if (globalThis.crypto?.subtle) return `sha256:${hex(await globalThis.crypto.subtle.digest('SHA-256', data))}`;
  // WebCrypto may be absent on a non-secure LAN origin. Two independent 32-bit hashes still make
  // filename collisions unable to silently reuse another project's decoded reference.
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const byte of new Uint8Array(data)) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x85ebca6b) >>> 0;
  }
  return `fnv:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}:${data.byteLength}`;
}

/** Decode the user's local QA still once. Only its tiny pixels stay in memory; the file is never uploaded. */
export async function setFrame0Reference(file?: File | null): Promise<Frame0Reference | undefined> {
  const request = ++frame0ReferenceRequest;
  if (!file) {
    frame0Reference = undefined;
    return undefined;
  }
  if (file.size > MAX_REFERENCE_BYTES) throw new Error('Reference stills must be 20 MB or smaller');
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot decode a reference still');
  const id = await fingerprint(file);
  if (request !== frame0ReferenceRequest) return undefined;
  const image = await createImageBitmap(file);
  try {
    if (image.width * image.height > 100_000_000) throw new Error('Reference stills must be 100 megapixels or smaller');
    const canvas = document.createElement('canvas');
    canvas.width = 36;
    canvas.height = 64;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This browser cannot read a reference still');
    context.drawImage(image, 0, 0, 36, 64);
    const topDown = context.getImageData(0, 0, 36, 64).data;
    const bottomUp = new Uint8Array(topDown.length);
    const row = 36 * 4;
    for (let y = 0; y < 64; y++) bottomUp.set(topDown.subarray(y * row, (y + 1) * row), (63 - y) * row);
    if (request !== frame0ReferenceRequest) return undefined;
    frame0Reference = { id, name: file.name, width: image.width, height: image.height, pixels: bottomUp };
    return frame0Reference;
  } finally {
    image.close();
  }
}

export const hasFrame0Reference = (id?: string): boolean => !!id && frame0Reference?.id === id;
export const frame0ReferenceLabel = (id?: string): string => hasFrame0Reference(id) ? frame0Reference?.name || 'Reference ready' : 'Reference needs re-selection';

/** The footage check failed: the clips came out as stills. */
export const froze = (r: RenderRecord): boolean => (r.checks || []).some((c) => c.id === 'footage' && c.level === 'fail');

export function autoSave(res: RenderRecord) {
  const s = useStudioStore.getState();
  if (s.exportOpts.autoSave === false || froze(res)) return;
  saveToDownloads(res.url, res.filename);
  if (res.promo_url) setTimeout(() => saveToDownloads(res.promo_url!, ''), 400);
  if (res.audio_url) setTimeout(() => saveToDownloads(res.audio_url!, ''), 600);
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
  const codec = r.output_codec
    ? ({ h264: 'H.264', prores_422_hq: 'ProRes 422 HQ', prores_4444: 'ProRes 4444' } as const)[r.output_codec]
    : r.codec;

  let headerText = 'Ready for Spotify';
  if (r.format === 'cover_art') headerText = 'Cover art and loop exported';
  else if (r.format === 'youtube_16_9') headerText = 'YouTube video exported';
  else if (r.format === 'social_square') headerText = 'Square video exported';
  else if (r.format === 'social_vertical') headerText = 'Vertical social video exported';
  else if (r.format && r.format.startsWith('apple_')) headerText = 'Ready for Apple Music';

  sheetStatus(
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between' },
      h('h2', {}, froze(r) ? 'Export failed: the clips froze' : fails ? 'Exported, but some checks failed' : headerText),
      h(
        'button',
        { class: 'btn icon', onclick: closeSheet },
        '✕',
      ),
    ),
    h(
      'div',
      { class: 'note' },
      `${r.filename} · ${r.size_mb} MB${r.seconds ? ` · rendered in ${r.seconds.toFixed(1)} s` : ''}${codec ? ` (${codec})` : ''}`,
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
      h('a', { class: 'btn primary', href: r.url, download: r.filename }, `↓ Download ${r.filename.toLowerCase().endsWith('.mov') ? 'MOV' : 'MP4'}`),
      r.cover_url ? h('a', { class: 'btn primary', href: r.cover_url, download: '' }, '↓ 3000×3000 Cover JPG') : null,
      r.audio_url ? h('a', { class: 'btn', href: r.audio_url, download: '' }, '↓ With audio') : null,
      r.promo_url ? h('a', { class: 'btn', href: r.promo_url, download: '' }, '↓ Promo with song') : null,
      h('button', { class: 'btn sm', onclick: () => useStudioStore.getState().exportCompanion({ filename: r.filename, kind: 'gif' }) }, '↓ GIF teaser'),
      h('button', { class: 'btn sm', onclick: () => useStudioStore.getState().exportCompanion({ filename: r.filename, kind: 'webp' }) }, '↓ WebP teaser'),
      h('button', { class: 'btn', onclick: () => useStudioStore.getState().reveal(r.filename) }, 'Reveal in Finder'),
    ),
  );
}

export async function renderOnce(onProgress?: (progress: ExportProgress) => void): Promise<RenderRecord> {
  const s = useStudioStore.getState();
  if (!s.ctx || !s.look || !s.engine) throw new Error('The preview is not ready to export');
  const o = s.exportOpts;
  const fmt = o.format || 'spotify';
  const isAudioFmt = fmt === 'spotify' || fmt === 'youtube_16_9' || fmt === 'social_vertical' || fmt === 'social_square';
  const promoSeconds = s.features && isAudioFmt ? o.promo || 0 : 0;
  const withAudio = !!s.features && o.withSong === true;
  const [W, H] = (o.format && FORMATS[o.format]?.size) || (o.size && SIZES[o.size]) || SIZES.master;
  const outputCodec = fmt.startsWith('apple_')
    ? o.codec === 'prores422' ? 'prores_422_hq' : o.codec === 'prores4444' ? 'prores_4444' : 'h264'
    : 'h264';
  const reference = hasFrame0Reference(o.coverRefId) ? frame0Reference : undefined;

  const wasPlaying = s.transport.playing;
  s.transport.pause();
  useStudioStore.setState({ exporting: true });
  document.body.classList.add('exporting');
  // The render loop stops drawing the badge during an export, so it shows the export's progress instead.
  const badge = document.getElementById('stageBadge');
  const showBadge = (text: string) => {
    if (!badge) return;
    badge.style.display = 'block';
    badge.textContent = text;
  };
  showBadge(`Rendering ${W}×${H}`);

  const snapshotCtx: ComposeContext = {
    ...s.ctx,
    look: cloneLook(s.ctx.look),
  };

  const clipMeta = new Map(s.clips.map((c) => [c.id, c]));
  const clipName = (id: string) => clipMeta.get(id)?.name?.replace(/\.still\.mp4$/, '') || 'a clip';

  try {
    return await exportLoop({
      engine: s.engine,
      frames: new ClipFrames(clipName),
      clips: (id) => ({ name: clipName(id), still: !!clipMeta.get(id)?.still }),
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
        promo_title: promoSeconds ? o.promoTitle || '' : '',
        promo_out_now: promoSeconds ? o.promoOutNow === true : false,
        codec: outputCodec,
        // Removed before begin JSON; only the comparison result is sent to the server at /raw/end.
        frame0Reference: reference,
        // saved with the export, so Exports can open the edit it was made from
        edit: editState(),
      },
      signal: exportAbortCtrl?.signal,
      onProgress: (p) => {
        showBadge(`Rendering ${W}×${H} · ${Math.round((p.frame / p.total) * 100)}%`);
        onProgress?.(p);
      },
    });
  } finally {
    if (badge) badge.style.display = 'none';
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

/** The sheet's progress readout: a title, a bar, and a line under it. Returns what updates them. */
function progressSheet(title: string) {
  const head = h('h2', {}, title);
  const pct = h('div', { class: 'pct' }, '0%');
  const bar = h('i');
  const info = h('div', { class: 'note' }, 'Preparing clips…');
  sheetStatus(
    head,
    h('div', { class: 'progress' }, pct, h('div', { class: 'pbar' }, bar), info),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => exportAbortCtrl?.abort() }, 'Cancel')),
  );
  return {
    title: (text: string) => { head.textContent = text; },
    progress: ({ frame, total, speed }: { frame: number; total: number; speed: number }, prefix = '') => {
      const p = Math.round((frame / total) * 100);
      pct.textContent = `${p}%`;
      bar.style.width = `${p}%`;
      const left = speed > 0 ? (total - frame) / 30 / speed : 0;
      info.textContent = `${prefix}Frame ${frame} / ${total} · ${speed.toFixed(1)}× real-time${left >= 1 ? ` · about ${fmtTime(left)} left` : ''}`;
    },
  };
}

function addRender(res: RenderRecord) {
  useStudioStore.setState((prev) => ({ renders: [res, ...prev.renders.filter((r) => r.filename !== res.filename)] }));
}

export async function runExport(): Promise<void> {
  const s = useStudioStore.getState();
  if (!s.ctx || !s.look) return;
  exportAbortCtrl = new AbortController();
  const sheet = progressSheet('Rendering…');

  try {
    const res = await renderOnce((p) => sheet.progress(p));

    addRender(res);
    autoSave(res);
    showResult(res);
    toast(froze(res) ? 'Export failed: the clips froze. The reason is in the export sheet.' : `Exported ${res.filename}`, froze(res) ? 6000 : undefined);
  } catch (e) {
    console.error(e);
    const cancelled = e instanceof Error && e.name === 'AbortError';
    sheetStatus(
      h('h2', {}, cancelled ? 'Export cancelled' : 'Export failed'),
      h('div', { class: 'note' }, e instanceof Error ? e.message : String(e)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: closeSheet }, 'Close')),
    );
    toast(cancelled ? 'Export cancelled' : 'Export failed');
  }
}

export async function runBatch(kind: 'rolls' | 'tracks'): Promise<void> {
  const s = useStudioStore.getState();
  exportAbortCtrl = new AbortController();
  const signal = exportAbortCtrl.signal;
  const beforeSnap = s.snapshot();
  const trackBefore = s.trackId;
  const jobs = kind === 'tracks' ? siblingTracks(s.tracks, s.trackId).map((t) => t.id) : [1, 2, 3, 4];
  const done: RenderRecord[] = [];
  let stopped: string | null = null;
  const sheet = progressSheet(`Rendering 1 of ${jobs.length}`);

  try {
    for (let i = 0; i < jobs.length && !signal.aborted; i++) {
      if (kind === 'tracks') {
        await s.selectTrack(jobs[i] as string);
        useStudioStore.setState((prev) => ({ loopStart: prev.features?.loops?.[0]?.start ?? prev.loopStart }));
        s.rebuild();
      } else {
        s.rollAll();
      }
      await new Promise((r) => setTimeout(r, 400));
      const cur = useStudioStore.getState();
      const what = kind === 'tracks' ? cur.tracks.find((t) => t.id === cur.trackId)?.name || 'this song' : cur.look?.name || 'this roll';
      sheet.title(`Rendering ${i + 1} of ${jobs.length}`);
      try {
        const res = await renderOnce((p) => sheet.progress(p, `${what} · `));
        addRender(res);
        autoSave(res);
        done.push(res);
      } catch (e) {
        if (!(e instanceof Error && e.name === 'AbortError')) {
          console.error(e);
          stopped = `${what}: ${e instanceof Error ? e.message : String(e)}`;
        }
        break;
      }
    }
  } finally {
    // `s` is the state from before the batch; read the song that's loaded now.
    if (kind === 'tracks' && useStudioStore.getState().trackId !== trackBefore) await s.selectTrack(trackBefore, { keepLoop: true });
    if (beforeSnap) s.applySnapshot(beforeSnap);
  }

  const failed = (r: RenderRecord) => (r.checks || []).some((c) => c.level === 'fail');
  const ok = done.filter((r) => !failed(r)).length;
  const head = signal.aborted ? 'Batch cancelled' : stopped ? 'Batch stopped' : 'Batch done';
  const notes = [
    done.length
      ? `${done.length} of ${jobs.length} exported, and ${ok === done.length ? 'all of them' : ok} passed every check. They're in Exports, and the studio is back on your edit.`
      : 'Nothing was exported. The studio is back on your edit.',
    stopped ? `It stopped at ${stopped}` : '',
  ].filter(Boolean);
  sheetStatus(
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, head), h('button', { class: 'btn icon', onclick: closeSheet }, '✕')),
    ...notes.map((n) => h('div', { class: 'note' }, n)),
    done.length
      ? h(
          'div',
          { class: 'checks' },
          ...done.map((r) =>
            h(
              'div',
              { class: `ck ${failed(r) ? 'fail' : 'ok'}` },
              h('span', { class: 'ic' }, '↓'),
              h('a', { href: r.url, download: r.filename }, r.filename),
              h('span', {}, `${r.size_mb} MB`),
            ),
          ),
        )
      : null,
  );
  toast(`${head}: ${done.length} of ${jobs.length} exported`);
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
