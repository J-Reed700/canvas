import React, { useRef, useEffect, useMemo } from 'react';
import { useStudioStore, type LookJob } from '../store.ts';
import { FORMATS, SIZES, fmt, fmtLength, siblingTracks, sourceLabel } from '../utils.ts';
import { mutate } from '../../looks.ts';
import { MODULES } from '../../modules.ts';

export const Modals: React.FC = () => {
  const varsContainerRef = useRef<HTMLDivElement>(null);

  const varOpen = useStudioStore((s) => s.varOpen);
  const helpOpen = useStudioStore((s) => s.helpOpen);
  const exportOpen = useStudioStore((s) => s.exportOpen);
  const mutAmt = useStudioStore((s) => s.mutAmt);
  const varSeed = useStudioStore((s) => s.varSeed);
  const look = useStudioStore((s) => s.look);
  const engine = useStudioStore((s) => s.engine);
  const ctx = useStudioStore((s) => s.ctx);
  const exportOpts = useStudioStore((s) => s.exportOpts);
  const features = useStudioStore((s) => s.features);
  const selected = useStudioStore((s) => s.selected);
  const tracks = useStudioStore((s) => s.tracks);
  const trackId = useStudioStore((s) => s.trackId);
  const renders = useStudioStore((s) => s.renders);
  const bpm = useStudioStore((s) => s.bpm());
  const audioStart = useStudioStore((s) => s.audioStart());
  const setLook = useStudioStore((s) => s.setLook);
  const runExport = useStudioStore((s) => s.runExport);
  const runBatch = useStudioStore((s) => s.runBatch);
  const exportCompanion = useStudioStore((s) => s.exportCompanion);
  const save = useStudioStore((s) => s.save);

  // Six mutations of the current look, shared by the live thumbnails and the click that applies one.
  const variations = useMemo(
    () => (varOpen && look ? Array.from({ length: 6 }, (_, k) => mutate(look, mutAmt, varSeed * 1000 + k * 7919)) : []),
    [varOpen, look, mutAmt, varSeed],
  );

  useEffect(() => {
    if (!variations.length || !varsContainerRef.current) return;

    const cards = varsContainerRef.current.querySelectorAll<HTMLElement>('.look');
    const jobs: LookJob[] = [];
    cards.forEach((card, k) => {
      const cv = card.querySelector('canvas');
      if (cv && variations[k]) {
        jobs.push({ id: `var:${k}`, look: variations[k], card, ctx2d: cv.getContext('2d'), visible: true });
      }
    });
    useStudioStore.setState({ varJobs: jobs });

    return () => {
      jobs.forEach((j) => engine?.dropThumb?.(j.id));
      useStudioStore.setState({ varJobs: [] });
    };
  }, [variations, engine]);

  const mutateAgain = () => {
    useStudioStore.setState((prev) => ({ varSeed: prev.varSeed + 1 }));
  };

  const closeModals = () => {
    useStudioStore.setState({ varOpen: false, helpOpen: false, exportOpen: false });
  };

  const batchTracks = useMemo(() => siblingTracks(tracks, trackId), [tracks, trackId]);
  const batchCur = tracks.find((t) => t.id === trackId);
  const batchFolder = batchCur?.dir ? batchCur.dir.split('/').pop() : sourceLabel(batchCur?.source);

  const currentFormat = exportOpts.format || 'spotify';
  const isSpotify = currentFormat === 'spotify';
  const hasAudioSupport = currentFormat === 'spotify' || currentFormat === 'youtube_16_9' || currentFormat === 'social_square';
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
    <>
      <div
        className={`modal-bg ${varOpen ? 'on' : ''}`}
        id="varModal"
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-close]')) closeModals();
        }}
      >
        <div className="modal">
          <div className="modal-h">
            <div>
              <h2>Variations</h2>
              <div className="sub" id="varSub">
                Mutations of {look?.name}, playing on your footage. Click one to keep it.
              </div>
            </div>
            <div className="mut-ctrl">
              <span className="muted">Subtle</span>
              <input
                type="range"
                id="mutAmt"
                min="0.1"
                max="1"
                step="0.05"
                value={mutAmt}
                onChange={(e) => useStudioStore.setState({ mutAmt: +e.target.value })}
              />
              <span className="muted">Wild</span>
              <button className="btn" id="btnMutate" onClick={mutateAgain}>
                ⟳ Mutate again
              </button>
            </div>
            <button className="btn icon modal-x" data-close title="Close (Esc)" onClick={closeModals}>
              ✕
            </button>
          </div>
          <div className="vars" id="vars" ref={varsContainerRef}>
            {Array.from({ length: 6 }, (_, k) => {
              const l = variations[k];
              return (
                <div
                  className="look"
                  key={k}
                  onClick={() => {
                    if (l) {
                      setLook(l, { keepEdit: true });
                      closeModals();
                    }
                  }}
                >
                  <canvas width={216} height={384} />
                  <div className="lbl">
                    <b>{l?.name}</b>
                    <span>{l?.layers.map((x) => MODULES[x.m]?.name).filter(Boolean).join(' + ')}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div
        className={`modal-bg ${helpOpen ? 'on' : ''}`}
        id="helpModal"
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-close]')) closeModals();
        }}
      >
        <div className="modal" style={{ width: 'min(520px, 94vw)' }}>
          <div className="modal-h">
            <div>
              <h2>Shortcuts</h2>
            </div>
            <button className="btn icon modal-x" data-close title="Close (Esc)" onClick={closeModals}>
              ✕
            </button>
          </div>
          <div className="keys">
            <span className="kbd">Space</span>
            <span>Play / pause</span>
            <span className="kbd">← →</span>
            <span>Previous / next look</span>
            <span className="kbd">M</span>
            <span>Variations of the current look</span>
            <span className="kbd">D</span>
            <span>🎲 Roll everything: look, layers, edit, per-clip FX</span>
            <span className="kbd">⇧ D</span>
            <span>Undo the last roll</span>
            <span className="kbd">R</span>
            <span>Surprise me: random look</span>
            <span className="kbd">E</span>
            <span>Export the canvas</span>
            <span className="kbd">[ ]</span>
            <span>Previous / next loop suggestion (Drop, Peaks…)</span>
            <span className="kbd">1–4</span>
            <span>Loop length in bars (1, 2, 4, 8)</span>
            <span className="kbd">H</span>
            <span>Toggle the Spotify player overlay</span>
            <span className="kbd">S</span>
            <span>Toggle safe zones</span>
            <span className="kbd">L</span>
            <span>Loop / Listener audition</span>
            <span className="kbd">T</span>
            <span>Tap tempo (tap along to the beat)</span>
            <span className="kbd">⌘ Z</span>
            <span>Undo any edit · ⇧⌘Z redo</span>
            <span className="kbd">Drag</span>
            <span>On the preview: reframe the current clip · scroll to zoom · double-click to reset</span>
            <span className="kbd">⌥ Drag</span>
            <span>On a timeline segment: slip to a different moment of the clip</span>
            <span className="kbd">Dbl-click</span>
            <span>On a timeline segment: clip, in-point, speed ramp, transition</span>
          </div>
        </div>
      </div>

      <div className={`sheet ${exportOpen ? 'on' : ''}`} id="exportSheet">
        <div id="exportForm">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Export</h2>
            <button className="btn icon" onClick={() => useStudioStore.setState({ exportOpen: false })}>
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
                  useStudioStore.setState({ exportOpts: { ...exportOpts, format: k } });
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
                  return "Apple Music motion artwork: the same edit re-framed for Apple's aspect ratio, silent, looping and repeated to at least 15 s. Square art is rendered at 2048 px, then upscaled to Apple's 3840 × 3840.";
                case 'youtube_16_9':
                  return 'YouTube visualizer: 1920 × 1080 landscape video with the song as its audio, as long as the loop you set in the Edit tab.';
                case 'social_square':
                  return 'Social feed loop: 1080 × 1080 square format for Instagram, Twitter/X, and Facebook feeds, with optional synced song audio.';
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
                  useStudioStore.setState({ exportOpts: { ...exportOpts, size: 'master' } });
                  save();
                },
              )}
              {optCard(
                currentSizeKey === 'lite',
                '720 × 1280 · Lite',
                'Smaller file, still crisp on most phones',
                () => {
                  useStudioStore.setState({ exportOpts: { ...exportOpts, size: 'lite' } });
                  save();
                },
              )}
              {optCard(
                currentSizeKey === 'strict',
                '608 × 1080 · Spec-literal',
                'Matches the 720 to 1080 px height Spotify lists. Use it if an upload is rejected',
                () => {
                  useStudioStore.setState({ exportOpts: { ...exportOpts, size: 'strict' } });
                  save();
                },
              )}
            </>
          )}

          {hasAudioSupport && features && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={exportOpts.audio !== false}
                  onChange={(e) => {
                    useStudioStore.setState({ exportOpts: { ...exportOpts, audio: e.target.checked } });
                    save();
                  }}
                />
                {L > 8 + 1e-6 ? 'Also save a copy with the song' : 'Also save a copy with the audio slice'}
              </label>

              <div className="field" style={{ margin: '8px 0 0' }}>
                <label>Promo copy with the song · Reels / TikTok / Spotify countdown</label>
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
                        useStudioStore.setState({ exportOpts: { ...exportOpts, promo: v as number } });
                        save();
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={exportOpts.autoSave !== false}
              onChange={(e) => {
                useStudioStore.setState({ exportOpts: { ...exportOpts, autoSave: e.target.checked } });
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
              {currentFormat === 'apple_square'
                ? '3840 × 3840 (rendered at 2048)'
                : `${W} × ${H} · ${FORMATS[currentFormat]?.name}`}
            </b>
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
            <button className="btn" onClick={() => useStudioStore.setState({ exportOpen: false })}>
              Cancel
            </button>
          </div>

          <div className="batch">
            <div className="ph">Stills and teasers</div>
            <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
              <button
                className="btn sm"
                disabled={!selected.length}
                title="Export 3000 × 3000 release cover art from current clip"
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
                  useStudioStore.setState({ exportOpen: false });
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
                    useStudioStore.setState({ exportOpen: false });
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

      <div className="pop" id="pop" />
      <div className="toast" id="toast" />
      <div id="videoBank" />
    </>
  );
};
