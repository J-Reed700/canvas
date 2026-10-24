// Built-in looks: one main effect, an optional second one, and a color grade.
import { CAMERA, FINISH_DEF, MODULES, defaults } from './modules.ts';
import { TRANSITIONS } from './shaders.ts';
import { RHYTHMS, rng } from './timeline.ts';
import type { CutSpec, LayerSpec, Look, Modulation, ParamDef } from './types.ts';

const L = (m: string, p: Record<string, number> = {}, mods: Record<string, Modulation> = {}): LayerSpec => ({ m, on: true, p, mods });
const mod = (src: string, amt: number): Modulation => ({ src, amt });

interface LookOptions {
  camera?: Record<string, number>;
  cameraMods?: Record<string, Modulation>;
  finish?: Record<string, number>;
  finishMods?: Record<string, Modulation>;
  cut?: Partial<CutSpec>;
}

const look = (id: string, name: string, vibe: string, layers: LayerSpec[], { camera = {}, cameraMods = {}, finish = {}, finishMods = {}, cut = {} }: LookOptions = {}): Look => ({
  id, name, vibe, layers,
  camera: { p: { ...defaults(CAMERA.params), ...camera }, mods: { zoom: mod('kick', 0.06), ...cameraMods } },
  finish: { p: { ...defaults(FINISH_DEF.params), ...finish }, mods: finishMods },
  cut: { rhythm: 'bar', transitions: ['dissolve'], beats: 0.5, order: 'cycle', ...cut },
});

