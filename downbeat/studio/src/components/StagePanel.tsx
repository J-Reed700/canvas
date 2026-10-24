import React, { useRef, useEffect, useState, useSyncExternalStore } from 'react';
import { useStudioStore, useVersion } from '../state/store.ts';
import { clamp } from '../engine/looks.ts';
import { room, toast, BAR_CHOICES, fmtLength, openPop, closePop, h, FORMATS, SIZES } from '../lib/utils.ts';
import { getLastFrame } from '../canvas/renderLoop.ts';
import { SCREENS, screenOf, type Screen } from '../lib/screens.ts';
import { useWorkspaceStore } from '../state/workspaceStore.ts';
import { stepFrame } from '../lib/playback.ts';
import { Icon, ICONS } from './ui.tsx';
import { SAFE_GUIDES, guideFor } from '../lib/safeGuides.ts';
import type { ClipMeta, FramePoint } from '../engine/types.ts';

const PlayIcon: React.FC<{ playing: boolean }> = ({ playing }) => (
  <svg viewBox="0 0 24 24">
    <path d={playing ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M7 4v16l13-8z'} />
  </svg>
);

/** A device outline in the screen's shape: its long side is 16 px, or 13 px for the square so it doesn't look bigger. */
function iconSize(screen: Screen): [number, number] {
  const long = screen.aspect === 1 ? 13 : 16;
  const w = Math.round(screen.aspect < 1 ? long * screen.aspect : long);
  return [w, Math.round(w / screen.aspect)];
}
function screenIcon(screen: Screen): HTMLElement {
  const [w, ht] = iconSize(screen);
  return h('i', { class: 'scr-ic', style: `width:${w}px;height:${ht}px` });
}

export const StagePanel: React.FC = () => {
  useVersion();
  const viewRef = useRef<HTMLCanvasElement>(null);

  const selected = useStudioStore((s) => s.selected);
  const tracks = useStudioStore((s) => s.tracks);
  const trackId = useStudioStore((s) => s.trackId);
  const features = useStudioStore((s) => s.features);
  const hud = useStudioStore((s) => s.hud);
  const safe = useStudioStore((s) => s.safe);
  const muted = useStudioStore((s) => s.muted);
  const exporting = useStudioStore((s) => s.exporting);
  const glError = useStudioStore((s) => s.glError);
  const transport = useStudioStore((s) => s.transport);
  const save = useStudioStore((s) => s.save);
  const touch = useStudioStore((s) => s.touch);
  const barDur = useStudioStore((s) => s.barDur());
  const maxBars = useStudioStore((s) => s.maxBars());
  const loopLen = useStudioStore((s) => s.loopLen());
  const setBars = useStudioStore((s) => s.setBars);
  const setTab = useStudioStore((s) => s.setTab);
  const setScreen = useStudioStore((s) => s.setScreen);
  const screen = useStudioStore((s) => screenOf(s.exportOpts.format));
  const format = useStudioStore((s) => s.exportOpts.format);
  const size = useStudioStore((s) => s.exportOpts.size);
  const focus = useWorkspaceStore((s) => s.focus);
  const [outputW, outputH] = FORMATS[format || 'spotify']?.size || SIZES[size || 'master'] || SIZES.master;
  const [guideId, setGuideId] = useState('');
  const guide = guideFor(screen.id, guideId, format);
  const [iconW, iconH] = iconSize(screen);
  const bars = Math.round(loopLen / barDur);
  const playing = useSyncExternalStore(transport.subscribe, () => transport.playing);

  const rfRef = useRef<{ id: string; c: ClipMeta; x: number; y: number; f0: FramePoint; zoom: number; moved: boolean } | null>(null);

  const target = () => {
    const s = useStudioStore.getState();
    const fr = s.ctx ? getLastFrame() : undefined;
    const n = fr?.needs[0];
    const c = n && s.clips?.find((x) => x.id === n.clipId);
    if (!c) return null;
    // a segment framed in its own menu ignores the clip's framing, so dragging here would do nothing
    const seg = fr.seg?.a.seg;
    if (seg?.frame) {
      toast(`Segment ${seg.i + 1} has its own framing. Double-click it in the timeline to change it.`);
      return null;
    }
    return { c, n };
  };

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const onPointerDown = (e: PointerEvent) => {
      const s = useStudioStore.getState();
      if (s.exporting) return;
      const tg = target();
      if (!tg) return;
      const f = s.clipFrame[tg.c.id] || [0.5, 0.5, 1];
      rfRef.current = {
        id: tg.c.id,
        c: tg.c,
        x: e.clientX,
        y: e.clientY,
        f0: [...f],
        zoom: tg.n.cam.zoom,
        moved: false,
      };
      view.setPointerCapture(e.pointerId);
      view.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      const rf = rfRef.current;
      if (!rf) return;
      const r = view.getBoundingClientRect();
      const { frac, room: rm } = room(rf.c, rf.zoom, r.width / r.height);
      const x = clamp(rf.f0[0] - ((e.clientX - rf.x) / r.width) * (frac[0] / rf.zoom), 0.5 - rm[0], 0.5 + rm[0]);
      const y = clamp(rf.f0[1] + ((e.clientY - rf.y) / r.height) * (frac[1] / rf.zoom), 0.5 - rm[1], 0.5 + rm[1]);
      if (Math.abs(e.clientX - rf.x) + Math.abs(e.clientY - rf.y) > 3) rf.moved = true;
      const s = useStudioStore.getState();
      s.clipFrame[rf.id] = [x, y, rf.f0[2]];
      s.rebuild();
    };

    const onPointerUp = () => {
      const rf = rfRef.current;
      if (!rf) return;
      if (rf.moved) {
        useStudioStore.getState().save();
        toast(`Reframed ${rf.c.name} · double-click the preview to reset`);
      }
      rfRef.current = null;
      view.style.cursor = '';
    };

    const onWheel = (e: WheelEvent) => {
      const s = useStudioStore.getState();
      if (s.exporting) return;
      const tg = target();
      if (!tg) return;
      e.preventDefault();
      const f = s.clipFrame[tg.c.id] || [0.5, 0.5, 1];
      s.clipFrame[tg.c.id] = [f[0], f[1], clamp(f[2] * Math.exp(-e.deltaY * 0.0015), 1, 3)];
      s.rebuild();
    };

    const onDblClick = () => {
      const tg = target();
      const s = useStudioStore.getState();
      if (!tg || !s.clipFrame[tg.c.id]) return;
      delete s.clipFrame[tg.c.id];
      s.rebuild();
      toast(`Framing reset for ${tg.c.name}`);
    };

    view.addEventListener('pointerdown', onPointerDown);
    view.addEventListener('pointermove', onPointerMove);
    view.addEventListener('pointerup', onPointerUp);
    view.addEventListener('pointercancel', onPointerUp);
    view.addEventListener('wheel', onWheel, { passive: false });
    view.addEventListener('dblclick', onDblClick);

    return () => {
      view.removeEventListener('pointerdown', onPointerDown);
      view.removeEventListener('pointermove', onPointerMove);
      view.removeEventListener('pointerup', onPointerUp);
      view.removeEventListener('pointercancel', onPointerUp);
      view.removeEventListener('wheel', onWheel);
      view.removeEventListener('dblclick', onDblClick);
    };
  }, []);

  const handleScreenMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    openPop(e.currentTarget, (box) => {
      box.append(h('div', { class: 'ph' }, 'Screen · sets the export shape'));
      for (const sc of SCREENS) {
        box.append(
          h(
            'button',
            {
              class: `pi ${sc === screen ? 'on' : ''}`,
              onclick: () => {
                closePop();
                setScreen(sc.id);
              },
            },
            h('span', { class: 'scr-box' }, screenIcon(sc)),
            h('span', { class: 'chk-t' }, h('b', {}, sc.name), h('small', {}, sc.use)),
            h('small', {}, sc.ratio),
          ),
        );
      }
    });
  };

  const handlePlayToggle = () => {
    if (!exporting) transport.toggle();
  };

  const handleModeChange = (mode: 'loop' | 'listen') => {
    transport.setMode(mode);
    touch();
    save();
  };

  const handleOffSync = () => {
    const was = transport.playing;
    if (was) transport.pause();
    transport.phase = transport.phase ? 0 : Math.max(0.05, Math.random() * transport.len);
    if (was) transport.play();
    touch();
    toast(
      transport.phase
        ? `Canvas offset by ${transport.phase.toFixed(2)} s from the song`
        : 'Canvas back in step with the song',
    );
  };

  const handleMuteToggle = () => {
    const nextMuted = !muted;
    useStudioStore.setState({ muted: nextMuted });
    transport.setMuted(nextMuted);
    save();
  };

  return (
    <main className="stage" aria-label="Video viewer">
      <div className="viewer-bar">
        <div className="viewer-title"><span className="viewer-mark" aria-hidden="true" /><b>Viewer</b><span className="viewer-format">{FORMATS[format || 'spotify']?.short}</span></div>
        <div className="viewer-actions">
        <button
          className="toggle screen-btn"
          id="tScreen"
          data-pop
          disabled={exporting}
          title={`Screen: ${screen.name} ${screen.ratio} (O)`}
          aria-label={`Screen: ${screen.name} ${screen.ratio}`}
          aria-haspopup="menu"
          onClick={handleScreenMenu}
        >
          <i className="scr-ic" style={{ width: iconW, height: iconH }} />
          <span className="ratio">{screen.ratio}</span>
        </button>
        <button
          className={`toggle ${hud ? 'on' : ''}`}
          id="tHud"
          aria-pressed={hud}
          title="Spotify player overlay (H)"
          onClick={() => {
            useStudioStore.setState({ hud: !hud });
            save();
          }}
        >
          Player UI
        </button>
        <button
          className={`toggle ${safe ? 'on' : ''}`}
          id="tSafe"
          aria-pressed={safe}
          title="Platform composition guides (S) · preview only"
          onClick={() => {
            useStudioStore.setState({ safe: !safe });
            save();
          }}
        >
          Safe zones
        </button>
          <button className={`toggle viewer-focus ${focus ? 'on' : ''}`} aria-label={focus ? 'Restore workspace' : 'Focus viewer'} aria-pressed={focus} title="Focus viewer (Shift+F)" onClick={() => useWorkspaceStore.getState().toggleFocus()}><Icon d={ICONS.expand} /></button>
        </div>
      </div>

      <div className="stage-badge" id="stageBadge" style={{ display: 'none' }} />

      <div className="phone-wrap">
        <div className="phone" id="phone" data-screen={screen.id}>
          <div className="screen">
            <canvas id="view" ref={viewRef} width="540" height="960" />

            <div className={`safe ${safe ? 'on' : ''}`} id="safe" data-guide={guide.id} aria-label={`${guide.name} approximate safe areas`}>
              <div style={{ top: 0, height: `${guide.top}%` }}>{guide.topLabel} · {guide.top}%</div>
              <div style={{ bottom: 0, height: `${guide.bottom}%` }}>{guide.bottomLabel} · {guide.bottom}%</div>
              <div
                className="side"
                style={{ top: `${guide.top}%`, bottom: `${guide.bottom}%`, left: 0, right: 'auto', width: `${guide.left}%` }}
              >
                {guide.id === 'spotify' ? guide.sideLabel : 'EDGE MARGIN'}
              </div>
              <div className="side" style={{ top: `${guide.top}%`, bottom: `${guide.bottom}%`, right: 0, left: 'auto', width: `${guide.right}%` }}>
                {guide.sideLabel}
              </div>
            </div>

            <div className={`hud ${hud ? '' : 'hidden'}`} id="hud">
              <div className="hud-top">
                <span>⌄</span>
                <span id="hudPlaying">PLAYING FROM YOUR LIBRARY</span>
                <span>•••</span>
              </div>
              <div className="hud-bot">
                <div className="meta">
                  <div className="title" id="hudTitle">
                    {trackId
                      ? tracks.find((t) => t.id === trackId)?.name.replace(/\.[^.]+$/, '') || 'Untitled'
                      : 'Downbeat'}
                  </div>
                  <div className="artist">Downbeat</div>
                </div>
                <div className="prog">
                  <i id="hudProg" />
                </div>
                <div className="ctrls">
                  <svg viewBox="0 0 24 24">
                    <path d="M17 3l4 4-4 4V8h-3.6l-7 9H3v-2h2.4l7-9H17V3zm0 10l4 4-4 4v-3h-4.6l-2.1-2.7 1.3-1.6 1.8 2.3H17v-3zM3 7h3.4l2.2 2.8-1.3 1.6L5.4 9H3V7z" />
                  </svg>
                  <svg viewBox="0 0 24 24">
                    <path d="M6 5h2v14H6zM20 5v14L9 12z" />
                  </svg>
                  <button
                    className="pp"
                    title={playing ? 'Pause (Space)' : 'Play (Space)'}
                    aria-label={playing ? 'Pause' : 'Play'}
                    onClick={handlePlayToggle}
                  >
                    <PlayIcon playing={playing} />
                  </button>
                  <svg viewBox="0 0 24 24">
                    <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
                  </svg>
                  <svg viewBox="0 0 24 24">
                    <path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z" />
                  </svg>
                </div>
              </div>
            </div>

            {glError ? (
              <div className="empty-stage" id="emptyStage">
                <b>The preview can't start</b>
                {glError.replace(/\.?$/, '.')} The studio needs WebGL2 to draw. Use a current Chrome or Edge, and turn on
                "Use graphics acceleration when available" in its System settings.
              </div>
            ) : (
              <div className="empty-stage" id="emptyStage" hidden={selected.length > 0}>
                <span className="empty-viewer-symbol" aria-hidden="true"><svg viewBox="0 0 48 48"><rect x="7" y="9" width="34" height="30" rx="3" /><path d="m20 18 11 6-11 6Z" /></svg></span><b>Your next visual starts here</b><span>Add footage or artwork to your library, then select a clip to begin.</span><button className="btn" onClick={() => document.getElementById('fileInput')?.click()}>Import media</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {safe && <div className="safe-guide-bar">
        <label htmlFor="safeGuide">Preview guide</label>
        <select id="safeGuide" value={guide.id} onChange={(e) => setGuideId(e.target.value)}>
          {SAFE_GUIDES.filter((g) => g.screen === screen.id).map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
        </select>
        <span title="Conservative composition guides. Actual interface, captions and cropping vary by device and placement. These guides are never exported.">Approximate · preview only</span>
        <a href={guide.source} target="_blank" rel="noreferrer">Platform guide ↗</a>
      </div>}

      <div className="viewer-meta"><span>{outputW} × {outputH}<i />30 fps<i />Fit</span><span className="viewer-reframe">Drag to reframe · scroll to zoom</span><span id="fps" className="viewer-fps" title="Live preview frame rate" /></div>
      <div className="transport">
        <div className="transport-readout"><span id="viewerTimecode">00:00:00:00</span><small> / <span id="viewerDuration">00:00:08:00</span></small><span id="timeNow" hidden>0.00</span><span id="timeLen" hidden>0.00</span></div>
        <div className="transport-playback">
          <button className="transport-step" aria-label="Go to start" title="Go to start" disabled={exporting} onClick={() => transport.seek(0)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M19 5 8 12l11 7Z" /></svg></button>
          <button className="transport-step" aria-label="Previous frame" title="Previous frame (,)" disabled={exporting} onClick={() => stepFrame(transport, -1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M17 6l-8 6 8 6" /></svg></button>
        <button
          className="play"
          id="btnPlay"
          title="Play / pause (Space)"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={handlePlayToggle}
        >
          <PlayIcon playing={playing} />
        </button>
          <button className="transport-step" aria-label="Next frame" title="Next frame (.)" disabled={exporting} onClick={() => stepFrame(transport, 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14M7 6l8 6-8 6" /></svg></button>
        </div>
        <div className="transport-audition">
        <div className="seg" id="modeSeg" style={{ display: features ? '' : 'none' }}>
          <button
            className={transport.mode === 'loop' ? 'on' : ''}
            data-mode="loop"
            title="Hear exactly the slice that drives the canvas, looped sample-accurately"
            onClick={() => handleModeChange('loop')}
          >
            Loop
          </button>
          <button
            className={transport.mode === 'listen' ? 'on' : ''}
            data-mode="listen"
            title="The song plays on while the canvas loops (listener view)"
            onClick={() => handleModeChange('listen')}
          >
            Listener
          </button>
        </div>

        <button
          className={`toggle ${transport.phase !== 0 ? 'on' : ''}`}
          id="tOffSync"
          style={{ display: features && transport.mode === 'listen' ? '' : 'none' }}
          title="Spotify starts a Canvas without syncing it to the song. Preview the loop at a random offset against the music (click again to turn off)"
          onClick={handleOffSync}
        >
          {transport.phase ? `Off-sync +${transport.phase.toFixed(2)}s` : 'Off-sync'}
        </button>

        <button
          className={`toggle ${!muted ? 'on' : ''}`}
          id="tMute"
          aria-pressed={!muted}
          style={{ display: features ? '' : 'none' }}
          title="Mute"
          onClick={handleMuteToggle}
        >
          Sound
        </button>
        </div>
      </div>
      <div className="viewer-loop"><span className="viewer-loop-label">Loop length</span>
        <div className="seg" id="barsSeg">
          {BAR_CHOICES.map((b) => (
            <button
              key={b}
              className={b === bars ? 'on' : ''}
              disabled={b > maxBars}
              title={`${(b * barDur).toFixed(2)} s`}
              onClick={() => setBars(b)}
            >
              {b === BAR_CHOICES[0] ? `${b} bar` : `${b}`}
            </button>
          ))}
          {!BAR_CHOICES.includes(bars) && (
            <button className="on" title="A custom length. Change it in the Edit tab." onClick={() => setTab('edit')}>
              {bars} · {fmtLength(loopLen)}
            </button>
          )}
        </div>

        <span className="viewer-beat"><span id="bbt">1.1</span> <small>BAR · BEAT</small></span>
      </div>
    </main>
  );
};
