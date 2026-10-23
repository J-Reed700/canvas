// Curated looks: one hero effect, one supporting effect, a designed grade — restraint over stacking.
import { CAMERA, FINISH_DEF, MODULES, defaults } from './modules.js';
import { TRANSITIONS } from './shaders.js';
import { RHYTHMS, rng } from './timeline.js';

const L = (m, p = {}, mods = {}) => ({ m, on: true, p, mods });
const mod = (src, amt) => ({ src, amt });

const look = (id, name, vibe, layers, { camera = {}, cameraMods = {}, finish = {}, finishMods = {}, cut = {} } = {}) => ({
  id, name, vibe, layers,
  camera: { p: { ...defaults(CAMERA.params), ...camera }, mods: { zoom: mod('kick', 0.06), ...cameraMods } },
  finish: { p: { ...defaults(FINISH_DEF.params), ...finish }, mods: finishMods },
  cut: { rhythm: 'bar', transitions: ['dissolve'], beats: 0.5, order: 'cycle', ...cut },
});

export const LOOKS = [
  look('liquid-chrome', 'Liquid Chrome', 'Refracting glass over polished metal', [
    L('glass', { strength: 0.55, scale: 2.2, shine: 0.6, disperse: 0.55 }, { strength: mod('bass', 0.18) }),
    L('chrome', { mix: 0.38, bands: 2.4 }),
    L('bloom', { threshold: 0.75, intensity: 0.9 }, { intensity: mod('kick', 0.25) }),
  ], { finish: { contrast: 1.15, saturation: 0.9, split: 0.3, splitHue: 0.6, vignette: 0.4, grain: 0.15 }, cut: { transitions: ['morph', 'dissolve'], beats: 1 } }),

  look('neon-kaleido', 'Neon Kaleidoscope', 'Six-fold symmetry smearing into light', [
    L('kaleido', { slices: 6, spin: 1, offset: 0.18 }, { offset: mod('bass', 0.08) }),
    L('trails', { decay: 0.8, zoom: 0.3, hue: 0.25, blend: 0 }),
    L('bloom', { threshold: 0.85, intensity: 0.75 }, { intensity: mod('kick', 0.2) }),
  ], { finish: { contrast: 1.1, saturation: 1.25 }, cut: { transitions: ['kaleido', 'swirl'] } }),

  look('hyperspace', 'Hyperspace', 'Infinite feedback tunnel that lunges on every kick', [
    L('trails', { decay: 0.86, zoom: 0.7, rotate: 0.25, hue: 0.3, blend: 0 }, { zoom: mod('kick', 0.25) }),
    L('chroma', { amount: 0.22 }, { amount: mod('kick', 0.35) }),
    L('bloom', { threshold: 0.85, intensity: 0.85 }),
  ], { camera: { zoom: 1.08 }, finish: { saturation: 1.2, vignette: 0.45 }, cut: { transitions: ['zoom', 'flare'] } }),

  look('one-bit', '1-Bit Signal', 'Ink dither with data tears on the snare', [
    L('dither', { size: 3, levels: 2, palette: 0, contrast: 1.5 }),
    L('glitch', { amount: 0.1, block: 0.6, split: 0.2 }, { amount: mod('snare', 0.45) }),
  ], { finish: { contrast: 1, saturation: 1, vignette: 0.15, grain: 0, fade: 0 }, cut: { rhythm: 'half', transitions: ['cut', 'glitch'], beats: 0.25 } }),

  look('acid-dither', 'Acid Rave', 'Cyber dither palette with shockwaves on the beat', [
    L('ripple', { strength: 0.45, every: 0, glow: 0.2 }),
    L('dither', { size: 2, levels: 3, palette: 3, contrast: 1.25 }),
  ], { finish: { contrast: 1.05, grain: 0, vignette: 0.2 }, cut: { rhythm: 'half', transitions: ['pixel', 'cut'], beats: 0.5 } }),

  look('super8', 'Super 8 Memory', 'Warm gate weave, halation and drifting light leaks', [
    L('leak', { amount: 0.7, hue: 0.06 }),
    L('bloom', { threshold: 1.0, intensity: 0.4, warmth: 0.6 }),
  ], {
    camera: { shake: 0.35, sway: 0.15, drift: 0.45 },
    finish: { temp: 0.35, fade: 0.08, halation: 0.5, grain: 0.55, vignette: 0.5, contrast: 1.05, saturation: 0.9, split: 0.3, splitHue: 0.08 },
    cut: { rhythm: 'bar2', transitions: ['flare', 'dissolve'], beats: 1 },
  }),

  look('vhs', 'VHS Afterhours', 'Tape bleed, fisheye and a rolling tracking band', [
    L('lens', { bulge: 0.35, disperse: 0.3 }),
    L('vhs', { amount: 0.65, tracking: 0.35, bleed: 0.6 }),
  ], { camera: { shake: 0.25 }, finish: { grain: 0.3, saturation: 1.1, temp: -0.1, vignette: 0.45 }, cut: { transitions: ['glitch', 'cut'], beats: 0.25 } }),

  look('thermal', 'Thermal Vision', 'Heat-map palette with glowing contours', [
    L('gradient', { palette: 0, contrast: 1.3 }),
    L('edges', { strength: 0.6, dim: 0.15, mode: 2 }),
    L('bloom', { threshold: 0.8, intensity: 0.7 }, { intensity: mod('kick', 0.3) }),
  ], { finish: { contrast: 1.05, grain: 0.1 }, cut: { rhythm: 'half', transitions: ['cut', 'pixel'], beats: 0.25 } }),

  look('halftone', 'Halftone Riot', 'CMYK print screens and silkscreen bands', [
    L('posterize', { levels: 4, sat: 1.4, mix: 0.6 }),
    L('halftone', { size: 9, mode: 0, angle: 20 }),
  ], { camera: { shake: 0.3 }, finish: { contrast: 1.15, grain: 0.1, vignette: 0.1 }, cut: { rhythm: 'half', transitions: ['slices', 'cut'], beats: 0.5 } }),

  look('datamosh', 'Datamosh Dream', 'Liquid currents with prismatic motion echoes', [
    L('liquid', { amount: 0.35, scale: 2 }, { amount: mod('bass', 0.2) }),
    L('echo', { amount: 0.8, drift: 0.3 }),
    L('glitch', { amount: 0.08, block: 0.4, split: 0.5 }, { amount: mod('kick', 0.3) }),
  ], { finish: { saturation: 1.25, split: 0.3, splitHue: 0.8 }, cut: { transitions: ['mosh', 'morph'], beats: 1 } }),

  look('golden-rays', 'Golden Rays', 'Sunlight pouring through the frame', [
    L('rays', { threshold: 0.55, intensity: 0.9, length: 0.65, height: 0.8 }, { intensity: mod('energy', 0.3) }),
  ], {
    camera: { drift: 0.5 },
    finish: { temp: 0.4, split: 0.35, splitHue: 0.07, contrast: 1.15, vignette: 0.45, grain: 0.2 },
    cut: { rhythm: 'bar2', transitions: ['flare', 'dissolve'], beats: 1 },
  }),

  look('pixel-sort', 'Pixel Sort Acid', 'Highlights melting into sorted streaks', [
    L('pixelsort', { threshold: 0.5, length: 0.45, dir: 0 }, { length: mod('kick', 0.3) }),
    L('gradient', { palette: 2, mix: 0.6, contrast: 1.2 }),
    L('chroma', { amount: 0.2 }),
  ], { finish: { contrast: 1.1 }, cut: { transitions: ['pixel', 'prism'] } }),

  look('matrix', 'Glyph Terminal', 'The picture rendered as glowing type', [
    L('ascii', { cell: 14, color: 1, charset: 0 }),
    L('bloom', { threshold: 0.35, intensity: 0.9 }),
    L('crt', { curve: 0.3, scan: 0.45, mask: 0.25 }),
  ], { finish: { contrast: 1.1, grain: 0.05, vignette: 0.3 }, cut: { rhythm: 'half', transitions: ['glitch', 'cut'], beats: 0.25 } }),

  look('iridescent', 'Iridescent Pulse', 'Holographic film rippling outward on the beat', [
    L('ripple', { strength: 0.55, every: 0, glow: 0.15 }),
    L('holo', { amount: 0.65, scale: 1.8 }),
    L('bloom', { threshold: 0.8, intensity: 0.7 }, { intensity: mod('kick', 0.12) }),
  ], { finish: { saturation: 1.1, contrast: 1.08 }, cut: { transitions: ['ripple', 'iris'] } }),

  look('anamorphic', 'Anamorphic Night', 'Teal-orange grade, cyan lens streaks, cinema bars', [
    L('streaks', { threshold: 0.85, intensity: 1.2, length: 0.7, hue: 0.56 }, { intensity: mod('kick', 0.3) }),
    L('chroma', { amount: 0.12 }),
  ], {
    camera: { drift: 0.5 },
    finish: { temp: -0.15, split: 0.45, splitHue: 0.55, contrast: 1.2, bars: 0.1, vignette: 0.4, grain: 0.2 },
    cut: { rhythm: 'bar2', transitions: ['whipX', 'dissolve'], beats: 0.5 },
  }),

  look('mirror-world', 'Mirror World', 'Quad symmetry through soft glass', [
    L('mirror', { mode: 1 }),
    L('glass', { strength: 0.3, scale: 1.6, shine: 0.3, disperse: 0.4 }),
    L('hue', { cycles: 1, sat: 1.1 }),
  ], { finish: { contrast: 1.1, vignette: 0.35 }, cut: { transitions: ['kaleido', 'dissolve'] } }),

  look('clone-wall', 'Clone Wall', 'A sliding video wall that punches on the kick', [
    L('tile', { count: 3, slide: 0.4, gap: 0.02, flip: 1 }),
    L('zoomblur', { amount: 0.1 }, { amount: mod('kick', 0.5) }),
  ], { finish: { contrast: 1.15, saturation: 1.1 }, cut: { rhythm: 'half', transitions: ['cut', 'whip'], beats: 0.25 } }),

  look('clean', 'Clean Cut', 'Just the footage, graded and cut on the beat', [
    L('bloom', { threshold: 1.0, intensity: 0.35 }),
  ], { finish: { contrast: 1.12, saturation: 1.08, grain: 0.12, vignette: 0.3 }, cut: { transitions: ['cut'], beats: 0 } }),
];

