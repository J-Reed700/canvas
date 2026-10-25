import './App.css';
import React from 'react';
import { useStudioStore } from '../../state/StudioContext.tsx';
import { useStudioLifecycle } from '../../hooks/useStudioLifecycle.ts';
import { useStudioShortcuts } from '../../hooks/useStudioShortcuts.ts';
import { useMediaDrop } from '../../hooks/useMediaDrop.ts';
import { TopBar } from '../TopBar/TopBar.tsx';
import { MediaPanel } from '../MediaPanel/MediaPanel.tsx';
import { StagePanel } from '../StagePanel/StagePanel.tsx';
import { TimelinePanel } from '../TimelinePanel/TimelinePanel.tsx';
import { InspectorPanel } from '../InspectorPanel/InspectorPanel.tsx';
import { Modals } from '../Modals/Modals.tsx';
import { ExportsLibrary } from '../ExportsLibrary/ExportsLibrary.tsx';
import { ClipsLibrary } from '../ClipsLibrary/ClipsLibrary.tsx';
import { Welcome } from '../Welcome/Welcome.tsx';
import { ProjectsModal } from '../ProjectsModal/ProjectsModal.tsx';
import { PanelDivider } from '../PanelDivider/PanelDivider.tsx';
import { WorkspaceLayout } from '../WorkspaceLayout/WorkspaceLayout.tsx';
import { WorkspaceStatus } from '../WorkspaceStatus/WorkspaceStatus.tsx';
import { CommandMenu } from '../CommandMenu/CommandMenu.tsx';
import { isMediaLoading } from '../../state/mediaLoading.ts';
import { MediaLoading } from '../MediaLoading/MediaLoading.tsx';

export const App: React.FC = () => {
  const mediaLoading = useStudioStore(isMediaLoading);
  useStudioLifecycle();
  useStudioShortcuts();
  useMediaDrop();

  return (
    <>
      <div className="studio-content" inert={mediaLoading} aria-busy={mediaLoading}>
        <WorkspaceLayout>
          <TopBar />
          <MediaPanel />
          <StagePanel />
          <TimelinePanel />
          <InspectorPanel />
          <PanelDivider panel="library" />
          <PanelDivider panel="inspector" />
          <PanelDivider panel="timeline" />
          <WorkspaceStatus />
        </WorkspaceLayout>

        <CommandMenu />
        <Modals />
        <ExportsLibrary />
        <ClipsLibrary />
        <ProjectsModal />
        <Welcome />
      </div>
      <MediaLoading />
    </>
  );
};
