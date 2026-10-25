import './LayersPane.css';
import { useStudioStore, useVersion, useStudioApi, useStudioRuntime } from '../../state/StudioContext.tsx';
import React, { useState } from 'react';
import { h, shuffle, openPop, closePop, toast, CLIP_MODES } from '../../lib/utils.ts';
import { cloneLook, insertAtStage } from '../../engine/looks.ts';
import { MODULES, CATEGORIES, CAMERA, FINISH_DEF, defaults } from '../../engine/modules.ts';
import { ModulatorsCard } from '../ModulatorsCard/ModulatorsCard.tsx';
import { ParamRow } from '../ParamRow/ParamRow.tsx';
import { ColorGradeCard } from '../ColorGradeCard/ColorGradeCard.tsx';
import { Card } from '../Card/Card.tsx';
import { SliderRow } from '../SliderRow/SliderRow.tsx';
import { thumbRef } from '../../lib/thumbs.ts';

type LayerSection = 'all' | 'effects' | 'color' | 'motion' | 'modulation';

export const LayersPane: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const store = useStudioApi();
  const { history: historyController } = useStudioRuntime();

  useVersion();
  const [section, setSection] = useState<LayerSection>('effects');
  const sectionId = (name: string) => `${embedded ? 'appearance-' : ''}layer-${name}`;
  const look = useStudioStore((s) => s.look);
  const selected = useStudioStore((s) => s.selected);
  const clipMode = useStudioStore((s) => s.clipMode);
  const clipLooks = useStudioStore((s) => s.clipLooks);
  const editClip = useStudioStore((s) => s.editClip);
  const editBlock = useStudioStore((s) => s.editBlock);
  const writable = () => store.getState().writableLook();
  const evolveAmt = useStudioStore((s) => s.evolveAmt);
  const evolveCuts = useStudioStore((s) => s.evolveCuts);
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
  const isClipEdit = !!editClip && !editBlock && target !== look;
  const clipNo = selected.indexOf(editClip || '') + 1;

  // Where the stack below actually renders, in timeline terms (#n = clip n in the Clips list).
  const mainClips = selected
    .map((cid, i) => (clipMode === 'custom' && clipLooks[cid] ? 0 : i + 1))
    .filter(Boolean)
    .map((n) => `#${n}`);
  const stackScope = editBlock
    ? 'Effects apply only to this timeline appearance. The source clip keeps its own look.'
    : isClipEdit
    ? `Clip ${clipNo}'s own stack: runs only while #${clipNo} is on screen (highlighted in the timeline). Camera and Finish stay shared.`
    : clipMode === 'one'
      ? 'Effect stack: every layer runs on every frame, top to bottom, whichever clip is playing.'
      : clipMode === 'custom'
        ? mainClips.length
          ? `Main stack: runs on ${mainClips.join(', ')} (clips without their own stack).`
          : 'Main stack: every clip has its own stack right now, so these layers are not on screen. Camera and Finish still apply to all.'
        : clipMode === 'evolve' && evolveCuts
          ? 'Main stack: runs on the first cut. Every later cut gets a mutation of it.'
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
                    writable().layers.push({ m: id, on: true, p: defaults(m.params), mods: {} });
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
    insertAtStage(writable().layers, { m: id, on: true, p: defaults(MODULES[id].params), mods: {} });
    engine?.main?.reset();
    rebuild();
    save();
    toast(`Added ${MODULES[id].name} at random`);
  };

  const setIntensity = (v: number) => {
    store.setState({ intensity: v });
    const currentCtx = store.getState().ctx;
    if (currentCtx) currentCtx.intensity = v;
    touch();
    save();
  };

  return (
    <div
      className={`pane on layers-pane${embedded ? ' appearance-layers' : ''}`}
      id={embedded ? 'appearance-layers' : 'pane-layers'}
      role="tabpanel"
      aria-labelledby={embedded ? undefined : 'inspector-tab-layers'}
      aria-label={embedded ? 'Appearance filters' : undefined}
    >
      <nav className="layers-subnav" aria-label="Layer inspector sections">
        {([
          ['effects', 'Effects', target.layers.length],
          ['color', 'Color', null],
          ['motion', 'Motion', null],
          ['modulation', 'Animate', null],
          ['all', 'All', null],
        ] as const).map(([id, label, meta]) => (
          <button
            type="button"
            key={id}
            className={section === id ? 'on' : ''}
            aria-pressed={section === id}
            aria-controls={id === 'all' ? ['effects', 'color', 'motion', 'modulation'].map((name) => sectionId(`${name}-section`)).join(' ') : sectionId(`${id}-section`)}
            onClick={(event) => { setSection(id); const pane = event.currentTarget.closest('.pane'); if (pane) pane.scrollTop = 0; }}
          >
            {label}
            {meta !== null && <span>{meta}</span>}
          </button>
        ))}
      </nav>

      <section
        className="layers-section"
        id={sectionId('effects-section')}
        aria-labelledby={sectionId('effects-heading')}
        hidden={section !== 'all' && section !== 'effects'}
      >
        <div className="layers-section-head">
          <div>
            <h3 id={sectionId('effects-heading')}>Effect stack</h3>
            <p>Applied from top to bottom</p>
          </div>
          <span>{target.layers.length} {target.layers.length === 1 ? 'layer' : 'layers'}</span>
        </div>

      <div className="note stack-scope">{stackScope}</div>
      <div className="layer-tools">
        <button type="button" className="btn sm layer-add" data-pop title="Add an effect layer" onClick={handleAddEffect}>
          + Add effect
        </button>
        <button type="button" className="btn sm" title="Add random effect" onClick={handleAddRandomLayer}>
          Random layer
        </button>
        <button
          type="button"
          className="btn sm"
          title="Shuffle layer order"
          disabled={target.layers.length < 2}
          onClick={() => {
            shuffle(writable().layers);
            engine?.main?.reset();
            rebuild();
            save();
            toast('Shuffled the stack');
          }}
        >
          Shuffle
        </button>
        <button
          type="button"
          className="btn sm"
          title="Remove every layer"
          disabled={!target.layers.length}
          onClick={() => {
            writable().layers.length = 0;
            engine?.main?.reset();
            rebuild();
            save();
            toast('Cleared: Revert restores the look');
          }}
        >
          Clear
        </button>
      </div>

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
                <button
                  type="button"
                  role="switch"
                  aria-checked={layer.on !== false}
                  aria-label={`Enable ${m.name}`}
                  className={`sw ${layer.on !== false ? 'on' : ''}`}
                  title="Enable / bypass"
                  onClick={() => {
                    const editable = writable().layers[i];
                    editable.on = editable.on === false;
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
                      const layers = writable().layers;
                      [layers[i - 1], layers[i]] = [layers[i], layers[i - 1]];
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
                      const layers = writable().layers;
                      [layers[i + 1], layers[i]] = [layers[i], layers[i + 1]];
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
                    writable().layers.splice(i, 1);
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
                holderForEdit={() => writable().layers[i]}
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
          No effect layers: just the camera and the grade. Add one above, or choose a random layer.
        </div>
      )}

      {!embedded && <Card
        color="#b9a4ff"
        title="Master"
        defaultFolded
        className="master-settings"
        sub="Global intensity & automatic clip looks"
      >
        <SliderRow
          label="FX intensity"
          title="Below 100% fades every layer toward clean footage. Above 100% turns up each layer's strength settings and makes modulation hit harder"
          min={0}
          max={1.8}
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
              evolve: evolveCuts
                ? 'The first cut uses the main look; every later cut gets its own mutation of it, even when its clip has been on before.'
                : 'Clip 1 uses the main look; each later clip gets its own mutation of it.',
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
              store.setState({ evolveAmt: v });
              touch();
              save();
            }}
          />
        )}
        {clipMode === 'evolve' && (
          <label className="check" style={{ margin: '2px 0 6px' }}>
            <input
              type="checkbox"
              checked={evolveCuts}
              onChange={(e) => {
                store.setState({ evolveCuts: e.target.checked });
                engine?.main?.reset();
                touch();
                save();
              }}
            />
            A new mutation on every cut, not just every clip
          </label>
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
                ref={thumbRef(`/api/thumb/${cid}?w=120`)}
                onClick={() => editClipLook(cid)}
              >
                <span>{i + 1}</span>
              </button>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: '6px', flexWrap: 'wrap', gap: '6px' }}>
          <button
            type="button"
            className="btn sm"
            title="Give every clip its own random stack"
            onClick={rollClips}
          >
            Roll FX per clip
          </button>
          {clipMode !== 'one' && (
            <button
              type="button"
              className="btn sm"
              title="Drop the per-clip looks"
              onClick={() => {
                store.setState({ clipLooks: {} });
                setClipMode('one');
                toast('Main look on every clip');
              }}
            >
              Same look on all
            </button>
          )}
          {isClipEdit && (
            <button
              type="button"
              className="btn sm"
              title="This clip follows the main look again"
              onClick={() => {
                const next = { ...clipLooks };
                if (editClip) delete next[editClip];
                store.setState({ clipLooks: next, editClip: null });
                rebuild();
              }}
            >
              Reset clip {clipNo}
            </button>
          )}
        </div>
      </Card>}

      </section>

      <section
        className="layers-section layers-section-color"
        id={sectionId('color-section')}
        aria-labelledby={sectionId('color-heading')}
        hidden={section !== 'all' && section !== 'color'}
      >
        <div className="layers-section-head">
          <div>
            <h3 id={sectionId('color-heading')}>Color &amp; finish</h3>
            <p>Grade, texture, output safety, and scopes</p>
          </div>
          <span>{target.finish.lut ? 'LUT active' : editBlock ? 'This segment' : 'Main finish'}</span>
        </div>

      {!isClipEdit ? (
        <Card color="#b9a4ff" title="Finish" sub="grade · texture · safety">
          {([
            ['Exposure & color', ['exposure', 'contrast', 'saturation', 'temp', 'tint']],
            ['Split tone', ['split', 'splitHue']],
            ['Film & texture', ['fade', 'halation', 'vignette', 'grain', 'bars']],
          ] as const).map(([label, ids], index) => (
            <details className="adjustment-family" key={label} open={index === 0}>
              <summary>{label}</summary>
              {FINISH_DEF.params.filter((p) => (ids as readonly string[]).includes(p.id)).map((p) => (
                <ParamRow key={p.id} p={p} holder={target.finish} holderForEdit={() => writable().finish} readLive={(fr) => fr.finish?.[`p_${p.id}`]} />
              ))}
            </details>
          ))}
        </Card>
      ) : (
        <div className="note" style={{ padding: '4px 16px 8px' }}>
          Camera, clip speed and the Finish grade are shared by every clip. Edit them on Main.
        </div>
      )}

      {!isClipEdit && <ColorGradeCard />}
      <ModulatorsCard part="palette" />

      </section>

      <section className="layers-section" id={sectionId('motion-section')} aria-labelledby={sectionId('motion-heading')} hidden={section !== 'all' && section !== 'motion'}>
        <div className="layers-section-head"><div><h3 id={sectionId('motion-heading')}>Camera &amp; framing</h3><p>Zoom, drift, shake, and sway</p></div></div>
      {!isClipEdit && (
        <Card color="#FFFFFF" title="Camera" sub="framing · motion">
          {CAMERA.params.filter((p) => p.id !== 'speed').map((p) => (
            <ParamRow key={p.id} p={p} holder={target.camera} holderForEdit={() => writable().camera} readLive={(fr) => fr.camera?.[`p_${p.id}`]} />
          ))}
        </Card>
      )}

        {isClipEdit && <div className="note stack-scope">Camera is shared. Choose Whole edit to adjust it, or select a segment for its own camera.</div>}
      </section>
      <section className="layers-section" id={sectionId('modulation-section')} aria-labelledby={sectionId('modulation-heading')} hidden={section !== 'all' && section !== 'modulation'}>
        <div className="layers-section-head"><div><h3 id={sectionId('modulation-heading')}>Animation &amp; modulation</h3><p>Connect a source with the dot beside any effect slider</p></div></div>
        <ModulatorsCard part="modulators" />
      </section>

      {!embedded && <div className="row layer-footer" style={{ padding: '2px 12px 16px', gap: '8px' }}>
        <button
          type="button"
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
          Save as look
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => {
            const base = historyController.originalLook(target.id);
            if (!base) {
              toast('This look came from your last session, so there is nothing to revert to. ⌘Z still undoes edits');
              return;
            }
            if (editBlock) {
              store.getState().applyLook(base);
            } else if (isClipEdit && editClip) {
              store.setState({ clipLooks: { ...clipLooks, [editClip]: cloneLook(base) } });
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
      </div>}
    </div>
  );
};
