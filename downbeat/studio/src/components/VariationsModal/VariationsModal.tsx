import './VariationsModal.css';
import { useStudioStore, useStudioApi } from '../../state/StudioContext.tsx';
import React, { useRef, useEffect, useMemo } from 'react';
import type { LookJob } from '../../state/storeTypes.ts';
import { mutate } from '../../engine/looks.ts';
import { screenOf, thumbSize } from '../../lib/screens.ts';
import { MODULES } from '../../engine/modules.ts';
import { Modal } from '../Modal/Modal.tsx';

export const VariationsModal: React.FC = () => {
  const store = useStudioApi();

  const varsContainerRef = useRef<HTMLDivElement>(null);

  const varOpen = useStudioStore((s) => s.varOpen);
  const mutAmt = useStudioStore((s) => s.mutAmt);
  const varSeed = useStudioStore((s) => s.varSeed);
  const look = useStudioStore((s) => (s.look ? s.editLook() : null));
  const targetPrefix = useStudioStore((s) => {
    const seg = s.editBlock ? s.ctx?.tl.segs.find((x) => x.id === s.editBlock) : null;
    if (seg) return `Segment ${seg.i + 1} · `;
    if (s.clipMode === 'custom' && s.editClip && s.selected.includes(s.editClip)) {
      return `Clip ${s.selected.indexOf(s.editClip) + 1} · `;
    }
    return '';
  });
  const engine = useStudioStore((s) => s.engine);
  const exportOpts = useStudioStore((s) => s.exportOpts);
  const applyLook = useStudioStore((s) => s.applyLook);

  // Six mutations of the current look, shared by the live thumbnails and the click that applies one.
  const variations = useMemo(
    () => (varOpen && look ? Array.from({ length: 6 }, (_, k) => mutate(look, mutAmt, varSeed * 1000 + k * 7919)) : []),
    [varOpen, look, mutAmt, varSeed],
  );

  useEffect(() => {
    if (!variations.length || !varsContainerRef.current) return;

    const cards = varsContainerRef.current.querySelectorAll<HTMLElement>('.look');
    const jobs: LookJob[] = [];
    cards.forEach((card, k) => {
      const cv = card.querySelector('canvas');
      if (cv && variations[k]) {
        jobs.push({ id: `var:${k}`, look: variations[k], card, ctx2d: cv.getContext('2d'), visible: true });
      }
    });
    store.setState({ varJobs: jobs });

    return () => {
      jobs.forEach((j) => engine?.dropThumb?.(j.id));
      store.setState({ varJobs: [] });
    };
  }, [variations, engine, store]);

  const mutateAgain = () => {
    store.setState((prev) => ({ varSeed: prev.varSeed + 1 }));
  };

  const closeModals = () => {
    store.setState({ varOpen: false, helpOpen: false, exportOpen: false });
  };

  const currentFormat = exportOpts.format || 'spotify';
  const screen = screenOf(currentFormat);
  const [varW, varH] = thumbSize(screen, 384);

  return (
    <Modal
      id="varModal"
      open={varOpen}
      onClose={closeModals}
      title="Variations"
      subtitle={`${targetPrefix}Mutations of ${look?.name}, playing on your footage. Click one to keep it.`}
      subtitleId="varSub"
      headerActions={
        <div className="mut-ctrl">
          <span className="muted">Subtle</span>
          <input
            type="range"
            id="mutAmt"
            min="0.1"
            max="1"
            step="0.05"
            value={mutAmt}
            onChange={(e) => store.setState({ mutAmt: +e.target.value })}
          />
          <span className="muted">Wild</span>
          <button className="btn" id="btnMutate" onClick={mutateAgain}>
            ⟳ Mutate again <span className="kbd">M</span>
          </button>
        </div>
      }
    >
      <div className="vars" id="vars" data-screen={screen.id} ref={varsContainerRef}>
        {Array.from({ length: 6 }, (_, k) => {
          const l = variations[k];
          return (
            <div
              className="look"
              key={k}
              onClick={() => {
                if (l) {
                  applyLook(l, { keepEdit: true });
                  closeModals();
                }
              }}
            >
              <canvas width={varW} height={varH} />
              <div className="lbl">
                <b>{l?.name}</b>
                <span>{l?.layers.map((x) => MODULES[x.m]?.name).filter(Boolean).join(' + ')}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
};
