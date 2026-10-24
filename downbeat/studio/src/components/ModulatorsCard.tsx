import React, { useRef, useEffect } from 'react';
import { useStudioStore, useVersion } from '../state/store.ts';
import { toast, SEQ_PRESETS, ENV_PRESETS } from '../lib/utils.ts';
import { clamp } from '../engine/looks.ts';
import { CAMERA, FINISH_DEF, MODULES, MOD_SOURCES } from '../engine/modules.ts';
import { defaultEnv, defaultLfos, defaultSeq, envAt, lfoAt, lfoCycles, LFO_RATES, LFO_SHAPES } from '../engine/audio.ts';
import type { ClipPalette, LfoSpec, Look, ParamDef } from '../engine/types.ts';
import { Card, SliderRow } from './ui.tsx';

const USER_SOURCES = ['lfoA', 'lfoB', 'macroA', 'macroB', 'env', 'seq'];
const LFO_KEYS = ['lfoA', 'lfoB'];

// One cycle of each shape, drawn in a 24 × 12 box.
const SHAPE_ICONS: Record<string, string> = {
  sine: 'M1 11C5 11 7 1 12 1S19 11 23 11',
  tri: 'M1 11L12 1L23 11',
  saw: 'M1 11L21 1L23 11',
  square: 'M1 11V1H12V11H23',
  random: 'M1 8H5V3H9V10H13V5H17V9H21V2H23',
  smooth: 'M1 8C3 8 4 3 7 3S10 10 13 10S17 4 19 4S22 8 23 7',
};

const loopBeatsNow = (): number => {
  const ctx = useStudioStore.getState().ctx;
  return ctx ? ctx.L / ctx.beatDur : 16;
};

// Waveform across the whole loop with a line per bar, and the playhead when the loop is running.
function drawScope(cv: HTMLCanvasElement, lfo: LfoSpec, beats: number, color: string, u: number | null) {
  const g = cv.getContext('2d');
  if (!g) return;
  const W = cv.width;
  const H = cv.height;
  const y = (v: number) => H - 6 - v * (H - 12);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.lineWidth = 1;
  const bars = Math.max(1, Math.round(beats / 4));
  for (let b = 1; b < bars; b++) {
    g.beginPath();
    g.moveTo((W * b) / bars, 0);
    g.lineTo((W * b) / bars, H);
    g.stroke();
  }
  g.beginPath();
  for (let x = 0; x <= W; x += 2) {
    const v = lfoAt(lfo, x / W, beats);
    if (x === 0) g.moveTo(x, y(v));
    else g.lineTo(x, y(v));
  }
  g.strokeStyle = color;
  g.lineWidth = 2.5;
  g.stroke();
  if (u !== null) {
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(u * W - 1, 0, 2, H);
    g.beginPath();
    g.arc(u * W, y(lfoAt(lfo, u, beats)), 5, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
  }
}

// Which parameters each user source (macros, envelope, steps) drives in this stack. Camera and Finish
// always read the main look, so they only count when the main look is the one being edited.
function userRoutes(target: Look, withShared: boolean): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(USER_SOURCES.map((k) => [k, []]));
  const scan = (owner: string, defs: ParamDef[], mods?: Record<string, { src: string }>) => {
    for (const p of defs) {
      const src = mods?.[p.id]?.src;
      if (src && out[src]) out[src].push(`${owner} · ${p.name}`);
    }
  };
  for (const l of target.layers) {
    if (l.on !== false && MODULES[l.m]) scan(MODULES[l.m].name, MODULES[l.m].params, l.mods);
  }
  if (withShared) {
    scan('Camera', CAMERA.params, target.camera?.mods);
    scan('Finish', FINISH_DEF.params, target.finish?.mods);
  }
  return out;
}

const isHueParam = (p: ParamDef) => p.id === 'hue' && !p.opts && p.step < 1 && p.min === 0 && p.max === 1;

