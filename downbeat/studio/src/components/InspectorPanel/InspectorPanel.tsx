import './InspectorPanel.css';
import { useStudioStore, useVersion } from '../../state/StudioContext.tsx';
import React from 'react';
import { LOOKS } from '../../engine/looks.ts';
import { LooksPane } from '../LooksPane/LooksPane.tsx';
import { LayersPane } from '../LayersPane/LayersPane.tsx';
import { EditPane } from '../EditPane/EditPane.tsx';
import { InspectorScope } from '../InspectorScope/InspectorScope.tsx';

const INSPECTOR_TABS = ['looks', 'layers', 'edit'] as const;

export const InspectorPanel: React.FC = () => {
  useVersion();
  const tab = useStudioStore((s) => s.tab);
  const setTab = useStudioStore((s) => s.setTab);
  const saved = useStudioStore((s) => s.saved);
  const look = useStudioStore((s) => s.look);
  const selected = useStudioStore((s) => s.selected);
  const editClip = useStudioStore((s) => s.editClip);
  const editBlock = useStudioStore((s) => s.editBlock);
  const editLook = useStudioStore((s) => s.editLook());

  const allLooksCount = saved.length + LOOKS.length;
  const layersCount = editLook?.layers?.length || 0;
  const isClipEdit = !!editClip && editLook !== look;
  const clipNo = selected.indexOf(editClip || '') + 1;

  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const current = INSPECTOR_TABS.indexOf(tab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % INSPECTOR_TABS.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = INSPECTOR_TABS.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    setTab(INSPECTOR_TABS[next]);
    requestAnimationFrame(() => document.getElementById(`inspector-tab-${INSPECTOR_TABS[next]}`)?.focus());
  };

  return (
    <aside className="panel inspector" aria-label="Inspector">
      <header className="inspector-head">
        <div>
          <p className="inspector-kicker">Inspector</p>
          <h2>{editLook?.name || 'Untitled look'}</h2>
        </div>
        <span className="inspector-context" aria-live="polite">
          {editBlock ? 'Segment FX' : isClipEdit ? `Clip ${clipNo}` : 'Main look'}
        </span>
      </header>

      <InspectorScope />

      <div className="tabs" id="tabs" role="tablist" aria-label="Inspector sections">
        <button
          type="button"
          id="inspector-tab-looks"
          role="tab"
          aria-controls="pane-looks"
          aria-selected={tab === 'looks'}
          tabIndex={tab === 'looks' ? 0 : -1}
          className={tab === 'looks' ? 'on' : ''}
          onKeyDown={moveTab}
          onClick={() => setTab('looks')}
        >
          Looks <span className="count" id="lookCount">{allLooksCount}</span>
        </button>
        <button
          type="button"
          id="inspector-tab-layers"
          role="tab"
          aria-controls="pane-layers"
          aria-selected={tab === 'layers'}
          tabIndex={tab === 'layers' ? 0 : -1}
          className={tab === 'layers' ? 'on' : ''}
          onKeyDown={moveTab}
          onClick={() => setTab('layers')}
        >
          Layers <span className="count" id="layerCount">{layersCount}</span>
        </button>
        <button
          type="button"
          id="inspector-tab-edit"
          role="tab"
          aria-controls="pane-edit"
          aria-selected={tab === 'edit'}
          tabIndex={tab === 'edit' ? 0 : -1}
          className={tab === 'edit' ? 'on' : ''}
          onKeyDown={moveTab}
          onClick={() => setTab('edit')}
        >
          Edit
        </button>
      </div>

      {tab === 'looks' && <LooksPane />}
      {tab === 'layers' && <LayersPane />}
      {tab === 'edit' && <EditPane />}
    </aside>
  );
};
