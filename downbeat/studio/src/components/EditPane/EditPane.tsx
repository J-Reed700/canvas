import './EditPane.css';
import { useStudioStore, useVersion, useStudioApi, useSegmentMenu } from '../../state/StudioContext.tsx';
import { SegmentTransitionPicker } from '../SegmentTransitionPicker/SegmentTransitionPicker.tsx';
import React, { useLayoutEffect, useRef } from 'react';
import { BAR_CHOICES, TRANS_BEATS, fmtLength, parseLength } from '../../lib/utils.ts';
import { RHYTHMS, DIRECTIONS, VELOCITY } from '../../engine/timeline.ts';
import { TransitionPicker } from '../TransitionPicker/TransitionPicker.tsx';
import { CAMERA, FINISH_DEF, MODULES } from '../../engine/modules.ts';
import { CLIP_SPEED_MIN, CLIP_SPEED_MAX, CLIP_SPEED_PRESETS } from '../../engine/clipSpeed.ts';
import type { BlockOverrides, ParamDef } from '../../engine/types.ts';

const ownValue = (values: Record<string, number> | undefined, id: string): number | undefined =>
  Object.prototype.hasOwnProperty.call(values || {}, id) ? values?.[id] : undefined;

const compactOverrides = (o: BlockOverrides): BlockOverrides | undefined => {
  const out: BlockOverrides = {};
  if (o.macro && Object.keys(o.macro).length) out.macro = o.macro;
  if (o.camera && Object.keys(o.camera).length) out.camera = o.camera;
  if (o.finish && Object.keys(o.finish).length) out.finish = o.finish;
  if (o.layers && Object.keys(o.layers).length) out.layers = o.layers;
  return Object.keys(out).length ? out : undefined;
};

const BlockParam: React.FC<{
  scope: string;
  p: ParamDef;
  inherited: number;
  value?: number;
  set: (value?: number) => void;
}> = ({ scope, p, inherited, value, set }) => {
  const owned = value !== undefined;
  const shown = owned ? value : inherited;
  const text = p.opts?.[Math.round(shown)] ?? (p.step >= 1 ? String(Math.round(shown)) : Math.abs(shown) >= 10 ? shown.toFixed(1) : shown.toFixed(2));
  return (
    <div className={`prm block-prm ${owned ? 'modded' : ''}`}>
      <label>
        <input
          type="checkbox"
          aria-label={`Override ${scope} ${p.name}`}
          checked={owned}
          onChange={(e) => set(e.target.checked ? inherited : undefined)}
        />{' '}
        {p.name}
      </label>
      {p.opts ? (
        <select aria-label={`${scope} ${p.name}`} disabled={!owned} value={Math.round(shown)} onChange={(e) => set(+e.target.value)}>
          {p.opts.map((option, i) => <option value={i} key={option}>{option}</option>)}
        </select>
      ) : (
        <input
          aria-label={`${scope} ${p.name}`}
          type="range"
          min={p.min}
          max={p.max}
          step={p.step >= 1 ? p.step : (p.max - p.min) / 400}
          disabled={!owned}
          value={shown}
          onChange={(e) => set(+e.target.value)}
        />
      )}
      <output>{text}</output>
    </div>
  );
};

