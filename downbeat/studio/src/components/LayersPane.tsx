import React from 'react';
import { useStudioStore, useVersion } from '../state/store.ts';
import { originalLook } from '../state/historyController.ts';
import {
  h,
  shuffle,
  openPop,
  closePop,
  toast,
  CLIP_MODES,
} from '../lib/utils.ts';
import { cloneLook, insertAtStage } from '../engine/looks.ts';
import { MODULES, CATEGORIES, CAMERA, FINISH_DEF, defaults } from '../engine/modules.ts';
import { ModulatorsCard } from './ModulatorsCard.tsx';
import { ParamRow } from './ParamRow.tsx';
import { Card, SliderRow } from './ui.tsx';

export const LayersPane: React.FC = () => {
  useVersion();
  const look = useStudioStore((s) => s.look);
  const selected = useStudioStore((s) => s.selected);
  const clipMode = useStudioStore((s) => s.clipMode);
  const clipLooks = useStudioStore((s) => s.clipLooks);
  const editClip = useStudioStore((s) => s.editClip);
  const evolveAmt = useStudioStore((s) => s.evolveAmt);
  const intensity = useStudioStore((s) => s.intensity);
  const engine = useStudioStore((s) => s.engine);

  const setLook = useStudioStore((s) => s.setLook);
  const editLook = useStudioStore((s) => s.editLook());
  const editClipLook = useStudioStore((s) => s.editClipLook);
  const setClipMode = useStudioStore((s) => s.setClipMode);
  const rollClips = useStudioStore((s) => s.rollClips);
  const rebuild = useStudioStore((s) => s.rebuild);
  const touch = useStudioStore((s) => s.touch);
  const save = useStudioStore((s) => s.save);
  const saveLook = useStudioStore((s) => s.saveLook);

  const target = editLook;
  const isClipEdit = target !== look;
  const clipNo = selected.indexOf(editClip || '') + 1;

  // Where the stack below actually renders, in timeline terms (#n = clip n in the Clips list).
  const mainClips = selected
    .map((cid, i) => (clipMode === 'custom' && clipLooks[cid] ? 0 : i + 1))
    .filter(Boolean)
    .map((n) => `#${n}`);
  const stackScope = isClipEdit
    ? `Clip ${clipNo}'s own stack: runs only while #${clipNo} is on screen (highlighted in the timeline). Camera and Finish stay shared.`
    : clipMode === 'one'
      ? 'Effect stack: every layer runs on every frame, top to bottom, whichever clip is playing.'
      : clipMode === 'custom'
        ? mainClips.length
          ? `Main stack: runs on ${mainClips.join(', ')} (clips without their own stack).`
          : 'Main stack: every clip has its own stack right now, so these layers are not on screen. Camera and Finish still apply to all.'
        : `Main stack: runs on #1. Later clips get ${clipMode === 'evolve' ? 'a mutation of it' : 'a different studio look'}.`;

  const handleAddEffect = (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    openPop(
      anchor,
      (box) => {
        for (const [cat, meta] of Object.entries(CATEGORIES)) {
          box.append(h('div', { class: 'ph', style: `color:${meta.color}` }, meta.name));
          for (const [id, m] of Object.entries(MODULES)) {
            if (m.cat !== cat) continue;
            box.append(
              h(
                'button',
                {
                  class: 'pi',
                  onclick: () => {
                    target.layers.push({ m: id, on: true, p: defaults(m.params), mods: {} });
                    closePop();
                    engine?.main?.reset();
                    rebuild();
                    save();
                    toast(`Added ${m.name}`);
                  },
                },
                h('b', {}, m.name),
                h('span', {}, m.desc),
              ),
            );
          }
        }
      },
      'menu',
    );
  };

  const handleAddRandomLayer = () => {
    const pool = Object.keys(MODULES).filter((id) => !target.layers.some((x) => x.m === id));
    if (!pool.length) return;
    const id = pool[Math.floor(Math.random() * pool.length)];
    insertAtStage(target.layers, { m: id, on: true, p: defaults(MODULES[id].params), mods: {} });
    engine?.main?.reset();
    rebuild();
    save();
    toast(`Added ${MODULES[id].name} at random`);
  };

  const setIntensity = (v: number) => {
    useStudioStore.setState({ intensity: v });
    const currentCtx = useStudioStore.getState().ctx;
    if (currentCtx) currentCtx.intensity = v;
    touch();
    save();
  };

  return (
    <div className="pane on" id="pane-layers">
      <Card
        color="#FF7AE6"
        title={isClipEdit ? `Clip ${clipNo} · ${target.name}` : 'Master'}
        sub={isClipEdit ? `plays only on the #${clipNo} blocks` : 'intensity · per-clip looks'}
      >
        <SliderRow
          label="FX intensity"
          title="Below 100% fades every layer toward clean footage; above 100% modulation hits harder"
          min={0}
          max={1.5}
          step={0.01}
          value={intensity}
          def={1}
          output={`${Math.round(intensity * 100)}%`}
          onChange={setIntensity}
        />

        <div className="prm-wide">
          <label title="Give each clip its own effects">Per clip</label>
          <div className="seg">
            {CLIP_MODES.map(([k, label]) => (
              <button
                key={k}
                className={clipMode === k ? 'on' : ''}
                onClick={() => setClipMode(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="note" style={{ padding: '2px 0 4px' }}>
          {
            {
              one: 'Every clip runs through the main look.',
              evolve: 'Clip 1 uses the main look; each later clip gets its own mutation of it.',
              cycle: 'Clip 1 uses the main look; each later clip gets another look from the library.',
              custom: 'Pick a clip to give it its own stack, or click a look while a clip is picked.',
            }[clipMode]
          }
        </div>

        {clipMode === 'evolve' && (
          <SliderRow
            label="Evolve amount"
            min={0.1}
            max={1}
            step={0.01}
            value={evolveAmt}
            def={0.45}
            output={`${Math.round(evolveAmt * 100)}%`}
            onChange={(v) => {
              useStudioStore.setState({ evolveAmt: v });
              touch();
              save();
            }}
          />
        )}

        {clipMode === 'custom' && (
          <div className="clipstrip">
            <button
              className={`cs main ${isClipEdit ? '' : 'on'}`}
              title="Edit the main look"
              onClick={() => editClipLook(null)}
            >
              Main
            </button>
            {selected.map((cid, i) => (
              <button
                key={cid}
                className={`cs ${editClip === cid && isClipEdit ? 'on' : ''} ${clipLooks[cid] ? 'own' : ''}`}
                title={
                  clipLooks[cid]
                    ? `Clip ${i + 1}: ${clipLooks[cid].name}`
                    : `Clip ${i + 1} uses the main look: click to customize`
                }
                style={{ backgroundImage: `url(/api/thumb/${cid}?w=120)` }}
                onClick={() => editClipLook(cid)}
              >
                <span>{i + 1}</span>
              </button>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: '6px', flexWrap: 'wrap', gap: '6px' }}>
          <button
            className="btn sm"
            title="Give every clip its own random stack"
            onClick={rollClips}
          >
            🎲 Roll FX per clip
          </button>
          {clipMode !== 'one' && (
            <button
              className="btn sm"
              title="Drop the per-clip looks"
              onClick={() => {
                useStudioStore.setState({ clipLooks: {} });
                setClipMode('one');
                toast('Main look on every clip');
              }}
            >
              Same look on all
            </button>
          )}
          {isClipEdit && (
            <button
              className="btn sm"
              title="This clip follows the main look again"
              onClick={() => {
                const next = { ...clipLooks };
                if (editClip) delete next[editClip];
                useStudioStore.setState({ clipLooks: next, editClip: null });
                rebuild();
              }}
            >
              Reset clip {clipNo}
            </button>
          )}
        </div>
      </Card>

      <ModulatorsCard />

      <div className="note stack-scope">{stackScope}</div>
      <div className="layer-tools">
        <button className="btn sm" data-pop title="Add an effect layer" onClick={handleAddEffect}>
          + Add effect
        </button>
        <button className="btn sm" title="Add random effect" onClick={handleAddRandomLayer}>
          🎲 Random
        </button>
        <button
          className="btn sm"
          title="Shuffle layer order"
          disabled={target.layers.length < 2}
          onClick={() => {
            shuffle(target.layers);
            engine?.main?.reset();
            rebuild();
            save();
            toast('Shuffled the stack');
          }}
        >
          ⇅ Shuffle
        </button>
        <button
          className="btn sm"
          title="Remove every layer"
          disabled={!target.layers.length}
          onClick={() => {
            target.layers.length = 0;
            engine?.main?.reset();
            rebuild();
            save();
            toast('Cleared: Revert restores the look');
          }}
        >
          Clear
        </button>
      </div>

      {!isClipEdit && (
        <Card color="#FFFFFF" title="Camera" sub="framing · motion · clip speed">
          {CAMERA.params.map((p) => (
            <ParamRow key={p.id} p={p} holder={target.camera} readLive={(fr) => fr.camera?.[`p_${p.id}`]} />
          ))}
        </Card>
      )}

      {target.layers.map((layer, i) => {
        const m = MODULES[layer.m];
        if (!m) return null;
        const catMeta = CATEGORIES[m.cat || 'space'];

        return (
          <Card
            key={`${layer.m}-${i}`}
            className={layer.on === false ? 'off' : ''}
            color={catMeta?.color || '#C8FF4D'}
            title={m.name}
            sub={catMeta?.name}
            actions={
              <>
                <span
                  className={`sw ${layer.on !== false ? 'on' : ''}`}
                  title="Enable / bypass"
                  onClick={() => {
                    layer.on = layer.on === false;
                    engine?.main?.reset();
                    touch();
                    save();
                  }}
                />
                <button
                  className="ib"
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => {
                    if (i > 0) {
                      [target.layers[i - 1], target.layers[i]] = [target.layers[i], target.layers[i - 1]];
                      engine?.main?.reset();
                      touch();
                      save();
                    }
                  }}
                >
                  ↑
                </button>
                <button
                  className="ib"
                  title="Move down"
                  disabled={i === target.layers.length - 1}
                  onClick={() => {
                    if (i < target.layers.length - 1) {
                      [target.layers[i + 1], target.layers[i]] = [target.layers[i], target.layers[i + 1]];
                      engine?.main?.reset();
                      touch();
                      save();
                    }
                  }}
                >
                  ↓
                </button>
                <button
                  className="ib"
                  title="Remove"
                  onClick={() => {
                    target.layers.splice(i, 1);
                    engine?.main?.reset();
                    touch();
                    save();
                  }}
                >
                  ✕
                </button>
              </>
            }
          >
            <div className="note" style={{ marginBottom: '2px' }}>
              {m.desc}
            </div>
            {m.params.map((p) => (
              <ParamRow
                key={p.id}
                p={p}
                holder={layer}
                readLive={(fr) => {
                  const found = fr.layers.find((x) => x.src === layer) || fr.pre?.flat().find((x) => x.src === layer);
                  return found?.params[`p_${p.id}`];
                }}
              />
            ))}
          </Card>
        );
      })}

      {!target.layers.length && (
        <div className="note" style={{ padding: '6px 16px 4px' }}>
          No effect layers: just the camera and the grade. Add one above, or roll 🎲.
        </div>
      )}

      {!isClipEdit ? (
        <Card color="#C8FF4D" title="Finish" sub="grade · texture · safety">
          {FINISH_DEF.params.map((p) => (
            <ParamRow key={p.id} p={p} holder={target.finish} readLive={(fr) => fr.finish?.[`p_${p.id}`]} />
          ))}
        </Card>
      ) : (
        <div className="note" style={{ padding: '4px 16px 8px' }}>
          Camera, clip speed and the Finish grade are shared by every clip. Edit them on Main.
        </div>
      )}

      <div className="row" style={{ padding: '2px 12px 16px', gap: '8px' }}>
        <button
          className="btn"
          style={{ flex: 1, justifyContent: 'center' }}
          data-pop
          onClick={(e) => {
            const anchor = e.currentTarget;
            openPop(anchor, (box) => {
              const input = h('input', {
                class: 'numin',
                style: 'width:100%;font-family:var(--font);font-weight:500',
                value: target.name,
                maxlength: 40,
              }) as HTMLInputElement;

              const commit = () => {
                const name = input.value.trim();
                if (!name) return;
                saveLook(name);
                closePop();
              };

              input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') commit();
              });

              box.append(
                h('div', { class: 'ph' }, 'Save look as'),
                h('div', { style: 'padding:4px 6px 8px' }, input),
                h('div', { class: 'row', style: 'padding:0 6px 6px' }, h('button', { class: 'btn primary sm', onclick: commit }, 'Save')),
              );
              setTimeout(() => {
                input.focus();
                input.select();
              }, 0);
            });
          }}
        >
          ★ Save as look
        </button>
        <button
          className="btn"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => {
            const base = originalLook(target.id);
            if (!base) {
              toast('This look came from your last session, so there is nothing to revert to. ⌘Z still undoes edits');
              return;
            }
            if (isClipEdit && editClip) {
              useStudioStore.setState({ clipLooks: { ...clipLooks, [editClip]: cloneLook(base) } });
              engine?.main?.reset();
              rebuild();
            } else {
              setLook(base);
            }
            toast(`Reverted to ${base.name}`);
          }}
        >
          Revert
        </button>
      </div>
    </div>
  );
};
