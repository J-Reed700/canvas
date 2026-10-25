import './SegmentAppearanceEditor.css';
import React, { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useSegmentMenu, useStudioApi, useStudioStore, useVersion } from '../../state/StudioContext.tsx';
import { LOOKS } from '../../engine/looks.ts';
import { LayersPane } from '../LayersPane/LayersPane.tsx';
import type { SegmentAppearanceTarget } from '../SegmentMenu/segmentMenu.ts';

/** The segment dialog reuses the inspector's controls in the same injected studio. */
export const SegmentAppearanceEditor: React.FC = () => {
  const menus = useSegmentMenu();
  const target = useSyncExternalStore(menus.subscribeAppearance, menus.getAppearanceTarget);
  return target ? createPortal(<AppearanceControls key={target.id} target={target} />, target.host) : null;
};

const AppearanceControls: React.FC<{ target: SegmentAppearanceTarget }> = ({ target }) => {
  const store = useStudioApi();
  useVersion();
  const look = useStudioStore((state) => state.editLook());
  const blocks = useStudioStore((state) => state.blocks);
  const saved = useStudioStore((state) => state.saved);
  const exporting = useStudioStore((state) => state.exporting);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  const own = blocks?.some((block) => block.id === target.id && (block.look || block.overrides?.layers || block.overrides?.finish || block.overrides?.macro));
  const choices = [...saved, ...LOOKS].filter((preset) => `${preset.name} ${preset.vibe}`.toLowerCase().includes(query.toLowerCase()));
  const select = (id: string) => {
    const preset = [...saved, ...LOOKS].find((item) => item.id === id);
    if (!preset) return;
    const state = store.getState();
    state.editBlockLook(target.id);
    state.applyLook(preset);
    setBrowsing(false);
  };
  return (
    <div className="appearance-editor inspector">
      <div className="appearance-treatment">
        <div className="appearance-treatment-copy">
          <span className="appearance-eyebrow">{own ? 'Appearance override' : 'Following the source look'}</span>
          <h3>{look.name}</h3>
          <p>{own ? 'Changes stay on this timeline appearance.' : 'Adjust a filter or choose a look to make this appearance independent.'}</p>
        </div>
        <button type="button" className="btn appearance-browse" aria-expanded={browsing} onClick={() => setBrowsing(!browsing)} disabled={exporting}>{browsing ? 'Back to filters' : 'Browse looks'}</button>
        {own && <button type="button" className="appearance-inherit" disabled={exporting} onClick={() => { const state = store.getState(); state.editBlockLook(target.id); state.resetBlockLook(); }}>Use source look</button>}
      </div>
      {browsing ? (
        <div className="appearance-presets">
          <input type="search" placeholder="Search looks" aria-label="Search appearance looks" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="appearance-look-grid" aria-label="Looks for this appearance">
            {choices.map((preset) => <button type="button" key={preset.id} data-segment-look-id={preset.id} className={look.id === preset.id ? 'on' : ''} aria-pressed={look.id === preset.id} disabled={exporting} onClick={() => select(preset.id)}>
              <span className="appearance-look-swatch" style={{ background: preset.group === 'art' ? 'linear-gradient(135deg, #e4b177, #a5658b)' : preset.group === 'classic' ? 'linear-gradient(135deg, #7db7c8, #706cbb)' : 'linear-gradient(135deg, #c9b5ff, #7c7baa)' }} aria-hidden="true" />
              <strong>{preset.name}</strong><small>{preset.vibe || `${preset.layers.length} effects`}</small>
            </button>)}
          </div>
          {!choices.length && <p className="note">No looks match this search.</p>}
        </div>
      ) : <LayersPane embedded />}
    </div>
  );
};
