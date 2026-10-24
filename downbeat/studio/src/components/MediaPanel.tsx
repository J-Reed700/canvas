import React, { useCallback, useRef, useState } from 'react';
import { useStudioStore, useVersion } from '../state/store.ts';
import { METERS, fmt } from '../lib/utils.ts';
import { MOD_SOURCES } from '../engine/modules.ts';
import type { ClipMeta } from '../engine/types.ts';
import { ExportsSection } from './Exports.tsx';
import { TrackPicker } from './TrackPicker.tsx';
import { isLoaded, removeClip } from '../state/mediaActions.ts';
import { useArmed } from './ui.tsx';
import { ChooserNote, FolderPathForm, useFolderPicker } from './Folders.tsx';

/** Needs a second click within 3 s, like deleting an export. */
const RemoveClipButton: React.FC<{ id: string }> = ({ id }) => {
  const [armed, setArmed] = useArmed();
  return (
    <button
      className={`rm ${armed ? 'armed' : ''}`}
      title={armed ? 'Click again to remove this clip' : 'Remove from the library'}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) removeClip(id);
        else setArmed(true);
      }}
    >
      {armed ? 'Remove?' : '✕'}
    </button>
  );
};

export const MediaPanel: React.FC = () => {
  useVersion();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addSong = useCallback(() => fileInputRef.current?.click(), []);
  const folder = useFolderPicker();
  const [dragId, setDragId] = useState<string | null>(null);

  const trackId = useStudioStore((s) => s.trackId);
  const trackStateText = useStudioStore((s) => s.trackStateText);
  const features = useStudioStore((s) => s.features);
  const bpmOverride = useStudioStore((s) => s.bpmOverride);
  const gridNudge = useStudioStore((s) => s.gridNudge);
  const setTempo = useStudioStore((s) => s.setTempo);
  const nudgeGrid = useStudioStore((s) => s.nudgeGrid);
  const tapTempo = useStudioStore((s) => s.tapTempo);

  const clips = useStudioStore((s) => s.clips);
  const selected = useStudioStore((s) => s.selected);
  const clipMode = useStudioStore((s) => s.clipMode);
  const editClip = useStudioStore((s) => s.editClip);
  const look = useStudioStore((s) => s.look);
  const clipLookOf = useStudioStore((s) => s.clipLookOf);
  const editClipLook = useStudioStore((s) => s.editClipLook);
  const toggleClip = useStudioStore((s) => s.toggleClip);
  const reorderClips = useStudioStore((s) => s.reorderClips);
  const autoFrame = useStudioStore((s) => s.autoFrame);
  const uploadFiles = useStudioStore((s) => s.uploadFiles);

  const orderedClips = [
    ...selected.map((id) => clips.find((c) => c.id === id)).filter(Boolean) as ClipMeta[],
    ...clips.filter((c) => !selected.includes(c.id)),
  ];

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length) uploadFiles(files);
  };

  return (
    <aside className="panel media">
      <div className="scroll">
        <section className="sec sec-track">
          <div className="sec-h">
            <h3>Track</h3>
            <span className="meta" id="trackState">
              {trackStateText}
            </span>
          </div>

          <TrackPicker onAddSong={addSong} />

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
                <button className="mini" title="Half tempo" onClick={() => setTempo((features.bpm || 120) / 2)}>
                  ½×
                </button>
                <button className="mini" title="Double tempo" onClick={() => setTempo((features.bpm || 120) * 2)}>
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

        <section className="sec sec-clips">
          <div className="sec-h">
            <h3>Clips</h3>
            <span className="meta" id="clipCount">
              {selected.length} of {clips.length}
            </span>
          </div>

          <div className="clip-tools">
            <button
              className="btn sm add"
              id="btnAddMedia"
              title="Copy video clips, album art / photos or songs into Downbeat (or drop them anywhere)"
              onClick={() => fileInputRef.current?.click()}
            >
              + Add files
            </button>
            <button
              className="btn sm add"
              id="btnAddFolder"
              disabled={folder.waiting}
              title="List the videos and songs in a folder and its subfolders"
              onClick={folder.choose}
            >
              + Add a folder
            </button>
            {(folder.waiting || folder.typing || folder.err) && (
              <div className="clip-folder">
                {folder.waiting && <ChooserNote />}
                {folder.typing && <FolderPathForm f={folder} />}
                {folder.err && <div className="tp-err">{folder.err}</div>}
              </div>
            )}
            <button className="btn sm" id="btnAllClips" title="Use every loaded clip" onClick={() => reorderClips('all')}>
              All
            </button>
            <button
              className="btn sm"
              id="btnSoloClip"
              title="Use only the first clip in the sequence"
              onClick={() => reorderClips('solo')}
            >
              Solo
            </button>
            <button className="btn sm" id="btnReverse" title="Reverse the sequence order" onClick={() => reorderClips('reverse')}>
              Reverse
            </button>
            <button className="btn sm" id="btnShuffle" title="Shuffle the sequence order" onClick={() => reorderClips('shuffle')}>
              Shuffle
            </button>
            <button
              className="btn sm wide"
              id="btnAutoFrame"
              title="Find faces or the main subject in each selected clip and center the crop on it. Drag the preview to adjust; double-click it to reset."
              onClick={autoFrame}
            >
              ⌖ Auto-frame subjects
            </button>
            <input
              type="file"
              id="fileInput"
              ref={fileInputRef}
              multiple
              hidden
              accept="video/*,audio/*,image/*,.mp4,.mov,.m4v,.webm,.mkv,.wav,.mp3,.m4a,.aac,.flac,.aif,.aiff,.ogg,.opus,.jpg,.jpeg,.png,.webp,.heic"
              onChange={handleFileInput}
            />
          </div>

          <div className="clips" id="clips">
            {orderedClips.map((c) => {
              const idx = selected.indexOf(c.id);
              const busy = c.proxy === 'queued' || c.proxy === 'building';
              const idle = !isLoaded(c, selected);
              const clk = clipLookOf(c.id);
              const own = clk !== look;

              return (
                <div
                  key={c.id}
                  className={`clip ${idx >= 0 ? 'on' : 'off'}${idle ? ' idle' : ''}`}
                  draggable={idx >= 0}
                  title={`${c.name}\n${c.width || 0}×${c.height || 0} · ${c.duration || 0}s${idle ? '\nNot loaded yet. Click to add it to the edit.' : ''}`}
                  style={{ backgroundImage: `url(/api/thumb/${c.id}?w=240)` }}
                  onClick={() => toggleClip(c.id)}
                  onDragStart={(e) => {
                    setDragId(c.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => {
                    if (dragId && idx >= 0) {
                      e.preventDefault();
                      e.currentTarget.classList.add('drag-over');
                    }
                  }}
                  onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.classList.remove('drag-over');
                    if (!dragId || dragId === c.id || idx < 0) return;
                    // the dragged clip takes the target's place, whichever way it moved
                    reorderClips({ from: selected.indexOf(dragId), to: idx });
                    setDragId(null);
                  }}
                >
                  {idx >= 0 && <span className="num">{idx + 1}</span>}
                  {idle && <span className="add-hint">+ Add</span>}
                  {busy && <span className="busy" title="Preparing playback proxy" />}
                  {idx >= 0 && clipMode !== 'one' && (
                    <button
                      className={`lk ${own ? 'own' : ''} ${editClip === c.id ? 'on' : ''}`}
                      title={`${own ? clk?.name : 'Main look'}: click to edit clip effects`}
                      onClick={(e) => {
                        e.stopPropagation();
                        editClipLook(c.id);
                      }}
                    >
                      {own ? clk?.name : 'Main'}
                    </button>
                  )}
                  <RemoveClipButton id={c.id} />
                  <div className="cap">
                    {c.still ? `Still · ${c.name?.replace(/\.still\.mp4$/, '')}` : `${(c.duration || 0).toFixed(1)}s · ${c.name}`}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="drop-hint">Drop MP4 / MOV / JPG / PNG / WAV / MP3 anywhere · drag clips to reorder</div>
        </section>

        <ExportsSection />
      </div>
    </aside>
  );
};
