import type { LookStyle, RollStyle } from './types.ts';

export const LOOK_STYLES: { id: LookStyle; name: string; description: string }[] = [
  { id: 'natural', name: 'Natural', description: 'Neutral color, warm portraits and soft editorial grades' },
  { id: 'monochrome', name: 'Monochrome', description: 'Silver, matte, noir and toned black and white' },
  { id: 'film', name: 'Film', description: 'Photographic color, grain, dust and gentle film movement' },
  { id: 'soft', name: 'Soft', description: 'Mist, diffusion, portrait softness and selective focus' },
  { id: 'light', name: 'Light & shadow', description: 'Window light, leaf shadows and colored lighting' },
  { id: 'illustrated', name: 'Illustrated', description: 'Pencil, charcoal, ink, watercolor and paper' },
  { id: 'experimental', name: 'Experimental', description: 'Glitches, neon, distortion and dense effect stacks' },
];

export const ROLL_STYLES: { id: RollStyle; name: string }[] = [
  { id: 'balanced', name: 'Balanced · all styles' },
  ...LOOK_STYLES,
];

export const normalizeRollStyle = (value: unknown): RollStyle =>
  ROLL_STYLES.some((style) => style.id === value) ? value as RollStyle : 'balanced';
