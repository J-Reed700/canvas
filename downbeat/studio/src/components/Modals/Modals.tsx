import './Modals.css';
import { useStudioElements } from '../../state/StudioContext.tsx';
import React from 'react';
import { VariationsModal } from '../VariationsModal/VariationsModal.tsx';
import { ShortcutsModal } from '../ShortcutsModal/ShortcutsModal.tsx';
import { ExportSheet } from '../ExportSheet/ExportSheet.tsx';

export const Modals: React.FC = () => {
  const { videoBank } = useStudioElements();
  return (
    <>
      <VariationsModal />
      <ShortcutsModal />
      <ExportSheet />
      <div className="pop" id="pop" />
      <div className="pop" id="subpop" />
      <div className="toast" id="toast" />
      <div id="videoBank" ref={videoBank} />
    </>
  );
};
