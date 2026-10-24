import React from 'react';
import { useStudioStore, useVersion } from '../state/store.ts';
import { BAR_CHOICES, POOLS, TRANS_BEATS, fmtLength, parseLength } from '../lib/utils.ts';
import { RHYTHMS, DIRECTIONS, VELOCITY } from '../engine/timeline.ts';
import { TRANSITIONS } from '../engine/shaders.ts';

const LoopLength: React.FC = () => {
  const bpm = useStudioStore((s) => s.bpm());
  const barDur = useStudioStore((s) => s.barDur());
  const maxBars = useStudioStore((s) => s.maxBars());
  const loopLen = useStudioStore((s) => s.loopLen());
  const features = useStudioStore((s) => s.features);
  const loopStart = useStudioStore((s) => s.loopStart);
  const setBars = useStudioStore((s) => s.setBars);
  const wholeSong = useStudioStore((s) => s.wholeSong);
  const bars = Math.round(loopLen / barDur);
  const [barsText, setBarsText] = React.useState(String(bars));
  const [lenText, setLenText] = React.useState(fmtLength(loopLen));
  React.useEffect(() => {
    setBarsText(String(bars));
    setLenText(fmtLength(loopLen));
  }, [bars, loopLen]);

  const commit = (b: number) => {
    if (!(b >= 1)) {
      setBarsText(String(bars));
      setLenText(fmtLength(loopLen));
      return;
    }
    const n = Math.min(maxBars, Math.max(1, Math.round(b)));
    setBars(n);
    setBarsText(String(n));
    setLenText(fmtLength(n * barDur));
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  };

  const isWhole = !!features?.duration && bars === maxBars && Math.abs(loopStart - (features.downbeats?.[0] ?? 0)) < 0.01;
  const fit =
    loopLen < 3 - 1e-6
      ? 'Shorter than a Spotify Canvas, which needs 3 to 8 s.'
      : loopLen <= 8 + 1e-6
        ? 'Fits a Spotify Canvas (3 to 8 s).'
        : 'Longer than a Spotify Canvas (3 to 8 s), so export it as YouTube 16:9 or Social 1:1.';
  const limit = features?.duration
    ? `The longest is ${maxBars} bars (${fmtLength(maxBars * barDur)}), the song from its first downbeat.`
    : `Without a song the longest is ${maxBars} bars (${fmtLength(maxBars * barDur)}).`;

  return (
    <div className="field">
      <label>Loop length</label>
      <div className="seg">
        {BAR_CHOICES.map((b) => (
          <button key={b} className={b === bars && !isWhole ? 'on' : ''} disabled={b > maxBars} onClick={() => setBars(b)}>
            {b} bar{b > 1 ? 's' : ''}
          </button>
        ))}
        {features?.duration ? (
          <button className={isWhole ? 'on' : ''} title="Start at the first downbeat and run to the last full bar of the song" onClick={wholeSong}>
            Whole song
          </button>
        ) : null}
      </div>
      <div className="row loop-len">
        <input
          className="numin"
          type="number"
          min={1}
          max={maxBars}
          aria-label="Loop length in bars"
          value={barsText}
          onChange={(e) => setBarsText(e.target.value)}
          onBlur={(e) => commit(parseInt(e.currentTarget.value, 10))}
          onKeyDown={onKey}
        />
        <span className="note">bars</span>
        <input
          className="numin"
          aria-label="Loop length in minutes and seconds"
          title="Type 2:30, 150 or 2.5m. It rounds to the nearest whole bar."
          value={lenText}
          onChange={(e) => setLenText(e.target.value)}
          onBlur={(e) => commit(parseLength(e.currentTarget.value) / barDur)}
          onKeyDown={onKey}
        />
      </div>
      <div className="note" style={{ marginTop: '6px' }}>
        {fmtLength(loopLen)} at {bpm.toFixed(2)} BPM. {fit} {limit} Lengths are whole bars so beat-synced effects stay in phase
        when the loop restarts.
      </div>
    </div>
  );
};

