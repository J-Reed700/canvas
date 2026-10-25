import { CAMERA, FINISH_DEF, defaults } from './modules.ts';
import type { CutSpec, LayerSpec, Look, Modulation } from './types.ts';

export const layer = (m: string, p: Record<string, number> = {}, mods: Record<string, Modulation> = {}): LayerSpec => ({ m, on: true, p, mods });
export const mod = (src: string, amt: number): Modulation => ({ src, amt });

export interface LookOptions {
  camera?: Record<string, number>;
  cameraMods?: Record<string, Modulation>;
  finish?: Record<string, number>;
  finishMods?: Record<string, Modulation>;
  cut?: Partial<CutSpec>;
}

export const createLook = (id: string, name: string, vibe: string, layers: LayerSpec[], { camera = {}, cameraMods = {}, finish = {}, finishMods = {}, cut = {} }: LookOptions = {}): Look => ({
  id, name, vibe, layers,
  camera: { p: { ...defaults(CAMERA.params), ...camera }, mods: { zoom: mod('kick', 0.06), ...cameraMods } },
  finish: { p: { ...defaults(FINISH_DEF.params), ...finish }, mods: finishMods },
  cut: { rhythm: 'bar', transitions: ['dissolve'], beats: 0.5, order: 'cycle', ...cut },
});