export const LOOKS: Look[] = [
  look('liquid-chrome', 'Liquid Chrome', 'Rippling glass over a chrome finish', [
    L('glass', { strength: 0.55, scale: 2.2, shine: 0.6, disperse: 0.55 }, { strength: mod('bass', 0.18) }),
    L('chrome', { mix: 0.38, bands: 2.4 }),
    L('bloom', { threshold: 0.75, intensity: 0.9 }, { intensity: mod('kick', 0.25) }),
  ], { finish: { contrast: 1.15, saturation: 0.9, split: 0.3, splitHue: 0.6, vignette: 0.4, grain: 0.15 }, cut: { transitions: ['morph', 'dissolve'], beats: 1 } }),

  look('neon-kaleido', 'Neon Kaleidoscope', 'Six-way kaleidoscope with light trails', [
    L('kaleido', { slices: 6, spin: 1, offset: 0.18 }, { offset: mod('bass', 0.08) }),
    L('trails', { decay: 0.8, zoom: 0.3, hue: 0.25, blend: 0 }),
    L('bloom', { threshold: 0.85, intensity: 0.75 }, { intensity: mod('kick', 0.2) }),
  ], { finish: { contrast: 1.1, saturation: 1.25 }, cut: { transitions: ['kaleido', 'swirl'] } }),

  look('hyperspace', 'Hyperspace', 'Feedback tunnel that zooms in on each kick', [
    L('trails', { decay: 0.86, zoom: 0.7, rotate: 0.25, hue: 0.3, blend: 0 }, { zoom: mod('kick', 0.25) }),
    L('chroma', { amount: 0.22 }, { amount: mod('kick', 0.35) }),
    L('bloom', { threshold: 0.85, intensity: 0.85 }),
  ], { camera: { zoom: 1.08 }, finish: { saturation: 1.2, vignette: 0.45 }, cut: { transitions: ['zoom', 'flare'] } }),

  look('one-bit', '1-Bit Signal', 'Black-and-white dither that glitches on the snare', [
    L('dither', { size: 3, levels: 2, palette: 0, contrast: 1.5 }),
    L('glitch', { amount: 0.1, block: 0.6, split: 0.2 }, { amount: mod('snare', 0.45) }),
  ], { finish: { contrast: 1, saturation: 1, vignette: 0.15, grain: 0, fade: 0 }, cut: { rhythm: 'half', transitions: ['cut', 'glitch'], beats: 0.25 } }),

  look('acid-dither', 'Acid Rave', 'Colored dither with a ripple on every beat', [
    L('ripple', { strength: 0.45, every: 0, glow: 0.2 }),
    L('dither', { size: 2, levels: 3, palette: 3, contrast: 1.25 }),
  ], { finish: { contrast: 1.05, grain: 0, vignette: 0.2 }, cut: { rhythm: 'half', transitions: ['pixel', 'cut'], beats: 0.5 } }),

  look('super8', 'Super 8 Memory', 'Warm home-movie film with light leaks', [
    L('leak', { amount: 0.7, hue: 0.06 }),
    L('bloom', { threshold: 1.0, intensity: 0.4, warmth: 0.6 }),
  ], {
    camera: { shake: 0.35, sway: 0.15, drift: 0.45 },
    finish: { temp: 0.35, fade: 0.08, halation: 0.5, grain: 0.55, vignette: 0.5, contrast: 1.05, saturation: 0.9, split: 0.3, splitHue: 0.08 },
    cut: { rhythm: 'bar2', transitions: ['flare', 'dissolve'], beats: 1 },
  }),

  look('vhs', 'VHS Afterhours', 'Tape bleed, fisheye and a rolling tracking line', [
    L('lens', { bulge: 0.35, disperse: 0.3 }),
    L('vhs', { amount: 0.65, tracking: 0.35, bleed: 0.6 }),
  ], { camera: { shake: 0.25 }, finish: { grain: 0.3, saturation: 1.1, temp: -0.1, vignette: 0.45 }, cut: { transitions: ['glitch', 'cut'], beats: 0.25 } }),

  look('thermal', 'Thermal Vision', 'Heat-camera colors with glowing edges', [
    L('gradient', { palette: 0, contrast: 1.3 }),
    L('edges', { strength: 0.6, dim: 0.15, mode: 2 }),
    L('bloom', { threshold: 0.8, intensity: 0.7 }, { intensity: mod('kick', 0.3) }),
  ], { finish: { contrast: 1.05, grain: 0.1 }, cut: { rhythm: 'half', transitions: ['cut', 'pixel'], beats: 0.25 } }),

  look('halftone', 'Halftone Riot', 'Posterized color printed as CMYK dots', [
    L('posterize', { levels: 4, sat: 1.4, mix: 0.6 }),
    L('halftone', { size: 9, mode: 0, angle: 20 }),
  ], { camera: { shake: 0.3 }, finish: { contrast: 1.15, grain: 0.1, vignette: 0.1 }, cut: { rhythm: 'half', transitions: ['slices', 'cut'], beats: 0.5 } }),

  look('datamosh', 'Datamosh Dream', 'Liquid warp with color-split motion echoes', [
    L('liquid', { amount: 0.35, scale: 2 }, { amount: mod('bass', 0.2) }),
    L('echo', { amount: 0.8, drift: 0.3 }),
    L('glitch', { amount: 0.08, block: 0.4, split: 0.5 }, { amount: mod('kick', 0.3) }),
  ], { finish: { saturation: 1.25, split: 0.3, splitHue: 0.8 }, cut: { transitions: ['mosh', 'morph'], beats: 1 } }),

  look('golden-rays', 'Golden Rays', 'Light rays streaming out of the bright areas', [
    L('rays', { threshold: 0.55, intensity: 0.9, length: 0.65, height: 0.8 }, { intensity: mod('energy', 0.3) }),
  ], {
    camera: { drift: 0.5 },
    finish: { temp: 0.4, split: 0.35, splitHue: 0.07, contrast: 1.15, vignette: 0.45, grain: 0.2 },
    cut: { rhythm: 'bar2', transitions: ['flare', 'dissolve'], beats: 1 },
  }),

  look('pixel-sort', 'Pixel Sort Acid', 'Bright pixels dragged into long sorted streaks', [
    L('pixelsort', { threshold: 0.5, length: 0.45, dir: 0 }, { length: mod('kick', 0.3) }),
    L('gradient', { palette: 2, mix: 0.6, contrast: 1.2 }),
    L('chroma', { amount: 0.2 }),
  ], { finish: { contrast: 1.1 }, cut: { transitions: ['pixel', 'prism'] } }),

  look('matrix', 'Glyph Terminal', 'The picture redrawn in glowing text characters', [
    L('ascii', { cell: 14, color: 1, charset: 0 }),
    L('bloom', { threshold: 0.35, intensity: 0.9 }),
    L('crt', { curve: 0.3, scan: 0.45, mask: 0.25 }),
  ], { finish: { contrast: 1.1, grain: 0.05, vignette: 0.3 }, cut: { rhythm: 'half', transitions: ['glitch', 'cut'], beats: 0.25 } }),

  look('iridescent', 'Iridescent Pulse', 'Holographic sheen with a ripple on the beat', [
    L('ripple', { strength: 0.55, every: 0, glow: 0.15 }),
    L('holo', { amount: 0.65, scale: 1.8 }),
    L('bloom', { threshold: 0.8, intensity: 0.7 }, { intensity: mod('kick', 0.12) }),
  ], { finish: { saturation: 1.1, contrast: 1.08 }, cut: { transitions: ['ripple', 'iris'] } }),

  look('anamorphic', 'Anamorphic Night', 'Teal and orange grade, blue lens streaks, letterbox', [
    L('streaks', { threshold: 0.85, intensity: 1.2, length: 0.7, hue: 0.56 }, { intensity: mod('kick', 0.3) }),
    L('chroma', { amount: 0.12 }),
  ], {
    camera: { drift: 0.5 },
    finish: { temp: -0.15, split: 0.45, splitHue: 0.55, contrast: 1.2, bars: 0.1, vignette: 0.4, grain: 0.2 },
    cut: { rhythm: 'bar2', transitions: ['whipX', 'dissolve'], beats: 0.5 },
  }),

  look('mirror-world', 'Mirror World', 'Four-way mirror seen through soft glass', [
    L('mirror', { mode: 1 }),
    L('glass', { strength: 0.3, scale: 1.6, shine: 0.3, disperse: 0.4 }),
    L('hue', { cycles: 1, sat: 1.1 }),
  ], { finish: { contrast: 1.1, vignette: 0.35 }, cut: { transitions: ['kaleido', 'dissolve'] } }),

  look('clone-wall', 'Clone Wall', 'A sliding wall of copies that jumps on the kick', [
    L('tile', { count: 3, slide: 0.4, gap: 0.02, flip: 1 }),
    L('zoomblur', { amount: 0.1 }, { amount: mod('kick', 0.5) }),
  ], { finish: { contrast: 1.15, saturation: 1.1 }, cut: { rhythm: 'half', transitions: ['cut', 'whip'], beats: 0.25 } }),

  look('clean', 'Clean Cut', 'Your footage, color graded and cut on the beat', [
    L('bloom', { threshold: 1.0, intensity: 0.35 }),
  ], { finish: { contrast: 1.12, saturation: 1.08, grain: 0.12, vignette: 0.3 }, cut: { transitions: ['cut'], beats: 0 } }),
];

