import React, { useEffect, useRef, useState } from 'react';
import { useStudioStore, useVersion } from '../state/store.ts';
import { MAX_CUBE_BYTES, lutValues, parseCube } from '../engine/lut.ts';
import { drawScope, type ScopeMode } from '../engine/scopes.ts';
import { Card, SliderRow } from './ui.tsx';
import { toast } from '../lib/utils.ts';

export const ColorGradeCard: React.FC = () => {
  useVersion();
  const look = useStudioStore((s) => s.look);
  const exporting = useStudioStore((s) => s.exporting);
  const engine = useStudioStore((s) => s.engine);
  const input = useRef<HTMLInputElement>(null);
  const scope = useRef<HTMLCanvasElement>(null);
  const request = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scopeMode, setScopeMode] = useState<ScopeMode | 'off'>('off');
  const lut = look?.finish.lut;

  useEffect(() => () => {
    request.current++;
  }, []);

  useEffect(() => {
    if (scopeMode === 'off' || !engine || exporting) return;
    let visible = typeof IntersectionObserver === 'undefined';
    const draw = () => {
      if (!visible || document.hidden || !scope.current?.offsetParent) return;
      const pixels = engine.readScope();
      if (pixels) drawScope(scope.current, pixels, scopeMode);
    };
    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) draw();
      })
      : null;
    if (scope.current) observer?.observe(scope.current);
    draw();
    const timer = setInterval(draw, 200);
    return () => {
      clearInterval(timer);
      observer?.disconnect();
    };
  }, [scopeMode, engine, exporting]);

  if (!look) return null;

  const changed = () => {
    const s = useStudioStore.getState();
    s.engine?.main.reset();
    s.touch();
    s.save();
  };
  const importLut = async (file: File) => {
    const id = ++request.current;
    setBusy(true);
    setError('');
    try {
      if (!/\.cube$/i.test(file.name)) throw new Error('Choose a .cube LUT file.');
      if (file.size > MAX_CUBE_BYTES) throw new Error('The LUT is too large (24 MB maximum).');
      const grade = parseCube(await file.text(), file.name);
      if (id !== request.current) return;
      const s = useStudioStore.getState();
      if (s.look !== look || s.exporting) throw new Error('The edit changed while the LUT was loading. Import it again.');
      lutValues(grade);
      // Check allocation before changing the edit; a GPU error must leave the old grade intact.
      s.engine?.gpu.lut(grade);
      look.finish.lut = grade;
      look.finish.p.lutMix = 1;
      changed();
      toast(`Loaded ${grade.name} · ${grade.size}³ LUT`);
    } catch (err) {
      if (id === request.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === request.current) setBusy(false);
    }
  };

  return (
    <Card color="#b9a4ff" title="Color studio" sub="3D LUT · video scopes">
      <div className="grade-file" aria-busy={busy}>
        <span className="grade-mark" aria-hidden="true">3D</span>
        <div className="grade-file-copy">
          <small>Creative LUT</small>
          <b>{lut?.name || 'No LUT loaded'}</b>
          <span>
            {lut
              ? `${lut.size} × ${lut.size} × ${lut.size} cube · embedded in project`
              : 'Load a display-referred .cube file'}
          </span>
        </div>
        <span className={`grade-status ${lut ? 'on' : ''}`}>{lut ? 'Active' : 'Optional'}</span>
      </div>
      <input
        ref={input}
        type="file"
        accept=".cube"
        aria-label="Import 3D LUT"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importLut(file);
        }}
      />
      <div className="row grade-actions">
        <button
          type="button"
          className="btn sm"
          disabled={exporting || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? 'Reading LUT…' : lut ? 'Replace .cube' : 'Import .cube'}
        </button>
        {lut && (
          <button
            type="button"
            className="btn sm grade-remove"
            disabled={exporting || busy}
            onClick={() => {
              delete look.finish.lut;
              changed();
              setError('');
            }}
          >
            Remove LUT
          </button>
        )}
      </div>
      {error && <div className="grade-error" role="alert">{error}</div>}
      {lut && (
        <SliderRow
          label="LUT mix"
          min={0}
          max={1}
          step={0.01}
          value={look.finish.p.lutMix ?? 1}
          def={1}
          output={`${Math.round((look.finish.p.lutMix ?? 1) * 100)}%`}
          onChange={(v) => {
            if (exporting) return;
            look.finish.p.lutMix = v;
            changed();
          }}
        />
      )}
      <div className="note grade-guidance">
        Creative LUTs run after the grade and before grain. Convert camera log footage before importing a display LUT.
      </div>

      <div className="scope-toolbar">
        <div>
          <b>Video scopes</b>
          <small>{exporting ? 'Paused during export' : 'Finished preview · 5 fps'}</small>
        </div>
        <div className="seg" role="group" aria-label="Video scopes">
          {([['off', 'Off'], ['waveform', 'Waveform'], ['rgb', 'RGB parade']] as const).map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={scopeMode === id ? 'on' : ''}
              aria-pressed={scopeMode === id}
              onClick={() => setScopeMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {scopeMode !== 'off' && (
        <div className="scope-frame">
          <canvas
            ref={scope}
            className="video-scope"
            width={320}
            height={154}
            aria-label={`${scopeMode === 'rgb' ? 'RGB parade' : 'Luma waveform'} of the finished preview`}
          />
        </div>
      )}
    </Card>
  );
};
