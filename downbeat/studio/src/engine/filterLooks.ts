import { createLook, layer as L, mod, type LookOptions } from './lookFactory.ts';
import type { LayerSpec, Look, LookStyle } from './types.ts';

// These grades deliberately start with neutral Finish settings and no beat-driven camera routes.
// The layers carry each look's character, including when it is applied to an individual appearance.
const F = (style: LookStyle, id: string, name: string, vibe: string, layers: LayerSpec[], opts: LookOptions = {}): Look => ({
  ...createLook(`${style}-${id}`, name, vibe, layers, {
    camera: { zoom: 1, drift: 0, shake: 0, sway: 0, ...opts.camera },
    cameraMods: { zoom: mod('off', 0), ...opts.cameraMods },
    finish: { contrast: 1, saturation: 1, temp: 0, tint: 0, split: 0, fade: 0, grain: 0, vignette: 0.08, ...opts.finish },
    finishMods: opts.finishMods,
    cut: { rhythm: 'bar2', transitions: ['cut', 'dissolve'], beats: 0.5, ...opts.cut },
  }),
  style,
  group: style,
});

export const FILTER_LOOKS: Look[] = [
  F('natural', 'documentary', 'Neutral Documentary', 'Clean, continuous color with a restrained contrast curve', [
    L('editorial', { mode: 0, strength: 0.65 }),
  ], { cut: { transitions: ['cut'], beats: 0 } }),
  F('natural', 'portrait', 'Warm Portrait', 'Warm skin and delicate portrait diffusion', [
    L('editorial', { mode: 1, strength: 0.75 }), L('diffusion', { mode: 1, amount: 0.16, radius: 10 }),
  ]),
  F('natural', 'editorial', 'Cool Editorial', 'Cool shadows and muted fashion color with warmer skin preserved', [
    L('editorial', { mode: 2, strength: 0.85 }),
  ]),
  F('natural', 'pastel', 'Pastel Daylight', 'Soft pastel color, lifted blacks and a little pearlescent light', [
    L('editorial', { mode: 3, strength: 0.8, matte: 0.015 }), L('diffusion', { mode: 2, amount: 0.14, radius: 12 }),
  ]),
  F('natural', 'lifestyle', 'Warm Lifestyle', 'An understated amber daylight grade with soft highlights', [
    L('editorial', { mode: 1, strength: 0.5, matte: 0.015 }), L('diffusion', { mode: 0, amount: 0.12, warmth: 0.2 }),
  ], { finish: { grain: 0.06 } }),

  F('monochrome', 'silver', 'Silver Screen', 'Clean silver black and white with continuous midtones', [
    L('monochrome', { mode: 0, contrast: 1.12, filter: 0.12 }),
  ], { finish: { grain: 0.12 } }),
  F('monochrome', 'matte', 'Matte Monochrome', 'Soft black and white with lifted shadows and a quiet matte finish', [
    L('monochrome', { mode: 1, contrast: 0.98 }),
  ], { finish: { grain: 0.08 } }),
  F('monochrome', 'noir', 'Noir Contrast', 'Deep blacks, bright silver highlights and a trace of scratched film', [
    L('monochrome', { mode: 2, contrast: 1.18, filter: 0.3 }), L('filmtexture', { dust: 0.12, scratches: 0.12, breath: 0 }),
  ], { finish: { grain: 0.22, vignette: 0.25 }, cut: { transitions: ['cut'], beats: 0 } }),
  F('monochrome', 'selenium', 'Selenium Print', 'Cool toned shadows on a subtle silver print base', [
    L('monochrome', { mode: 3, contrast: 1.08 }), L('paper', { amount: 0.12, warmth: 0, fibers: 0.2 }),
  ]),
  F('monochrome', 'documentary', 'Documentary B&W', 'Gentle black and white with fine documentary grain', [
    L('monochrome', { mode: 0, contrast: 1, filter: -0.1 }), L('filmtexture', { dust: 0.08, scratches: 0, breath: 0 }),
  ], { finish: { grain: 0.2 }, cut: { transitions: ['cut'], beats: 0 } }),

  F('film', '16mm', '16mm Daylight', 'Warm small-gauge color, grain, dust and tiny mechanical frame movement', [
    L('gateweave', { amount: 0.22, rotation: 0.12, breath: 0.12 }),
    L('photoprint', { mode: 0, strength: 0.85 }), L('filmtexture', { dust: 0.3, scratches: 0.18, breath: 0 }),
  ], { finish: { grain: 0.38, halation: 0.1, vignette: 0.18 } }),
  F('film', '35mm', '35mm Cinema', 'Restrained photographic color with fine grain and gentle optical diffusion', [
    L('photoprint', { mode: 1, strength: 0.85 }), L('diffusion', { amount: 0.14, radius: 12, warmth: 0.1 }),
    L('filmtexture', { dust: 0.08, scratches: 0.04, breath: 0.04 }),
  ], { finish: { grain: 0.18, halation: 0.08 } }),
  F('film', 'faded', 'Faded Print', 'A sun-faded photographic print with soft color and a warm paper base', [
    L('photoprint', { mode: 2, strength: 0.85 }), L('paper', { amount: 0.22, warmth: 0.4 }),
  ], { finish: { grain: 0.14 } }),
  F('film', 'expired', 'Expired Film', 'Aged film color with amber highlights, greenish shadows and light dust', [
    L('photoprint', { mode: 3, strength: 0.8 }), L('filmtexture', { dust: 0.2, scratches: 0.1, breath: 0.08 }),
  ], { finish: { grain: 0.28, vignette: 0.2 } }),
  F('film', 'disposable', 'Disposable Flash', 'Punchy point-and-shoot color, a brighter center and darker edges', [
    L('photoprint', { mode: 4, strength: 0.9 }), L('diffusion', { amount: 0.12, radius: 8 }),
  ], { finish: { grain: 0.3, vignette: 0.18 } }),

  F('soft', 'mist', 'Black Mist', 'Contained highlight bloom that keeps the subject and dark tones intact', [
    L('diffusion', { mode: 0, amount: 0.42, radius: 20, threshold: 0.55 }),
  ]),
  F('soft', 'portrait', 'Soft Portrait', 'Gently softened fine detail with a natural, quiet highlight glow', [
    L('diffusion', { mode: 1, amount: 0.5, radius: 12, threshold: 0.62 }),
  ]),
  F('soft', 'pearl', 'Pearl Glow', 'Pearlescent light and soft shadows without color cycling', [
    L('diffusion', { mode: 2, amount: 0.55, radius: 24, threshold: 0.5, warmth: 0.08 }),
  ]),
  F('soft', 'dream', 'Dream Focus', 'A clear center surrounded by a dreamy, softly diffused frame', [
    L('defocus', { mode: 0, amount: 0.65, radius: 30, width: 0.35, bokeh: 0.3 }),
    L('diffusion', { mode: 2, amount: 0.3, radius: 20 }),
  ]),
  F('soft', 'bokeh', 'Quiet Bokeh', 'A sharp focal spot with softly rounded, highlight-weighted blur around it', [
    L('defocus', { mode: 0, amount: 0.9, radius: 40, width: 0.22, bokeh: 0.85 }),
  ]),

  F('light', 'window', 'Window Light', 'A soft four-pane window shadow with warm side light', [
    L('gobo', { mode: 0, amount: 0.28, softness: 0.12, drift: 0 }),
    L('gel', { mode: 1, hue: 0.1, saturation: 0.25, amount: 0.2 }),
  ]),
  F('light', 'blinds', 'Venetian Blinds', 'Angled blind shadows with a warm afternoon glow', [
    L('gobo', { mode: 1, amount: 0.35, scale: 0.8, softness: 0.07, drift: 0.08 }),
    L('gel', { mode: 0, hue: 0.09, saturation: 0.24, amount: 0.18 }),
  ]),
  F('light', 'leaves', 'Dappled Sun', 'Slowly moving leaf shadows over warm, natural color', [
    L('editorial', { mode: 1, strength: 0.35 }), L('gobo', { mode: 2, amount: 0.28, softness: 0.13, drift: 0.3 }),
  ]),
  F('light', 'golden', 'Golden Window', 'Wide, soft window light with gentle amber highlight diffusion', [
    L('gobo', { mode: 0, amount: 0.22, scale: 0.6, angle: -12, softness: 0.18, drift: 0 }),
    L('diffusion', { amount: 0.25, warmth: 0.4, radius: 20 }),
  ], { finish: { temp: 0.12 } }),
  F('light', 'gels', 'Split Color Gels', 'Subtle blue and amber lighting on opposite sides of the original picture', [
    L('gel', { mode: 2, hue: 0.6, saturation: 0.55, amount: 0.42, spread: 0.45 }),
  ]),

  F('illustrated', 'pencil', 'Pencil Study', 'Fine graphite lines and crosshatching on lightly textured paper', [
    L('sketch', { mode: 0, detail: 0.6, width: 1, paper: 0.25 }), L('paper', { amount: 0.4, fibers: 0.35, warmth: 0.1 }),
  ]),
  F('illustrated', 'charcoal', 'Charcoal Paper', 'Dark, softly smudged charcoal with visible paper tooth', [
    L('sketch', { mode: 1, detail: 0.45, width: 1.6, paper: 0.1 }), L('paper', { amount: 0.65, scale: 1.5, fibers: 0.55, warmth: 0.05 }),
  ]),
  F('illustrated', 'ink', 'Ink Wash', 'Bold ink contours and a few diluted gray washes on warm paper', [
    L('sketch', { mode: 2, detail: 0.7, width: 1.3, paper: 0.35 }), L('paper', { amount: 0.3, fibers: 0.2, warmth: 0.2 }),
  ]),
  F('illustrated', 'watercolor', 'Watercolor', 'Broad color washes with pooled pigment at the subject edges', [
    L('watercolor', { radius: 5, bleed: 0.5, detail: 0.5 }), L('paper', { amount: 0.4, fibers: 0.3, warmth: 0.1 }),
  ]),
  F('illustrated', 'postcard', 'Watercolor Postcard', 'A faded watercolor print with soft pigments and a warm paper base', [
    L('watercolor', { radius: 7, bleed: 0.35, detail: 0.35 }), L('photoprint', { mode: 2, strength: 0.35 }),
    L('paper', { amount: 0.5, scale: 1.3, warmth: 0.45 }),
  ]),
];