const BlockLookOverrides: React.FC = () => {
  const store = useStudioApi();

  const selected = useStudioStore((s) => s.selectedBlock);
  const ctx = useStudioStore((s) => s.ctx);
  const look = useStudioStore((s) => s.look);
  const stored = useStudioStore((s) => s.blocks);
  if (!selected || !ctx || !look) {
    return (
      <div className="field">
        <label>Block look</label>
        <div className="note">Select a block in the timeline to give just that block its own macros, camera, finish or effect settings.</div>
      </div>
    );
  }
  const seg = ctx.tl.segs.find((x) => x.id === selected);
  const block = (stored ?? ctx.tl.blocks).find((x) => x.id === selected);
  if (!seg || !block) return null;
  // Per-clip modes replace the effect stack and its macros for this segment. Camera and Finish stay
  // global, matching compose(), while indexed layer controls describe the stack actually on this block.
  const layerLook = seg.look || ctx.clipLook?.(seg.clipId, seg) || look;
  const overrides = block.overrides || {};
  const apply = (next: BlockOverrides) => store.getState().setBlock(selected, { overrides: compactOverrides(next) });
  const group = (key: 'camera' | 'finish', id: string, value?: number) => {
    const values = { ...(overrides[key] || {}) };
    if (value === undefined) delete values[id]; else values[id] = value;
    apply({ ...overrides, [key]: Object.keys(values).length ? values : undefined });
  };
  const macro = (key: 'a' | 'b', value?: number) => {
    const values = { ...(overrides.macro || {}) };
    if (value === undefined) delete values[key]; else values[key] = value;
    apply({ ...overrides, macro: Object.keys(values).length ? values : undefined });
  };
  const layerParam = (index: number, module: string, id: string, value?: number) => {
    const layers = { ...(overrides.layers || {}) };
    const prior = layers[String(index)]?.m === module ? layers[String(index)].p : {};
    const values = { ...prior };
    if (value === undefined) delete values[id]; else values[id] = value;
    if (Object.keys(values).length) layers[String(index)] = { m: module, p: values };
    else delete layers[String(index)];
    apply({ ...overrides, layers: Object.keys(layers).length ? layers : undefined });
  };
  const macroDefs: ParamDef[] = [
    { id: 'a', name: 'Macro A', min: 0, max: 1, def: 0, step: 0.01 },
    { id: 'b', name: 'Macro B', min: 0, max: 1, def: 0, step: 0.01 },
  ];
  return (
    <div className="field block-look">
      <label>Block {seg.i + 1} look</label>
      <div className="row">
        <span className="note">Checked settings belong to this block. Unchecked settings keep following the look.</span>
        {block.overrides && <button className="btn sm" onClick={() => apply({})}>Use look for all</button>}
      </div>
      <details open>
        <summary>Macros</summary>
        {macroDefs.map((p) => <BlockParam key={p.id} scope="Block" p={p} inherited={layerLook.macro?.[p.id as 'a' | 'b'] ?? 0} value={overrides.macro?.[p.id as 'a' | 'b']} set={(v) => macro(p.id as 'a' | 'b', v)} />)}
      </details>
      <details>
        <summary>Camera</summary>
        {CAMERA.params.map((p) => <BlockParam key={p.id} scope="Camera" p={p} inherited={look.camera.p[p.id] ?? p.def} value={ownValue(overrides.camera, p.id)} set={(v) => group('camera', p.id, v)} />)}
      </details>
      <details>
        <summary>Finish</summary>
        {FINISH_DEF.params.map((p) => <BlockParam key={p.id} scope="Finish" p={p} inherited={look.finish.p[p.id] ?? p.def} value={ownValue(overrides.finish, p.id)} set={(v) => group('finish', p.id, v)} />)}
      </details>
      {layerLook.layers.map((layer, index) => {
        const def = MODULES[layer.m];
        if (!def) return null;
        const own = overrides.layers?.[String(index)]?.m === layer.m ? overrides.layers[String(index)].p : undefined;
        return (
          <details key={`${index}:${layer.m}`}>
            <summary>Layer {index + 1} · {def.name}</summary>
            {def.params.map((p) => <BlockParam key={p.id} scope={`Layer ${index + 1}`} p={p} inherited={layer.p[p.id] ?? p.def} value={ownValue(own, p.id)} set={(v) => layerParam(index, layer.m, p.id, v)} />)}
          </details>
        );
      })}
    </div>
  );
};

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

/** The selected timeline segment's own timing, transition, playback and framing, drawn by the segment panel. */
const SegmentPanel: React.FC<{ id: string }> = ({ id }) => {
  const menus = useSegmentMenu();
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => menus.mountSegmentPanel(host.current!, id), [menus, id]);
  return <div className="seg-panel" ref={host} />;
};

const SegmentEditPane: React.FC<{ id: string }> = ({ id }) => (
  <div className="pane on edit-pane" id="pane-edit" role="tabpanel" aria-labelledby="inspector-tab-edit">
    <div style={{ padding: '14px' }}>
      <div className="edit-scope-note">Segment settings · only this segment</div>
      <SegmentPanel id={id} />
      <SegmentTransitionPicker />
      <details className="edit-family">
        <summary>Advanced values</summary>
        <div className="edit-family-body">
          <BlockLookOverrides />
        </div>
      </details>
    </div>
  </div>
);

/** Edit follows the inspector's target: a selected segment's own settings, or the arrangement of the whole edit. */
export const EditPane: React.FC = () => {
  const segment = useStudioStore((s) => (s.editBlock && s.ctx?.tl.segs.some((seg) => seg.id === s.editBlock) ? s.editBlock : null));
  return segment ? <SegmentEditPane id={segment} /> : <ArrangementPane />;
};