// Classic stacks rebuilt with GPU modules.
const C = (id: string, name: string, vibe: string, layers: LayerSpec[], opts: LookOptions = {}): Look => ({ ...look(`classic-${id}`, name, vibe, layers, opts), group: 'classic' });
const BOUNCE: LookOptions = { camera: { shake: 0.3 }, cameraMods: { zoom: mod('kick', 0.06), shake: mod('kick', 0.25) } };

export const CLASSIC_LOOKS: Look[] = [
  C('hypnotic', 'Hypnotic Tunnel', 'Tunnel with prism echoes and a color split on the kick', [
    L('tunnel', { mix: 0.85, fog: 0.5 }), L('echo', { amount: 0.6 }), L('chroma', { amount: 0.25 }, { amount: mod('kick', 0.3) }), L('bloom', { intensity: 0.9 }),
  ], { finish: { contrast: 1.15, saturation: 1.1, vignette: 0.5 }, cut: { rhythm: 'bar', transitions: ['luma', 'dissolve'] } }),
  C('acid-dither', 'Acid Dither 2026', 'Dither with neon outlines and CRT scanlines', [
    L('dither', { palette: 2, size: 3 }), L('edges', { dim: 0.55, strength: 1.1 }), L('crt', { curve: 0.12, scan: 0.6, mask: 0.3 }),
  ], { finish: { contrast: 1.15, halation: 0.45 }, cut: { rhythm: 'bar', transitions: ['glitch', 'cut'], beats: 0.25 } }),
  C('crt-melt', 'Analog CRT Melt', 'Liquid warp on an old CRT screen, with grain', [
    L('liquid', { amount: 0.45 }), L('chroma', { amount: 0.3 }), L('crt', { curve: 0.4, scan: 0.5, mask: 0.45 }), L('bloom', { threshold: 0.8, intensity: 0.6, warmth: 0.5 }),
  ], { finish: { temp: 0.25, halation: 0.5, grain: 0.45 }, cut: { rhythm: 'bar', transitions: ['mosh', 'luma'] } }),
  C('kaleido-rave', 'Kaleido Rave', 'Four-way mirror cycling through the color wheel', [
    L('mirror', { mode: 1 }), L('hue', { cycles: 1, sat: 1.3 }), L('chroma', { amount: 0.3 }, { amount: mod('kick', 0.3) }), L('bloom', { intensity: 0.9 }),
  ], { finish: { vignette: 0.5, contrast: 1.12 }, cut: { rhythm: 'bar', transitions: ['whip', 'kaleido'] } }),
  C('cyber-glitch', 'Cyber Glitch', 'Block glitches and neon outlines, shaking on the beat', [
    L('glitch', { amount: 0.5 }, { amount: mod('snare', 0.25) }), L('edges', { dim: 0.45, mode: 1 }), L('chroma', { amount: 0.45, mode: 1 }), L('bloom', { intensity: 0.6 }),
  ], { ...BOUNCE, finish: { contrast: 1.2, saturation: 1.15 }, cut: { rhythm: 'half', transitions: ['mosh', 'glitch'], beats: 0.25 } }),
  C('liquid-acid', 'Liquid Acid', 'Fluid warp with trails and solarized highlights', [
    L('liquid', { amount: 0.5, scale: 2.5 }), L('echo', { amount: 0.65 }), L('solarize', { mode: 1, amount: 0.85 }), L('bloom', { intensity: 0.7 }),
  ], { finish: { halation: 0.4, contrast: 1.1 }, cut: { rhythm: 'bar2', transitions: ['luma', 'morph'], beats: 1 } }),
  C('dark-cinema', 'Dark Cinema', 'Teal and orange with a heavy vignette and a shake on the beat', [
    L('filmstock', { mode: 5, strength: 0.95 }), L('bloom', { threshold: 1.1, intensity: 0.45 }), L('streaks', { threshold: 1.2, intensity: 0.5 }),
  ], { ...BOUNCE, finish: { exposure: -0.2, contrast: 1.32, saturation: 0.85, grain: 0.45, vignette: 0.7, halation: 0.35 }, cut: { rhythm: 'bar2', transitions: ['luma', 'dissolve'], beats: 1 } }),
  C('vhs-rewind', 'VHS Retro Rewind', 'Tape tracking errors with scanlines and grain', [
    L('lens', { bulge: 0.3 }), L('vhs', { amount: 0.65 }), L('crt', { curve: 0.3, scan: 0.6, mask: 0.3 }),
  ], { finish: { halation: 0.4, grain: 0.45, contrast: 1.1, saturation: 1.1 }, cut: { rhythm: 'bar', transitions: ['glitch', 'cut'], beats: 0.25 } }),
  C('neon-tokyo', 'Neon Tokyo 2026', 'Cyberpunk colors with neon outlines and trails', [
    L('echo', { amount: 0.5 }), L('edges', { dim: 0.6 }), L('filmstock', { mode: 1, strength: 0.85 }), L('bloom', { intensity: 1 }),
  ], { finish: { vignette: 0.5, contrast: 1.15 }, cut: { rhythm: 'bar', transitions: ['flare', 'prism'] } }),
  C('solar-flare', 'Solar Flare', 'Lens flares and solarized gold, with a warm pulse on the kick', [
    L('solarize', { amount: 0.8, threshold: 0.6 }), L('filmstock', { mode: 2, strength: 1 }), L('streaks', { threshold: 0.7, intensity: 1.5, hue: 0.08 }), L('pulse', { amount: 0.35 }),
  ], { finish: { vignette: 0.45 }, cut: { rhythm: 'bar', transitions: ['dissolve', 'flare'] } }),
  C('matrix-stream', 'Matrix Data Stream', 'Glowing text characters torn up by glitches', [
    L('ascii', { color: 1, charset: 1, cell: 12 }), L('glitch', { amount: 0.3 }), L('chroma', { amount: 0.25 }), L('bloom', { intensity: 0.8 }),
  ], { finish: { vignette: 0.5, contrast: 1.15 }, cut: { rhythm: 'half', transitions: ['mosh', 'glitch'], beats: 0.25 } }),
  C('prism-velocity', 'Prism Velocity', 'Zoom blur on the kick with prism trails', [
    L('zoomblur', { amount: 0.45 }, { amount: mod('kick', 0.3) }), L('echo', { amount: 0.75 }), L('chroma', { amount: 0.4 }), L('bloom', { intensity: 0.6 }),
  ], { ...BOUNCE, finish: { vignette: 0.5 }, cut: { rhythm: 'bar', transitions: ['zoom', 'prism'] } }),
  C('thermal-ir', 'Thermal Infrared', 'Infrared heat map with shockwaves on the bass', [
    L('ripple', { strength: 0.45, every: 0 }), L('gradient', { palette: 0 }), L('bloom', { intensity: 0.5 }),
  ], { ...BOUNCE, finish: { grain: 0.4, halation: 0.45, vignette: 0.5 }, cut: { rhythm: 'bar', transitions: ['swirl', 'cut'] } }),
  C('duotone-punk', 'Duotone Acid Punk', 'Two-color acid palette with outlines and dither', [
    L('gradient', { palette: 2 }), L('dither', { palette: 6, size: 2, levels: 3 }), L('edges', { dim: 0.5, mode: 2 }), L('pulse', { amount: 0.3 }),
  ], { finish: { vignette: 0.5, contrast: 1.15 }, cut: { rhythm: 'half', transitions: ['whip', 'glitch'], beats: 0.25 } }),
  C('noir-35', '35mm Noir', 'Sepia film with light leaks and a letterbox', [
    L('filmstock', { mode: 3, strength: 0.9 }), L('leak', { amount: 0.3 }), L('bloom', { threshold: 1, intensity: 0.4 }),
  ], { camera: { shake: 0.2 }, finish: { grain: 0.55, bars: 0.1, vignette: 0.6, contrast: 1.2 }, cut: { rhythm: 'bar2', transitions: ['luma', 'dissolve'], beats: 1 } }),
  C('kaleido-vortex', 'Kaleido Vortex', 'Six-sided kaleidoscope that twists on the kick', [
    L('kaleido', { slices: 6 }), L('vortex', { twist: 0.35 }, { twist: mod('kick', 0.2) }), L('hue', { cycles: 1 }), L('bloom', { intensity: 0.9 }),
  ], { finish: { vignette: 0.5 }, cut: { rhythm: 'bar', transitions: ['kaleido', 'swirl'] } }),
  C('subbass-quake', 'Sub-Bass Quake', 'Shockwaves and a heavy shake on the bass', [
    L('ripple', { strength: 0.75, every: 0, glow: 0.45 }), L('chroma', { amount: 0.35 }, { amount: mod('bass', 0.35) }), L('bassrim', { amount: 0.85, rim: 0.7 }),
  ], { camera: { shake: 0.45 }, cameraMods: { zoom: mod('kick', 0.07), shake: mod('bass', 0.3) }, finish: { halation: 0.4, contrast: 1.2 }, cut: { rhythm: 'bar', transitions: ['slices', 'zoom'] } }),
  C('cosmic-hyperdrive', 'Cosmic Hyperdrive', 'Star tunnel with prism trails and glints', [
    L('tunnel', { speed: 2, mix: 0.9 }), L('echo', { amount: 0.6 }), L('glint', { intensity: 1.2 }), L('bloom', { intensity: 1 }),
  ], { finish: { vignette: 0.5, contrast: 1.12 }, cut: { rhythm: 'bar', transitions: ['prism', 'zoom'] } }),
];
// Album art: built for a single still (cover art, a photo). Depth parallax and slow camera
// drift give it life; the rest is light and texture rather than cuts.
const A = (id: string, name: string, vibe: string, layers: LayerSpec[], opts: LookOptions = {}): Look => ({ ...look(`art-${id}`, name, vibe, layers, opts), group: 'art' });
const STILL: Record<string, number> = { zoom: 1.12, drift: 0.55 };

