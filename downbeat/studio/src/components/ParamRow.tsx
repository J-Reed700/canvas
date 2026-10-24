import React from 'react';
import { useStudioStore } from '../store.ts';
import { h, openPop, closePop } from '../utils.ts';
import { MOD_SOURCES } from '../../modules.ts';
import type { ParamDef } from '../../types.ts';
import { Slider } from './ui.tsx';

export function openModPopover(
  anchor: HTMLElement,
  p: ParamDef,
  holder: any,
  paintMod: () => void,
) {
  const { features, touch, save } = useStudioStore.getState();
  const mods = holder.mods || (holder.mods = {});

  openPop(anchor, (box) => {
    box.append(h('div', { class: 'ph' }, `Modulate ${p.name}`));
    const amtRow = h('div', { class: 'amt' });
    const drawAmt = () => {
      const m = mods[p.id];
      amtRow.replaceChildren();
      if (!m) return;
      const o = h('output', {}, m.amt.toFixed(2));
      amtRow.append(
        h('input', {
          type: 'range',
          min: -1,
          max: 1,
          step: 0.01,
          value: m.amt,
          style: 'accent-color:var(--accent)',
          oninput: (e: Event) => {
            m.amt = +(e.target as HTMLInputElement).value;
            o.textContent = m.amt.toFixed(2);
            paintMod();
            touch();
            save();
          },
        }),
        o,
      );
    };

    const kinds: Record<string, string> = {
      audio: features ? 'From the song' : 'Audio (synthetic beat, no track)',
      clock: 'Tempo clocks · loop-locked',
      user: 'Yours · Modulators card',
    };

    for (const [kind, label] of Object.entries(kinds)) {
      box.append(h('div', { class: 'ph' }, label));
      for (const [k, s] of Object.entries(MOD_SOURCES)) {
        if (s.kind !== kind) continue;
        box.append(
          h(
            'button',
            {
              class: `pi ${mods[p.id]?.src === k ? 'on' : ''}`,
              style: `--c:${s.color}`,
              onclick: (e: MouseEvent) => {
                mods[p.id] = { src: k, amt: mods[p.id]?.amt ?? (kind === 'user' ? 0.5 : 0.25) };
                (box.querySelectorAll('.pi') as NodeListOf<HTMLElement>).forEach((b) => b.classList.remove('on'));
                (e.currentTarget as HTMLElement).classList.add('on');
                paintMod();
                drawAmt();
                touch();
                save();
              },
            },
            h('span', { class: 'sd' }),
            s.name,
          ),
        );
      }
    }

    box.append(amtRow);
    box.append(
      h(
        'button',
        {
          class: 'pi',
          onclick: () => {
            delete mods[p.id];
            paintMod();
            closePop();
            touch();
            save();
          },
        },
        h('span', { class: 'muted' }, 'Remove modulation'),
      ),
    );
    drawAmt();
  });
}

export interface ParamRowProps {
  p: ParamDef;
  holder: any;
  readLive?: (fr: any) => number | undefined;
}

export const ParamRow: React.FC<ParamRowProps> = ({ p, holder, readLive }) => {
  const touch = useStudioStore((s) => s.touch);
  const rebuild = useStudioStore((s) => s.rebuild);
  const save = useStudioStore((s) => s.save);

  const values = holder.p || (holder.p = {});
  const mods = holder.mods || (holder.mods = {});
  const stepped = !!p.opts || p.step >= 1;
  const v0 = values[p.id] ?? p.def;

  if (p.opts) {
    return (
      <div className="prm" key={p.id}>
        <label>{p.name}</label>
        <div className="opts">
          {p.opts.map((opt, i) => (
            <button
              key={opt}
              className={Math.round(values[p.id] ?? p.def) === i ? 'on' : ''}
              onClick={() => {
                values[p.id] = i;
                touch();
                if (p.retime) rebuild();
                save();
              }}
            >
              {opt}
            </button>
          ))}
        </div>
        <span />
      </div>
    );
  }

  const fmtVal = (val: number) =>
    p.step >= 1 ? String(Math.round(val)) : Math.abs(val) >= 10 ? val.toFixed(1) : val.toFixed(2);
  const mod = mods[p.id];

  return (
    <div
      className={`prm ${mod ? 'modded' : ''}`}
      key={p.id}
      style={mod ? ({ ['--mc' as any]: MOD_SOURCES[mod.src]?.color } as any) : undefined}
    >
      <label title={`${p.name}: double-click slider to reset`}>{p.name}</label>
      <Slider
        min={p.min}
        max={p.max}
        step={stepped ? p.step : (p.max - p.min) / 400}
        value={v0}
        def={p.def}
        onChange={(val) => {
          values[p.id] = val;
          touch();
          if (p.retime) rebuild();
          save();
        }}
      >
        <div
          className="ghost"
          ref={(el) => {
            if (el && readLive) {
              // The card may be reused for another layer or clip stack: keep the reader current.
              const s = useStudioStore.getState();
              const existing = s.ghosts.find((g) => g.el === el);
              if (existing) {
                existing.def = p;
                existing.read = readLive;
              } else {
                s.ghosts.push({ el, def: p, read: readLive });
              }
            }
          }}
        />
      </Slider>
      <output>{fmtVal(v0)}</output>
      <button
        className={`modbtn ${stepped ? 'na' : ''}`}
        data-pop
        title={mod ? `${MOD_SOURCES[mod.src]?.name} × ${mod.amt > 0 ? '+' : ''}${mod.amt.toFixed(2)}` : 'Modulate with audio or an LFO'}
        onClick={(e) => openModPopover(e.currentTarget, p, holder, touch)}
      />
    </div>
  );
};