const ArrangementPane: React.FC = () => {
  const exporting = useStudioStore((s) => s.exporting);
  const store = useStudioApi();

  useVersion();
  const look = useStudioStore((s) => s.look);
  const handCut = useStudioStore((s) => !!s.ctx?.tl.handCut);
  const direction = useStudioStore((s) => s.direction);
  const seed = useStudioStore((s) => s.seed);
  const bpmManual = useStudioStore((s) => s.bpmManual);
  const lockEdit = useStudioStore((s) => s.lockEdit);
  const rebound = useStudioStore((s) => s.rebound);
  const fitAll = useStudioStore((s) => s.fitAll);
  const nClips = useStudioStore((s) => s.selected.length);
  const nShown = useStudioStore((s) => new Set(s.ctx?.tl.segs.map((x) => x.clipId)).size);
  const features = useStudioStore((s) => s.features);

  const rebuild = useStudioStore((s) => s.rebuild);
  const save = useStudioStore((s) => s.save);
  const speed = look?.camera.p.speed ?? 1;
  const setSpeed = (value: number) => {
    if (!look) return;
    look.camera.p.speed = value;
    rebuild();
  };

  return (
    <div className="pane on edit-pane" id="pane-edit" role="tabpanel" aria-labelledby="inspector-tab-edit">
      <div style={{ padding: '14px' }}>
        <div className="edit-scope-note">Arrangement settings · whole edit</div>
        <details className="edit-family" open><summary>Loop & timing</summary><div className="edit-family-body">
        <LoopLength />

        <div className="field">
          <label>Loop</label>
          <div className="seg">
            {[
              [false, 'Repeat', 'Plays the edit from the start again, with a transition at the seam'],
              [true, 'Rebound', 'Plays the first half of the loop forward, then backward, so the footage turns round in the middle and meets itself at the seam'],
            ].map(([on, label, title]) => (
              <button
                key={label as string}
                className={rebound === on ? 'on' : ''}
                title={title as string}
                onClick={() => {
                  if (rebound === on) return;
                  store.setState({ rebound: on as boolean, blocks: null });
                  rebuild();
                }}
              >
                {label as string}
              </button>
            ))}
          </div>
          {rebound && (
            <div className="note" style={{ marginTop: '6px' }}>
              The cuts fill the first half of the loop. The second half plays them backward, so the timeline shows it dimmed.
              The music and the effects keep going forward.
            </div>
          )}
        </div>

        </div></details>

        <details className="edit-family" open><summary>Rhythm & transitions</summary><div className="edit-family-body">
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
                  store.setState({ blocks: null });
                  rebuild();
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
          <label className="check" style={{ marginTop: '8px' }}>
            <input
              type="checkbox"
              checked={fitAll}
              onChange={(e) => {
                store.setState({ fitAll: e.target.checked });
                rebuild();
              }}
            />
            Show every clip at least once
          </label>
          <div className="note">
            {fitAll
              ? 'When the rhythm gives fewer cuts than there are clips, the longest cuts are split in two until each clip has one.'
              : nShown && nShown < nClips
                ? `${nClips - nShown} of the ${nClips} clips ${nClips - nShown === 1 ? "doesn't" : "don't"} appear, because there are more clips than cuts.`
                : 'Clips take turns, one per cut.'}
          </div>
        </div>

        <div className="field">
          <label>Transitions</label>
          <TransitionPicker multiple value={look?.cut.transitions || []} disabled={!look || exporting} onChange={(ids) => {
            if (!look) return;
            look.cut.transitions = ids;
            rebuild();
          }} />
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

        </div></details>

        <details className="edit-family"><summary>Playback & speed</summary><div className="edit-family-body">
        <div className="field clip-speed">
          <label>Clip speed</label>
          <div className="row">
            <input
              aria-label="Default clip speed"
              type="range"
              min={CLIP_SPEED_MIN}
              max={CLIP_SPEED_MAX}
              step={0.01}
              value={speed}
              disabled={!look}
              onChange={(e) => setSpeed(+e.target.value)}
              onDoubleClick={() => setSpeed(1)}
            />
            <output>{speed.toFixed(2)}×</output>
          </div>
          <div className="seg">
            {CLIP_SPEED_PRESETS.map((value) => (
              <button key={value} className={Math.abs(speed - value) < 1e-6 ? 'on' : ''} disabled={!look} onClick={() => setSpeed(value)}>
                {value}×
              </button>
            ))}
          </div>
          <div className="note">
            Speeds footage up or slows it down while cuts stay on the beat and the song keeps its tempo.
            Select a segment on the timeline to set only its speed or match its original BPM to the song.
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
                  store.setState({ direction: d });
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
            Velocity-edit curves locked to the beat. Each averages out to the clip speed, so total segment timing is preserved. Select a segment on the timeline to ramp just that one.
          </div>
        </div>

        </div></details>

        <details className="edit-family"><summary>Generate & preserve</summary><div className="edit-family-body">
        <div className="field">
          <label>Edit seed</label>
          <div className="row">
            <input
              className="numin"
              type="number"
              value={seed}
              onChange={(e) => {
                store.setState({ seed: Math.round(+e.target.value) || 1, blocks: null });
                rebuild();
              }}
            />
            <button
              className="btn sm"
              onClick={() => {
                store.setState({ seed: Math.floor(Math.random() * 1e6), blocks: null });
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
                  store.setState({ bpmManual: +e.target.value });
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
                store.setState({ lockEdit: e.target.checked });
                save();
              }}
            />
            Keep my edit (cuts & transitions) when switching looks
          </label>
        </div>

        </div></details>

        <div className="note">
          The loop starts and ends on the beat grid, and noise-based effects cross-fade over the loop length so the end matches the start. Feedback effects are run in before an export begins. A flash guard on the GPU limits sudden jumps in brightness between frames.
        </div>
      </div>
    </div>
  );
};