export const ART_LOOKS: Look[] = [
  A('living-cover', 'Living Cover Art', 'Parallax depth with a warm glow that swells with the vocals', [
    L('parallax', { amount: 0.55, speed: 1, src: 2, focus: 0.45, kick: 0.35 }),
    L('pulse', { trigger: 0, amount: 0.22, warmth: 0.4, glow: 0.3 }, { amount: mod('presence', 0.2) }),
    L('bloom', { threshold: 0.85, intensity: 0.5, warmth: 0.25 }, { intensity: mod('vocals', 0.2) }),
  ], { camera: STILL, finish: { contrast: 1.08, saturation: 1.05, halation: 0.28, grain: 0.18, vignette: 0.32 }, cut: { rhythm: 'bar2', transitions: ['dissolve'], beats: 2 } }),
  A('visualizer', 'Track Visualizer', 'A spectrum ring over the cover art, pulsing on the kick', [
    L('parallax', { amount: 0.4, speed: 1 }),
    L('visualizer', { mode: 0, scale: 0.46, glow: 0.75, hue: 0.56, mix: 0.85 }, { scale: mod('kick', 0.08), glow: mod('energy', 0.3) }),
    L('bloom', { threshold: 0.8, intensity: 0.55 }),
  ], { camera: STILL, finish: { contrast: 1.12, vignette: 0.4, grain: 0.15 }, cut: { rhythm: 'bar2', transitions: ['dissolve'], beats: 2 } }),
  A('breathe', 'Cover Breathe', 'Slow parallax orbit with a soft pulse on the kick', [
    L('parallax', { amount: 0.6, speed: 1 }), L('pulse', { trigger: 0, amount: 0.25, glow: 0.35 }), L('bloom', { threshold: 0.8, intensity: 0.55 }),
  ], { camera: STILL, finish: { grain: 0.3, vignette: 0.45, contrast: 1.12 }, cut: { rhythm: 'bar2', transitions: ['dissolve'], beats: 2 } }),
  A('sparkle', 'Cover Sparkle', 'Parallax with star glints and a drifting light leak', [
    L('parallax', { amount: 0.45, speed: 2 }), L('glint', { threshold: 0.45, intensity: 1.1, spin: 0.3 }, { intensity: mod('hats', 0.3) }), L('leak', { amount: 0.45 }),
  ], { camera: STILL, finish: { grain: 0.25, halation: 0.35, saturation: 1.1 }, cut: { rhythm: 'bar2', transitions: ['flare', 'dissolve'], beats: 2 } }),
  A('dream', 'Cover Dream', 'Parallax with a slow liquid melt and a warm glow', [
    L('parallax', { amount: 0.5 }), L('liquid', { amount: 0.25, scale: 1.6 }, { amount: mod('bass', 0.15) }), L('ghost', { amount: 0.35, tint: 0.7 }), L('bloom', { intensity: 0.7, warmth: 0.6 }),
  ], { camera: STILL, finish: { temp: 0.15, fade: 0.03, halation: 0.4, grain: 0.3 }, cut: { rhythm: 'bar2', transitions: ['luma', 'morph'], beats: 2 } }),
  A('tape', 'Cover on Tape', 'Parallax on VHS tape that freezes briefly on the kick', [
    L('parallax', { amount: 0.35 }), L('stutter', { mode: 2, hold: 0.35 }), L('vhs', { amount: 0.55 }), L('chroma', { amount: 0.25 }, { amount: mod('snare', 0.35) }),
  ], { camera: { ...STILL, shake: 0.15 }, cameraMods: { zoom: mod('kick', 0.08) }, finish: { grain: 0.5, contrast: 1.15, vignette: 0.4 }, cut: { rhythm: 'bar', transitions: ['glitch', 'mosh'], beats: 0.5 } }),
  A('glitch', 'Cover Glitch', 'Parallax broken up by glitches on the snare', [
    L('parallax', { amount: 0.4, speed: 0 }), L('glitch', { amount: 0.15, block: 0.5 }, { amount: mod('snare', 0.5) }), L('chroma', { amount: 0.2, mode: 1 }, { amount: mod('kick', 0.4) }),
    L('bloom', { intensity: 0.5 }),
  ], { camera: STILL, cameraMods: { zoom: mod('kick', 0.1) }, finish: { contrast: 1.2, saturation: 1.15 }, cut: { rhythm: 'half', transitions: ['glitch', 'pixel'], beats: 0.25 } }),
  A('halo', 'Cover Halo', 'Light rays through the art with a frosted, golden grade', [
    L('parallax', { amount: 0.5, speed: 2 }), L('rays', { threshold: 0.55, intensity: 0.9 }, { intensity: mod('kick', 0.25) }), L('frost', { amount: 0.25, mist: 0.2 }),
    L('filmstock', { mode: 2, strength: 0.6 }),
  ], { camera: STILL, finish: { halation: 0.45, grain: 0.3, vignette: 0.45 }, cut: { rhythm: 'bar2', transitions: ['flare', 'dissolve'], beats: 2 } }),
];

