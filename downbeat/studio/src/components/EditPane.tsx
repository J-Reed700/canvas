import React from 'react';
import { useStudioStore, useVersion } from '../store.ts';
import { BAR_CHOICES, POOLS, TRANS_BEATS } from '../utils.ts';
import { RHYTHMS, DIRECTIONS, VELOCITY } from '../../timeline.ts';
import { TRANSITIONS } from '../../shaders.ts';

export const EditPane: React.FC = () => {
  useVersion();
  const look = useStudioStore((s) => s.look);
  const bars = useStudioStore((s) => s.bars);
  const customCuts = useStudioStore((s) => s.customCuts);
  const direction = useStudioStore((s) => s.direction);
  const seed = useStudioStore((s) => s.seed);
  const bpmManual = useStudioStore((s) => s.bpmManual);
  const lockEdit = useStudioStore((s) => s.lockEdit);
  const features = useStudioStore((s) => s.features);

  const rebuild = useStudioStore((s) => s.rebuild);
  const save = useStudioStore((s) => s.save);
  const validBars = useStudioStore((s) => s.validBars());
  const loopLen = useStudioStore((s) => s.loopLen());
  const bpm = useStudioStore((s) => s.bpm());

  return (
    <div className="pane on" id="pane-edit">
      <div style={{ padding: '14px' }}>
        <div className="field">
          <label>Loop length</label>
          <div className="seg">
            {BAR_CHOICES.map((b) => (
              <button
                key={b}
                className={b === bars ? 'on' : ''}
                disabled={!validBars.includes(b)}
                onClick={() => {
                  useStudioStore.setState({ bars: b, customCuts: null });
                  rebuild();
                }}
              >
                {b} bar{b > 1 ? 's' : ''}
              </button>
            ))}
          </div>
          <div className="note" style={{ marginTop: '6px' }}>
            {loopLen.toFixed(3)} s at {bpm.toFixed(2)} BPM. Whole bars keep every beat-synced effect phase-locked across the seam.
          </div>
        </div>

        <div className="field">
          <label>Cut rhythm</label>
          <div className="seg">
            {Object.entries(RHYTHMS).map(([k, r]) => (
              <button
                key={k}
                className={(customCuts ? 'custom' : look?.cut?.rhythm) === k ? 'on' : ''}
                onClick={() => {
                  if (!look) return;
                  look.cut.rhythm = k;
                  useStudioStore.setState({ customCuts: null, segOverrides: {} });
                  rebuild();
                }}
              >
                {(r as any).name}
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
                    useStudioStore.setState({ segOverrides: {} });
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
                  title={`${(t as any).name}: click to toggle, double-click to isolate`}
                  onClick={() => {
                    if (!look) return;
                    const idx = cutTrans.indexOf(k);
                    if (idx >= 0 && cutTrans.length > 1) cutTrans.splice(idx, 1);
                    else if (idx < 0) cutTrans.push(k);
                    useStudioStore.setState({ segOverrides: {} });
                    rebuild();
                  }}
                  onDoubleClick={() => {
                    if (!look) return;
                    look.cut.transitions = [k];
                    useStudioStore.setState({ segOverrides: {} });
                    rebuild();
                  }}
                >
                  {(t as any).name}
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
                title={(v as any).desc || 'Constant clip speed'}
                onClick={() => {
                  if (!look) return;
                  look.cut.velocity = k;
                  rebuild();
                }}
              >
                {(v as any).name}
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
                useStudioStore.setState({ seed: Math.round(+e.target.value) || 1 });
                rebuild();
              }}
            />
            <button
              className="btn sm"
              onClick={() => {
                useStudioStore.setState({ seed: Math.floor(Math.random() * 1e6), segOverrides: {} });
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
