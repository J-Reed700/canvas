import './ExportSheet.css';
import { useStudioStore, useStudioApi, useStudioRuntime } from '../../state/StudioContext.tsx';
import React, { useRef, useMemo } from 'react';
import { FORMATS, SIZES, fmt, fmtLength, siblingTracks, sourceLabel, toast } from '../../lib/utils.ts';

export const ExportSheet: React.FC = () => {
  const store = useStudioApi();
  const { exports } = useStudioRuntime();

  const referenceInput = useRef<HTMLInputElement>(null);
  const exportOpen = useStudioStore((s) => s.exportOpen);
  const exportOpts = useStudioStore((s) => s.exportOpts);
  const features = useStudioStore((s) => s.features);
  const selected = useStudioStore((s) => s.selected);
  const tracks = useStudioStore((s) => s.tracks);
  const trackId = useStudioStore((s) => s.trackId);
  const renders = useStudioStore((s) => s.renders);
  const bpm = useStudioStore((s) => s.bpm());
  const audioStart = useStudioStore((s) => s.audioStart());
  const look = useStudioStore((s) => s.look);
  const ctx = useStudioStore((s) => s.ctx);
  const runExport = useStudioStore((s) => s.runExport);
  const runBatch = useStudioStore((s) => s.runBatch);
  const exportCompanion = useStudioStore((s) => s.exportCompanion);
  const save = useStudioStore((s) => s.save);

  const batchTracks = useMemo(() => siblingTracks(tracks, trackId), [tracks, trackId]);
  const batchCur = tracks.find((t) => t.id === trackId);
  const batchFolder = batchCur?.dir ? batchCur.dir.split('/').pop() : sourceLabel(batchCur?.source);

  const currentFormat = exportOpts.format || 'spotify';
  const isSpotify = currentFormat === 'spotify';
  const isApple = currentFormat === 'apple_tall' || currentFormat === 'apple_square';
  const hasAudioSupport = currentFormat === 'spotify' || currentFormat === 'youtube_16_9' || currentFormat === 'social_vertical' || currentFormat === 'social_square';
  const currentSizeKey = exportOpts.size || 'master';
  const sizeArr = FORMATS[currentFormat]?.size || SIZES[currentSizeKey] || SIZES.master;
  const [W, H] = sizeArr;

  const L = ctx?.L || 8;
  const frames = Math.round(L * 30);
  const minSeg = ctx?.tl?.segs?.length ? Math.min(...ctx.tl.segs.map((x) => x.dur)) : 1;
  const rapidCuts = ctx && ctx.tl.segs.length > 1 && (minSeg < 0.3 || ctx.tl.segs.length / L > 2.5);
  const bars = Math.round((L * bpm) / 240);
  // Formats with a length rule of their own; the rest take any length.
  const lengthWarning =
    isSpotify && (L < 3 - 1e-6 || L > 8 + 1e-6)
      ? `This loop is ${fmtLength(L)}, and Spotify only takes a Canvas of 3 to 8 s, so the length check will fail. For a longer video choose YouTube 16:9 or Social 1:1, or set a shorter loop in the Edit tab.`
      : (currentFormat === 'apple_tall' || currentFormat === 'apple_square') && L > 35 + 1e-6
        ? `This loop is ${fmtLength(L)}, and Apple Music motion art can be at most 35 s, so the length check will fail.`
        : null;

  const optCard = (on: boolean, title: string, sub: string, pick: () => void) => (
    <div className={`opt-card ${on ? 'on' : ''}`} onClick={pick} key={title}>
      <span className="radio" />
      <div>
        <b>{title}</b>
        <span>{sub}</span>
      </div>
    </div>
  );

  return (
    <div className={`sheet ${exportOpen ? 'on' : ''}`} id="exportSheet">
      <div id="exportForm">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Export</h2>
          <button className="btn icon" onClick={() => store.setState({ exportOpen: false })}>
            ✕
          </button>
        </div>

        <div className="seg fmt-seg">
          {Object.entries(FORMATS).map(([k, f]) => (
            <button
              key={k}
              className={currentFormat === k ? 'on' : ''}
              title={f.sub}
              onClick={() => {
                store.setState({ exportOpts: { ...exportOpts, format: k } });
                save();
              }}
            >
              {f.short}
            </button>
          ))}
        </div>

        <div className="note">
          {(() => {
            switch (currentFormat) {
              case 'spotify':
                return 'Every frame is rendered on the GPU, frame-exact, encoded to H.264 in hardware and verified against the Spotify Canvas spec.';
              case 'apple_tall':
              case 'apple_square':
                return "Apple Music motion artwork: silent, 8–35 s, rendered by the GPU at Apple's native delivery dimensions. ProRes avoids an extra H.264 output intermediate; source footage still comes from Downbeat's 8-bit playback pipeline.";
              case 'youtube_16_9':
                return 'YouTube visualizer: 1920 × 1080 landscape video, as long as the loop you set in the Edit tab. For a copy with the song as its audio, check Also save a copy with the song.';
              case 'social_square':
                return 'Social feed loop: 1080 × 1080 square format for Instagram, Twitter/X, and Facebook feeds, with optional synced song audio.';
              case 'social_vertical':
                return 'Vertical social video: 1080 × 1920 for TikTok, Instagram Reels and YouTube Shorts, separate from Spotify Canvas length limits.';
              case 'cover_art':
                return 'Album cover art: a 3000 × 3000 sRGB JPEG for distributors such as DistroKid and TuneCore, plus a 1:1 motion preview.';
              default:
                return FORMATS[currentFormat]?.sub || 'Rendered on the GPU, frame-exact and encoded in hardware.';
            }
          })()}
        </div>

        {lengthWarning && <div className="warn-note">{lengthWarning}</div>}

        {isSpotify && (
          <>
            {optCard(
              currentSizeKey === 'master',
              '1080 × 1920 · Master',
              'The widely used Canvas size, sharpest on modern phones',
              () => {
                store.setState({ exportOpts: { ...exportOpts, size: 'master' } });
                save();
              },
            )}
            {optCard(
              currentSizeKey === 'lite',
              '720 × 1280 · Lite',
              'Smaller file, still crisp on most phones',
              () => {
                store.setState({ exportOpts: { ...exportOpts, size: 'lite' } });
                save();
              },
            )}
            {optCard(
              currentSizeKey === 'strict',
              '608 × 1080 · Spec-literal',
              'Matches the 720 to 1080 px height Spotify lists. Use it if an upload is rejected',
              () => {
                store.setState({ exportOpts: { ...exportOpts, size: 'strict' } });
                save();
              },
            )}
          </>
        )}

        {isApple && (
          <div className="field">
            <label>Master codec</label>
            <div className="seg">
              {([
                ['h264', 'H.264 MP4'],
                ['prores422', 'ProRes 422 HQ'],
                ['prores4444', 'ProRes 4444'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  className={(exportOpts.codec || 'h264') === value ? 'on' : ''}
                  onClick={() => {
                    store.setState({ exportOpts: { ...exportOpts, codec: value } });
                    save();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="note">
              ProRes exports a native-size MOV. The renderer is opaque 8-bit RGB, so 4444 preserves 4:4:4 chroma but does not invent alpha or extra source precision.
            </div>
          </div>
        )}

        <div className="field">
          <label>Frame 0 reference still · optional QA</label>
          <input
            ref={referenceInput}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const started = store.getState();
              const projectId = started.project?.id;
              const format = started.exportOpts.format;
              const previousId = started.exportOpts.coverRefId;
              try {
                const reference = await exports.setFrame0Reference(file);
                if (!reference) return;
                const current = store.getState();
                if (current.project?.id !== projectId || current.exportOpts.format !== format || current.exportOpts.coverRefId !== previousId) {
                  if (exports.hasFrame0Reference(reference.id)) await exports.setFrame0Reference(null);
                  return;
                }
                store.setState((state) => ({ exportOpts: { ...state.exportOpts, coverRefId: reference.id } }));
                save();
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not read that reference still');
              } finally {
                if (referenceInput.current) referenceInput.current.value = '';
              }
            }}
          />
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => referenceInput.current?.click()}>
              {exportOpts.coverRefId ? 'Replace reference…' : 'Choose reference…'}
            </button>
            {exportOpts.coverRefId && (
              <>
                <span className="note">{exports.frame0ReferenceLabel(exportOpts.coverRefId)}</span>
                <button
                  className="btn sm"
                  onClick={() => {
                    exports.setFrame0Reference(null);
                    store.setState({ exportOpts: { ...exportOpts, coverRefId: undefined } });
                    if (referenceInput.current) referenceInput.current.value = '';
                    save();
                  }}
                >
                  Clear
                </button>
              </>
            )}
          </div>
          <div className="note">The chosen image stays in this browser session. QA compares its pixels with the actual rendered first frame; without one, the export reports a warning instead of claiming a match.</div>
        </div>

        {features && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={exportOpts.withSong === true}
                onChange={(e) => {
                  store.setState({ exportOpts: { ...exportOpts, withSong: e.target.checked } });
                  save();
                }}
              />
              Also save a copy with the song
            </label>
            {exportOpts.withSong && (
              <div className="note">For demos. The export itself stays silent. The copy plays the song under it and is saved next to it.</div>
            )}
          </>
        )}

        {hasAudioSupport && features && (
          <>
            <div className="field">
              <label>Promo copy with the song</label>
              <div className="seg">
                {[
                  [0, 'Off'],
                  [15, '15 s'],
                  [30, '30 s'],
                ].map(([v, l]) => (
                  <button
                    key={v}
                    className={exportOpts.promo === v ? 'on' : ''}
                    onClick={() => {
                      store.setState({ exportOpts: { ...exportOpts, promo: v as number } });
                      save();
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <div className="note">The loop repeated under the song, for Reels, TikTok or a Spotify Countdown Page.</div>
              {!!exportOpts.promo && (
                <>
                  <label htmlFor="promoTitle">Promo title card · optional</label>
                  <input
                    id="promoTitle"
                    type="text"
                    maxLength={120}
                    placeholder="Artist — Release"
                    value={exportOpts.promoTitle || ''}
                    onChange={(e) => store.setState({ exportOpts: { ...exportOpts, promoTitle: e.target.value } })}
                    onBlur={save}
                  />
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={exportOpts.promoOutNow === true}
                      onChange={(e) => {
                        store.setState({ exportOpts: { ...exportOpts, promoOutNow: e.target.checked } });
                        save();
                      }}
                    />
                    Add “OUT NOW” to the promo card
                  </label>
                </>
              )}
            </div>
          </>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={exportOpts.autoSave !== false}
            onChange={(e) => {
              store.setState({ exportOpts: { ...exportOpts, autoSave: e.target.checked } });
              save();
            }}
          />
          Save to my Downloads folder when it's done
        </label>

        {rapidCuts && isSpotify && (
          <div className="warn-note">
            <b>⚠ Rapid cuts. </b>
            The shortest segment is {minSeg.toFixed(2)} s. Spotify asks Canvases to avoid rapid video cuts. Try a slower rhythm (½ bar or Bar) in Edit.
          </div>
        )}

        <div className="summary">
          <span>Look</span>
          <b>{look?.name}</b>
          <span>Size</span>
          <b>
            {`${W} × ${H} · ${FORMATS[currentFormat]?.name}`}
          </b>
          <span>Codec</span>
          <b>{isApple ? ({ h264: 'H.264 MP4', prores422: 'ProRes 422 HQ MOV', prores4444: 'ProRes 4444 MOV' } as const)[exportOpts.codec || 'h264'] : 'H.264 MP4'}</b>
          <span>Length</span>
          <b>
            {L < 60 ? `${L.toFixed(3)} s` : fmtLength(L)} · {frames} frames @ 30 fps
          </b>
          <span>Tempo</span>
          <b>
            {bpm.toFixed(2)} BPM · {bars || '-'} bars
          </b>
          <span>Edit</span>
          <b>
            {ctx?.tl.segs.length || 0} cuts · {selected.length} clips
          </b>
          <span>Audio</span>
          <b>
            {features ? `${fmt(audioStart)} → ${fmt(audioStart + L)}` : 'none (silent canvas)'}
          </b>
        </div>

        <div className="actions">
          <button
            className="btn primary"
            onClick={() => {
              runExport();
            }}
          >
            Render & verify
          </button>
          <button className="btn" onClick={() => store.setState({ exportOpen: false })}>
            Cancel
          </button>
        </div>

        <div className="batch">
          <div className="ph">Stills and teasers</div>
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
            <button
              className="btn sm"
              disabled={!selected.length}
              title="Export 3000 × 3000 release cover art from clip 1"
              onClick={() => exportCompanion({ clip_id: selected[0], kind: 'cover' })}
            >
              Cover 3000×3000
            </button>
            <button
              className="btn sm"
              disabled={!selected.length}
              title="Export 2660 × 1140 Spotify artist header banner"
              onClick={() => exportCompanion({ clip_id: selected[0], kind: 'spotify_header' })}
            >
              Spotify Header 2660×1140
            </button>
            <button
              className="btn sm"
              disabled={!selected.length}
              title="Export 2560 × 1440 YouTube channel banner"
              onClick={() => exportCompanion({ clip_id: selected[0], kind: 'youtube_banner' })}
            >
              YouTube Banner 2560×1440
            </button>
            <button
              className="btn sm"
              disabled={!selected.length}
              title="Export 2480 × 520 SoundCloud profile banner"
              onClick={() => exportCompanion({ clip_id: selected[0], kind: 'soundcloud_header' })}
            >
              SoundCloud Header 2480×520
            </button>
            {renders.length > 0 && (
              <>
                <button
                  className="btn sm"
                  title="Export animated GIF teaser from latest render"
                  onClick={() => exportCompanion({ filename: renders[0].filename, kind: 'gif' })}
                >
                  GIF Loop
                </button>
                <button
                  className="btn sm"
                  title="Export animated WebP teaser from latest render"
                  onClick={() => exportCompanion({ filename: renders[0].filename, kind: 'webp' })}
                >
                  WebP Loop
                </button>
              </>
            )}
          </div>
        </div>

        <div className="batch">
          <div className="ph">Batch</div>
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
            <button
              className="btn sm"
              title="Roll 4 times and export each roll; studio returns to this edit afterwards"
              onClick={() => {
                store.setState({ exportOpen: false });
                runBatch('rolls');
              }}
            >
              🎲 Export 4 rolls
            </button>
            {batchTracks.length > 1 && (
              <button
                className="btn sm"
                title={`This look and edit on the ${batchTracks.length} newest songs in the same folder as this one, each at its top loop suggestion, so a release shares one theme`}
                onClick={() => {
                  store.setState({ exportOpen: false });
                  runBatch('tracks');
                }}
              >
                This look on {batchTracks.length} songs in {batchFolder}
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Progress and results are drawn here by exportController. React never renders into it. */}
      <div id="exportStatus" />
    </div>
  );
};