LOOKS.push(...ART_LOOKS);
LOOKS.push(...CLASSIC_LOOKS);

// Variation engine
const ADJ = ['Velvet', 'Neon', 'Molten', 'Hollow', 'Static', 'Prism', 'Silver', 'Midnight', 'Solar', 'Feral', 'Lunar', 'Acid', 'Glass',
  'Ghost', 'Chrome', 'Infra', 'Hyper', 'Soft', 'Fever', 'Wired'];
const NOUN = ['Bloom', 'Drift', 'Signal', 'Halo', 'Tide', 'Mirage', 'Pulse', 'Circuit', 'Ember', 'Haze', 'Echo', 'Spiral', 'Orbit',
  'Ritual', 'Fracture', 'Current', 'Aura', 'Relic', 'Flux', 'Nova'];
const AUDIO_SRC = ['kick', 'kick', 'snare', 'hats', 'bass', 'energy', 'beat', 'lfo', 'off', 'lfoH', 'arc', 'seq'];

const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

export function cloneLook(l: Look): Look { return JSON.parse(JSON.stringify(l)); }

function jitterParams(r: () => number, params: ParamDef[], values: Record<string, number>, amount: number): void {
  for (const p of params) {
    if (p.opts || p.step >= 1) {
      if (r() < amount * 0.25) values[p.id] = p.opts ? Math.floor(r() * p.opts.length) : Math.round(p.min + r() * (p.max - p.min));
    } else {
      const v = values[p.id] ?? p.def;
      values[p.id] = +clamp(v + gauss(r) * amount * 0.22 * (p.max - p.min), p.min, p.max).toFixed(3);
    }
  }
}