export const ModulatorsCard: React.FC = () => {
  useVersion();
  const envCanvasRef = useRef<HTMLCanvasElement>(null);
  const lfoCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef<((u?: number | null) => void) | null>(null);

  const selected = useStudioStore((s) => s.selected);
  const palettes = useStudioStore((s) => s.palettes);
  const fetchPalette = useStudioStore((s) => s.fetchPalette);
  const look = useStudioStore((s) => s.look);
  const touch = useStudioStore((s) => s.touch);
  const save = useStudioStore((s) => s.save);
  const target = useStudioStore((s) => s.editLook());

  useEffect(() => {
    if (selected[0]) fetchPalette(selected[0]);
  }, [selected[0], fetchPalette]);

  useEffect(() => {
    const cv = envCanvasRef.current;
    if (!cv) return;

    // Always read the envelope off the look being edited: presets and undo replace the array.
    const env = () => {
      const l = useStudioStore.getState().editLook();
      return l.env || (l.env = defaultEnv());
    };

    const drawEnv = (u: number | null = null) => {
      const g = cv.getContext('2d');
      if (!g) return;
      const pts = env();
      const W = cv.width;
      const H = cv.height;
      g.clearRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      for (let i = 1; i < 4; i++) {
        g.beginPath();
        g.moveTo((W * i) / 4, 0);
        g.lineTo((W * i) / 4, H);
        g.stroke();
      }
      g.beginPath();
      for (let x = 0; x <= W; x += 4) {
        const v = envAt(pts, x / W);
        const y = H - 8 - v * (H - 16);
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = MOD_SOURCES.env?.color || '#FFA36E';
      g.lineWidth = 3;
      g.stroke();
      g.fillStyle = MOD_SOURCES.env?.color || '#FFA36E';
      pts.forEach((v, i) => {
        g.beginPath();
        g.arc((i / pts.length) * W, H - 8 - v * (H - 16), 5, 0, Math.PI * 2);
        g.fill();
      });
      if (u !== null) {
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.fillRect(u * W - 1, 0, 2, H);
      }
    };
    const drawLfos = (u: number | null = null) => {
      const lfos = useStudioStore.getState().editLook().lfos || defaultLfos();
      const beats = loopBeatsNow();
      lfoCanvasRefs.current.forEach((c, i) => {
        if (c && lfos[i]) drawScope(c, lfos[i], beats, MOD_SOURCES[LFO_KEYS[i]].color, u);
      });
    };
    const drawAll = (u: number | null = null) => {
      drawEnv(u);
      drawLfos(u);
    };
    drawRef.current = drawAll;

    let drawing = false;
    const setPt = (e: PointerEvent) => {
      const pts = env();
      const r = cv.getBoundingClientRect();
      const i = clamp(Math.round(((e.clientX - r.left) / r.width) * pts.length), 0, pts.length - 1);
      pts[i] = +clamp(1 - (e.clientY - r.top - 4) / (r.height - 8), 0, 1).toFixed(3);
      drawEnv();
      touch();
      save();
    };

    const onPointerDown = (e: PointerEvent) => {
      drawing = true;
      cv.setPointerCapture(e.pointerId);
      setPt(e);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (drawing) setPt(e);
    };
    const onPointerUp = () => {
      drawing = false;
    };
    const onDblClick = () => {
      const pts = env();
      pts.splice(0, pts.length, ...defaultEnv());
      drawEnv();
      touch();
      save();
    };

    cv.addEventListener('pointerdown', onPointerDown);
    cv.addEventListener('pointermove', onPointerMove);
    cv.addEventListener('pointerup', onPointerUp);
    cv.addEventListener('dblclick', onDblClick);

    useStudioStore.setState({ modUI: { drawEnv: drawAll, grid: gridRef.current } });

    return () => {
      cv.removeEventListener('pointerdown', onPointerDown);
      cv.removeEventListener('pointermove', onPointerMove);
      cv.removeEventListener('pointerup', onPointerUp);
      cv.removeEventListener('dblclick', onDblClick);
      drawRef.current = null;
      useStudioStore.setState({ modUI: null });
    };
  }, [touch, save]);

  // Redraw after every edit too: the render loop only repaints the envelope while a timeline exists.
  useEffect(() => {
    drawRef.current?.();
  });

  const palette: ClipPalette | undefined = selected[0] ? palettes[selected[0]] : undefined;
  const finishP = look?.finish?.p;
  const tintOn = (finishP?.split ?? 0) >= 0.35;

  const tint = (sw: ClipPalette['colors'][number]) => {
    const main = useStudioStore.getState().look;
    if (!main) return;
    // Finish is shared by every clip, so the split tone always goes on the main look.
    if (!main.finish) main.finish = { p: {}, mods: {} };
    const fp = main.finish.p || (main.finish.p = {});
    fp.splitHue = sw.hue;
    fp.split = Math.max(0.6, fp.split || 0);
    let hues = 0;
    for (const layer of target.layers) {
      if (layer.on === false || !MODULES[layer.m]) continue;
      for (const p of MODULES[layer.m].params) {
        if (!isHueParam(p)) continue;
        (layer.p || (layer.p = {}))[p.id] = sw.hue;
        hues++;
      }
    }
    touch();
    save();
    toast(`Tinted with ${sw.hex}: Finish split tone${hues ? ` + ${hues} layer hue${hues > 1 ? 's' : ''}` : ''} · ⌘Z undoes`);
  };

  const setMacro = (k: 'a' | 'b', v: number) => {
    target.macro = target.macro || { a: 0, b: 0 };
    target.macro[k] = v;
    touch();
    save();
  };

  const editLfo = (i: number, patch: Partial<LfoSpec>) => {
    const lfos = target.lfos || (target.lfos = defaultLfos());
    Object.assign(lfos[i], patch);
    touch();
    save();
  };
  const loopBeats = loopBeatsNow();
  const lfos = target.lfos || defaultLfos();

  const routes = userRoutes(target, target === look);
  const routed = USER_SOURCES.some((k) => routes[k].length);

  return (
    <>
      {palette && (
        <Card
          color={palette.colors[0]?.hex || '#C8FF4D'}
          title="Color palette"
          sub="from clip #1 · click one to tint"
          bodyStyle={{ padding: '8px 12px' }}
        >
          <div className="pal-grad" style={{ background: palette.css_gradient }} title="Palette gradient preview" />
          <div className="pal-list">
            {palette.colors.map((sw, idx) => {
              const on = tintOn && Math.abs((finishP?.splitHue ?? -1) - sw.hue) < 0.002;
              return (
                <div
                  key={idx}
                  role="button"
                  tabIndex={0}
                  className={`pal-row ${on ? 'on' : ''}`}
                  title={`Tint the look with ${sw.role} (split-tone hue ${sw.hue.toFixed(2)})`}
                  onClick={() => tint(sw)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      tint(sw);
                    }
                  }}
                >
                  <span className="chip-sw" style={{ backgroundColor: sw.hex }} />
                  <button
                    className="hex"
                    title={`Copy ${sw.hex}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard?.writeText(sw.hex).then(
                        () => toast(`Copied ${sw.hex}`),
                        () => toast(`Could not copy ${sw.hex}`),
                      );
                    }}
                  >
                    {sw.hex}
                  </button>
                  <span className="role">{sw.role}</span>
                  <span className="act">{on ? 'Tinted' : 'Tint'}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card color="#FFD36E" title="Modulators" sub="LFOs, macros, envelope, steps">
        {lfos.slice(0, 2).map((lfo, i) => {
          const key = LFO_KEYS[i];
          const color = MOD_SOURCES[key].color;
          const cycles = lfoCycles(lfo.rate, loopBeats);
          const fitted = lfo.rate > 0 && lfo.rate * 4 > loopBeats;
          const randomish = lfo.shape === 'random' || lfo.shape === 'smooth';
          return (
            <div className="lfo" key={key}>
              <div className="mod-h">
                <span>
                  <i className="lfo-dot" style={{ background: color }} />
                  {MOD_SOURCES[key].name} ·{' '}
                  {fitted
                    ? `once per loop (the loop is ${loopBeats / 4} bar${loopBeats > 4 ? 's' : ''})`
                    : `${cycles} cycle${cycles > 1 ? 's' : ''} per loop`}
                </span>
                {randomish && (
                  <div className="mini-presets">
                    <button className="mini" title="New random pattern" onClick={() => editLfo(i, { seed: (lfo.seed || 0) + 1 })}>
                      🎲 New pattern
                    </button>
                  </div>
                )}
              </div>
              <canvas
                className="envcv lfocv"
                ref={(el) => {
                  lfoCanvasRefs.current[i] = el;
                }}
                width={600}
                height={96}
                title={`${MOD_SOURCES[key].name} over one loop. Lines mark the bars.`}
              />
              <div className="seg lfo-seg" role="group" aria-label={`${MOD_SOURCES[key].name} shape`}>
                {LFO_SHAPES.map(([k, name]) => (
                  <button key={k} className={lfo.shape === k ? 'on' : ''} title={name} aria-label={name} onClick={() => editLfo(i, { shape: k })}>
                    <svg viewBox="0 0 24 12" aria-hidden="true">
                      <path d={SHAPE_ICONS[k]} />
                    </svg>
                  </button>
                ))}
              </div>
              <div className="lfo-row">
                <span className="lfo-lbl">Bars</span>
                <div className="seg lfo-seg" role="group" aria-label={`${MOD_SOURCES[key].name} rate`}>
                  {LFO_RATES.map(([r, label]) => (
                    <button
                      key={r}
                      className={lfo.rate === r ? 'on' : ''}
                      title={r ? `One cycle every ${label} bar${r > 1 ? 's' : ''}` : 'One cycle per loop'}
                      onClick={() => editLfo(i, { rate: r })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <SliderRow
                label="Phase"
                title="Where in its cycle the LFO starts"
                min={0}
                max={0.99}
                step={0.01}
                value={lfo.phase}
                def={0}
                output={`${Math.round(lfo.phase * 360)}°`}
                onChange={(v) => editLfo(i, { phase: v })}
              />
            </div>
          );
        })}

        {(['a', 'b'] as const).map((k) => {
          const v = target.macro?.[k] || 0;
          return (
            <SliderRow
              key={k}
              label={`Macro ${k.toUpperCase()}`}
              title={`One knob for many parameters: set a parameter's ● to Macro ${k.toUpperCase()}`}
              min={0}
              max={1}
              step={0.01}
              value={v}
              def={0}
              output={`${Math.round(v * 100)}%`}
              onChange={(x) => setMacro(k, x)}
            />
          );
        })}

        <div className="mod-h stack">
          <span>Envelope · whole loop</span>
          <div className="mini-presets">
            {Object.entries(ENV_PRESETS).map(([name, fn]) => (
              <button
                key={name}
                className="mini"
                onClick={() => {
                  target.env = fn();
                  touch();
                  save();
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <canvas
          className="envcv"
          ref={envCanvasRef}
          width={600}
          height={128}
          title="Drag to draw · double-click for default arc"
        />

        <div className="mod-h stack">
          <span>Step sequencer · 1 bar</span>
          <div className="mini-presets">
            {Object.entries(SEQ_PRESETS).map(([name, fn]) => (
              <button
                key={name}
                className="mini"
                onClick={() => {
                  target.seq = fn();
                  touch();
                  save();
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="seqgrid" ref={gridRef}>
          {(target.seq || defaultSeq()).map((on, i) => (
            <button
              key={i}
              className={on ? 'on' : ''}
              title={`Step ${i + 1} (16th note ${i + 1} of the bar)`}
              onClick={() => {
                target.seq = target.seq || defaultSeq();
                target.seq[i] = target.seq[i] ? 0 : 1;
                touch();
                save();
              }}
            />
          ))}
        </div>

        <div className="note mod-routes">
          {routed ? (
            USER_SOURCES.map((k) => (
              <div key={k}>
                <b style={{ color: MOD_SOURCES[k].color }}>{MOD_SOURCES[k].name}</b> →{' '}
                {routes[k].length ? routes[k].join(', ') : <span className="muted">nothing yet</span>}
              </div>
            ))
          ) : (
            <div>
              None of these are connected yet. To use one, click the ● at the end of a slider below and pick
              LFO A, LFO B, Step sequencer, Drawn envelope, Macro A or Macro B.
            </div>
          )}
        </div>
      </Card>
    </>
  );
};
