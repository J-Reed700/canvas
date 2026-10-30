import './InspectorScope.css';
import { useStudioStore } from '../../state/StudioContext.tsx';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { thumbRef } from '../../lib/thumbs.ts';

/** One consistent effects target, above Looks, Layers and Edit. */
export const InspectorScope: React.FC = () => {
  const s = useStudioStore(useShallow((state) => ({
    ctx: state.ctx,
    blocks: state.blocks,
    editBlock: state.editBlock,
    selectedBlock: state.selectedBlock,
    editClip: state.editClip,
    selected: state.selected,
    exporting: state.exporting,
    tab: state.tab,
    editClipLook: state.editClipLook,
    editBlockLook: state.editBlockLook,
    resetBlockLook: state.resetBlockLook,
    remix: state.remix,
    setTab: state.setTab,
  })));
  const seg = s.ctx?.tl.segs.find((seg) => seg.id === (s.editBlock || s.selectedBlock));
  const clipId = s.editClip || seg?.clipId || s.selected[0];
  const clipNo = s.selected.indexOf(clipId) + 1;
  const block = s.editBlock ? (s.blocks ?? s.ctx?.tl.blocks)?.find((b) => b.id === s.editBlock) : null;
  const scope = s.editBlock ? 'segment' : s.editClip ? 'clip' : 'main';
  const appearances = s.ctx?.tl.segs.filter((item) => item.clipId === clipId) || [];
  const appearance = seg ? appearances.findIndex((item) => item.id === seg.id) + 1 : 0;
  const owned = !!(block?.look || block?.overrides?.layers || block?.overrides?.finish || block?.overrides?.macro || Object.keys(block?.overrides?.camera || {}).some((key) => key !== 'speed'));
  const title = scope === 'segment' && seg ? `Segment ${seg.i + 1}` : scope === 'clip' ? `Clip ${clipNo}` : 'Whole edit';
  const detail = scope === 'segment' ? `Clip ${clipNo} · appearance ${appearance} of ${appearances.length}`
    : scope === 'clip' ? `${appearances.length} appearance${appearances.length === 1 ? '' : 's'} in the timeline` : 'Shared look for the edit';
  return (
    <div className="inspector-scope">
      <div className="scope-target">
        <span className="scope-thumb" aria-hidden="true" ref={thumbRef(clipId ? `/api/thumb/${clipId}?w=120` : '')} />
        <div className="scope-target-copy"><strong>{title}</strong><span>{detail}</span></div>
        <span className={`scope-state ${scope === 'segment' && owned ? 'is-own' : ''}`}>
          {scope === 'segment' ? owned ? 'Own look' : 'Inherited' : scope === 'clip' ? 'Clip look' : 'Main look'}
        </span>
      </div>
      <div className="scope-choices" role="group" aria-label="Apply effects to">
        <button type="button" title="Only the selected block on the timeline" aria-pressed={scope === 'segment'} disabled={!seg || s.exporting} onClick={() => seg && s.editBlockLook(seg.id)}>This appearance</button>
        <button type="button" title={`Every appearance of source clip ${clipNo}`} aria-pressed={scope === 'clip'} disabled={!clipId || s.exporting} onClick={() => s.editClipLook(clipId, { tab: s.tab })}>All uses</button>
        <button type="button" aria-pressed={scope === 'main'} disabled={s.exporting} onClick={() => s.editBlockLook(null)}>Whole edit</button>
      </div>
      <div className="scope-foot" aria-live="polite">
        <span>{scope === 'segment' ? owned ? 'Only this appearance has these effects.' : 'Your first change affects only this appearance.' : scope === 'clip' ? `Editing all ${appearances.length} appearances of clip ${clipNo}.` : 'Segments with their own looks keep their effects.'}</span>
        {scope !== 'main' && (
          <div className="scope-acts">
            <button
              type="button"
              disabled={s.exporting}
              aria-label={scope === 'segment' ? 'Remix this appearance' : 'Remix all uses'}
              title={scope === 'segment' ? 'Roll a new look for this appearance only, and with Edit on in the Remix menu its transition, moment, direction and speed ramp (D)' : `Roll a new look for clip ${clipNo}, on every appearance of it (D)`}
              onClick={s.remix}
            >Remix</button>
            {scope === 'segment' && owned && <button type="button" disabled={s.exporting} onClick={s.resetBlockLook}>Use source look</button>}
          </div>
        )}
      </div>
    </div>
  );
};
