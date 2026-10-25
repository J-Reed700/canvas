import { TRANSITIONS } from './shaders.ts';
import type { TransitionType } from './types.ts';

/** One ordered catalog supplies grouping, search, presets and both transition pickers. */
export const TRANSITION_TYPES: TransitionType[] = [
  'Cuts & fades', 'Wipes', 'Slides', 'Zoom & spin', 'Light & color', 'Distortion', 'Glitch', 'Shapes',
];

export const TRANSITION_GROUPS = TRANSITION_TYPES.map((type) => ({
  type,
  entries: Object.entries(TRANSITIONS)
    .filter(([, transition]) => transition.type === type)
    .map(([id, transition]) => ({ id, ...transition }))
    .sort((a, b) => a.name.localeCompare(b.name)),
}));

export const TRANSITION_CATALOG = TRANSITION_GROUPS.flatMap((group) => group.entries);

const inTypes = (...types: TransitionType[]) => TRANSITION_CATALOG
  .filter((transition) => transition.id !== 'cut' && types.includes(transition.type))
  .map((transition) => transition.id);

export const TRANSITION_POOLS: Record<string, string[]> = {
  All: Object.keys(TRANSITIONS).filter((id) => id !== 'cut'),
  Smooth: [...inTypes('Cuts & fades', 'Light & color'), 'morph', 'iris'],
  Kinetic: inTypes('Slides', 'Zoom & spin', 'Distortion'),
  Glitch: inTypes('Glitch'),
  Wipes: inTypes('Wipes'),
  Shapes: inTypes('Shapes'),
  'Hard cuts': ['cut'],
};
