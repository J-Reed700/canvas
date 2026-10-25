import React, { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useSegmentMenu, useStudioStore } from '../../state/StudioContext.tsx';
import type { SegmentAppearanceTarget } from '../SegmentMenu/segmentMenu.ts';
import { TransitionPicker } from '../TransitionPicker/TransitionPicker.tsx';

/** Mount the shared React picker in the timeline's imperative appearance editor. */
export const SegmentTransitionPicker: React.FC = () => {
  const menus = useSegmentMenu();
  const target = useSyncExternalStore(menus.subscribeAppearance, menus.getAppearanceTarget);
  return target ? createPortal(<SegmentTransition key={target.id} target={target} />, target.transitionHost) : null;
};

const SegmentTransition: React.FC<{ target: SegmentAppearanceTarget }> = ({ target }) => {
  const segment = useStudioStore((state) => state.ctx?.tl.segs.find((item) => item.id === target.id));
  const exporting = useStudioStore((state) => state.exporting);
  return segment ? <TransitionPicker value={[segment.trans]} disabled={exporting} context={`Segment ${segment.i + 1} · Only this appearance`}
    onChange={([id]) => target.onTransitionChange(id)} /> : null;
};