export const EditPane: React.FC = () => {
  useVersion();
  const look = useStudioStore((s) => s.look);
  const handCut = useStudioStore((s) => !!s.ctx?.tl.handCut);
  const direction = useStudioStore((s) => s.direction);
  const seed = useStudioStore((s) => s.seed);
  const bpmManual = useStudioStore((s) => s.bpmManual);
  const lockEdit = useStudioStore((s) => s.lockEdit);
  const features = useStudioStore((s) => s.features);

  const rebuild = useStudioStore((s) => s.rebuild);
  const save = useStudioStore((s) => s.save);

  return (
    <div className="pane on" id="pane-edit">
      <div style={{ padding: '14px' }}>
        <LoopLength />

        <div className="field">
          <label>Cut rhythm</label>
          <div className="seg">
            {Object.entries(RHYTHMS).map(([k, r]) => (
              <button
                key={k}
                className={!handCut && look?.cut?.rhythm === k ? 'on' : ''}
                onClick={() => {
                  if (!look) return;
                  look.cut.rhythm = k;
                  useStudioStore.setState({ blocks: null });
                  rebuild();
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Transitions</label>
          <div className="pools">
            {Object.entries(POOLS).map(([name, ids]) => {
              const cutTrans = look?.cut?.transitions || [];
              const active = ids.length === cutTrans.length && ids.every((k) => cutTrans.includes(k));
              return (
                <button
                  key={name}
                  className={`btn sm ${active ? 'on' : ''}`}
                  onClick={() => {
                    if (!look) return;
                    look.cut.transitions = [...ids];
                    rebuild();
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <div className="tgrid">
            {Object.entries(TRANSITIONS).map(([k, t]) => {
              const cutTrans = look?.cut?.transitions || [];
              return (
                <button
                  key={k}
                  className={cutTrans.includes(k) ? 'on' : ''}
                  title={`${t.name}: click to toggle, double-click to isolate`}
                  onClick={() => {
                    if (!look) return;
                    const idx = cutTrans.indexOf(k);
                    if (idx >= 0 && cutTrans.length > 1) cutTrans.splice(idx, 1);
                    else if (idx < 0) cutTrans.push(k);
                    rebuild();
                  }}
                  onDoubleClick={() => {
                    if (!look) return;
                    look.cut.transitions = [k];
                    rebuild();
                  }}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>Transition length (beats)</label>
          <div className="seg">
            {TRANS_BEATS.map(([b, l]) => (
              <button
                key={b}
                className={look?.cut?.beats === b ? 'on' : ''}
                onClick={() => {
                  if (!look) return;
                  look.cut.beats = b;
                  rebuild();
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Transition order</label>
          <div className="seg">
            {[
              ['cycle', 'Cycle'],
              ['random', 'Shuffle'],
            ].map(([o, label]) => (
              <button
                key={o}
                className={(look?.cut?.order || 'cycle') === o ? 'on' : ''}
                onClick={() => {
                  if (!look) return;
                  look.cut.order = o;
                  rebuild();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Clip direction</label>
          <div className="seg">
            {Object.entries(DIRECTIONS).map(([d, label]) => (
              <button
                key={d}
                className={direction === d ? 'on' : ''}
                onClick={() => {
                  useStudioStore.setState({ direction: d });
                  rebuild();
                }}
              >
                {label as string}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Speed ramp</label>
          <div className="seg wrap">
            {Object.entries(VELOCITY).map(([k, v]) => (
              <button
                key={k}
                className={(look?.cut?.velocity || 'none') === k ? 'on' : ''}
                title={v.desc || 'Constant clip speed'}
                onClick={() => {
                  if (!look) return;
                  look.cut.velocity = k;
                  rebuild();
                }}
              >
                {v.name}
              </button>
            ))}
          </div>
          <div className="note" style={{ marginTop: '6px' }}>
            Velocity-edit curves locked to the beat. Each averages out to the clip speed, so total segment timing is preserved. Double-click a segment to ramp just that one.
          </div>
        </div>

        <div className="field">
          <label>Edit seed</label>
          <div className="row">
            <input
              className="numin"
              type="number"
              value={seed}
              onChange={(e) => {
                useStudioStore.setState({ seed: Math.round(+e.target.value) || 1, blocks: null });
                rebuild();
              }}
            />
            <button
              className="btn sm"
              onClick={() => {
                useStudioStore.setState({ seed: Math.floor(Math.random() * 1e6), blocks: null });
                rebuild();
              }}
            >
              ⚄ Re-roll in-points & order
            </button>
          </div>
        </div>

        {!features && (
          <div className="field">
            <label>Tempo (no track)</label>
            <div className="row">
              <input
                type="range"
                min={60}
                max={180}
                step={1}
                value={bpmManual}
                style={{ flex: 1, accentColor: 'var(--accent)' }}
                onChange={(e) => {
                  useStudioStore.setState({ bpmManual: +e.target.value });
                  rebuild();
                }}
              />
              <span className="muted" style={{ minWidth: '64px', textAlign: 'right' }}>
                {bpmManual} BPM
              </span>
            </div>
          </div>
        )}

        <div className="field">
          <label>Browsing looks</label>
          <label className="check">
            <input
              type="checkbox"
              checked={lockEdit}
              onChange={(e) => {
                useStudioStore.setState({ lockEdit: e.target.checked });
                save();
              }}
            />
            Keep my edit (cuts & transitions) when switching looks
          </label>
        </div>

        <div className="note">
          The loop starts and ends on the beat grid, and noise-based effects cross-fade over the loop length so the end matches the start. Feedback effects are run in before an export begins. A flash guard on the GPU limits sudden jumps in brightness between frames.
        </div>
      </div>
    </div>
  );
};
