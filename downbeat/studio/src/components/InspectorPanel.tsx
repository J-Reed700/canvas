import React from 'react';
import { useStudioStore, useVersion } from '../store.ts';
import { LOOKS } from '../../looks.ts';
import { LooksPane } from './LooksPane.tsx';
import { LayersPane } from './LayersPane.tsx';
import { EditPane } from './EditPane.tsx';

export const InspectorPanel: React.FC = () => {
  useVersion();
  const tab = useStudioStore((s) => s.tab);
  const setTab = useStudioStore((s) => s.setTab);
  const saved = useStudioStore((s) => s.saved);
  const editLook = useStudioStore((s) => s.editLook());

  const allLooksCount = saved.length + LOOKS.length;
  const layersCount = editLook?.layers?.length || 0;

  return (
    <aside className="panel inspector">
      <div className="tabs" id="tabs">
        <button className={tab === 'looks' ? 'on' : ''} onClick={() => setTab('looks')}>
          Looks <span className="count" id="lookCount">{allLooksCount}</span>
        </button>
        <button className={tab === 'layers' ? 'on' : ''} onClick={() => setTab('layers')}>
          Layers <span className="count" id="layerCount">{layersCount}</span>
        </button>
        <button className={tab === 'edit' ? 'on' : ''} onClick={() => setTab('edit')}>
          Edit
        </button>
      </div>

      {tab === 'looks' && <LooksPane />}
      {tab === 'layers' && <LayersPane />}
      {tab === 'edit' && <EditPane />}
    </aside>
  );
};