// ------------------------------------------------------------------ variation engine
const ADJ = ['Velvet', 'Neon', 'Molten', 'Hollow', 'Static', 'Prism', 'Silver', 'Midnight', 'Solar', 'Feral', 'Lunar', 'Acid', 'Glass',
  'Ghost', 'Chrome', 'Infra', 'Hyper', 'Soft', 'Fever', 'Wired'];
const NOUN = ['Bloom', 'Drift', 'Signal', 'Halo', 'Tide', 'Mirage', 'Pulse', 'Circuit', 'Ember', 'Haze', 'Echo', 'Spiral', 'Orbit',
  'Ritual', 'Fracture', 'Current', 'Aura', 'Relic', 'Flux', 'Nova'];
const AUDIO_SRC = ['kick', 'kick', 'snare', 'hats', 'bass', 'energy', 'beat', 'lfo'];

const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

export function cloneLook(l) { return JSON.parse(JSON.stringify(l)); }

function jitterParams(r, params, values, amount) {
  for (const p of params) {
    if (p.opts || p.step >= 1) {
      if (r() < amount * 0.25) values[p.id] = p.opts ? Math.floor(r() * p.opts.length) : Math.round(p.min + r() * (p.max - p.min));
    } else {
      const v = values[p.id] ?? p.def;
      values[p.id] = +clamp(v + gauss(r) * amount * 0.22 * (p.max - p.min), p.min, p.max).toFixed(3);
    }
  }
}

