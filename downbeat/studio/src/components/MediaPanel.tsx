import React, { useCallback, useRef } from 'react';
import { useStudioStore, useVersion } from '../state/store.ts';
import { METERS, fmt } from '../lib/utils.ts';
import { MOD_SOURCES } from '../engine/modules.ts';
import { ExportsSection } from './Exports.tsx';
import { ClipsSection } from './Clips.tsx';
import { TrackPicker } from './TrackPicker.tsx';
import './media-polish.css';

export const MediaPanel: React.FC = () => {
  useVersion();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // One file input for songs, clips and stills: the server sorts out which is which.
  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const trackId = useStudioStore((s) => s.trackId);
  const trackStateText = useStudioStore((s) => s.trackStateText);
  const features = useStudioStore((s) => s.features);
  const bpmOverride = useStudioStore((s) => s.bpmOverride);
  const gridNudge = useStudioStore((s) => s.gridNudge);
  const setTempo = useStudioStore((s) => s.setTempo);
  const nudgeGrid = useStudioStore((s) => s.nudgeGrid);
  const tapTempo = useStudioStore((s) => s.tapTempo);
  const uploadFiles = useStudioStore((s) => s.uploadFiles);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length) uploadFiles(files);
  };

  return (
    <aside className="panel media" aria-label="Media library">
      <input
        type="file"
        id="fileInput"
        ref={fileInputRef}
        multiple
        hidden
        accept="video/*,audio/*,image/*,.avi,.mts,.m2ts,.wmv,.mp4,.mov,.m4v,.webm,.mkv,.wav,.mp3,.m4a,.aac,.flac,.aif,.aiff,.ogg,.opus,.jpg,.jpeg,.png,.webp,.heic"
        onChange={handleFileInput}
      />
      <header className="media-head">
        <div className="media-title">
          <h2>Library</h2>
          <span>Media &amp; output</span>
        </div>
        <button
          className="btn sm media-import"
          id="btnAddMedia"
          type="button"
          title="Import video, audio, or still images"
          onClick={pickFiles}
        >
          <svg className="stroke-ico" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.25v8.5M3.75 6.5H12.25M3 13.5h10" />
          </svg>
          Import
        </button>
      </header>
      <div className="scroll">
        <section className="sec sec-track">
          <div className="sec-h">
            <h3>Audio</h3>
            <span className="meta" id="trackState">
              {trackStateText}
            </span>
          </div>

          <TrackPicker onAddSong={pickFiles} />

          <div className="track-meta" id="trackMeta">
            {features ? (
              <>
                <span
                  className="bpm-edit"
                  title={`Tempo ${
                    features.bpm_source === 'manual'
                      ? 'set by you'
                      : features.bpm_source === 'filename'
                      ? 'from filename'
                      : 'detected'
                  }: click to edit`}
                >
                  <b
                    contentEditable="plaintext-only"
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLElement).blur();
                      }
                    }}
                    onBlur={(e) => setTempo(parseFloat(e.currentTarget.textContent || ''))}
                  >
                    {(features.bpm || 120).toFixed((features.bpm || 120) % 1 ? 2 : 0)}
                  </b>{' '}
                  BPM
                </span>
                <button className="mini" title="Half tempo" disabled={(features.bpm || 120) / 2 < 40} onClick={() => setTempo((features.bpm || 120) / 2)}>
                  ½×
                </button>
                <button className="mini" title="Double tempo" disabled={(features.bpm || 120) * 2 > 220} onClick={() => setTempo((features.bpm || 120) * 2)}>
                  2×
                </button>
                {bpmOverride[trackId] && (
                  <button className="mini" title="Back to detected tempo" onClick={() => setTempo(null)}>
                    auto
                  </button>
                )}
                <button className="mini" title="Tap tempo (or press T)" onClick={tapTempo}>
                  Tap
                </button>
                <span style={{ marginLeft: 'auto' }}>
                  <b>{fmt(features.duration || 0)}</b>
                </span>
                <div className="grid-row" title="Slide beat grid if cuts land slightly early/late">
                  <span>Beat grid</span>
                  <button
                    className="mini"
                    title="Earlier by 10 ms (Shift: 1 ms)"
                    onClick={(e) => nudgeGrid(e.shiftKey ? -0.001 : -0.01)}
                  >
                    ◂
                  </button>
                  <span className="nudge" title="Click to reset" onClick={() => nudgeGrid(null)}>
                    {(gridNudge[trackId] || 0) > 0 ? '+' : ''}
                    {Math.round((gridNudge[trackId] || 0) * 1000)} ms
                  </span>
                  <button
                    className="mini"
                    title="Later by 10 ms (Shift: 1 ms)"
                    onClick={(e) => nudgeGrid(e.shiftKey ? 0.001 : 0.01)}
                  >
                    ▸
                  </button>
                </div>
              </>
            ) : (
              <span>Visuals follow a synthetic beat at the tempo set in Edit</span>
            )}
          </div>

          <div className="meters" id="meters">
            {METERS.map((m) => {
              const meta = MOD_SOURCES[m];
              return (
                <div className="meter" style={{ ['--c' as any]: meta?.color || '#FFD36A' }} title={meta?.name || m} key={m}>
                  <div className="bar">
                    <i />
                  </div>
                  <span>{(meta?.name || m).slice(0, 6)}</span>
                </div>
              );
            })}
          </div>
        </section>

        <ClipsSection onAddFiles={pickFiles} />

        <ExportsSection />
      </div>
    </aside>
  );
};