function randomMod(r: () => number, params: ParamDef[]): [string, Modulation] | null {
  const cont = params.filter((p) => !p.opts && p.step < 1 && p.id !== 'mix');
  if (!cont.length) return null;
  const p = pick(r, cont);
  return [p.id, mod(pick(r, AUDIO_SRC), +((r() < 0.8 ? 1 : -1) * (0.08 + r() * 0.3)).toFixed(2))];
}

export function mutate(base: Look, amount: number, seed: number): Look {
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

export function randomLook(seed: number): Look {
  const r = rng(seed);
  const ids = Object.keys(MODULES);
  const heroCats = ['space', 'warp', 'stylize', 'color', 'time'];
  const hero = pick(r, ids.filter((id) => heroCats.includes(MODULES[id].cat || '')));
  const support = pick(r, ids.filter((id) => ['light', 'color'].includes(MODULES[id].cat || '') && id !== hero));
  const base = look(`rnd-${seed}`, '', '', [L(hero), L(support)], {
    cut: { rhythm: pick(r, ['bar', 'half', 'hits', 'build']), transitions: [pick(r, Object.keys(TRANSITIONS)), pick(r, Object.keys(TRANSITIONS))] },
  });
  const l = mutate(base, 0.7, seed + 1);
  l.vibe = `${MODULES[hero].name} + ${MODULES[support].name}`;
  return l;
}

// Chaos roll: random stack (4-6 layers) or heavily mutated built-in look.
/** Pipeline order of effect categories: geometry first, light last. */
export const STAGE: string[] = ['space', 'warp', 'time', 'stylize', 'color', 'light'];

/** Insert a layer before the first layer from a later pipeline stage. */
export function insertAtStage(layers: LayerSpec[], layer: LayerSpec): void {
  const stage = (m: string) => STAGE.indexOf(MODULES[m]?.cat || '');
  const at = layers.findIndex((x) => stage(x.m) > stage(layer.m));
  layers.splice(at < 0 ? layers.length : at, 0, layer);
}
const CAPS: Record<string, number> = { space: 1, warp: 2, time: 1, stylize: 1, color: 2, light: 2 };
const GLOWS: string[] = ['bloom', 'streaks', 'rays', 'leak', 'glint', 'pulse', 'ghost'];

// Starting points: every setting a built-in look uses for a module.
const CURATED: Record<string, Record<string, number>[]> = {};
for (const lk of LOOKS) for (const x of lk.layers) (CURATED[x.m] ||= []).push(x.p);
// how far a roll may wander from that starting point (image-replacing effects break first)
const WANDER: Record<string, number> = { space: 0.45, warp: 0.45, time: 0.35, stylize: 0.2, color: 0.25, light: 0.35 };

export function chaosLook(seed: number): Look {
  const r = rng(seed);
  const ids = Object.keys(MODULES);
  const of = (...cats: string[]) => ids.filter((id) => cats.includes(MODULES[id].cat || ''));
  let l: Look;
  if (r() < 0.4) {
    const base = pick(r, LOOKS.filter((x) => x.id !== 'clean'));
    l = cloneLook(base);
    if (r() < 0.6 && l.layers.length) {
      const i = Math.floor(r() * l.layers.length);
      const same = of(MODULES[l.layers[i].m].cat || '').filter((id) => !l.layers.some((x) => x.m === id));
      if (same.length) l.layers[i] = L(pick(r, same));
    }
    l.vibe = `${base.name}, rolled`;
  } else {
    const stack: string[] = [];
    const add = (pool: string[]) => {
      const free = pool.filter((id) => !stack.includes(id));
      if (free.length) stack.push(pick(r, free));
    };
    if (r() < 0.75) add(of('space', 'warp'));
    if (r() < 0.6) add(of('stylize', 'time'));
    if (r() < 0.55) add(of('color'));
    add(of('light'));
    stack.sort((a, b) => STAGE.indexOf(MODULES[a].cat || '') - STAGE.indexOf(MODULES[b].cat || ''));
    l = look('', '', '', stack.map((id) => L(id)));
  }
  // Keep rolls punchy, not mush: no duplicates, at most one image-replacing stylizer, one feedback
  // effect, two glows and two color remaps; then top up to 4–6 layers at their pipeline stage.
  const counts: Record<string, number> = {};
  const fits = (id: string) => (counts[MODULES[id].cat || ''] || 0) < (CAPS[MODULES[id].cat || ''] || 0);
  l.layers = l.layers.filter((x, i, a) => {
    if (a.findIndex((y) => y.m === x.m) !== i || !fits(x.m)) return false;
    counts[MODULES[x.m].cat || ''] = (counts[MODULES[x.m].cat || ''] || 0) + 1;
    return true;
  });
  const want = 4 + Math.floor(r() * 3);
  while (l.layers.length < want) {
    const pool = ids.filter((id) => fits(id) && !l.layers.some((x) => x.m === id));
    if (!pool.length) break;
    const id = pick(r, pool);
    counts[MODULES[id].cat || ''] = (counts[MODULES[id].cat || ''] || 0) + 1;
    insertAtStage(l.layers, L(id));
  }
  if (!l.vibe) l.vibe = l.layers.map((x) => MODULES[x.m].name).join(' + ');
  l.id = `chaos-${seed}`;
  l.name = `${pick(r, ADJ)} ${pick(r, NOUN)}`;
  for (const layer of l.layers) {
    const def = MODULES[layer.m];
    const designed = Object.keys(layer.p).length ? layer.p : CURATED[layer.m] ? pick(r, CURATED[layer.m]) : {};
    layer.p = { ...defaults(def.params), ...designed };
    jitterParams(r, def.params, layer.p, WANDER[def.cat || '']);
    layer.mods = { ...layer.mods };
    if (r() < 0.5) { const m = randomMod(r, def.params); if (m) layer.mods[m[0]] = m[1]; }
  }
  const cam = l.camera.p;
  cam.zoom = +(1 + r() * 0.2).toFixed(3);
  cam.drift = +(0.15 + r() * 0.55).toFixed(3);
  cam.shake = r() < 0.35 ? +(r() * 0.45).toFixed(3) : 0;
  cam.sway = r() < 0.3 ? +(r() * 0.45).toFixed(3) : 0;
  l.camera.mods = r() < 0.7 ? { zoom: mod(pick(r, ['kick', 'kick', 'bass', 'beat']), +(0.03 + r() * 0.07).toFixed(3)) } : {};
  const fin = l.finish.p;
  jitterParams(r, FINISH_DEF.params.filter((p) => ['temp', 'tint', 'split', 'splitHue', 'saturation', 'contrast', 'vignette', 'grain'].includes(p.id)), fin, 0.7);
  fin.contrast = Math.max(fin.contrast, 1.08);
  fin.saturation = Math.max(fin.saturation, 0.9);
  fin.fade = Math.min(fin.fade, 0.04);
  fin.vignette = Math.max(fin.vignette, 0.25);
  // every glow layer lifts the image; pull exposure back a touch for each one past the first
  const glows = l.layers.filter((x) => GLOWS.includes(x.m)).length;
  fin.exposure = Math.min(fin.exposure, glows > 1 ? -0.12 * (glows - 1) : 0);
  if (r() < 0.25) fin.halation = +(0.2 + r() * 0.5).toFixed(3);
  if (r() < 0.15) fin.bars = +(0.06 + r() * 0.08).toFixed(3);
  return l;
}

// "Evolve" per-clip mode: each clip gets a gentle, deterministic mutation of the main look.
export function evolveLook(base: Look, amount: number, seed: number): Look {
  const l = mutate(base, amount, seed);
  l.camera = base.camera;
  l.finish = base.finish;
  l.cut = base.cut;
  return l;
}