function randomMod(r, params) {
  const cont = params.filter((p) => !p.opts && p.step < 1 && p.id !== 'mix');
  if (!cont.length) return null;
  const p = pick(r, cont);
  return [p.id, mod(pick(r, AUDIO_SRC), +((r() < 0.8 ? 1 : -1) * (0.08 + r() * 0.3)).toFixed(2))];
}

export function mutate(base, amount, seed) {
  const r = rng(seed);
  const l = cloneLook(base);
  l.id = `var-${seed}`;
  l.name = `${pick(r, ADJ)} ${pick(r, NOUN)}`;
  l.vibe = `Variation of ${base.name}`;
  const ids = Object.keys(MODULES);
  if (r() < amount * 0.35 && l.layers.length) {
    const i = Math.floor(r() * l.layers.length);
    const cat = MODULES[l.layers[i].m].cat;
    const same = ids.filter((id) => MODULES[id].cat === cat && id !== l.layers[i].m);
    if (same.length) l.layers[i] = L(pick(r, same));
  }
  if (r() < amount * 0.3 && l.layers.length < 4) {
    const support = ids.filter((id) => ['light', 'color', 'time'].includes(MODULES[id].cat) && !l.layers.some((x) => x.m === id));
    l.layers.splice(Math.floor(r() * (l.layers.length + 1)), 0, L(pick(r, support)));
  }
  if (r() < amount * 0.15 && l.layers.length > 1) l.layers.splice(Math.floor(r() * l.layers.length), 1);
  for (const layer of l.layers) {
    const def = MODULES[layer.m];
    layer.p = { ...defaults(def.params), ...layer.p };
    jitterParams(r, def.params, layer.p, amount);
    if (r() < amount * 0.4) { const m = randomMod(r, def.params); if (m) layer.mods[m[0]] = m[1]; }
  }
  jitterParams(r, FINISH_DEF.params.filter((p) => ['temp', 'tint', 'split', 'splitHue', 'saturation', 'contrast', 'fade', 'vignette', 'grain'].includes(p.id)),
    l.finish.p, amount * 0.8);
  jitterParams(r, CAMERA.params.filter((p) => p.id !== 'speed'), l.camera.p, amount * 0.6);
  if (r() < amount * 0.3) l.cut.rhythm = pick(r, Object.keys(RHYTHMS));
  if (r() < amount * 0.4) l.cut.transitions = [pick(r, Object.keys(TRANSITIONS)), pick(r, Object.keys(TRANSITIONS))];
  return l;
}

export function randomLook(seed) {
  const r = rng(seed);
  const ids = Object.keys(MODULES);
  const heroCats = ['space', 'warp', 'stylize', 'color', 'time'];
  const hero = pick(r, ids.filter((id) => heroCats.includes(MODULES[id].cat)));
  const support = pick(r, ids.filter((id) => ['light', 'color'].includes(MODULES[id].cat) && id !== hero));
  const base = look(`rnd-${seed}`, '', '', [L(hero), L(support)], {
    cut: { rhythm: pick(r, ['bar', 'half', 'hits', 'build']), transitions: [pick(r, Object.keys(TRANSITIONS)), pick(r, Object.keys(TRANSITIONS))] },
  });
  const l = mutate(base, 0.7, seed + 1);
  l.vibe = `${MODULES[hero].name} + ${MODULES[support].name}`;
  return l;
}
